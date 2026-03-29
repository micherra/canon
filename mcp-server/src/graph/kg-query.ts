/**
 * Knowledge Graph Read-Only Query Module
 *
 * Wraps a better-sqlite3 Database instance with complex read-only queries.
 * All statements are prepared once at construction time and reused for
 * performance. All operations are purely SELECT — no mutations here.
 */

import Database from 'better-sqlite3';
import type {
  EntityRow,
  CallerResult,
  BlastRadiusResult,
  FileBlastRadiusResult,
  SearchResult,
  DeadCodeResult,
  FileRow,
} from './kg-types.ts';

// ---------------------------------------------------------------------------
// Helper — SQLite returns 0/1 for booleans; coerce to boolean
// ---------------------------------------------------------------------------

function toEntityRow(row: Record<string, unknown>): EntityRow {
  return {
    ...(row as unknown as EntityRow),
    is_exported: Boolean(row['is_exported']),
    is_default_export: Boolean(row['is_default_export']),
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
    const seedRows = entityIds.map(() => 'SELECT ?, 0').join(' UNION ALL ');

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
      if (msg.includes('fts5') || msg.includes('syntax')) {
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
      entity_id: row['entity_id'] as number,
      file_id: row['file_id'] as number,
      name: row['name'] as string,
      qualified_name: row['qualified_name'] as string,
      kind: row['kind'] as DeadCodeResult['kind'],
      is_unreferenced: Boolean(row['is_unreferenced']),
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
    return this.stmtAllFilesWithStats.all() as Array<
      FileRow & { entity_count: number; export_count: number }
    >;
  }
}
