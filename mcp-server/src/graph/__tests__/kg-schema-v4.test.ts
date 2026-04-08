/**
 * kg-schema-v4.test.ts
 *
 * Tests for migration v4: hotspot_scores and co_change_edges tables.
 */

import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { initDatabase, runMigrations } from "@graph/kg-schema.ts";

// Helper to check if a table exists in a SQLite DB
function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName) as { name: string } | undefined;
  return row !== undefined;
}

// Helper to check if an index exists
function indexExists(db: Database.Database, indexName: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
    .get(indexName) as { name: string } | undefined;
  return row !== undefined;
}

describe("migration v4 — hotspot_scores and co_change_edges", () => {
  test("new database has hotspot_scores table", () => {
    const db = initDatabase(":memory:");
    expect(tableExists(db, "hotspot_scores")).toBe(true);
    db.close();
  });

  test("new database has co_change_edges table", () => {
    const db = initDatabase(":memory:");
    expect(tableExists(db, "co_change_edges")).toBe(true);
    db.close();
  });

  test("co_change_edges has expected indexes", () => {
    const db = initDatabase(":memory:");
    expect(indexExists(db, "idx_co_change_a")).toBe(true);
    expect(indexExists(db, "idx_co_change_b")).toBe(true);
    db.close();
  });

  test("schema_version is 4 after initDatabase", () => {
    const db = initDatabase(":memory:");
    const row = db
      .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
      .get() as { value: string };
    expect(row.value).toBe("4");
    db.close();
  });

  test("hotspot_scores table accepts valid rows", () => {
    const db = initDatabase(":memory:");
    db.prepare(`
      INSERT INTO hotspot_scores
        (file_path, churn_raw, churn_percentile, complexity_raw, complexity_pctile, score, is_hotspot, computed_at_commit, computed_at)
      VALUES
        ('src/foo.ts', 1.5, 0.8, 10.0, 0.75, 0.77, 1, 'abc123', '2026-01-01T00:00:00Z')
    `).run();
    const row = db
      .prepare(`SELECT * FROM hotspot_scores WHERE file_path = 'src/foo.ts'`)
      .get() as { score: number; is_hotspot: number };
    expect(row.score).toBeCloseTo(0.77);
    expect(row.is_hotspot).toBe(1);
    db.close();
  });

  test("co_change_edges table accepts valid rows", () => {
    const db = initDatabase(":memory:");
    db.prepare(`
      INSERT INTO co_change_edges
        (file_a, file_b, co_commit_count, jaccard, computed_at_commit, computed_at)
      VALUES
        ('src/a.ts', 'src/b.ts', 5, 0.42, 'abc123', '2026-01-01T00:00:00Z')
    `).run();
    const row = db
      .prepare(`SELECT * FROM co_change_edges WHERE file_a = 'src/a.ts'`)
      .get() as { file_b: string; jaccard: number };
    expect(row.file_b).toBe("src/b.ts");
    expect(row.jaccard).toBeCloseTo(0.42);
    db.close();
  });

  test("migration v4 is idempotent — running twice does not fail", () => {
    const db = initDatabase(":memory:");
    // Running runMigrations again should be a no-op (version already 4)
    expect(() => runMigrations(db)).not.toThrow();
    db.close();
  });

  test("existing v3 database is upgraded to v4", () => {
    // Use initDatabase to create a fresh DB (starts at v4).
    // Then simulate a downgrade to v3 by resetting the schema_version
    // and dropping the new tables, then re-running runMigrations.
    const db = initDatabase(":memory:");

    // Drop the v4 tables to simulate a v3 DB
    db.exec(`DROP TABLE IF EXISTS hotspot_scores`);
    db.exec(`DROP INDEX IF EXISTS idx_co_change_a`);
    db.exec(`DROP INDEX IF EXISTS idx_co_change_b`);
    db.exec(`DROP TABLE IF EXISTS co_change_edges`);
    db.exec(`UPDATE meta SET value = '3' WHERE key = 'schema_version'`);

    // Verify precondition
    expect(tableExists(db, "hotspot_scores")).toBe(false);
    expect(tableExists(db, "co_change_edges")).toBe(false);

    // Run migrations — should upgrade v3 → v4
    runMigrations(db);

    // Verify upgrade
    const row = db
      .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
      .get() as { value: string };
    expect(row.value).toBe("4");
    expect(tableExists(db, "hotspot_scores")).toBe(true);
    expect(tableExists(db, "co_change_edges")).toBe(true);
    db.close();
  });
});
