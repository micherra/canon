/**
 * kg-doc-store.ts
 *
 * DocVectorStore — wraps all CRUD for the doc corpus vector tables:
 *   doc_chunks, doc_vectors (vec0), doc_chunk_meta.
 *
 * Applies the SAME vec0 binding-bug workaround as KgVectorStore:
 * prepared-statement params fail for vec0 inserts; use db.exec() with inline
 * JSON string literals instead.
 *
 * This class throws on errors — it is internal infrastructure, not an MCP tool
 * handler. Callers that need graceful degradation should catch errors.
 */

import { createHash } from "node:crypto";
import { EMBEDDING_DIM, EMBEDDING_MODEL_ID } from "@shared/constants.ts";
import type Database from "better-sqlite3";

export type DocChunkRow = {
  corpus: string;
  doc_path: string;
  heading_path: string | null;
  chunk_index: number;
  char_start: number;
  char_end: number;
  content: string;
  content_hash: string;
  trust_tier: string;
  updated_at: string;
};

export type StaleChunk = {
  chunk_id: number;
  corpus: string;
  doc_path: string;
  content: string;
  content_hash: string;
};

export class DocVectorStore {
  private readonly db: Database.Database;
  private readonly stmtUpsertChunk: Database.Statement;
  private readonly stmtUpsertChunkMeta: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;

    this.stmtUpsertChunk = db.prepare(`
      INSERT INTO doc_chunks
        (corpus, doc_path, heading_path, chunk_index, char_start, char_end,
         content, content_hash, trust_tier, updated_at)
      VALUES
        (@corpus, @doc_path, @heading_path, @chunk_index, @char_start, @char_end,
         @content, @content_hash, @trust_tier, @updated_at)
      ON CONFLICT(corpus, doc_path, chunk_index) DO UPDATE SET
        heading_path = excluded.heading_path,
        char_start   = excluded.char_start,
        char_end     = excluded.char_end,
        content      = excluded.content,
        content_hash = excluded.content_hash,
        trust_tier   = excluded.trust_tier,
        updated_at   = excluded.updated_at
    `);

    this.stmtUpsertChunkMeta = db.prepare(`
      INSERT INTO doc_chunk_meta (chunk_id, text_hash, model_id, updated_at)
      VALUES (@chunk_id, @text_hash, @model_id, @updated_at)
      ON CONFLICT(chunk_id) DO UPDATE SET
        text_hash  = excluded.text_hash,
        model_id   = excluded.model_id,
        updated_at = excluded.updated_at
    `);
  }

  // Static helpers

  /** Compute SHA-256 hash of text for staleness detection. Mirrors KgVectorStore.textHash. */
  static textHash(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  }

  // Chunk row operations

  /**
   * Upsert a doc chunk row. Returns the chunk_id (insert or existing via ROWID).
   */
  upsertDocChunk(row: DocChunkRow): number {
    const result = this.stmtUpsertChunk.run(row);
    // On conflict (update path), last_insert_rowid still reflects the conflicting row's rowid
    if (result.changes === 0) {
      // No row modified — fetch existing chunk_id
      const existing = this.db
        .prepare(
          `SELECT chunk_id FROM doc_chunks
           WHERE corpus = ? AND doc_path = ? AND chunk_index = ?`,
        )
        .get(row.corpus, row.doc_path, row.chunk_index) as { chunk_id: number } | undefined;
      if (!existing) throw new Error("upsertDocChunk: chunk missing after upsert");
      return existing.chunk_id;
    }
    return result.lastInsertRowid as number;
  }

  // Vector operations

  /**
   * Upsert a doc vector + meta row.
   *
   * Uses db.exec() with inline JSON literal for the vec0 INSERT — this bypasses
   * the sqlite-vec binding bug (prepared-statement params fail for vec0 writes).
   */
  upsertDocVector(chunkId: number, embedding: Float32Array, textHash: string): void {
    if (embedding.length !== EMBEDDING_DIM) {
      throw new Error(
        `upsertDocVector: expected ${EMBEDDING_DIM}-dim embedding, got ${embedding.length}`,
      );
    }
    // Validate all values are finite
    for (let i = 0; i < embedding.length; i++) {
      if (!Number.isFinite(embedding[i])) {
        throw new Error(`upsertDocVector: non-finite value at index ${i}`);
      }
    }

    const jsonVec = `[${Array.from(embedding).join(",")}]`;
    // vec0 binding-bug workaround: DELETE + INSERT via db.exec (inline literals)
    this.db.exec(`DELETE FROM doc_vectors WHERE chunk_id = ${chunkId}`);
    this.db.exec(`INSERT INTO doc_vectors (chunk_id, embedding) VALUES (${chunkId}, '${jsonVec}')`);

    // Meta row (regular table — prepared statements work fine)
    this.stmtUpsertChunkMeta.run({
      chunk_id: chunkId,
      model_id: EMBEDDING_MODEL_ID,
      text_hash: textHash,
      updated_at: new Date().toISOString(),
    });
  }

  // Staleness detection

  /**
   * Return chunks that need re-embedding: those with no meta row, a stale
   * text_hash, or a mismatched model_id.
   *
   * Uses LEFT JOIN on doc_chunk_meta; computes current hash in JS (same pattern
   * as KgVectorStore.getStaleEntityVectors).
   */
  getStaleChunks(limit?: number): StaleChunk[] {
    const sql = `
      SELECT dc.chunk_id, dc.corpus, dc.doc_path, dc.content, dc.content_hash,
             dcm.text_hash AS stored_hash, dcm.model_id AS stored_model_id
      FROM doc_chunks dc
      LEFT JOIN doc_chunk_meta dcm ON dcm.chunk_id = dc.chunk_id
      ORDER BY dc.chunk_id
      ${limit != null ? `LIMIT ${limit}` : ""}
    `;

    const rows = this.db.prepare(sql).all() as Array<{
      chunk_id: number;
      corpus: string;
      doc_path: string;
      content: string;
      content_hash: string;
      stored_hash: string | null;
      stored_model_id: string | null;
    }>;

    return rows.filter((row) => {
      const currentHash = DocVectorStore.textHash(row.content);
      const isStale =
        row.stored_hash === null ||
        row.stored_model_id !== EMBEDDING_MODEL_ID ||
        row.stored_hash !== currentHash;
      return isStale;
    });
  }

  // Cleanup / pruning

  /**
   * Remove doc_vectors rows whose chunk_id no longer exists in doc_chunks.
   * Returns the number of deleted rows.
   */
  cleanOrphanDocVectors(): number {
    // Fetch orphan chunk_ids (LEFT JOIN, doc_chunks missing)
    const orphans = this.db
      .prepare(
        `SELECT dv.chunk_id FROM doc_vectors dv
         LEFT JOIN doc_chunks dc ON dc.chunk_id = dv.chunk_id
         WHERE dc.chunk_id IS NULL`,
      )
      .all() as { chunk_id: number }[];

    let deleted = 0;
    for (const { chunk_id } of orphans) {
      this.db.exec(`DELETE FROM doc_vectors WHERE chunk_id = ${chunk_id}`);
      deleted++;
    }
    return deleted;
  }

  /**
   * Delete doc_chunks rows for `corpus` whose doc_path is not in `keptDocPaths`.
   * Associated meta rows cascade-delete via FK.
   * Vec0 orphans are cleaned by a separate cleanOrphanDocVectors() call.
   */
  pruneCorpusDocs(corpus: string, keptDocPaths: string[]): void {
    if (keptDocPaths.length === 0) {
      this.db.prepare(`DELETE FROM doc_chunks WHERE corpus = ?`).run(corpus);
      return;
    }
    const placeholders = keptDocPaths.map(() => "?").join(",");
    this.db
      .prepare(`DELETE FROM doc_chunks WHERE corpus = ? AND doc_path NOT IN (${placeholders})`)
      .run(corpus, ...keptDocPaths);
  }

  /**
   * Delete chunk_index entries for (corpus, doc_path) not in `keptIndexes`.
   * Used to prune stale chunk rows when a file's chunk count decreases.
   */
  pruneDocChunks(corpus: string, docPath: string, keptIndexes: number[]): void {
    if (keptIndexes.length === 0) {
      this.db
        .prepare(`DELETE FROM doc_chunks WHERE corpus = ? AND doc_path = ?`)
        .run(corpus, docPath);
      return;
    }
    const placeholders = keptIndexes.map(() => "?").join(",");
    this.db
      .prepare(
        `DELETE FROM doc_chunks
         WHERE corpus = ? AND doc_path = ? AND chunk_index NOT IN (${placeholders})`,
      )
      .run(corpus, docPath, ...keptIndexes);
  }
}
