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

// Helper: create a v3 database manually (base DDL + migrations v2 + v3, no v4)
// This simulates an existing v3 drift.db before the v4 migration runs.
function createV3Db(): Database.Database {
  const db = createV1Db();

  // Run v2 migration manually
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
  db.exec(`CREATE INDEX IF NOT EXISTS idx_decisions_run ON decisions(run_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions(timestamp)`);
  db.exec(`ALTER TABLE flow_runs ADD COLUMN commits TEXT`);
  db.exec(`ALTER TABLE flow_runs ADD COLUMN diff_stat TEXT`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_flow_runs_completed ON flow_runs(completed)`);
  db.exec(`UPDATE meta SET value = '2' WHERE key = 'schema_version'`);

  // Run v3 migration manually
  db.exec(`CREATE TABLE IF NOT EXISTS build_archives (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    archive_id        TEXT NOT NULL UNIQUE,
    branch            TEXT NOT NULL,
    sanitized_branch  TEXT NOT NULL,
    slug              TEXT NOT NULL,
    flow              TEXT NOT NULL DEFAULT '',
    tier              TEXT NOT NULL DEFAULT '',
    task              TEXT NOT NULL DEFAULT '',
    archived_at       TEXT NOT NULL,
    archive_path      TEXT NOT NULL,
    artifact_types    TEXT NOT NULL DEFAULT '[]',
    has_run_summary   INTEGER NOT NULL DEFAULT 0,
    source_run_id     TEXT
  )`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_build_archives_branch ON build_archives(sanitized_branch)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_build_archives_archived_at ON build_archives(archived_at)`,
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_build_archives_flow ON build_archives(flow)`);
  db.exec(`UPDATE meta SET value = '3' WHERE key = 'schema_version'`);

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
  test("DRIFT_SCHEMA_VERSION is '9'", () => {
    expect(DRIFT_SCHEMA_VERSION).toBe("10");
  });

  test("meta table has schema_version = '9' after init", () => {
    const db = initDriftDb(":memory:");
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(row.value).toBe("10");
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

  test("migrates a v1 DB to current version: updates schema_version to '9'", () => {
    const db = createV1Db();
    runDriftMigrations(db);
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(row.value).toBe("10");
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

// v4 migration — file_violation_history and path_effects tables

describe("initDriftDb — fresh database v4 tables", () => {
  test("DRIFT_SCHEMA_VERSION is '9'", () => {
    expect(DRIFT_SCHEMA_VERSION).toBe("10");
  });

  test("fresh DB has schema_version = '9' after init", () => {
    const db = initDriftDb(":memory:");
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(row.value).toBe("10");
    db.close();
  });

  test("fresh DB creates file_violation_history table with correct columns", () => {
    const db = initDriftDb(":memory:");
    const cols = db.prepare(`PRAGMA table_info(file_violation_history)`).all() as Array<{
      name: string;
    }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("file_path");
    expect(colNames).toContain("principle_id");
    expect(colNames).toContain("violation_count");
    expect(colNames).toContain("last_seen");
    expect(colNames).toContain("first_seen");
    db.close();
  });

  test("fresh DB creates path_effects table with correct columns", () => {
    const db = initDriftDb(":memory:");
    const cols = db.prepare(`PRAGMA table_info(path_effects)`).all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("file_path");
    expect(colNames).toContain("total_violations");
    expect(colNames).toContain("total_reviews");
    expect(colNames).toContain("last_violation_at");
    expect(colNames).toContain("last_clean_at");
    expect(colNames).toContain("clean_streak");
    expect(colNames).toContain("violation_streak");
    db.close();
  });

  test("fresh DB has indexes on file_violation_history", () => {
    const db = initDriftDb(":memory:");
    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='file_violation_history' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_fvh_file");
    expect(indexNames).toContain("idx_fvh_principle");
    db.close();
  });

  test("fresh DB has index on path_effects", () => {
    const db = initDriftDb(":memory:");
    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='path_effects' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_pe_file");
    db.close();
  });
});

describe("runDriftMigrations — v3 to v4 upgrade", () => {
  test("migrates a v3 DB to v4: creates file_violation_history table", () => {
    const db = createV3Db();
    runDriftMigrations(db);

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("file_violation_history");
    db.close();
  });

  test("migrates a v3 DB to v4: creates path_effects table", () => {
    const db = createV3Db();
    runDriftMigrations(db);

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("path_effects");
    db.close();
  });

  test("migrates a v3 DB to current version: updates schema_version to '9'", () => {
    const db = createV3Db();
    runDriftMigrations(db);
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(row.value).toBe("10");
    db.close();
  });
});

describe("runDriftMigrations — v4 idempotency", () => {
  test("calling runDriftMigrations twice on a v4 DB does not error", () => {
    const db = initDriftDb(":memory:");
    expect(() => runDriftMigrations(db)).not.toThrow();
    db.close();
  });

  test("calling v4 migration twice from a v3 DB does not error", () => {
    const db = createV3Db();
    runDriftMigrations(db);
    expect(() => runDriftMigrations(db)).not.toThrow();
    db.close();
  });
});

describe("v4 schema — UNIQUE constraints", () => {
  test("file_violation_history UNIQUE(file_path, principle_id) rejects duplicate", () => {
    const db = initDriftDb(":memory:");
    db.exec(`INSERT INTO file_violation_history (file_path, principle_id, violation_count, last_seen, first_seen)
      VALUES ('src/foo.ts', 'simplicity-first', 1, '2026-01-01', '2026-01-01')`);
    expect(() =>
      db.exec(`INSERT INTO file_violation_history (file_path, principle_id, violation_count, last_seen, first_seen)
        VALUES ('src/foo.ts', 'simplicity-first', 2, '2026-01-02', '2026-01-01')`),
    ).toThrow(/UNIQUE constraint failed/);
    db.close();
  });

  test("file_violation_history allows same file_path with different principle_id", () => {
    const db = initDriftDb(":memory:");
    db.exec(`INSERT INTO file_violation_history (file_path, principle_id, violation_count, last_seen, first_seen)
      VALUES ('src/foo.ts', 'simplicity-first', 1, '2026-01-01', '2026-01-01')`);
    expect(() =>
      db.exec(`INSERT INTO file_violation_history (file_path, principle_id, violation_count, last_seen, first_seen)
        VALUES ('src/foo.ts', 'errors-are-values', 1, '2026-01-01', '2026-01-01')`),
    ).not.toThrow();
    db.close();
  });

  test("path_effects UNIQUE(file_path) rejects duplicate", () => {
    const db = initDriftDb(":memory:");
    db.exec(`INSERT INTO path_effects (file_path, total_violations, total_reviews, clean_streak, violation_streak)
      VALUES ('src/foo.ts', 0, 1, 0, 0)`);
    expect(() =>
      db.exec(`INSERT INTO path_effects (file_path, total_violations, total_reviews, clean_streak, violation_streak)
        VALUES ('src/foo.ts', 1, 2, 0, 0)`),
    ).toThrow(/UNIQUE constraint failed/);
    db.close();
  });

  test("path_effects INSERT OR REPLACE enables upsert pattern", () => {
    const db = initDriftDb(":memory:");
    db.exec(`INSERT INTO path_effects (file_path, total_violations, total_reviews, clean_streak, violation_streak)
      VALUES ('src/foo.ts', 0, 1, 0, 0)`);
    // INSERT OR REPLACE should succeed where plain INSERT would fail
    expect(() =>
      db.exec(`INSERT OR REPLACE INTO path_effects (file_path, total_violations, total_reviews, clean_streak, violation_streak)
        VALUES ('src/foo.ts', 1, 2, 1, 0)`),
    ).not.toThrow();
    const row = db
      .prepare(`SELECT total_violations FROM path_effects WHERE file_path = 'src/foo.ts'`)
      .get() as { total_violations: number };
    expect(row.total_violations).toBe(1);
    db.close();
  });
});
