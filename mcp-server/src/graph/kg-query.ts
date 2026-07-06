/**
 * Knowledge Graph Read-Only Query Module
 *
 * Wraps a better-sqlite3 Database instance with complex read-only queries.
 * All statements are prepared once at construction time and reused for
 * performance. All operations are purely SELECT — no mutations here.
 */

import type Database from "better-sqlite3";
import { computeImpactScore } from "./kg-query-insights.ts";
import type {
  BlastRadiusResult,
  CallerResult,
  DeadCodeResult,
  FileBlastRadiusResult,
  FileMetrics,
  FileRow,
  FileTagRow,
  LayerViolation,
  SearchResult,
} from "./kg-types.ts";

// KgQuery

export class KgQuery {
  private readonly db: Database.Database;

  private readonly stmtGetCallers: Database.Statement;
  private readonly stmtGetCallees: Database.Statement;
  private readonly stmtSearch: Database.Statement;
  private stmtDeadCode!: Database.Statement;
  private stmtDeadCodeIncludeTests!: Database.Statement;
  private readonly stmtGetAdjacencyList: Database.Statement;
  private stmtFileEntityCount!: Database.Statement;
  private stmtFileExportCount!: Database.Statement;
  private stmtFileDeadCodeCount!: Database.Statement;
  private stmtAllFilesWithStats!: Database.Statement;
  private stmtGetFileInDegree!: Database.Statement;
  private stmtGetFileOutDegree!: Database.Statement;
  private stmtGetAllInDegrees!: Database.Statement;
  private stmtGetAllOutDegrees!: Database.Statement;
  private readonly stmtGetFileAdjacencyList: Database.Statement;
  private readonly stmtGetFileIdByPath: Database.Statement;
  private readonly stmtGetKgFreshness: Database.Statement;
  private readonly stmtGetFileTagsByPath: Database.Statement;
  private readonly stmtGetFileTagsByFileId: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.stmtGetCallers = db.prepare(`
      SELECT ent.entity_id, ent.file_id, ent.name, ent.qualified_name, ent.kind,
             ed.edge_type, ed.confidence
      FROM edges ed
      JOIN entities ent ON ent.entity_id = ed.source_entity_id
      WHERE ed.target_entity_id = ?
        AND ed.edge_type IN ('calls', 'type-references', 'extends', 'implements')
    `);
    this.stmtGetCallees = db.prepare(`
      SELECT ent.entity_id, ent.file_id, ent.name, ent.qualified_name, ent.kind,
             ed.edge_type, ed.confidence
      FROM edges ed
      JOIN entities ent ON ent.entity_id = ed.target_entity_id
      WHERE ed.source_entity_id = ?
        AND ed.edge_type IN ('calls', 'type-references', 'extends', 'implements')
    `);
    this.stmtSearch = db.prepare(`
      SELECT e.entity_id, e.file_id, e.name, e.qualified_name, e.kind,
             fts.rank,
             snippet(entity_fts, 0, '<b>', '</b>', '...', 10) AS snippet
      FROM entity_fts fts
      JOIN entities e ON e.entity_id = fts.rowid
      WHERE entity_fts MATCH ?
      ORDER BY fts.rank
      LIMIT ?
    `);
    this.stmtGetAdjacencyList = db.prepare(`SELECT source_entity_id, target_entity_id FROM edges`);
    // Pinned to edge_type='imports': adjacency list is used for cycle detection
    // and community assignment — doc:references edges must not contaminate these.
    this.stmtGetFileAdjacencyList = db.prepare(
      `SELECT source_file_id, target_file_id FROM file_edges WHERE edge_type = 'imports'`,
    );
    this.stmtGetFileIdByPath = db.prepare(`SELECT file_id, layer FROM files WHERE path = ?`);
    this.stmtGetKgFreshness = db.prepare(`SELECT MIN(last_indexed_at) AS min_ts FROM files`);
    this.stmtGetFileTagsByPath = db.prepare(`
      SELECT ft.* FROM file_tags ft
      JOIN files f ON f.file_id = ft.file_id
      WHERE f.path = ?
    `);
    this.stmtGetFileTagsByFileId = db.prepare(`SELECT * FROM file_tags WHERE file_id = ?`);
    this.prepareDeadCodeStatements(db);
    this.prepareFileStatStatements(db);
    this.prepareFileDegreeStatements(db);
  }

  private prepareDeadCodeStatements(db: Database.Database): void {
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
  }

  private prepareFileStatStatements(db: Database.Database): void {
    this.stmtFileEntityCount = db.prepare(`SELECT COUNT(*) AS n FROM entities WHERE file_id = ?`);
    this.stmtFileExportCount = db.prepare(
      `SELECT COUNT(*) AS n FROM entities WHERE file_id = ? AND is_exported = 1`,
    );
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
             COUNT(DISTINCT e.entity_id) AS entity_count,
             SUM(CASE WHEN e.is_exported = 1 THEN 1 ELSE 0 END) AS export_count
      FROM files f
      LEFT JOIN entities e ON e.file_id = f.file_id
      GROUP BY f.file_id
    `);
  }

  private prepareFileDegreeStatements(db: Database.Database): void {
    // Pinned to edge_type='imports': doc:references edges must not inflate
    // in_degree/out_degree/hub/impact metrics. Only structural import edges count.
    // getFileBlastRadius CTE (~line 244) and getSubgraph (~line 549) are left
    // UNFILTERED so a doc citing a file appears in that file's blast radius
    // (the freshness signal this build exists to create).
    this.stmtGetFileInDegree = db.prepare(
      `SELECT COUNT(*) AS n FROM file_edges WHERE target_file_id = ? AND edge_type = 'imports'`,
    );
    this.stmtGetFileOutDegree = db.prepare(
      `SELECT COUNT(*) AS n FROM file_edges WHERE source_file_id = ? AND edge_type = 'imports'`,
    );
    this.stmtGetAllInDegrees = db.prepare(
      `SELECT target_file_id AS file_id, COUNT(*) AS n FROM file_edges WHERE edge_type = 'imports' GROUP BY target_file_id`,
    );
    this.stmtGetAllOutDegrees = db.prepare(
      `SELECT source_file_id AS file_id, COUNT(*) AS n FROM file_edges WHERE edge_type = 'imports' GROUP BY source_file_id`,
    );
  }

  // Callers / Callees

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

  // Blast Radius (Recursive CTE)

  /**
   * Return all entities that depend on the given seed entity IDs within
   * `maxDepth` hops following reverse edges (callers/dependents).
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

  // File Blast Radius (Recursive CTE on file_edges)

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

  // FTS5 Search

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

  // Dead Code Detection

  /**
   * Find unexported entities with no incoming dependency edges.
   * By default test files are excluded; pass `{ includeTests: true }` to
   * include them.
   */
  findDeadCode(options: { includeTests?: boolean } = {}): DeadCodeResult[] {
    const stmt = options.includeTests ? this.stmtDeadCodeIncludeTests : this.stmtDeadCode;
    const rows = stmt.all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      entity_id: row.entity_id as number,
      file_id: row.file_id as number,
      is_unreferenced: Boolean(row.is_unreferenced),
      kind: row.kind as DeadCodeResult["kind"],
      name: row.name as string,
      qualified_name: row.qualified_name as string,
    }));
  }

  // Adjacency List (Community Detection Prep)

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

  // File Stats

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
    return { deadCodeCount, entityCount, exportCount };
  }

  /**
   * Return all files with their aggregate entity and export counts.
   */
  getAllFilesWithStats(): Array<FileRow & { entity_count: number; export_count: number }> {
    return this.stmtAllFilesWithStats.all() as Array<
      FileRow & { entity_count: number; export_count: number }
    >;
  }

  // File Metric Methods

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
    const fileRow = this.stmtGetFileIdByPath.get(filePath) as
      | { file_id: number; layer: string }
      | undefined;
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
      cycle_peers,
      impact_score,
      in_cycle,
      in_degree,
      is_hub,
      layer,
      layer_violation_count: layer_violations.length,
      layer_violations,
      out_degree,
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

  // File Tag Queries

  /**
   * Return all tags for the file identified by its path.
   * Returns an empty array when the file does not exist or has no tags.
   */
  getFileTagsByPath(path: string): FileTagRow[] {
    return this.stmtGetFileTagsByPath.all(path) as FileTagRow[];
  }

  /**
   * Return all tags for the given file_id.
   * Returns an empty array when the file has no tags or does not exist.
   */
  getFileTagsByFileId(fileId: number): FileTagRow[] {
    return this.stmtGetFileTagsByFileId.all(fileId) as FileTagRow[];
  }

  /**
   * Return tags for multiple file_ids in a single query, grouped by file_id.
   */
  getFileTagsByFileIds(fileIds: number[]): Map<number, FileTagRow[]> {
    const result = new Map<number, FileTagRow[]>();
    if (fileIds.length === 0) return result;
    const placeholders = fileIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM file_tags WHERE file_id IN (${placeholders})`)
      .all(...fileIds) as FileTagRow[];
    for (const row of rows) {
      const arr = result.get(row.file_id);
      if (arr) arr.push(row);
      else result.set(row.file_id, [row]);
    }
    return result;
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
    if (filePaths.length === 0) return { edges: [], nodes: [] };

    // Resolve seed paths to file_ids — keep path alongside each resolved row
    const seedEntries: Array<{ path: string; file_id: number; layer: string }> = [];
    for (const p of filePaths) {
      const row = this.stmtGetFileIdByPath.get(p) as { file_id: number; layer: string } | undefined;
      if (row) {
        seedEntries.push({ file_id: row.file_id, layer: row.layer, path: p });
      }
    }

    if (seedEntries.length === 0) return { edges: [], nodes: [] };

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
        file_id: row.source_fid,
        layer: row.source_layer,
        path: row.source_path,
      });
      nodeMap.set(row.target_fid, {
        file_id: row.target_fid,
        layer: row.target_layer,
        path: row.target_path,
      });
      edges.push({ source: row.source_path, target: row.target_path });
    }

    // Also include seed files that have no edges (isolated in this subgraph)
    for (const entry of seedEntries) {
      if (!nodeMap.has(entry.file_id)) {
        nodeMap.set(entry.file_id, {
          file_id: entry.file_id,
          layer: entry.layer,
          path: entry.path,
        });
      }
    }

    return {
      edges,
      nodes: [...nodeMap.values()],
    };
  }
}
