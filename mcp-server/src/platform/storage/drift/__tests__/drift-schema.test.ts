/**
 * drift-schema.ts migration runner tests
 *
 * Tests the v2 migration runner ported from execution-schema.ts pattern.
 * Uses in-memory SQLite (:memory:) for speed and isolation.
 *
 * Test plan:
 * - Fresh DB has schema version 2 with decisions table and flow_runs.commits column
 * - Existing v1 DB (simulated) migrates to v2
 * - Migration is idempotent — running twice does not error
 * - columnExists returns true/false correctly for existing/missing columns
 */

import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import {
  columnExists,
  DRIFT_SCHEMA_VERSION,
  initDriftDb,
  runDriftMigrations,
} from "../drift-schema.ts";

// Helper: create a v1 database manually (base DDL without migration)
// This simulates an existing v1 drift.db on disk before the migration runner existed.
function createV1Db(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");

  // v1 base DDL — mirrors what drift-schema.ts originally had (no decisions table, no commits/diff_stat)
  db.exec(`CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
  db.exec(`INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')`);
  db.exec(`CREATE TABLE IF NOT EXISTS reviews (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id         TEXT NOT NULL UNIQUE,
    timestamp         TEXT NOT NULL,
    files             TEXT NOT NULL,
    honored           TEXT NOT NULL,
    score             TEXT NOT NULL,
    verdict           TEXT NOT NULL,
    pr_number         INTEGER,
    branch            TEXT,
    last_reviewed_sha TEXT,
    file_priorities   TEXT,
    recommendations   TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS violations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id     TEXT NOT NULL REFERENCES reviews(review_id),
    principle_id  TEXT NOT NULL,
    severity      TEXT NOT NULL,
    file_path     TEXT,
    impact_score  REAL,
    message       TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS flow_runs (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id                   TEXT NOT NULL UNIQUE,
    flow                     TEXT NOT NULL,
    tier                     TEXT NOT NULL,
    task                     TEXT NOT NULL,
    started                  TEXT NOT NULL,
    completed                TEXT NOT NULL,
    total_duration_ms        INTEGER NOT NULL,
    state_durations          TEXT NOT NULL,
    state_iterations         TEXT NOT NULL,
    skipped_states           TEXT NOT NULL,
    total_spawns             INTEGER NOT NULL,
    gate_pass_rate           REAL,
    postcondition_pass_rate  REAL,
    total_violations         INTEGER,
    total_test_results       TEXT,
    total_files_changed      INTEGER
  )`);

  return db;
}

// columnExists

describe("columnExists", () => {
  test("returns true for an existing column", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE test_table (id INTEGER PRIMARY KEY, name TEXT)`);
    expect(columnExists(db, "test_table", "name")).toBe(true);
    db.close();
  });

  test("returns false for a missing column", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE test_table (id INTEGER PRIMARY KEY, name TEXT)`);
    expect(columnExists(db, "test_table", "nonexistent_col")).toBe(false);
    db.close();
  });

  test("returns false when the table does not exist", () => {
    const db = new Database(":memory:");
    expect(columnExists(db, "no_such_table", "some_col")).toBe(false);
    db.close();
  });

  test("throws for a table name with invalid characters (SQL injection guard)", () => {
    const db = new Database(":memory:");
    expect(() => columnExists(db, "bad; DROP TABLE meta; --", "col")).toThrow(/invalid table name/);
    db.close();
  });
});

// Fresh DB — schema version 2

describe("initDriftDb — fresh database", () => {
  test("DRIFT_SCHEMA_VERSION is '2'", () => {
    expect(DRIFT_SCHEMA_VERSION).toBe("2");
  });

  test("meta table has schema_version = '2' after init", () => {
    const db = initDriftDb(":memory:");
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(row.value).toBe("2");
    db.close();
  });

  test("decisions table is created on fresh DB", () => {
    const db = initDriftDb(":memory:");
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("decisions");
    db.close();
  });

  test("flow_runs has commits column on fresh DB", () => {
    const db = initDriftDb(":memory:");
    expect(columnExists(db, "flow_runs", "commits")).toBe(true);
    db.close();
  });

  test("flow_runs has diff_stat column on fresh DB", () => {
    const db = initDriftDb(":memory:");
    expect(columnExists(db, "flow_runs", "diff_stat")).toBe(true);
    db.close();
  });

  test("decisions table has all expected columns", () => {
    const db = initDriftDb(":memory:");
    const cols = db.prepare(`PRAGMA table_info(decisions)`).all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("decision_id");
    expect(colNames).toContain("run_id");
    expect(colNames).toContain("flow");
    expect(colNames).toContain("task");
    expect(colNames).toContain("title");
    expect(colNames).toContain("content");
    expect(colNames).toContain("file_path");
    expect(colNames).toContain("timestamp");
    db.close();
  });

  test("decisions table has indexes on run_id and timestamp", () => {
    const db = initDriftDb(":memory:");
    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='decisions' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_decisions_run");
    expect(indexNames).toContain("idx_decisions_ts");
    db.close();
  });
});

// v1 → v2 migration

describe("runDriftMigrations — v1 to v2 upgrade", () => {
  test("migrates a v1 DB to v2: creates decisions table", () => {
    const db = createV1Db();
    runDriftMigrations(db);

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("decisions");
    db.close();
  });

  test("migrates a v1 DB to v2: adds commits column to flow_runs", () => {
    const db = createV1Db();
    runDriftMigrations(db);
    expect(columnExists(db, "flow_runs", "commits")).toBe(true);
    db.close();
  });

  test("migrates a v1 DB to v2: adds diff_stat column to flow_runs", () => {
    const db = createV1Db();
    runDriftMigrations(db);
    expect(columnExists(db, "flow_runs", "diff_stat")).toBe(true);
    db.close();
  });

  test("migrates a v1 DB to v2: updates schema_version to '2'", () => {
    const db = createV1Db();
    runDriftMigrations(db);
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(row.value).toBe("2");
    db.close();
  });

  test("preserves existing flow_run data during migration", () => {
    const db = createV1Db();
    // Insert a row before migrating
    db.exec(`INSERT INTO flow_runs (
      run_id, flow, tier, task, started, completed,
      total_duration_ms, state_durations, state_iterations,
      skipped_states, total_spawns
    ) VALUES (
      'run_v1_001', 'build', 'full', 'Test task',
      '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z',
      3600000, '{}', '{}', '[]', 3
    )`);

    runDriftMigrations(db);

    const row = db.prepare(`SELECT run_id FROM flow_runs WHERE run_id = 'run_v1_001'`).get() as
      | { run_id: string }
      | undefined;
    expect(row?.run_id).toBe("run_v1_001");
    db.close();
  });
});

// Idempotency

describe("runDriftMigrations — idempotency", () => {
  test("calling runDriftMigrations twice on a fresh DB does not error", () => {
    const db = initDriftDb(":memory:");
    expect(() => runDriftMigrations(db)).not.toThrow();
    db.close();
  });

  test("calling runDriftMigrations twice on a v1 DB does not error", () => {
    const db = createV1Db();
    runDriftMigrations(db);
    expect(() => runDriftMigrations(db)).not.toThrow();
    db.close();
  });

  test("running initDriftDb twice on same-path DB is idempotent (IF NOT EXISTS guards)", () => {
    // Two separate in-memory instances (each :memory: open is independent)
    // Testing that the DDL itself is safe to run twice on the same connection
    const db = initDriftDb(":memory:");
    // Manually re-run DDL statements — they should not throw
    expect(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS decisions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        decision_id TEXT NOT NULL UNIQUE,
        run_id      TEXT,
        flow        TEXT,
        task        TEXT,
        title       TEXT NOT NULL,
        content     TEXT NOT NULL,
        file_path   TEXT,
        timestamp   TEXT NOT NULL
      )`);
      db.exec(`ALTER TABLE flow_runs ADD COLUMN commits TEXT`);
    }).toThrow(); // ALTER TABLE on existing column IS expected to throw — the guard prevents this
    db.close();
  });

  test("columnExists guard prevents duplicate ALTER TABLE errors", () => {
    const db = createV1Db();
    // Manually add the column first
    db.exec(`ALTER TABLE flow_runs ADD COLUMN commits TEXT`);
    // Now run migrations — columnExists guard should prevent second ALTER TABLE
    expect(() => runDriftMigrations(db)).not.toThrow();
    db.close();
  });
});
