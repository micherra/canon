/**
 * kg-schema-v6.test.ts
 *
 * Tests for migration v6: doc_chunks, doc_vectors (vec0), doc_chunk_meta tables.
 * Verifies: fresh DB has all three tables; v5→v6 upgrade works; existing v5
 * tables (entity_vectors, summary_vectors) are unaffected.
 */

import { initDatabase, runMigrations } from "@graph/kg-schema.ts";
import type Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName) as { name: string } | undefined;
  return row !== undefined;
}

function indexExists(db: Database.Database, indexName: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
    .get(indexName) as { name: string } | undefined;
  return row !== undefined;
}

describe("migration v6 — doc_chunks, doc_vectors, doc_chunk_meta", () => {
  test("new database has doc_chunks table", () => {
    const db = initDatabase(":memory:");
    expect(tableExists(db, "doc_chunks")).toBe(true);
    db.close();
  });

  test("new database has doc_vectors vec0 virtual table", () => {
    const db = initDatabase(":memory:");
    expect(tableExists(db, "doc_vectors")).toBe(true);
    db.close();
  });

  test("new database has doc_chunk_meta table", () => {
    const db = initDatabase(":memory:");
    expect(tableExists(db, "doc_chunk_meta")).toBe(true);
    db.close();
  });

  test("schema_version is 6 after initDatabase", () => {
    const db = initDatabase(":memory:");
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(row.value).toBe("6");
    db.close();
  });

  test("doc_chunks has expected indexes", () => {
    const db = initDatabase(":memory:");
    expect(indexExists(db, "idx_doc_chunks_corpus")).toBe(true);
    expect(indexExists(db, "idx_doc_chunks_doc_path")).toBe(true);
    db.close();
  });

  test("existing v5 database is upgraded to v6 via runMigrations", () => {
    const db = initDatabase(":memory:");
    // Simulate a v5 DB by dropping v6 tables and resetting version
    db.exec(`DROP TABLE IF EXISTS doc_chunk_meta`);
    db.exec(`DROP TABLE IF EXISTS doc_vectors`);
    db.exec(`DROP TABLE IF EXISTS doc_chunks`);
    db.exec(`DROP INDEX IF EXISTS idx_doc_chunks_corpus`);
    db.exec(`DROP INDEX IF EXISTS idx_doc_chunks_doc_path`);
    db.exec(`UPDATE meta SET value = '5' WHERE key = 'schema_version'`);

    // Pre-condition: tables gone
    expect(tableExists(db, "doc_chunks")).toBe(false);
    expect(tableExists(db, "doc_vectors")).toBe(false);
    expect(tableExists(db, "doc_chunk_meta")).toBe(false);

    runMigrations(db);

    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(row.value).toBe("6");
    expect(tableExists(db, "doc_chunks")).toBe(true);
    expect(tableExists(db, "doc_vectors")).toBe(true);
    expect(tableExists(db, "doc_chunk_meta")).toBe(true);
    db.close();
  });

  test("existing v5 tables (entity_vectors, summary_vectors) unaffected by v6 migration", () => {
    const db = initDatabase(":memory:");
    expect(tableExists(db, "entity_vectors")).toBe(true);
    expect(tableExists(db, "summary_vectors")).toBe(true);
    expect(tableExists(db, "entity_vector_meta")).toBe(true);
    expect(tableExists(db, "summary_vector_meta")).toBe(true);
    db.close();
  });

  test("migration v6 is idempotent — running runMigrations again does not fail", () => {
    const db = initDatabase(":memory:");
    expect(() => runMigrations(db)).not.toThrow();
    db.close();
  });

  test("doc_chunks table accepts valid rows and enforces UNIQUE(corpus, doc_path, chunk_index)", () => {
    const db = initDatabase(":memory:");
    db.prepare(
      `INSERT INTO doc_chunks (corpus, doc_path, heading_path, chunk_index, char_start, char_end, content, content_hash, trust_tier, updated_at)
       VALUES ('principles', 'principles/foo.md', 'H1 > H2', 0, 0, 100, 'chunk content', 'hash123', 'internal', '2026-01-01T00:00:00Z')`,
    ).run();
    const row = db
      .prepare(`SELECT corpus, chunk_id, trust_tier FROM doc_chunks WHERE corpus = 'principles'`)
      .get() as { chunk_id: number; corpus: string; trust_tier: string };
    expect(row.corpus).toBe("principles");
    expect(row.chunk_id).toBeGreaterThan(0);
    expect(row.trust_tier).toBe("internal");

    // UNIQUE constraint: same (corpus, doc_path, chunk_index) should fail
    expect(() =>
      db
        .prepare(
          `INSERT INTO doc_chunks (corpus, doc_path, chunk_index, char_start, char_end, content, content_hash, trust_tier, updated_at)
           VALUES ('principles', 'principles/foo.md', 0, 0, 5, 'other', 'other', 'internal', '2026-01-01T00:00:00Z')`,
        )
        .run(),
    ).toThrow();
    db.close();
  });

  test("doc_chunk_meta ON DELETE CASCADE removes meta when chunk deleted", () => {
    const db = initDatabase(":memory:");
    db.prepare(
      `INSERT INTO doc_chunks (corpus, doc_path, chunk_index, char_start, char_end, content, content_hash, trust_tier, updated_at)
       VALUES ('principles', 'principles/foo.md', 0, 0, 7, 'content', 'hash', 'internal', '2026-01-01T00:00:00Z')`,
    ).run();
    const chunkRow = db
      .prepare(`SELECT chunk_id FROM doc_chunks WHERE corpus = 'principles'`)
      .get() as { chunk_id: number };
    const chunkId = chunkRow.chunk_id;

    db.prepare(
      `INSERT INTO doc_chunk_meta (chunk_id, text_hash, model_id, updated_at)
       VALUES (?, 'h1', 'all-MiniLM-L6-v2', '2026-01-01T00:00:00Z')`,
    ).run(chunkId);

    // Verify meta inserted
    const meta = db.prepare(`SELECT * FROM doc_chunk_meta WHERE chunk_id = ?`).get(chunkId) as
      | { chunk_id: number }
      | undefined;
    expect(meta).toBeDefined();

    // Delete chunk — meta should cascade
    db.prepare(`DELETE FROM doc_chunks WHERE chunk_id = ?`).run(chunkId);
    const metaAfter = db.prepare(`SELECT * FROM doc_chunk_meta WHERE chunk_id = ?`).get(chunkId) as
      | { chunk_id: number }
      | undefined;
    expect(metaAfter).toBeUndefined();
    db.close();
  });
});
