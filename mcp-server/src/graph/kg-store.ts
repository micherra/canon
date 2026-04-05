/**
 * Knowledge Graph CRUD Store
 *
 * Wraps a better-sqlite3 Database instance with typed CRUD operations.
 * All statements are prepared once at construction time and reused for
 * performance. The API is fully synchronous (better-sqlite3 is sync).
 */

import type Database from "better-sqlite3";
import type { EdgeRow, EntityRow, FileEdgeRow, FileRow, SummaryRow } from "./kg-types.ts";

// Helper — SQLite returns 0/1 for booleans; coerce to boolean

function toEntityRow(row: Record<string, unknown>): EntityRow {
  const base = row as unknown as EntityRow;
  return {
    ...base,
    is_default_export: Boolean(row.is_default_export),
    is_exported: Boolean(row.is_exported),
  };
}

// KgStore

export class KgStore {
  private readonly db: Database.Database;

  // ---- File statements ----
  private stmtUpsertFile!: Database.Statement;
  private stmtGetFile!: Database.Statement;
  private stmtGetFileById!: Database.Statement;
  private stmtDeleteFile!: Database.Statement;

  // ---- Entity statements ----
  private stmtInsertEntity!: Database.Statement;
  private stmtGetEntitiesByFile!: Database.Statement;
  private stmtGetEntityByQualifiedName!: Database.Statement;
  private stmtFindExportedByName!: Database.Statement;
  private stmtDeleteEntitiesByFile!: Database.Statement;

  // ---- Edge statements ----
  private stmtInsertEdge!: Database.Statement;
  private stmtGetEdgesFrom!: Database.Statement;
  private stmtGetEdgesTo!: Database.Statement;
  private stmtDeleteEdgesByEntity!: Database.Statement;

  // ---- File edge statements ----
  private stmtInsertFileEdge!: Database.Statement;
  private stmtGetFileEdgesFrom!: Database.Statement;
  private stmtGetFileEdgesTo!: Database.Statement;
  private stmtDeleteFileEdgesByFile!: Database.Statement;

  // ---- Summary statements ----
  private stmtUpsertSummary!: Database.Statement;
  private stmtDeleteExistingNullEntitySummary!: Database.Statement;
  private stmtInsertSummaryReturning!: Database.Statement;
  private stmtGetSummaryByFile!: Database.Statement;
  private stmtDeleteSummariesByFile!: Database.Statement;
  private stmtGetStaleSummaries!: Database.Statement;

  // ---- Stats statements ----
  private stmtCountFiles!: Database.Statement;
  private stmtCountEntities!: Database.Statement;
  private stmtCountEdges!: Database.Statement;
  private stmtCountFileEdges!: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.prepareFileStatements(db);
    this.prepareEntityStatements(db);
    this.prepareEdgeStatements(db);
    this.prepareFileEdgeStatements(db);
    this.prepareSummaryStatements(db);
    this.stmtCountFiles = db.prepare(`SELECT COUNT(*) AS n FROM files`);
    this.stmtCountEntities = db.prepare(`SELECT COUNT(*) AS n FROM entities`);
    this.stmtCountEdges = db.prepare(`SELECT COUNT(*) AS n FROM edges`);
    this.stmtCountFileEdges = db.prepare(`SELECT COUNT(*) AS n FROM file_edges`);
  }

  private prepareFileStatements(db: Database.Database): void {
    this.stmtUpsertFile = db.prepare(`
      INSERT INTO files (path, mtime_ms, content_hash, language, layer, last_indexed_at)
      VALUES (@path, @mtime_ms, @content_hash, @language, @layer, @last_indexed_at)
      ON CONFLICT(path) DO UPDATE SET
        mtime_ms = excluded.mtime_ms, content_hash = excluded.content_hash,
        language = excluded.language, layer = excluded.layer,
        last_indexed_at = excluded.last_indexed_at
      RETURNING *
    `);
    this.stmtGetFile = db.prepare(`SELECT * FROM files WHERE path = ?`);
    this.stmtGetFileById = db.prepare(`SELECT * FROM files WHERE file_id = ?`);
    this.stmtDeleteFile = db.prepare(`DELETE FROM files WHERE path = ?`);
  }

  private prepareEntityStatements(db: Database.Database): void {
    this.stmtInsertEntity = db.prepare(`
      INSERT OR IGNORE INTO entities
        (file_id, name, qualified_name, kind, line_start, line_end,
         is_exported, is_default_export, signature, metadata)
      VALUES
        (@file_id, @name, @qualified_name, @kind, @line_start, @line_end,
         @is_exported, @is_default_export, @signature, @metadata)
      RETURNING *
    `);
    this.stmtGetEntitiesByFile = db.prepare(`SELECT * FROM entities WHERE file_id = ?`);
    this.stmtGetEntityByQualifiedName = db.prepare(
      `SELECT * FROM entities WHERE file_id = ? AND qualified_name = ?`,
    );
    this.stmtFindExportedByName = db.prepare(
      `SELECT * FROM entities WHERE name = ? AND is_exported = 1`,
    );
    this.stmtDeleteEntitiesByFile = db.prepare(`DELETE FROM entities WHERE file_id = ?`);
  }

  private prepareEdgeStatements(db: Database.Database): void {
    this.stmtInsertEdge = db.prepare(`
      INSERT OR IGNORE INTO edges
        (source_entity_id, target_entity_id, edge_type, confidence, metadata)
      VALUES (@source_entity_id, @target_entity_id, @edge_type, @confidence, @metadata)
      RETURNING *
    `);
    this.stmtGetEdgesFrom = db.prepare(`SELECT * FROM edges WHERE source_entity_id = ?`);
    this.stmtGetEdgesTo = db.prepare(`SELECT * FROM edges WHERE target_entity_id = ?`);
    this.stmtDeleteEdgesByEntity = db.prepare(
      `DELETE FROM edges WHERE source_entity_id = ? OR target_entity_id = ?`,
    );
  }

  private prepareFileEdgeStatements(db: Database.Database): void {
    this.stmtInsertFileEdge = db.prepare(`
      INSERT OR IGNORE INTO file_edges
        (source_file_id, target_file_id, edge_type, confidence, evidence, relation)
      VALUES (@source_file_id, @target_file_id, @edge_type, @confidence, @evidence, @relation)
      RETURNING *
    `);
    this.stmtGetFileEdgesFrom = db.prepare(`SELECT * FROM file_edges WHERE source_file_id = ?`);
    this.stmtGetFileEdgesTo = db.prepare(`SELECT * FROM file_edges WHERE target_file_id = ?`);
    this.stmtDeleteFileEdgesByFile = db.prepare(
      `DELETE FROM file_edges WHERE source_file_id = ? OR target_file_id = ?`,
    );
  }

  private prepareSummaryStatements(db: Database.Database): void {
    this.stmtUpsertSummary = db.prepare(`
      INSERT INTO summaries (file_id, entity_id, scope, summary, model, content_hash, updated_at)
      VALUES (@file_id, @entity_id, @scope, @summary, @model, @content_hash, @updated_at)
      ON CONFLICT(file_id, entity_id, scope) DO UPDATE SET
        summary = excluded.summary, model = excluded.model,
        content_hash = excluded.content_hash, updated_at = excluded.updated_at
      RETURNING *
    `);
    this.stmtDeleteExistingNullEntitySummary = db.prepare(
      `DELETE FROM summaries WHERE file_id = @file_id AND entity_id IS NULL AND scope = @scope`,
    );
    this.stmtInsertSummaryReturning = db.prepare(`
      INSERT INTO summaries (file_id, entity_id, scope, summary, model, content_hash, updated_at)
      VALUES (@file_id, @entity_id, @scope, @summary, @model, @content_hash, @updated_at)
      RETURNING *
    `);
    this.stmtGetSummaryByFile = db.prepare(
      `SELECT * FROM summaries WHERE file_id = ? AND entity_id IS NULL AND scope = 'file'`,
    );
    this.stmtDeleteSummariesByFile = db.prepare(`DELETE FROM summaries WHERE file_id = ?`);
    this.stmtGetStaleSummaries = db.prepare(`
      SELECT s.*, f.path, f.content_hash AS file_content_hash
      FROM summaries s JOIN files f ON f.file_id = s.file_id
      WHERE s.content_hash IS NOT NULL AND s.content_hash != f.content_hash
      LIMIT ?
    `);
  }

  // Files

  upsertFile(file: Omit<FileRow, "file_id">): FileRow {
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

  // Entities

  insertEntity(entity: Omit<EntityRow, "entity_id">): EntityRow {
    const params = {
      ...entity,
      is_default_export: entity.is_default_export ? 1 : 0,
      is_exported: entity.is_exported ? 1 : 0,
    };

    const row = this.stmtInsertEntity.get(params) as Record<string, unknown> | undefined;
    if (row !== undefined) {
      return toEntityRow(row);
    }

    // INSERT OR IGNORE conflict: return existing row
    const existing = this.getEntityByQualifiedName(entity.file_id, entity.qualified_name);
    if (!existing) {
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

  // Edges (entity-level)

  insertEdge(edge: Omit<EdgeRow, "edge_id">): EdgeRow {
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

  // File edges

  insertFileEdge(edge: Omit<FileEdgeRow, "file_edge_id">): FileEdgeRow {
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

  // Summaries

  upsertSummary(params: Omit<SummaryRow, "summary_id">): SummaryRow {
    // SQLite UNIQUE constraints treat NULLs as distinct, so ON CONFLICT never fires
    // for rows where entity_id IS NULL. Handle that case with DELETE + INSERT.
    if (params.entity_id === null) {
      this.stmtDeleteExistingNullEntitySummary.run(params);
      return this.stmtInsertSummaryReturning.get(params) as SummaryRow;
    }
    return this.stmtUpsertSummary.get(params) as SummaryRow;
  }

  getSummaryByFile(fileId: number): SummaryRow | undefined {
    return this.stmtGetSummaryByFile.get(fileId) as SummaryRow | undefined;
  }

  getSummariesByFiles(fileIds: number[]): SummaryRow[] {
    if (fileIds.length === 0) return [];
    const placeholders = fileIds.map(() => "?").join(",");
    const stmt = this.db.prepare(
      `SELECT * FROM summaries WHERE file_id IN (${placeholders}) AND entity_id IS NULL AND scope = 'file'`,
    );
    return stmt.all(...fileIds) as SummaryRow[];
  }

  deleteSummariesByFile(fileId: number): void {
    this.stmtDeleteSummariesByFile.run(fileId);
  }

  getStaleSummaries(limit = 100): Array<SummaryRow & { path: string; file_content_hash: string }> {
    return this.stmtGetStaleSummaries.all(limit) as Array<
      SummaryRow & { path: string; file_content_hash: string }
    >;
  }

  // Bulk operations

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

  // Stats

  getStats(): { files: number; entities: number; edges: number; fileEdges: number } {
    const files = (this.stmtCountFiles.get() as { n: number }).n;
    const entities = (this.stmtCountEntities.get() as { n: number }).n;
    const edges = (this.stmtCountEdges.get() as { n: number }).n;
    const fileEdges = (this.stmtCountFileEdges.get() as { n: number }).n;
    return { edges, entities, fileEdges, files };
  }

  // Lifecycle

  close(): void {
    this.db.close();
  }
}
