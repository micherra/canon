/**
 * kg-schema.test.ts
 *
 * Tests for schema v5 migration: community_id column on files table
 * and file_tags table for computed tag storage.
 */

import { initDatabase, runMigrations } from "@graph/kg-schema.ts";
import type Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

// Helper — check whether a table exists
function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName) as { name: string } | undefined;
  return row !== undefined;
}

// Helper — check whether a column exists in a table
function columnExists(db: Database.Database, tableName: string, columnName: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === columnName);
}

// Helper — check whether an index exists
function indexExists(db: Database.Database, indexName: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
    .get(indexName) as { name: string } | undefined;
  return row !== undefined;
}

describe("migration v5 — community_id column and file_tags table", () => {
  test("new database has community_id column on files table", () => {
    const db = initDatabase(":memory:");
    expect(columnExists(db, "files", "community_id")).toBe(true);
    db.close();
  });

  test("new database has file_tags table", () => {
    const db = initDatabase(":memory:");
    expect(tableExists(db, "file_tags")).toBe(true);
    db.close();
  });

  test("file_tags table has correct columns", () => {
    const db = initDatabase(":memory:");
    const cols = db.prepare(`PRAGMA table_info(file_tags)`).all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("file_id");
    expect(colNames).toContain("tag");
    expect(colNames).toContain("source");
    expect(colNames).toContain("confidence");
    db.close();
  });

  test("file_tags has index on tag column", () => {
    const db = initDatabase(":memory:");
    expect(indexExists(db, "idx_file_tags_tag")).toBe(true);
    db.close();
  });

  test("schema_version is 5 after initDatabase", () => {
    const db = initDatabase(":memory:");
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(row.value).toBe("5");
    db.close();
  });

  test("file_tags enforces primary key (file_id, tag)", () => {
    const db = initDatabase(":memory:");
    // Insert a file to satisfy FK
    db.exec(`INSERT INTO files (path, mtime_ms, content_hash, language, layer, last_indexed_at)
             VALUES ('src/A.ts', 0, 'hash1', 'typescript', 'domain', '2024-01-01')`);
    const fileRow = db.prepare(`SELECT file_id FROM files WHERE path = 'src/A.ts'`).get() as {
      file_id: number;
    };

    const insert = db.prepare(
      `INSERT INTO file_tags (file_id, tag, source, confidence) VALUES (?, ?, ?, ?)`,
    );
    insert.run(fileRow.file_id, "backend", "louvain", 0.9);
    // Duplicate (file_id, tag) should throw
    expect(() => insert.run(fileRow.file_id, "backend", "louvain", 0.9)).toThrow();
    db.close();
  });

  test("file_tags enforces FK — inserting with invalid file_id fails", () => {
    const db = initDatabase(":memory:");
    expect(() =>
      db
        .prepare(
          `INSERT INTO file_tags (file_id, tag, source, confidence) VALUES (99999, 'backend', 'louvain', 1.0)`,
        )
        .run(),
    ).toThrow();
    db.close();
  });

  test("migration v5 is idempotent — running runMigrations twice does not error", () => {
    const db = initDatabase(":memory:");
    // Should be a no-op since version is already "5"
    expect(() => runMigrations(db)).not.toThrow();
    db.close();
  });

  test("existing v4 database is upgraded to v5", () => {
    const db = initDatabase(":memory:");

    // Simulate a v4 DB by removing v5 artifacts and downgrading version
    db.exec(`DROP TABLE IF EXISTS file_tags`);
    db.exec(`DROP INDEX IF EXISTS idx_file_tags_tag`);
    // community_id cannot be dropped in SQLite; simulate by not having the tag table
    db.exec(`UPDATE meta SET value = '4' WHERE key = 'schema_version'`);

    // Precondition: file_tags should not exist
    expect(tableExists(db, "file_tags")).toBe(false);

    // Upgrade v4 → v5
    runMigrations(db);

    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(row.value).toBe("5");
    expect(tableExists(db, "file_tags")).toBe(true);
    db.close();
  });
});
