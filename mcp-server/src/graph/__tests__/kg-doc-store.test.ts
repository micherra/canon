/**
 * kg-doc-store.test.ts
 *
 * Tests for DocVectorStore: staleness detection, upsertDocVector round-trip,
 * orphan cleanup, and corpus/doc prune helpers.
 */

import { DocVectorStore } from "@graph/kg-doc-store.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import { EMBEDDING_DIM, EMBEDDING_MODEL_ID } from "@shared/constants.ts";
import { randomEmbedding } from "@tests/helpers/embedding-test-helpers.ts";
import { describe, expect, test } from "vitest";

function makeDb() {
  return initDatabase(":memory:");
}

function insertChunk(
  db: ReturnType<typeof makeDb>,
  overrides: Partial<{
    corpus: string;
    doc_path: string;
    chunk_index: number;
    content: string;
  }> = {},
): number {
  const {
    corpus = "principles",
    doc_path = "principles/foo.md",
    chunk_index = 0,
    content = "some content",
  } = overrides;
  const result = db
    .prepare(
      `INSERT INTO doc_chunks (corpus, doc_path, chunk_index, char_start, char_end, content, content_hash, trust_tier, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, 'placeholder', 'internal', '2026-01-01T00:00:00Z')`,
    )
    .run(corpus, doc_path, chunk_index, content.length, content);
  return result.lastInsertRowid as number;
}

describe("DocVectorStore", () => {
  describe("getStaleChunks", () => {
    test("returns all chunks when no meta rows exist", () => {
      const db = makeDb();
      const store = new DocVectorStore(db);
      insertChunk(db, { content: "chunk one" });
      insertChunk(db, { chunk_index: 1, content: "chunk two" });

      const stale = store.getStaleChunks();
      expect(stale.length).toBe(2);
      db.close();
    });

    test("returns chunk when text_hash mismatch (content changed)", () => {
      const db = makeDb();
      const store = new DocVectorStore(db);
      const chunkId = insertChunk(db, { content: "original content" });

      // Insert meta with a stale hash
      db.prepare(
        `INSERT INTO doc_chunk_meta (chunk_id, text_hash, model_id, updated_at)
         VALUES (?, 'stale-hash', ?, '2026-01-01T00:00:00Z')`,
      ).run(chunkId, EMBEDDING_MODEL_ID);

      const stale = store.getStaleChunks();
      // current hash of "original content" != "stale-hash"
      expect(stale.length).toBe(1);
      expect(stale[0].chunk_id).toBe(chunkId);
      db.close();
    });

    test("returns chunk when model_id mismatch", () => {
      const db = makeDb();
      const store = new DocVectorStore(db);
      const chunkId = insertChunk(db, { content: "some content" });
      const currentHash = DocVectorStore.textHash("some content");

      db.prepare(
        `INSERT INTO doc_chunk_meta (chunk_id, text_hash, model_id, updated_at)
         VALUES (?, ?, 'old-model', '2026-01-01T00:00:00Z')`,
      ).run(chunkId, currentHash);

      const stale = store.getStaleChunks();
      expect(stale.length).toBe(1);
      db.close();
    });

    test("does NOT return chunk when hash and model_id both match", () => {
      const db = makeDb();
      const store = new DocVectorStore(db);
      const content = "fresh content";
      const chunkId = insertChunk(db, { content });
      const currentHash = DocVectorStore.textHash(content);

      db.prepare(
        `INSERT INTO doc_chunk_meta (chunk_id, text_hash, model_id, updated_at)
         VALUES (?, ?, ?, '2026-01-01T00:00:00Z')`,
      ).run(chunkId, currentHash, EMBEDDING_MODEL_ID);

      const stale = store.getStaleChunks();
      expect(stale.length).toBe(0);
      db.close();
    });

    test("respects optional limit parameter", () => {
      const db = makeDb();
      const store = new DocVectorStore(db);
      for (let i = 0; i < 5; i++) {
        insertChunk(db, { chunk_index: i, content: `chunk ${i}` });
      }
      const stale = store.getStaleChunks(2);
      expect(stale.length).toBeLessThanOrEqual(2);
      db.close();
    });
  });

  describe("upsertDocVector", () => {
    test("round-trips an embedding via the vec0 binding workaround", () => {
      const db = makeDb();
      const store = new DocVectorStore(db);
      const chunkId = insertChunk(db);
      const embedding = randomEmbedding(42);
      const textHash = DocVectorStore.textHash("some content");

      store.upsertDocVector(chunkId, embedding, textHash);

      // Verify meta row written
      const meta = db
        .prepare(`SELECT text_hash, model_id FROM doc_chunk_meta WHERE chunk_id = ?`)
        .get(chunkId) as { text_hash: string; model_id: string } | undefined;
      expect(meta).toBeDefined();
      expect(meta!.text_hash).toBe(textHash);
      expect(meta!.model_id).toBe(EMBEDDING_MODEL_ID);

      // Verify vec0 row exists (SELECT without MATCH works for existence check)
      const vecRow = db
        .prepare(`SELECT chunk_id FROM doc_vectors WHERE chunk_id = ?`)
        .get(chunkId) as { chunk_id: number } | undefined;
      expect(vecRow).toBeDefined();
      db.close();
    });

    test("upsert is idempotent — re-inserting same chunk_id replaces the vector", () => {
      const db = makeDb();
      const store = new DocVectorStore(db);
      const chunkId = insertChunk(db);
      const emb1 = randomEmbedding(1);
      const emb2 = randomEmbedding(2);

      store.upsertDocVector(chunkId, emb1, "hash1");
      store.upsertDocVector(chunkId, emb2, "hash2");

      // Meta should show updated hash
      const meta = db
        .prepare(`SELECT text_hash FROM doc_chunk_meta WHERE chunk_id = ?`)
        .get(chunkId) as { text_hash: string };
      expect(meta.text_hash).toBe("hash2");
      db.close();
    });

    test("throws for embedding of wrong dimension", () => {
      const db = makeDb();
      const store = new DocVectorStore(db);
      const chunkId = insertChunk(db);
      const badEmb = new Float32Array(100); // wrong dim

      expect(() => store.upsertDocVector(chunkId, badEmb, "hash")).toThrow();
      db.close();
    });

    test("throws for non-finite embedding values", () => {
      const db = makeDb();
      const store = new DocVectorStore(db);
      const chunkId = insertChunk(db);
      const badEmb = new Float32Array(EMBEDDING_DIM).fill(NaN);

      expect(() => store.upsertDocVector(chunkId, badEmb, "hash")).toThrow();
      db.close();
    });
  });

  describe("cleanOrphanDocVectors", () => {
    test("removes doc_vectors rows whose chunk_id no longer exists", () => {
      const db = makeDb();
      const store = new DocVectorStore(db);
      const chunkId = insertChunk(db);
      store.upsertDocVector(chunkId, randomEmbedding(1), "h1");

      // Verify vector exists
      let vecRow = db.prepare(`SELECT chunk_id FROM doc_vectors WHERE chunk_id = ?`).get(chunkId) as
        | { chunk_id: number }
        | undefined;
      expect(vecRow).toBeDefined();

      // Delete the chunk (simulating removed doc)
      db.prepare(`DELETE FROM doc_chunks WHERE chunk_id = ?`).run(chunkId);

      store.cleanOrphanDocVectors();

      vecRow = db.prepare(`SELECT chunk_id FROM doc_vectors WHERE chunk_id = ?`).get(chunkId) as
        | { chunk_id: number }
        | undefined;
      expect(vecRow).toBeUndefined();
      db.close();
    });

    test("returns 0 when no orphans exist", () => {
      const db = makeDb();
      const store = new DocVectorStore(db);
      expect(store.cleanOrphanDocVectors()).toBe(0);
      db.close();
    });
  });

  describe("pruneCorpusDocs", () => {
    test("deletes chunks for docs not in keptDocPaths", () => {
      const db = makeDb();
      const store = new DocVectorStore(db);
      insertChunk(db, { corpus: "principles", doc_path: "principles/kept.md", chunk_index: 0 });
      insertChunk(db, { corpus: "principles", doc_path: "principles/gone.md", chunk_index: 0 });

      store.pruneCorpusDocs("principles", ["principles/kept.md"]);

      const remaining = db
        .prepare(`SELECT doc_path FROM doc_chunks WHERE corpus = 'principles'`)
        .all() as { doc_path: string }[];
      expect(remaining.map((r) => r.doc_path)).toEqual(["principles/kept.md"]);
      db.close();
    });

    test("does not affect other corpora", () => {
      const db = makeDb();
      const store = new DocVectorStore(db);
      insertChunk(db, { corpus: "references", doc_path: "references/doc.md", chunk_index: 0 });
      insertChunk(db, { corpus: "principles", doc_path: "principles/gone.md", chunk_index: 0 });

      store.pruneCorpusDocs("principles", []);

      const refs = db
        .prepare(`SELECT doc_path FROM doc_chunks WHERE corpus = 'references'`)
        .all() as { doc_path: string }[];
      expect(refs).toHaveLength(1);
      db.close();
    });
  });

  describe("pruneDocChunks", () => {
    test("deletes chunk_index entries not in keptIndexes", () => {
      const db = makeDb();
      const store = new DocVectorStore(db);
      const docPath = "principles/foo.md";
      insertChunk(db, { corpus: "principles", doc_path: docPath, chunk_index: 0 });
      insertChunk(db, { corpus: "principles", doc_path: docPath, chunk_index: 1 });
      insertChunk(db, { corpus: "principles", doc_path: docPath, chunk_index: 2 });

      store.pruneDocChunks("principles", docPath, [0, 2]);

      const remaining = db
        .prepare(
          `SELECT chunk_index FROM doc_chunks WHERE corpus = 'principles' AND doc_path = ? ORDER BY chunk_index`,
        )
        .all(docPath) as { chunk_index: number }[];
      expect(remaining.map((r) => r.chunk_index)).toEqual([0, 2]);
      db.close();
    });
  });

  describe("upsertDocChunk", () => {
    test("inserts a new chunk and returns its chunk_id", () => {
      const db = makeDb();
      const store = new DocVectorStore(db);
      const chunkId = store.upsertDocChunk({
        corpus: "principles",
        doc_path: "principles/bar.md",
        heading_path: "H1 > H2",
        chunk_index: 0,
        char_start: 0,
        char_end: 50,
        content: "some text",
        content_hash: "chash",
        trust_tier: "internal",
        updated_at: new Date().toISOString(),
      });
      expect(typeof chunkId).toBe("number");
      expect(chunkId).toBeGreaterThan(0);
      db.close();
    });

    test("upsert on conflict updates content and hash", () => {
      const db = makeDb();
      const store = new DocVectorStore(db);
      store.upsertDocChunk({
        corpus: "principles",
        doc_path: "principles/bar.md",
        heading_path: null,
        chunk_index: 0,
        char_start: 0,
        char_end: 10,
        content: "old",
        content_hash: "old-hash",
        trust_tier: "internal",
        updated_at: new Date().toISOString(),
      });
      // Upsert same (corpus, doc_path, chunk_index)
      store.upsertDocChunk({
        corpus: "principles",
        doc_path: "principles/bar.md",
        heading_path: null,
        chunk_index: 0,
        char_start: 0,
        char_end: 20,
        content: "new",
        content_hash: "new-hash",
        trust_tier: "internal",
        updated_at: new Date().toISOString(),
      });
      const row = db
        .prepare(
          `SELECT content, content_hash FROM doc_chunks WHERE corpus = 'principles' AND doc_path = 'principles/bar.md' AND chunk_index = 0`,
        )
        .get() as { content: string; content_hash: string };
      expect(row.content).toBe("new");
      expect(row.content_hash).toBe("new-hash");
      db.close();
    });
  });
});
