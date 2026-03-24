/**
 * Knowledge Graph CRUD Store
 *
 * Wraps a better-sqlite3 Database instance with typed CRUD operations.
 * All statements are prepared once at construction time and reused for
 * performance. The API is fully synchronous (better-sqlite3 is sync).
 */

import Database from 'better-sqlite3';
import type { FileRow, EntityRow, EdgeRow, FileEdgeRow } from './kg-types.js';

// ---------------------------------------------------------------------------
// Helper — SQLite returns 0/1 for booleans; coerce to boolean
// ---------------------------------------------------------------------------

function toEntityRow(row: Record<string, unknown>): EntityRow {
  const base = row as unknown as EntityRow;
  return {
    ...base,
    is_exported: Boolean(row['is_exported']),
    is_default_export: Boolean(row['is_default_export']),
  };
}

// ---------------------------------------------------------------------------
// KgStore
// ---------------------------------------------------------------------------

export class KgStore {
  private readonly db: Database.Database;

  // ---- File statements ----
  private readonly stmtUpsertFile: Database.Statement;
  private readonly stmtGetFile: Database.Statement;
  private readonly stmtGetFileById: Database.Statement;
  private readonly stmtDeleteFile: Database.Statement;

  // ---- Entity statements ----
  private readonly stmtInsertEntity: Database.Statement;
  private readonly stmtGetEntitiesByFile: Database.Statement;
  private readonly stmtGetEntityByQualifiedName: Database.Statement;
  private readonly stmtFindExportedByName: Database.Statement;
  private readonly stmtDeleteEntitiesByFile: Database.Statement;

  // ---- Edge statements ----
  private readonly stmtInsertEdge: Database.Statement;
  private readonly stmtGetEdgesFrom: Database.Statement;
  private readonly stmtGetEdgesTo: Database.Statement;
  private readonly stmtDeleteEdgesByEntity: Database.Statement;

  // ---- File edge statements ----
  private readonly stmtInsertFileEdge: Database.Statement;
  private readonly stmtGetFileEdgesFrom: Database.Statement;
  private readonly stmtGetFileEdgesTo: Database.Statement;
  private readonly stmtDeleteFileEdgesByFile: Database.Statement;

  // ---- Stats statements ----
  private readonly stmtCountFiles: Database.Statement;
  private readonly stmtCountEntities: Database.Statement;
  private readonly stmtCountEdges: Database.Statement;
  private readonly stmtCountFileEdges: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;

    // Files
    this.stmtUpsertFile = db.prepare(`
      INSERT INTO files (path, mtime_ms, content_hash, language, layer, last_indexed_at)
      VALUES (@path, @mtime_ms, @content_hash, @language, @layer, @last_indexed_at)
      ON CONFLICT(path) DO UPDATE SET
        mtime_ms        = excluded.mtime_ms,
        content_hash    = excluded.content_hash,
        language        = excluded.language,
        layer           = excluded.layer,
        last_indexed_at = excluded.last_indexed_at
      RETURNING *
    `);

    this.stmtGetFile = db.prepare(`
      SELECT * FROM files WHERE path = ?
    `);

    this.stmtGetFileById = db.prepare(`
      SELECT * FROM files WHERE file_id = ?
    `);

    this.stmtDeleteFile = db.prepare(`
      DELETE FROM files WHERE path = ?
    `);

    // Entities
    this.stmtInsertEntity = db.prepare(`
      INSERT OR IGNORE INTO entities
        (file_id, name, qualified_name, kind, line_start, line_end,
         is_exported, is_default_export, signature, metadata)
      VALUES
        (@file_id, @name, @qualified_name, @kind, @line_start, @line_end,
         @is_exported, @is_default_export, @signature, @metadata)
      RETURNING *
    `);

    this.stmtGetEntitiesByFile = db.prepare(`
      SELECT * FROM entities WHERE file_id = ?
    `);

    this.stmtGetEntityByQualifiedName = db.prepare(`
      SELECT * FROM entities WHERE file_id = ? AND qualified_name = ?
    `);

    this.stmtFindExportedByName = db.prepare(`
      SELECT * FROM entities WHERE name = ? AND is_exported = 1
    `);

    this.stmtDeleteEntitiesByFile = db.prepare(`
      DELETE FROM entities WHERE file_id = ?
    `);

    // Edges
    this.stmtInsertEdge = db.prepare(`
      INSERT OR IGNORE INTO edges
        (source_entity_id, target_entity_id, edge_type, confidence, metadata)
      VALUES
        (@source_entity_id, @target_entity_id, @edge_type, @confidence, @metadata)
      RETURNING *
    `);

    this.stmtGetEdgesFrom = db.prepare(`
      SELECT * FROM edges WHERE source_entity_id = ?
    `);

    this.stmtGetEdgesTo = db.prepare(`
      SELECT * FROM edges WHERE target_entity_id = ?
    `);

    this.stmtDeleteEdgesByEntity = db.prepare(`
      DELETE FROM edges
      WHERE source_entity_id = ? OR target_entity_id = ?
    `);

    // File edges
    this.stmtInsertFileEdge = db.prepare(`
      INSERT OR IGNORE INTO file_edges
        (source_file_id, target_file_id, edge_type, confidence, evidence, relation)
      VALUES
        (@source_file_id, @target_file_id, @edge_type, @confidence, @evidence, @relation)
      RETURNING *
    `);

    this.stmtGetFileEdgesFrom = db.prepare(`
      SELECT * FROM file_edges WHERE source_file_id = ?
    `);

    this.stmtGetFileEdgesTo = db.prepare(`
      SELECT * FROM file_edges WHERE target_file_id = ?
    `);

    this.stmtDeleteFileEdgesByFile = db.prepare(`
      DELETE FROM file_edges
      WHERE source_file_id = ? OR target_file_id = ?
    `);

    // Stats
    this.stmtCountFiles = db.prepare(`SELECT COUNT(*) AS n FROM files`);
    this.stmtCountEntities = db.prepare(`SELECT COUNT(*) AS n FROM entities`);
    this.stmtCountEdges = db.prepare(`SELECT COUNT(*) AS n FROM edges`);
    this.stmtCountFileEdges = db.prepare(`SELECT COUNT(*) AS n FROM file_edges`);
  }

  // --------------------------------------------------------------------------
  // Files
  // --------------------------------------------------------------------------

  upsertFile(file: Omit<FileRow, 'file_id'>): FileRow {
    const row = this.stmtUpsertFile.get(file) as FileRow;
    return row;
  }

  getFile(path: string): FileRow | undefined {
    return this.stmtGetFile.get(path) as FileRow | undefined;
  }

  getFileById(fileId: number): FileRow | undefined {
    return this.stmtGetFileById.get(fileId) as FileRow | undefined;
  }

  deleteFile(path: string): void {
    this.stmtDeleteFile.run(path);
  }

  // --------------------------------------------------------------------------
  // Entities
  // --------------------------------------------------------------------------

  insertEntity(entity: Omit<EntityRow, 'entity_id'>): EntityRow {
    const params = {
      ...entity,
      // SQLite stores booleans as 0/1
      is_exported: entity.is_exported ? 1 : 0,
      is_default_export: entity.is_default_export ? 1 : 0,
    };
    const row = this.stmtInsertEntity.get(params) as Record<string, unknown> | undefined;
    if (row !== undefined) {
      return toEntityRow(row);
    }
    // INSERT OR IGNORE fired a conflict — RETURNING * emits no rows. Fall back to
    // fetching the existing row by qualified_name so callers always get a valid EntityRow.
    const existing = this.getEntityByQualifiedName(entity.file_id, entity.qualified_name);
    if (existing === undefined) {
      throw new Error(
        `insertEntity: conflict on (file_id=${entity.file_id}, qualified_name=${entity.qualified_name}) but existing row not found`,
      );
    }
    return existing;
  }

  getEntitiesByFile(fileId: number): EntityRow[] {
    const rows = this.stmtGetEntitiesByFile.all(fileId) as Record<string, unknown>[];
    return rows.map(toEntityRow);
  }

  getEntityByQualifiedName(fileId: number, qualifiedName: string): EntityRow | undefined {
    const row = this.stmtGetEntityByQualifiedName.get(fileId, qualifiedName) as
      | Record<string, unknown>
      | undefined;
    return row ? toEntityRow(row) : undefined;
  }

  findExportedByName(name: string): EntityRow[] {
    const rows = this.stmtFindExportedByName.all(name) as Record<string, unknown>[];
    return rows.map(toEntityRow);
  }

  deleteEntitiesByFile(fileId: number): void {
    this.stmtDeleteEntitiesByFile.run(fileId);
  }

  // --------------------------------------------------------------------------
  // Edges (entity-level)
  // --------------------------------------------------------------------------

  insertEdge(edge: Omit<EdgeRow, 'edge_id'>): EdgeRow {
    const row = this.stmtInsertEdge.get(edge) as EdgeRow;
    return row;
  }

  getEdgesFrom(entityId: number): EdgeRow[] {
    return this.stmtGetEdgesFrom.all(entityId) as EdgeRow[];
  }

  getEdgesTo(entityId: number): EdgeRow[] {
    return this.stmtGetEdgesTo.all(entityId) as EdgeRow[];
  }

  deleteEdgesByEntity(entityId: number): void {
    this.stmtDeleteEdgesByEntity.run(entityId, entityId);
  }

  // --------------------------------------------------------------------------
  // File edges
  // --------------------------------------------------------------------------

  insertFileEdge(edge: Omit<FileEdgeRow, 'file_edge_id'>): FileEdgeRow {
    const row = this.stmtInsertFileEdge.get(edge) as FileEdgeRow;
    return row;
  }

  getFileEdgesFrom(fileId: number): FileEdgeRow[] {
    return this.stmtGetFileEdgesFrom.all(fileId) as FileEdgeRow[];
  }

  getFileEdgesTo(fileId: number): FileEdgeRow[] {
    return this.stmtGetFileEdgesTo.all(fileId) as FileEdgeRow[];
  }

  deleteFileEdgesByFile(fileId: number): void {
    this.stmtDeleteFileEdgesByFile.run(fileId, fileId);
  }

  // --------------------------------------------------------------------------
  // Bulk operations
  // --------------------------------------------------------------------------

  /**
   * Delete a file and all its dependents (entities, edges, file_edges).
   * ON DELETE CASCADE in the schema handles cascading deletes automatically.
   */
  deleteFileAndDependents(path: string): void {
    this.deleteFile(path);
  }

  /**
   * Wrap a function in a SQLite transaction.
   * Commits on success, rolls back on throw.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // --------------------------------------------------------------------------
  // Stats
  // --------------------------------------------------------------------------

  getStats(): { files: number; entities: number; edges: number; fileEdges: number } {
    const files = (this.stmtCountFiles.get() as { n: number }).n;
    const entities = (this.stmtCountEntities.get() as { n: number }).n;
    const edges = (this.stmtCountEdges.get() as { n: number }).n;
    const fileEdges = (this.stmtCountFileEdges.get() as { n: number }).n;
    return { files, entities, edges, fileEdges };
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  close(): void {
    this.db.close();
  }
}
