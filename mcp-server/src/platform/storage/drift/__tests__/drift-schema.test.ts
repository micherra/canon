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

// Helper: create a v9 database (all migrations through v9)
function createV9Db(): Database.Database {
  const db = initDriftDb(":memory:");
  // initDriftDb runs all migrations up to DRIFT_SCHEMA_VERSION (now "11")
  // so we need to manually create a v9-only DB
  // Build a fresh DB and undo the v10/v11 migration: not feasible with in-memory SQLite,
  // so instead we create a raw v1 DB and run only up to v9 manually
  db.close();
  // Build v9 by creating fresh v1 and running manual v9 migrations
  const v9db = new Database(":memory:");
  v9db.pragma("journal_mode = WAL");
  v9db.pragma("foreign_keys = ON");
  v9db.pragma("synchronous = NORMAL");
  v9db.pragma("busy_timeout = 5000");

  // v1 base DDL
  v9db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  v9db.exec(`INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')`);
  v9db.exec(`CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT, review_id TEXT NOT NULL UNIQUE,
    timestamp TEXT NOT NULL, files TEXT NOT NULL, honored TEXT NOT NULL,
    score TEXT NOT NULL, verdict TEXT NOT NULL, pr_number INTEGER,
    branch TEXT, last_reviewed_sha TEXT, file_priorities TEXT, recommendations TEXT
  )`);
  v9db.exec(`CREATE TABLE IF NOT EXISTS violations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id TEXT NOT NULL REFERENCES reviews(review_id),
    principle_id TEXT NOT NULL, severity TEXT NOT NULL,
    file_path TEXT, impact_score REAL, message TEXT
  )`);
  v9db.exec(`CREATE TABLE IF NOT EXISTS flow_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL UNIQUE,
    flow TEXT NOT NULL, tier TEXT NOT NULL, task TEXT NOT NULL,
    started TEXT NOT NULL, completed TEXT NOT NULL, total_duration_ms INTEGER NOT NULL,
    state_durations TEXT NOT NULL, state_iterations TEXT NOT NULL, skipped_states TEXT NOT NULL,
    total_spawns INTEGER NOT NULL, gate_pass_rate REAL, postcondition_pass_rate REAL,
    total_violations INTEGER, total_test_results TEXT, total_files_changed INTEGER
  )`);

  // v2
  v9db.exec(`CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, decision_id TEXT NOT NULL UNIQUE,
    run_id TEXT, flow TEXT, task TEXT, title TEXT NOT NULL, content TEXT NOT NULL,
    file_path TEXT, timestamp TEXT NOT NULL
  )`);
  v9db.exec(`ALTER TABLE flow_runs ADD COLUMN commits TEXT`);
  v9db.exec(`ALTER TABLE flow_runs ADD COLUMN diff_stat TEXT`);
  v9db.exec(`UPDATE meta SET value = '2' WHERE key = 'schema_version'`);

  // v3
  v9db.exec(`CREATE TABLE IF NOT EXISTS build_archives (
    id INTEGER PRIMARY KEY AUTOINCREMENT, archive_id TEXT NOT NULL UNIQUE,
    branch TEXT NOT NULL, sanitized_branch TEXT NOT NULL, slug TEXT NOT NULL,
    flow TEXT NOT NULL DEFAULT '', tier TEXT NOT NULL DEFAULT '',
    task TEXT NOT NULL DEFAULT '', archived_at TEXT NOT NULL, archive_path TEXT NOT NULL,
    artifact_types TEXT NOT NULL DEFAULT '[]', has_run_summary INTEGER NOT NULL DEFAULT 0,
    source_run_id TEXT
  )`);
  v9db.exec(`UPDATE meta SET value = '3' WHERE key = 'schema_version'`);

  // v4
  v9db.exec(`CREATE TABLE IF NOT EXISTS file_violation_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL,
    principle_id TEXT NOT NULL, violation_count INTEGER NOT NULL DEFAULT 0,
    last_seen TEXT NOT NULL, first_seen TEXT NOT NULL, UNIQUE(file_path, principle_id)
  )`);
  v9db.exec(`CREATE TABLE IF NOT EXISTS path_effects (
    id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL UNIQUE,
    total_violations INTEGER NOT NULL DEFAULT 0, total_reviews INTEGER NOT NULL DEFAULT 0,
    last_violation_at TEXT, last_clean_at TEXT, clean_streak INTEGER NOT NULL DEFAULT 0,
    violation_streak INTEGER NOT NULL DEFAULT 0
  )`);
  v9db.exec(`UPDATE meta SET value = '4' WHERE key = 'schema_version'`);

  // v5
  v9db.exec(`CREATE TABLE IF NOT EXISTS predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, prediction_id TEXT NOT NULL UNIQUE,
    workspace TEXT, flow_id TEXT, file_paths TEXT NOT NULL, principle_ids TEXT NOT NULL,
    signals_json TEXT NOT NULL, timestamp TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0,
    resolved_at TEXT, outcome TEXT
  )`);
  v9db.exec(`UPDATE meta SET value = '5' WHERE key = 'schema_version'`);

  // v6
  v9db.exec(`CREATE TABLE IF NOT EXISTS error_fixes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL, principle_id TEXT NOT NULL,
    error_pattern TEXT NOT NULL, fix_pattern TEXT NOT NULL, occurrences INTEGER NOT NULL DEFAULT 0,
    last_seen TEXT NOT NULL, first_seen TEXT NOT NULL, UNIQUE(file_path, principle_id)
  )`);
  v9db.exec(`UPDATE meta SET value = '6' WHERE key = 'schema_version'`);

  // v7
  v9db.exec(`CREATE TABLE IF NOT EXISTS violation_outcomes (
    file_path TEXT NOT NULL, principle_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('fix', 'acknowledge', 'defer')),
    slug TEXT NOT NULL, timestamp TEXT NOT NULL, PRIMARY KEY (file_path, principle_id, slug)
  )`);
  v9db.exec(`UPDATE meta SET value = '7' WHERE key = 'schema_version'`);

  // v8
  v9db.exec(`CREATE TABLE IF NOT EXISTS area_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, subsystem_key TEXT NOT NULL,
    content TEXT NOT NULL, source TEXT NOT NULL, workflow_slug TEXT, created_at TEXT NOT NULL,
    injected_count INTEGER NOT NULL DEFAULT 0, last_injected_at TEXT
  )`);
  v9db.exec(`UPDATE meta SET value = '8' WHERE key = 'schema_version'`);

  // v9
  v9db.exec(`CREATE TABLE IF NOT EXISTS craft_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT, subsystem_key TEXT NOT NULL, source TEXT NOT NULL,
    flow TEXT, run_id TEXT, ratings TEXT NOT NULL, rollup REAL, created_at TEXT NOT NULL
  )`);
  v9db.exec(`UPDATE meta SET value = '9' WHERE key = 'schema_version'`);

  return v9db;
}

// Helper: create a v10 database (all migrations through v10 — cliff_events)
function createV10Db(): Database.Database {
  const v10db = createV9Db();
  // v10 — cliff_events
  v10db.exec(`CREATE TABLE IF NOT EXISTS cliff_events (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_slug   TEXT NOT NULL,
    step_id          TEXT NOT NULL,
    agent_type       TEXT,
    source           TEXT NOT NULL,
    detected_at      TEXT NOT NULL,
    missing_count    INTEGER,
    partial_count    INTEGER,
    recovery_outcome TEXT NOT NULL DEFAULT 'unknown',
    recorded_at      TEXT NOT NULL,
    UNIQUE(workspace_slug, step_id)
  )`);
  v10db.exec(`CREATE INDEX IF NOT EXISTS idx_cliff_events_detected ON cliff_events(detected_at)`);
  v10db.exec(`UPDATE meta SET value = '10' WHERE key = 'schema_version'`);
  return v10db;
}

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

// Fresh DB — schema version 11

describe("initDriftDb — fresh database", () => {
  test("DRIFT_SCHEMA_VERSION is '11'", () => {
    expect(DRIFT_SCHEMA_VERSION).toBe("11");
  });

  test("meta table has schema_version = '11' after init", () => {
    const db = initDriftDb(":memory:");
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(row.value).toBe("11");
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

  test("migrates a v1 DB to current version: updates schema_version to '11'", () => {
    const db = createV1Db();
    runDriftMigrations(db);
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(row.value).toBe("11");
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
  test("DRIFT_SCHEMA_VERSION is '11'", () => {
    expect(DRIFT_SCHEMA_VERSION).toBe("11");
  });

  test("fresh DB has schema_version = '11' after init", () => {
    const db = initDriftDb(":memory:");
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(row.value).toBe("11");
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

  test("migrates a v3 DB to current version: updates schema_version to '11'", () => {
    const db = createV3Db();
    runDriftMigrations(db);
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(row.value).toBe("11");
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

// v10 migration — cliff_events table

describe("initDriftDb — fresh database v10 cliff_events", () => {
  test("fresh DB creates cliff_events table", () => {
    const db = initDriftDb(":memory:");
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("cliff_events");
    db.close();
  });

  test("cliff_events table has all expected columns", () => {
    const db = initDriftDb(":memory:");
    const cols = db.prepare(`PRAGMA table_info(cliff_events)`).all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("workspace_slug");
    expect(colNames).toContain("step_id");
    expect(colNames).toContain("agent_type");
    expect(colNames).toContain("source");
    expect(colNames).toContain("detected_at");
    expect(colNames).toContain("missing_count");
    expect(colNames).toContain("partial_count");
    expect(colNames).toContain("recovery_outcome");
    expect(colNames).toContain("recorded_at");
    db.close();
  });

  test("cliff_events has idx_cliff_events_detected index", () => {
    const db = initDriftDb(":memory:");
    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='cliff_events' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain("idx_cliff_events_detected");
    db.close();
  });
});

describe("runDriftMigrations — v9 to v10 upgrade (cliff_events)", () => {
  test("migrates a v9 DB: creates cliff_events table", () => {
    const db = createV9Db();
    runDriftMigrations(db);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("cliff_events");
    db.close();
  });

  test("migrates a v9 DB: schema_version advances past 10 to '11'", () => {
    const db = createV9Db();
    runDriftMigrations(db);
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(row.value).toBe("11");
    db.close();
  });
});

// v11 migration — violation lifecycle columns

describe("initDriftDb — fresh database v11 columns", () => {
  test("fresh DB has all 4 v11 lifecycle columns on violations", () => {
    const db = initDriftDb(":memory:");
    expect(columnExists(db, "violations", "status")).toBe(true);
    expect(columnExists(db, "violations", "resolved_at")).toBe(true);
    expect(columnExists(db, "violations", "resolved_by_review_id")).toBe(true);
    expect(columnExists(db, "violations", "resolution_reason")).toBe(true);
    db.close();
  });

  test("fresh DB has partial index idx_violations_open", () => {
    const db = initDriftDb(":memory:");
    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='violations' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_violations_open");
    db.close();
  });

  test("violations inserted without status default to 'open'", () => {
    const db = initDriftDb(":memory:");
    // Insert a review first (FK constraint)
    db.exec(`INSERT INTO reviews (review_id, timestamp, files, honored, score, verdict)
      VALUES ('r1', '2026-01-01', '[]', '[]', '{}', 'CLEAN')`);
    db.exec(`INSERT INTO violations (review_id, principle_id, severity)
      VALUES ('r1', 'simplicity-first', 'warning')`);
    const row = db.prepare(`SELECT status FROM violations WHERE review_id = 'r1'`).get() as {
      status: string;
    };
    expect(row.status).toBe("open");
    db.close();
  });

  test("DRIFT_SCHEMA_VERSION is '11'", () => {
    expect(DRIFT_SCHEMA_VERSION).toBe("11");
  });
});

describe("runDriftMigrations — v10 to v11 upgrade (lifecycle columns)", () => {
  test("migrates a v10 DB: adds status column with default 'open'", () => {
    const db = createV10Db();
    runDriftMigrations(db);
    expect(columnExists(db, "violations", "status")).toBe(true);
    db.close();
  });

  test("migrates a v10 DB: adds resolved_at column", () => {
    const db = createV10Db();
    runDriftMigrations(db);
    expect(columnExists(db, "violations", "resolved_at")).toBe(true);
    db.close();
  });

  test("migrates a v10 DB: adds resolved_by_review_id column", () => {
    const db = createV10Db();
    runDriftMigrations(db);
    expect(columnExists(db, "violations", "resolved_by_review_id")).toBe(true);
    db.close();
  });

  test("migrates a v10 DB: adds resolution_reason column", () => {
    const db = createV10Db();
    runDriftMigrations(db);
    expect(columnExists(db, "violations", "resolution_reason")).toBe(true);
    db.close();
  });

  test("migrates a v10 DB: adds idx_violations_open partial index", () => {
    const db = createV10Db();
    runDriftMigrations(db);
    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='violations' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_violations_open");
    db.close();
  });

  test("pre-existing violation rows default to status='open' after migration", () => {
    const db = createV10Db();
    // Insert violation row before migration
    db.exec(`INSERT INTO reviews (review_id, timestamp, files, honored, score, verdict)
      VALUES ('rev-pre', '2026-01-01', '[]', '[]', '{}', 'BLOCKING')`);
    db.exec(`INSERT INTO violations (review_id, principle_id, severity)
      VALUES ('rev-pre', 'some-principle', 'rule')`);

    runDriftMigrations(db);

    const row = db.prepare(`SELECT status FROM violations WHERE review_id = 'rev-pre'`).get() as {
      status: string;
    };
    expect(row.status).toBe("open");
    db.close();
  });

  test("v10→v11 migration updates schema_version to '11'", () => {
    const db = createV10Db();
    runDriftMigrations(db);
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(row.value).toBe("11");
    db.close();
  });
});

// Also test v9 → v11 (both v10 and v11 apply in sequence)
describe("runDriftMigrations — v9 to v11 full upgrade", () => {
  test("migrates a v9 DB: creates cliff_events AND adds lifecycle columns", () => {
    const db = createV9Db();
    runDriftMigrations(db);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("cliff_events");
    expect(columnExists(db, "violations", "status")).toBe(true);
    expect(columnExists(db, "violations", "resolved_at")).toBe(true);
    db.close();
  });

  test("migrates a v9 DB: schema_version reaches '11'", () => {
    const db = createV9Db();
    runDriftMigrations(db);
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(row.value).toBe("11");
    db.close();
  });
});

describe("runDriftMigrations — v11 idempotency", () => {
  test("calling runDriftMigrations twice on a v11 DB does not error", () => {
    const db = initDriftDb(":memory:");
    expect(() => runDriftMigrations(db)).not.toThrow();
    db.close();
  });

  test("calling v11 migration twice from a v10 DB does not error", () => {
    const db = createV10Db();
    runDriftMigrations(db);
    expect(() => runDriftMigrations(db)).not.toThrow();
    db.close();
  });
});
