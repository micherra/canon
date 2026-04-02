/**
 * KgVectorStore
 *
 * Wraps all vector table CRUD operations for entity_vectors and summary_vectors.
 * Uses the same Database instance pattern as KgStore.
 *
 * IMPORTANT: sqlite-vec 0.1.6-alpha.2 has a bug where prepared statement
 * parameter binding fails for vec0 inserts. Only db.exec() with inline JSON
 * string literals works. This class uses that workaround for all vec0 writes.
 *
 * This class throws on errors (it is internal infrastructure, not an MCP tool
 * handler). Callers that need graceful degradation should catch errors.
 */

import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { EMBEDDING_DIM, EMBEDDING_MODEL_ID } from "../constants.ts";

// ---------------------------------------------------------------------------
// KgVectorStore
// ---------------------------------------------------------------------------

export class KgVectorStore {
  private readonly db: Database.Database;

  // Prepared statements for meta table operations (regular SQLite tables work fine)
  private readonly stmtUpsertEntityMeta: Database.Statement;
  private readonly stmtUpsertSummaryMeta: Database.Statement;
  private readonly stmtDeleteEntityMeta: Database.Statement;
  private readonly stmtDeleteSummaryMeta: Database.Statement;
  private readonly stmtCountEntityVectorMeta: Database.Statement;
  private readonly stmtCountSummaryVectorMeta: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;

    // Meta table statements (not vec0 — no binding bug)
    this.stmtUpsertEntityMeta = db.prepare(`
      INSERT INTO entity_vector_meta (entity_id, text_hash, model_id, updated_at)
      VALUES (@entity_id, @text_hash, @model_id, @updated_at)
      ON CONFLICT(entity_id) DO UPDATE SET
        text_hash  = excluded.text_hash,
        model_id   = excluded.model_id,
        updated_at = excluded.updated_at
    `);

    this.stmtUpsertSummaryMeta = db.prepare(`
      INSERT INTO summary_vector_meta (summary_id, text_hash, model_id, updated_at)
      VALUES (@summary_id, @text_hash, @model_id, @updated_at)
      ON CONFLICT(summary_id) DO UPDATE SET
        text_hash  = excluded.text_hash,
        model_id   = excluded.model_id,
        updated_at = excluded.updated_at
    `);

    this.stmtDeleteEntityMeta = db.prepare(`
      DELETE FROM entity_vector_meta WHERE entity_id = ?
    `);

    this.stmtDeleteSummaryMeta = db.prepare(`
      DELETE FROM summary_vector_meta WHERE summary_id = ?
    `);

    // Stats via meta tables (meta tables stay in sync with vec0 rows via upsert/cleanup)
    this.stmtCountEntityVectorMeta = db.prepare(`SELECT COUNT(*) AS n FROM entity_vector_meta`);
    this.stmtCountSummaryVectorMeta = db.prepare(`SELECT COUNT(*) AS n FROM summary_vector_meta`);
  }

  // ---------------------------------------------------------------------------
  // Static helpers
  // ---------------------------------------------------------------------------

  /** Compute SHA-256 hash of text for staleness detection. */
  static textHash(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  }

  /** Build composite text representation for entity embedding. */
  static compositeEntityText(entity: {
    kind: string;
    qualified_name: string;
    signature: string | null;
    file_path: string;
  }): string {
    let text = `${entity.kind}: ${entity.qualified_name}`;
    if (entity.signature) text += `\nsignature: ${entity.signature}`;
    text += `\nfile: ${entity.file_path}`;
    return text;
  }

  // ---------------------------------------------------------------------------
  // Upsert operations
  // ---------------------------------------------------------------------------

  /**
   * Upsert an entity vector + meta row.
   *
   * vec0 does not support INSERT OR REPLACE on virtual tables, so we DELETE
   * then INSERT. Both operations are wrapped in a transaction for atomicity.
   *
   * WORKAROUND: sqlite-vec 0.1.6-alpha.2 parameter binding fails for vec0.
   * We use db.exec() with an inline JSON array literal instead.
   */
  upsertEntityVector(entityId: number, embedding: Float32Array, textHash: string): void {
    if (!Number.isInteger(entityId) || !Number.isFinite(entityId)) {
      throw new Error(`entityId must be a finite integer, got: ${entityId}`);
    }
    if (embedding.length !== EMBEDDING_DIM) {
      throw new Error(
        `embedding must have length ${EMBEDDING_DIM}, got ${embedding.length}`,
      );
    }
    if (embedding.some((v) => !Number.isFinite(v))) {
      throw new Error("embedding contains non-finite values (NaN or Infinity)");
    }
    const jsonVec = "[" + Array.from(embedding).join(",") + "]";
    const updatedAt = new Date().toISOString();

    const doUpsert = this.db.transaction(() => {
      // Delete existing vec0 row (if any)
      this.db.exec(`DELETE FROM entity_vectors WHERE entity_id = ${entityId}`);

      // Insert new vec0 row using exec + JSON literal (workaround for binding bug)
      this.db.exec(
        `INSERT INTO entity_vectors (entity_id, embedding) VALUES (${entityId}, '${jsonVec}')`,
      );

      // Upsert meta row (regular table — prepared statements work fine)
      this.stmtUpsertEntityMeta.run({
        entity_id: entityId,
        text_hash: textHash,
        model_id: EMBEDDING_MODEL_ID,
        updated_at: updatedAt,
      });
    });

    doUpsert();
  }

  /**
   * Upsert a summary vector + meta row.
   * Same workaround pattern as upsertEntityVector.
   */
  upsertSummaryVector(summaryId: number, embedding: Float32Array, textHash: string): void {
    if (!Number.isInteger(summaryId) || !Number.isFinite(summaryId)) {
      throw new Error(`summaryId must be a finite integer, got: ${summaryId}`);
    }
    if (embedding.length !== EMBEDDING_DIM) {
      throw new Error(
        `embedding must have length ${EMBEDDING_DIM}, got ${embedding.length}`,
      );
    }
    if (embedding.some((v) => !Number.isFinite(v))) {
      throw new Error("embedding contains non-finite values (NaN or Infinity)");
    }
    const jsonVec = "[" + Array.from(embedding).join(",") + "]";
    const updatedAt = new Date().toISOString();

    const doUpsert = this.db.transaction(() => {
      // Delete existing vec0 row (if any)
      this.db.exec(`DELETE FROM summary_vectors WHERE summary_id = ${summaryId}`);

      // Insert new vec0 row using exec + JSON literal
      this.db.exec(
        `INSERT INTO summary_vectors (summary_id, embedding) VALUES (${summaryId}, '${jsonVec}')`,
      );

      // Upsert meta row
      this.stmtUpsertSummaryMeta.run({
        summary_id: summaryId,
        text_hash: textHash,
        model_id: EMBEDDING_MODEL_ID,
        updated_at: updatedAt,
      });
    });

    doUpsert();
  }

  // ---------------------------------------------------------------------------
  // Orphan cleanup
  // ---------------------------------------------------------------------------

  /**
   * Delete orphan entity vectors where the source entity no longer exists.
   * Returns count of rows deleted.
   *
   * Note: entity_vector_meta has ON DELETE CASCADE from entities, so meta rows
   * are cleaned up automatically when entities are deleted. The vec0 table
   * does NOT cascade, so we must enumerate vec0 rows directly and find orphans.
   */
  cleanOrphanEntityVectors(): number {
    // Enumerate all entity_ids present in the vec0 table (direct SELECT works without MATCH)
    const vecRows = this.db
      .prepare("SELECT entity_id FROM entity_vectors")
      .all() as Array<{ entity_id: number }>;

    if (vecRows.length === 0) return 0;

    // Check which entity_ids no longer exist in the entities table
    let deleted = 0;
    const doClean = this.db.transaction(() => {
      for (const { entity_id } of vecRows) {
        const exists = this.db
          .prepare("SELECT 1 FROM entities WHERE entity_id = ?")
          .get(entity_id);
        if (!exists) {
          if (!Number.isInteger(entity_id) || !Number.isFinite(entity_id)) {
            throw new Error(`entity_id must be a finite integer, got: ${entity_id}`);
          }
          this.db.exec(`DELETE FROM entity_vectors WHERE entity_id = ${entity_id}`);
          deleted++;
        }
      }
    });
    doClean();

    return deleted;
  }

  /**
   * Delete orphan summary vectors where the source summary no longer exists.
   * Returns count of rows deleted.
   */
  cleanOrphanSummaryVectors(): number {
    const vecRows = this.db
      .prepare("SELECT summary_id FROM summary_vectors")
      .all() as Array<{ summary_id: number }>;

    if (vecRows.length === 0) return 0;

    let deleted = 0;
    const doClean = this.db.transaction(() => {
      for (const { summary_id } of vecRows) {
        const exists = this.db
          .prepare("SELECT 1 FROM summaries WHERE summary_id = ?")
          .get(summary_id);
        if (!exists) {
          if (!Number.isInteger(summary_id) || !Number.isFinite(summary_id)) {
            throw new Error(`summary_id must be a finite integer, got: ${summary_id}`);
          }
          this.db.exec(`DELETE FROM summary_vectors WHERE summary_id = ${summary_id}`);
          deleted++;
        }
      }
    });
    doClean();

    return deleted;
  }

  // ---------------------------------------------------------------------------
  // Staleness detection
  // ---------------------------------------------------------------------------

  /**
   * Get entities needing (re-)embedding.
   *
   * Returns entities that either:
   * - Have no row in entity_vector_meta
   * - Have text_hash mismatch (composite text changed)
   * - Have model_id mismatch (model upgraded)
   *
   * Excludes kind='file' entities (bare file entities have no useful signature).
   * Joins with files table for file_path.
   */
  getStaleEntityVectors(limit?: number): Array<{
    entity_id: number;
    kind: string;
    qualified_name: string;
    signature: string | null;
    file_path: string;
    current_hash: string;
  }> {
    // Build composite text for each entity and compute its hash in SQL via
    // the same format as compositeEntityText() but computed here in JS after fetch,
    // since SQLite doesn't have SHA-256 built in.
    //
    // Strategy: fetch candidate entities (missing meta OR hash/model mismatch),
    // then compute the current_hash in JS.

    const limitClause = limit != null ? `LIMIT ${limit}` : "";

    // Fetch all entities (with optional limit) so we can compute current_hash in JS
    // and filter by staleness (no meta, model mismatch, or text_hash mismatch).
    const allCandidates = this.db
      .prepare(
        `
        SELECT
          e.entity_id,
          e.kind,
          e.qualified_name,
          e.signature,
          f.path AS file_path,
          evm.text_hash AS stored_hash,
          evm.model_id AS stored_model_id
        FROM entities e
        JOIN files f ON f.file_id = e.file_id
        LEFT JOIN entity_vector_meta evm ON evm.entity_id = e.entity_id
        WHERE e.kind != 'file'
        ${limitClause}
      `,
      )
      .all() as Array<{
      entity_id: number;
      kind: string;
      qualified_name: string;
      signature: string | null;
      file_path: string;
      stored_hash: string | null;
      stored_model_id: string | null;
    }>;

    const result: Array<{
      entity_id: number;
      kind: string;
      qualified_name: string;
      signature: string | null;
      file_path: string;
      current_hash: string;
    }> = [];

    for (const row of allCandidates) {
      const compositeText = KgVectorStore.compositeEntityText({
        kind: row.kind,
        qualified_name: row.qualified_name,
        signature: row.signature,
        file_path: row.file_path,
      });
      const currentHash = KgVectorStore.textHash(compositeText);

      const isStale =
        row.stored_hash === null || // No meta row
        row.stored_model_id !== EMBEDDING_MODEL_ID || // Model changed
        row.stored_hash !== currentHash; // Text changed

      if (isStale) {
        result.push({
          entity_id: row.entity_id,
          kind: row.kind,
          qualified_name: row.qualified_name,
          signature: row.signature,
          file_path: row.file_path,
          current_hash: currentHash,
        });
      }
    }

    return limit != null ? result.slice(0, limit) : result;
  }

  /**
   * Get summaries needing (re-)embedding.
   *
   * Returns summaries that either:
   * - Have no row in summary_vector_meta
   * - Have text_hash mismatch
   * - Have model_id mismatch
   */
  getStaleSummaryVectors(limit?: number): Array<{
    summary_id: number;
    summary: string;
    entity_id: number | null;
    file_id: number;
    current_hash: string;
  }> {
    const limitClause = limit != null ? `LIMIT ${limit}` : "";

    const rows = this.db
      .prepare(
        `
        SELECT
          s.summary_id,
          s.summary,
          s.entity_id,
          s.file_id,
          svm.text_hash AS stored_hash,
          svm.model_id AS stored_model_id
        FROM summaries s
        LEFT JOIN summary_vector_meta svm ON svm.summary_id = s.summary_id
        ${limitClause}
      `,
      )
      .all() as Array<{
      summary_id: number;
      summary: string;
      entity_id: number | null;
      file_id: number;
      stored_hash: string | null;
      stored_model_id: string | null;
    }>;

    const result: Array<{
      summary_id: number;
      summary: string;
      entity_id: number | null;
      file_id: number;
      current_hash: string;
    }> = [];

    for (const row of rows) {
      const currentHash = KgVectorStore.textHash(row.summary);

      const isStale =
        row.stored_hash === null ||
        row.stored_model_id !== EMBEDDING_MODEL_ID ||
        row.stored_hash !== currentHash;

      if (isStale) {
        result.push({
          summary_id: row.summary_id,
          summary: row.summary,
          entity_id: row.entity_id,
          file_id: row.file_id,
          current_hash: currentHash,
        });
      }
    }

    return limit != null ? result.slice(0, limit) : result;
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  /** Get vector counts for stats. */
  getVectorStats(): { entityVectors: number; summaryVectors: number } {
    const entityCount = (this.stmtCountEntityVectorMeta.get() as { n: number }).n;
    const summaryCount = (this.stmtCountSummaryVectorMeta.get() as { n: number }).n;
    return { entityVectors: entityCount, summaryVectors: summaryCount };
  }
}
