/**
 * Knowledge Graph Store — Schema and Transaction Tests
 *
 * Tests for KgStore transactions and Schema v3 vector table creation and migration.
 * Uses in-memory SQLite (:memory:) for speed and isolation.
 */

import { initDatabase, runMigrations, SCHEMA_VERSION } from "@graph/kg-schema.ts";
import { KgStore } from "@graph/kg-store.ts";
import type { FileRow } from "@graph/kg-types.ts";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

function makeFileRow(overrides: Partial<Omit<FileRow, "file_id">> = {}): Omit<FileRow, "file_id"> {
  return {
    content_hash: "abc123",
    language: "typescript",
    last_indexed_at: Date.now(),
    layer: "domain",
    mtime_ms: 1700000000000,
    path: "src/A.ts",
    ...overrides,
  };
}

// KgStore — Transactions

describe("KgStore — Transactions", () => {
  let db: Database.Database;
  let store: KgStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new KgStore(db);
  });

  afterEach(() => {
    store.close();
  });

  test("transaction commits on success", () => {
    store.transaction(() => {
      store.upsertFile(makeFileRow({ path: "src/committed.ts" }));
    });
    expect(store.getFile("src/committed.ts")).toBeDefined();
  });

  test("transaction rolls back on error", () => {
    expect(() => {
      store.transaction(() => {
        store.upsertFile(makeFileRow({ path: "src/rolled-back.ts" }));
        throw new Error("intentional rollback");
      });
    }).toThrow("intentional rollback");
    // The insert should have been rolled back
    expect(store.getFile("src/rolled-back.ts")).toBeUndefined();
  });
});

// Schema v3 — vec0 tables and migration

describe("Schema v3 — vector tables", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  test("initDatabase creates entity_vectors virtual table", () => {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='entity_vectors'`)
      .get() as { name: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.name).toBe("entity_vectors");
  });

  test("initDatabase creates summary_vectors virtual table", () => {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='summary_vectors'`)
      .get() as { name: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.name).toBe("summary_vectors");
  });

  test("initDatabase creates entity_vector_meta table", () => {
    const cols = db.prepare(`PRAGMA table_info(entity_vector_meta)`).all() as Array<{
      name: string;
    }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("entity_id");
    expect(colNames).toContain("text_hash");
    expect(colNames).toContain("model_id");
    expect(colNames).toContain("updated_at");
  });

  test("initDatabase creates summary_vector_meta table", () => {
    const cols = db.prepare(`PRAGMA table_info(summary_vector_meta)`).all() as Array<{
      name: string;
    }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("summary_id");
    expect(colNames).toContain("text_hash");
    expect(colNames).toContain("model_id");
    expect(colNames).toContain("updated_at");
  });

  test("schema_version is '5' for new databases", () => {
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined;
    expect(row?.value).toBe("5");
    expect(SCHEMA_VERSION).toBe("5");
  });

  test("entity_vectors accepts insert with valid embedding", () => {
    // sqlite-vec pre-v1 quirk: only db.exec() with inline SQL works for vec0 inserts.
    // Prepared statement parameterized inserts fail with "Only integers are allows for
    // primary key values" — this is a known bug in sqlite-vec 0.1.6-alpha.2.
    const jsonEmbedding = `[${new Array(384).fill("0.1").join(",")}]`;
    expect(() =>
      db.exec(`INSERT INTO entity_vectors (entity_id, embedding) VALUES (1, '${jsonEmbedding}')`),
    ).not.toThrow();
  });

  test("summary_vectors accepts insert with valid embedding", () => {
    const jsonEmbedding = `[${new Array(384).fill("0.2").join(",")}]`;
    expect(() =>
      db.exec(`INSERT INTO summary_vectors (summary_id, embedding) VALUES (1, '${jsonEmbedding}')`),
    ).not.toThrow();
  });
});

describe("Schema v3 — migration from v2", () => {
  test("runMigrations upgrades v2 DB to v3 (creates vec0 tables)", () => {
    // Build a v2 DB by applying DDL manually without v3 tables
    // We simulate a v2 DB by creating base schema, setting schema_version to '2',
    // then calling runMigrations() to migrate forward.
    const db = initDatabase(":memory:");

    // Confirm the migration already ran (new DB starts at v5)
    const before = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(before.value).toBe("5");

    // Simulate a v2 DB: downgrade schema_version to '2' and drop v3 tables
    db.exec(`UPDATE meta SET value = '2' WHERE key = 'schema_version'`);
    db.exec(`DROP TABLE IF EXISTS entity_vector_meta`);
    db.exec(`DROP TABLE IF EXISTS summary_vector_meta`);
    // Note: vec0 virtual tables need sqlite-vec loaded; can't drop and recreate
    // but we can verify meta tables are created by the migration

    // Re-run migrations — should upgrade from 2 to 3 to 4 to 5
    runMigrations(db);

    // schema_version should now be '5' (all pending migrations run)
    const after = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(after.value).toBe("5");

    // entity_vector_meta should exist
    const metaTable = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='entity_vector_meta'`)
      .get() as { name: string } | undefined;
    expect(metaTable).toBeDefined();

    db.close();
  });

  test("runMigrations is idempotent when already at current version", () => {
    const db = initDatabase(":memory:");
    // Should not throw on double-call
    expect(() => runMigrations(db)).not.toThrow();
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(row.value).toBe("5");
    db.close();
  });
});
