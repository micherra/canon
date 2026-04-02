/**
 * Knowledge Graph Read-Only Query Module
 *
 * Wraps a better-sqlite3 Database instance with complex read-only queries.
 * All statements are prepared once at construction time and reused for
 * performance. All operations are purely SELECT — no mutations here.
 */

import type Database from "better-sqlite3";
import { LAYER_CENTRALITY } from "../constants.ts";
import type {
  BlastRadiusResult,
  CallerResult,
  DeadCodeResult,
  EntityRow,
  FileBlastRadiusResult,
  FileMetrics,
  FileRow,
  LayerViolation,
  SearchResult,
} from "./kg-types.ts";

// ---------------------------------------------------------------------------
// Layer rules — clean-architecture defaults (mirrors insights.ts)
// ---------------------------------------------------------------------------

const DEFAULT_LAYER_RULES: Record<string, string[]> = {
  api: ["domain", "shared", "data"],
  ui: ["domain", "shared"],
  domain: ["data", "shared"],
  data: ["infra", "shared"],
  infra: ["shared"],
  shared: [],
};

// ---------------------------------------------------------------------------
// computeImpactScore — exported for consumers that migrated from query.ts
// ---------------------------------------------------------------------------

/** Compute impact score for a file based on graph position. Higher = more impactful. */
export function computeImpactScore(
  inDegree: number,
  violationCount: number,
  isChanged: boolean,
  layer: string,
): number {
  const centrality = LAYER_CENTRALITY[layer] ?? 0;
  const score = inDegree * 3 + violationCount * 2 + (isChanged ? 1 : 0) + centrality;
  return Math.round(score * 100) / 100;
}

// ---------------------------------------------------------------------------
// computeFileInsightMaps — batch helper for hub/cycle/violation computation
// ---------------------------------------------------------------------------

export interface FileInsightMaps {
  /** Set of file paths that qualify as hubs (top 10 by total degree). */
  hubPaths: Set<string>;
  /** Map from file path to the set of cycle-peer paths. */
  cycleMemberPaths: Map<string, string[]>;
  /** Map from file path to its outbound layer violations. */
  layerViolationsByPath: Map<string, LayerViolation[]>;
}

/**
 * Compute hub detection, cycle membership, and layer violations from the
 * file_edges and files tables.  Pure SQL aggregates — no persisted columns.
 *
 * Intended to be called once per request and the result passed into
 * getFileMetrics() for individual file lookups, avoiding N+1 query patterns.
 */
export function computeFileInsightMaps(db: Database.Database): FileInsightMaps {
  // ---- 1. Load all file edges ------------------------------------------------
  const edgeRows = loadFileEdgeRows(db);

  // ---- 2. Hub detection via degree computation --------------------------------
  const hubPaths = computeHubPaths(edgeRows);

  // ---- 3. Cycle detection via adjacency list ----------------------------------
  const adj = buildAdjacencyMap(edgeRows);
  const fileRows = db.prepare(`SELECT path FROM files`).all() as Array<{ path: string }>;
  const cycleMemberPaths = detectFileCycles(
    fileRows.map((r) => r.path),
    adj,
  );

  // ---- 4. Layer violations ----------------------------------------------------
  const layerViolationsByPath = computeLayerViolations(edgeRows);

  return { hubPaths, cycleMemberPaths, layerViolationsByPath };
}

/** Row type returned by the file edges query. */
interface FileEdgeRow {
  source_file_id: number;
  target_file_id: number;
  source_path: string;
  target_path: string;
  source_layer: string;
  target_layer: string;
}

/** Load all file edges with joined path and layer data. */
function loadFileEdgeRows(db: Database.Database): FileEdgeRow[] {
  return db
    .prepare(`SELECT fe.source_file_id, fe.target_file_id, fs.path AS source_path, ft.path AS target_path,
                     fs.layer AS source_layer, ft.layer AS target_layer
              FROM file_edges fe
              JOIN files fs ON fs.file_id = fe.source_file_id
              JOIN files ft ON ft.file_id = fe.target_file_id`)
    .all() as FileEdgeRow[];
}

/** Compute the top-10 hub paths by total degree. */
function computeHubPaths(edgeRows: FileEdgeRow[]): Set<string> {
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();

  for (const row of edgeRows) {
    outDegree.set(row.source_path, (outDegree.get(row.source_path) || 0) + 1);
    inDegree.set(row.target_path, (inDegree.get(row.target_path) || 0) + 1);
  }

  const allPaths = new Set([...inDegree.keys(), ...outDegree.keys()]);
  const sorted = [...allPaths]
    .map((p) => ({ path: p, total: (inDegree.get(p) || 0) + (outDegree.get(p) || 0) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);
  return new Set(sorted.map((x) => x.path));
}

/** Build an adjacency map from source_path → target_path[]. */
function buildAdjacencyMap(edgeRows: FileEdgeRow[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const row of edgeRows) {
    let neighbors = adj.get(row.source_path);
    if (!neighbors) {
      neighbors = [];
      adj.set(row.source_path, neighbors);
    }
    neighbors.push(row.target_path);
  }
  return adj;
}

/** Compute layer violations from file edge rows using default layer rules. */
function computeLayerViolations(edgeRows: FileEdgeRow[]): Map<string, LayerViolation[]> {
  const layerViolationsByPath = new Map<string, LayerViolation[]>();

  for (const row of edgeRows) {
    const sourceLayer = row.source_layer || "unknown";
    const targetLayer = row.target_layer || "unknown";

    if (sourceLayer === targetLayer || sourceLayer === "unknown" || targetLayer === "unknown") {
      continue;
    }

    const allowed = DEFAULT_LAYER_RULES[sourceLayer];
    if (allowed && !allowed.includes(targetLayer)) {
      let violations = layerViolationsByPath.get(row.source_path);
      if (!violations) {
        violations = [];
        layerViolationsByPath.set(row.source_path, violations);
      }
      violations.push({
        target: row.target_path,
        source_layer: sourceLayer,
        target_layer: targetLayer,
      });
    }
  }

  return layerViolationsByPath;
}

// ---------------------------------------------------------------------------
// Cycle detection helpers (file-level DFS — mirrors insights.ts pattern)
// ---------------------------------------------------------------------------

function detectFileCycles(nodes: string[], adj: Map<string, string[]>): Map<string, string[]> {
  const MAX_CYCLE_LEN = 5;
  const MAX_CYCLES = 20;
  const cycleSet = new Set<string>();
  const cycles: string[][] = [];
  const visited = new Set<string>();

  for (const startNode of nodes) {
    if (visited.has(startNode) || cycles.length >= MAX_CYCLES) continue;
    fileDfsComponent(startNode, adj, visited, MAX_CYCLE_LEN, cycleSet, cycles, MAX_CYCLES);
  }

  return buildCycleMembershipMap(cycles);
}

/** Build a map from each node to its cycle peers from a list of detected cycles. */
function buildCycleMembershipMap(cycles: string[][]): Map<string, string[]> {
  const cycleMembers = new Map<string, string[]>();
  for (const cycle of cycles) {
    for (const node of cycle) {
      const existing = cycleMembers.get(node) || [];
      for (const peer of cycle) {
        if (peer !== node && !existing.includes(peer)) existing.push(peer);
      }
      cycleMembers.set(node, existing);
    }
  }
  return cycleMembers;
}

/** Try to record a cycle from the current path if the neighbor is already in the stack. */
function tryRecordCycle(
  neighbor: string,
  path: string[],
  maxCycleLen: number,
  cycleSet: Set<string>,
  cycles: string[][],
): void {
  const cycleStart = path.indexOf(neighbor);
  if (cycleStart < 0) return;
  const cycle = path.slice(cycleStart);
  if (cycle.length > maxCycleLen) return;
  const normalized = fileNormalizeCycle(cycle);
  const key = normalized.join(" -> ");
  if (!cycleSet.has(key)) {
    cycleSet.add(key);
    cycles.push(normalized);
  }
}

function fileDfsComponent(
  startNode: string,
  adj: Map<string, string[]>,
  visited: Set<string>,
  maxCycleLen: number,
  cycleSet: Set<string>,
  cycles: string[][],
  maxCycles: number,
): void {
  type Frame = { node: string; neighborIdx: number };

  const inStack = new Set<string>();
  const path: string[] = [];
  const callStack: Frame[] = [{ node: startNode, neighborIdx: 0 }];
  visited.add(startNode);
  inStack.add(startNode);
  path.push(startNode);

  while (callStack.length > 0 && cycles.length < maxCycles) {
    const frame = callStack[callStack.length - 1];
    const neighbors = adj.get(frame.node) || [];

    if (frame.neighborIdx >= neighbors.length) {
      callStack.pop();
      path.pop();
      inStack.delete(frame.node);
      continue;
    }

    const neighbor = neighbors[frame.neighborIdx];
    frame.neighborIdx++;

    if (inStack.has(neighbor)) {
      tryRecordCycle(neighbor, path, maxCycleLen, cycleSet, cycles);
    } else if (!visited.has(neighbor)) {
      visited.add(neighbor);
      inStack.add(neighbor);
      path.push(neighbor);
      callStack.push({ node: neighbor, neighborIdx: 0 });
    }
  }

  for (const node of path) inStack.delete(node);
}

function fileNormalizeCycle(cycle: string[]): string[] {
  let minIdx = 0;
  for (let i = 1; i < cycle.length; i++) {
    if (cycle[i] < cycle[minIdx]) minIdx = i;
  }
  return [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
}

// ---------------------------------------------------------------------------
// Helper — SQLite returns 0/1 for booleans; coerce to boolean
// ---------------------------------------------------------------------------

function toEntityRow(row: Record<string, unknown>): EntityRow {
  return {
    ...(row as unknown as EntityRow),
    is_exported: Boolean(row["is_exported"]),
    is_default_export: Boolean(row["is_default_export"]),
  };
}

// ---------------------------------------------------------------------------
// KgQuery
// ---------------------------------------------------------------------------

export class KgQuery {
  private readonly db: Database.Database;

  // ---- Caller/callee statements ----
  private readonly stmtGetCallers: Database.Statement;
  private readonly stmtGetCallees: Database.Statement;

  // ---- Blast radius statement ----
  // Not pre-prepared — uses a dynamic IN clause for the seed set and a
  // variable maxDepth; built at call time instead.

  // ---- FTS5 search ----
  private readonly stmtSearch: Database.Statement;

  // ---- Dead code ----
  private readonly stmtDeadCode: Database.Statement;
  private readonly stmtDeadCodeIncludeTests: Database.Statement;

  // ---- Ancestry ----
  private readonly stmtGetAncestors: Database.Statement;

  // ---- Adjacency list ----
  private readonly stmtGetAdjacencyList: Database.Statement;

  // ---- File stats ----
  private readonly stmtFileEntityCount: Database.Statement;
  private readonly stmtFileExportCount: Database.Statement;
  private readonly stmtFileDeadCodeCount: Database.Statement;
  private readonly stmtAllFilesWithStats: Database.Statement;

  // ---- File metric statements ----
  private readonly stmtGetFileInDegree: Database.Statement;
  private readonly stmtGetFileOutDegree: Database.Statement;
  private readonly stmtGetAllInDegrees: Database.Statement;
  private readonly stmtGetAllOutDegrees: Database.Statement;
  private readonly stmtGetFileAdjacencyList: Database.Statement;
  private readonly stmtGetFileIdByPath: Database.Statement;
  private readonly stmtGetFileById: Database.Statement;
  private readonly stmtGetKgFreshness: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;

    // ------------------------------------------------------------------
    // Callers: entities that reference entityId via dependency edge types
    // ------------------------------------------------------------------
    this.stmtGetCallers = db.prepare(`
      SELECT ent.entity_id, ent.file_id, ent.name, ent.qualified_name, ent.kind,
             ed.edge_type, ed.confidence
      FROM edges ed
      JOIN entities ent ON ent.entity_id = ed.source_entity_id
      WHERE ed.target_entity_id = ?
        AND ed.edge_type IN ('calls', 'type-references', 'extends', 'implements')
    `);

    // ------------------------------------------------------------------
    // Callees: entities that entityId references via dependency edge types
    // ------------------------------------------------------------------
    this.stmtGetCallees = db.prepare(`
      SELECT ent.entity_id, ent.file_id, ent.name, ent.qualified_name, ent.kind,
             ed.edge_type, ed.confidence
      FROM edges ed
      JOIN entities ent ON ent.entity_id = ed.target_entity_id
      WHERE ed.source_entity_id = ?
        AND ed.edge_type IN ('calls', 'type-references', 'extends', 'implements')
    `);

    // ------------------------------------------------------------------
    // FTS5 search — rank is a special column provided by FTS5 (BM25)
    // snippet() requires the FTS table name and column index.
    // column 0 = name (index 0 in the FTS virtual table)
    // ------------------------------------------------------------------
    this.stmtSearch = db.prepare(`
      SELECT e.entity_id, e.file_id, e.name, e.qualified_name, e.kind,
             fts.rank,
             snippet(entity_fts, 0, '<b>', '</b>', '…', 10) AS snippet
      FROM entity_fts fts
      JOIN entities e ON e.entity_id = fts.rowid
      WHERE entity_fts MATCH ?
      ORDER BY fts.rank
      LIMIT ?
    `);

    // ------------------------------------------------------------------
    // Dead code — unexported, not a file/property, no incoming dep edges
    // Excludes test/spec files by default.
    // ------------------------------------------------------------------
    this.stmtDeadCode = db.prepare(`
      SELECT e.entity_id, e.file_id, e.name, e.qualified_name, e.kind,
             1 AS is_unreferenced
      FROM entities e
      WHERE e.is_exported = 0
        AND e.kind NOT IN ('file', 'property')
        AND NOT EXISTS (
          SELECT 1 FROM edges ed
          WHERE ed.target_entity_id = e.entity_id
            AND ed.edge_type IN ('calls', 'type-references', 'extends', 'implements')
        )
        AND NOT EXISTS (
          SELECT 1 FROM files f
          WHERE f.file_id = e.file_id
            AND (f.path LIKE '%test%' OR f.path LIKE '%spec%')
        )
    `);

    // Same but includes test files
    this.stmtDeadCodeIncludeTests = db.prepare(`
      SELECT e.entity_id, e.file_id, e.name, e.qualified_name, e.kind,
             1 AS is_unreferenced
      FROM entities e
      WHERE e.is_exported = 0
        AND e.kind NOT IN ('file', 'property')
        AND NOT EXISTS (
          SELECT 1 FROM edges ed
          WHERE ed.target_entity_id = e.entity_id
            AND ed.edge_type IN ('calls', 'type-references', 'extends', 'implements')
        )
    `);

    // ------------------------------------------------------------------
    // Ancestors: entities that contain entityId (via 'contains' edges
    // where entityId is the target), joined to get the parent entity row.
    // ------------------------------------------------------------------
    this.stmtGetAncestors = db.prepare(`
      SELECT ent.entity_id, ent.file_id, ent.name, ent.qualified_name,
             ent.kind, ent.line_start, ent.line_end,
             ent.is_exported, ent.is_default_export, ent.signature, ent.metadata
      FROM edges ed
      JOIN entities ent ON ent.entity_id = ed.source_entity_id
      WHERE ed.target_entity_id = ?
        AND ed.edge_type = 'contains'
    `);

    // ------------------------------------------------------------------
    // Adjacency list — all edges for community detection (all types)
    // ------------------------------------------------------------------
    this.stmtGetAdjacencyList = db.prepare(`
      SELECT source_entity_id, target_entity_id FROM edges
    `);

    // ------------------------------------------------------------------
    // File stats helpers
    // ------------------------------------------------------------------
    this.stmtFileEntityCount = db.prepare(`
      SELECT COUNT(*) AS n FROM entities WHERE file_id = ?
    `);

    this.stmtFileExportCount = db.prepare(`
      SELECT COUNT(*) AS n FROM entities WHERE file_id = ? AND is_exported = 1
    `);

    this.stmtFileDeadCodeCount = db.prepare(`
      SELECT COUNT(*) AS n
      FROM entities e
      WHERE e.file_id = ?
        AND e.is_exported = 0
        AND e.kind NOT IN ('file', 'property')
        AND NOT EXISTS (
          SELECT 1 FROM edges ed
          WHERE ed.target_entity_id = e.entity_id
            AND ed.edge_type IN ('calls', 'type-references', 'extends', 'implements')
        )
    `);

    this.stmtAllFilesWithStats = db.prepare(`
      SELECT f.*,
             COUNT(DISTINCT e.entity_id)              AS entity_count,
             SUM(CASE WHEN e.is_exported = 1 THEN 1 ELSE 0 END) AS export_count
      FROM files f
      LEFT JOIN entities e ON e.file_id = f.file_id
      GROUP BY f.file_id
    `);

    // ------------------------------------------------------------------
    // File metric statements
    // ------------------------------------------------------------------
    this.stmtGetFileInDegree = db.prepare(`
      SELECT COUNT(*) AS n FROM file_edges WHERE target_file_id = ?
    `);

    this.stmtGetFileOutDegree = db.prepare(`
      SELECT COUNT(*) AS n FROM file_edges WHERE source_file_id = ?
    `);

    // Aggregate all degrees in two GROUP BY queries (simpler and indexed)
    this.stmtGetAllInDegrees = db.prepare(`
      SELECT target_file_id AS file_id, COUNT(*) AS n FROM file_edges GROUP BY target_file_id
    `);

    this.stmtGetAllOutDegrees = db.prepare(`
      SELECT source_file_id AS file_id, COUNT(*) AS n FROM file_edges GROUP BY source_file_id
    `);

    this.stmtGetFileAdjacencyList = db.prepare(`
      SELECT source_file_id, target_file_id FROM file_edges
    `);

    this.stmtGetFileIdByPath = db.prepare(`
      SELECT file_id, layer FROM files WHERE path = ?
    `);

    this.stmtGetFileById = db.prepare(`
      SELECT file_id, path, layer FROM files WHERE file_id = ?
    `);

    this.stmtGetKgFreshness = db.prepare(`
      SELECT MIN(last_indexed_at) AS min_ts FROM files
    `);
  }

  // --------------------------------------------------------------------------
  // Callers / Callees
  // --------------------------------------------------------------------------

  /**
   * Return all entities that call / reference / extend / implement entityId.
   */
  getCallers(entityId: number): CallerResult[] {
    return this.stmtGetCallers.all(entityId) as CallerResult[];
  }

  /**
   * Return all entities that entityId calls / references / extends / implements.
   */
  getCallees(entityId: number): CallerResult[] {
    return this.stmtGetCallees.all(entityId) as CallerResult[];
  }

  // --------------------------------------------------------------------------
  // Blast Radius (Recursive CTE)
  // --------------------------------------------------------------------------

  /**
   * Return all entities that depend on the given seed entity IDs within
   * `maxDepth` hops following reverse edges (callers/dependents), excluding
   * `contains` edges which represent structural containment rather than
   * functional dependency.
   *
   * Uses a recursive CTE; the seed set is expanded via a VALUES clause so a
   * single prepared statement is not possible — the statement is built and
   * executed inline. SQLite handles recursive CTEs efficiently for typical
   * graph sizes.
   */
  getBlastRadius(entityIds: number[], maxDepth: number = 3): BlastRadiusResult[] {
    if (entityIds.length === 0) return [];

    // Build "SELECT ?, 0 UNION ALL SELECT ?, 0 ..." seed rows
    const seedRows = entityIds.map(() => "SELECT ?, 0").join(" UNION ALL ");

    const sql = `
      WITH RECURSIVE blast(entity_id, depth) AS (
        ${seedRows}
        UNION ALL
        SELECT e.source_entity_id, blast.depth + 1
        FROM blast
        JOIN edges e ON e.target_entity_id = blast.entity_id
        WHERE blast.depth < ?
          AND e.edge_type IN ('calls', 'type-references', 'extends', 'implements', 're-exports')
      )
      SELECT DISTINCT b.entity_id, b.depth,
             ent.file_id, ent.name, ent.qualified_name, ent.kind
      FROM blast b
      JOIN entities ent ON ent.entity_id = b.entity_id
      ORDER BY b.depth
    `;

    const stmt = this.db.prepare(sql);
    const params = [...entityIds, maxDepth];
    return stmt.all(params) as BlastRadiusResult[];
  }

  // --------------------------------------------------------------------------
  // File Blast Radius (Recursive CTE on file_edges)
  // --------------------------------------------------------------------------

  /**
   * Return all files that depend on the given seed file ID within `maxDepth`
   * hops following reverse file edges (files that import/reference the seed).
   *
   * Uses a recursive CTE on `file_edges`; the seed file is excluded from
   * results (depth > 0). When a file is reachable via multiple routes, the
   * shortest path depth is returned.
   */
  getFileBlastRadius(fileId: number, maxDepth: number = 2): FileBlastRadiusResult[] {
    const sql = `
      WITH RECURSIVE blast(file_id, depth) AS (
        SELECT ?, 0
        UNION ALL
        SELECT fe.source_file_id, blast.depth + 1
        FROM blast
        JOIN file_edges fe ON fe.target_file_id = blast.file_id
        WHERE blast.depth < ?
      )
      SELECT DISTINCT b.file_id, MIN(b.depth) as depth,
             f.path, f.layer, f.language
      FROM blast b
      JOIN files f ON f.file_id = b.file_id
      WHERE b.depth > 0
      GROUP BY b.file_id
      ORDER BY b.depth, f.path
    `;

    const stmt = this.db.prepare(sql);
    return stmt.all(fileId, maxDepth) as FileBlastRadiusResult[];
  }

  // --------------------------------------------------------------------------
  // FTS5 Search
  // --------------------------------------------------------------------------

  /**
   * Full-text search over entity names, qualified names, and signatures.
   * Returns up to `limit` results ordered by BM25 rank (lower = better).
   */
  search(query: string, limit: number = 50): SearchResult[] {
    try {
      const rows = this.stmtSearch.all(query, limit) as Array<
        Record<string, unknown> & { is_exported?: number; is_default_export?: number }
      >;
      // SearchResult doesn't include boolean fields from EntityRow, cast directly
      return rows as unknown as SearchResult[];
    } catch (err: unknown) {
      // FTS5 throws on malformed query syntax (bare AND, trailing OR, etc.)
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("fts5") || msg.includes("syntax")) {
        return [];
      }
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // Dead Code Detection
  // --------------------------------------------------------------------------

  /**
   * Find unexported entities with no incoming dependency edges.
   * By default test files are excluded; pass `{ includeTests: true }` to
   * include them.
   */
  findDeadCode(options: { includeTests?: boolean } = {}): DeadCodeResult[] {
    const stmt = options.includeTests ? this.stmtDeadCodeIncludeTests : this.stmtDeadCode;
    const rows = stmt.all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      entity_id: row["entity_id"] as number,
      file_id: row["file_id"] as number,
      name: row["name"] as string,
      qualified_name: row["qualified_name"] as string,
      kind: row["kind"] as DeadCodeResult["kind"],
      is_unreferenced: Boolean(row["is_unreferenced"]),
    }));
  }

  // --------------------------------------------------------------------------
  // Ancestry
  // --------------------------------------------------------------------------

  /**
   * Return entities that contain entityId (i.e. parent scopes — file, class,
   * or function that encloses this entity via 'contains' edges).
   */
  getAncestors(entityId: number): EntityRow[] {
    const rows = this.stmtGetAncestors.all(entityId) as Record<string, unknown>[];
    return rows.map(toEntityRow);
  }

  // --------------------------------------------------------------------------
  // Adjacency List (Community Detection Prep)
  // --------------------------------------------------------------------------

  /**
   * Export the full edge set as an adjacency list for external community
   * detection algorithms (e.g. Louvain, connected-components).
   */
  getAdjacencyList(): Map<number, number[]> {
    const rows = this.stmtGetAdjacencyList.all() as Array<{
      source_entity_id: number;
      target_entity_id: number;
    }>;
    const map = new Map<number, number[]>();
    for (const { source_entity_id, target_entity_id } of rows) {
      let neighbors = map.get(source_entity_id);
      if (!neighbors) {
        neighbors = [];
        map.set(source_entity_id, neighbors);
      }
      neighbors.push(target_entity_id);
    }
    return map;
  }

  // --------------------------------------------------------------------------
  // File Stats
  // --------------------------------------------------------------------------

  /**
   * Return entity count, export count, and dead-code count for a single file.
   */
  getFileStats(fileId: number): {
    entityCount: number;
    exportCount: number;
    deadCodeCount: number;
  } {
    const entityCount = (this.stmtFileEntityCount.get(fileId) as { n: number }).n;
    const exportCount = (this.stmtFileExportCount.get(fileId) as { n: number }).n;
    const deadCodeCount = (this.stmtFileDeadCodeCount.get(fileId) as { n: number }).n;
    return { entityCount, exportCount, deadCodeCount };
  }

  /**
   * Return all files with their aggregate entity and export counts.
   */
  getAllFilesWithStats(): Array<FileRow & { entity_count: number; export_count: number }> {
    return this.stmtAllFilesWithStats.all() as Array<FileRow & { entity_count: number; export_count: number }>;
  }

  // --------------------------------------------------------------------------
  // File Metric Methods
  // --------------------------------------------------------------------------

  /**
   * Return in-degree and out-degree for a single file by file_id.
   * Two indexed COUNT queries — efficient at all typical project sizes.
   */
  getFileDegrees(fileId: number): { in_degree: number; out_degree: number } {
    const in_degree = (this.stmtGetFileInDegree.get(fileId) as { n: number }).n;
    const out_degree = (this.stmtGetFileOutDegree.get(fileId) as { n: number }).n;
    return { in_degree, out_degree };
  }

  /**
   * Return a Map from file_id to { in_degree, out_degree } for all files
   * that appear in file_edges.  Two GROUP BY queries merged into one Map —
   * avoids N queries when iterating over all files.
   */
  getAllFileDegrees(): Map<number, { in_degree: number; out_degree: number }> {
    const inRows = this.stmtGetAllInDegrees.all() as Array<{ file_id: number; n: number }>;
    const outRows = this.stmtGetAllOutDegrees.all() as Array<{ file_id: number; n: number }>;

    const map = new Map<number, { in_degree: number; out_degree: number }>();

    for (const row of inRows) {
      map.set(row.file_id, { in_degree: row.n, out_degree: 0 });
    }
    for (const row of outRows) {
      const existing = map.get(row.file_id);
      if (existing) {
        existing.out_degree = row.n;
      } else {
        map.set(row.file_id, { in_degree: 0, out_degree: row.n });
      }
    }

    return map;
  }

  /**
   * Return the full file adjacency list as a Map from source_file_id to
   * target_file_id[].  Mirrors getAdjacencyList() but operates on file_edges.
   */
  getFileAdjacencyList(): Map<number, number[]> {
    const rows = this.stmtGetFileAdjacencyList.all() as Array<{
      source_file_id: number;
      target_file_id: number;
    }>;
    const map = new Map<number, number[]>();
    for (const { source_file_id, target_file_id } of rows) {
      let neighbors = map.get(source_file_id);
      if (!neighbors) {
        neighbors = [];
        map.set(source_file_id, neighbors);
      }
      neighbors.push(target_file_id);
    }
    return map;
  }

  /**
   * Return full FileMetrics for a file identified by its path.
   * Returns null when the file does not exist in the DB.
   *
   * Hub/cycle/violation data must be precomputed and passed via options —
   * call computeFileInsightMaps() once per request and reuse the result.
   */
  getFileMetrics(
    filePath: string,
    options?: {
      changedFiles?: Set<string>;
      hubPaths?: Set<string>;
      cycleMemberPaths?: Map<string, string[]>;
      layerViolationsByPath?: Map<string, LayerViolation[]>;
    },
  ): FileMetrics | null {
    const fileRow = this.stmtGetFileIdByPath.get(filePath) as { file_id: number; layer: string } | undefined;
    if (!fileRow) return null;

    const { in_degree, out_degree } = this.getFileDegrees(fileRow.file_id);

    const isChanged = options?.changedFiles?.has(filePath) ?? false;
    const is_hub = options?.hubPaths?.has(filePath) ?? false;
    const in_cycle = options?.cycleMemberPaths?.has(filePath) ?? false;
    const cycle_peers = options?.cycleMemberPaths?.get(filePath) ?? [];
    const layer_violations = options?.layerViolationsByPath?.get(filePath) ?? [];
    const layer = fileRow.layer || "unknown";

    const impact_score = computeImpactScore(in_degree, layer_violations.length, isChanged, layer);

    return {
      in_degree,
      out_degree,
      is_hub,
      in_cycle,
      cycle_peers,
      layer,
      layer_violation_count: layer_violations.length,
      layer_violations,
      impact_score,
    };
  }

  /**
   * Return the age of the oldest indexed file in milliseconds, measured from
   * now.  Returns null when the files table is empty (DB not indexed).
   *
   * Uses MIN(last_indexed_at) because the KG is only as fresh as its oldest
   * entry — stale files drag down the entire graph's freshness guarantee.
   */
  getKgFreshnessMs(): number | null {
    const row = this.stmtGetKgFreshness.get() as { min_ts: number | string | null } | undefined;
    if (!row || row.min_ts === null) return null;

    let epochMs: number;
    if (typeof row.min_ts === "number") {
      // Stored as numeric epoch ms
      epochMs = row.min_ts;
    } else if (typeof row.min_ts === "string") {
      const asNumber = Number(row.min_ts);
      if (!Number.isNaN(asNumber) && row.min_ts.trim() !== "") {
        // Numeric string (e.g. "1712345678000")
        epochMs = asNumber;
      } else {
        // ISO string (e.g. "2024-04-05T12:34:56.000Z")
        epochMs = Date.parse(row.min_ts);
        if (Number.isNaN(epochMs)) return null;
      }
    } else {
      return null;
    }

    return Date.now() - epochMs;
  }

  /**
   * Return a subgraph containing all files directly connected to the given
   * seed paths, plus the file_edges between them.  Useful for rendering
   * focused dependency views without loading the full graph.
   *
   * A file is included if at least one of its file_edges connects it to a
   * seed file (either as source or target).
   */
  getSubgraph(filePaths: string[]): {
    nodes: Array<{ path: string; layer: string; file_id: number }>;
    edges: Array<{ source: string; target: string }>;
  } {
    if (filePaths.length === 0) return { nodes: [], edges: [] };

    // Resolve seed paths to file_ids — keep path alongside each resolved row
    const seedEntries: Array<{ path: string; file_id: number; layer: string }> = [];
    for (const p of filePaths) {
      const row = this.stmtGetFileIdByPath.get(p) as { file_id: number; layer: string } | undefined;
      if (row) {
        seedEntries.push({ path: p, file_id: row.file_id, layer: row.layer });
      }
    }

    if (seedEntries.length === 0) return { nodes: [], edges: [] };

    // Build a dynamic IN clause for the seed file_ids
    const seedIds = seedEntries.map((e) => e.file_id);
    const placeholders = seedIds.map(() => "?").join(", ");

    // Load all edges where source or target is in the seed set
    const edgeRows = this.db
      .prepare(
        `SELECT fe.source_file_id, fe.target_file_id,
                fs.path AS source_path, ft.path AS target_path,
                fs.layer AS source_layer, ft.layer AS target_layer,
                fs.file_id AS source_fid, ft.file_id AS target_fid
         FROM file_edges fe
         JOIN files fs ON fs.file_id = fe.source_file_id
         JOIN files ft ON ft.file_id = fe.target_file_id
         WHERE fe.source_file_id IN (${placeholders})
            OR fe.target_file_id IN (${placeholders})`,
      )
      .all([...seedIds, ...seedIds]) as Array<{
      source_file_id: number;
      target_file_id: number;
      source_path: string;
      target_path: string;
      source_layer: string;
      target_layer: string;
      source_fid: number;
      target_fid: number;
    }>;

    // Collect unique nodes and edges
    const nodeMap = new Map<number, { path: string; layer: string; file_id: number }>();
    const edges: Array<{ source: string; target: string }> = [];

    for (const row of edgeRows) {
      nodeMap.set(row.source_fid, {
        path: row.source_path,
        layer: row.source_layer,
        file_id: row.source_fid,
      });
      nodeMap.set(row.target_fid, {
        path: row.target_path,
        layer: row.target_layer,
        file_id: row.target_fid,
      });
      edges.push({ source: row.source_path, target: row.target_path });
    }

    // Also include seed files that have no edges (isolated in this subgraph)
    for (const entry of seedEntries) {
      if (!nodeMap.has(entry.file_id)) {
        nodeMap.set(entry.file_id, {
          path: entry.path,
          layer: entry.layer,
          file_id: entry.file_id,
        });
      }
    }

    return {
      nodes: [...nodeMap.values()],
      edges,
    };
  }
}
