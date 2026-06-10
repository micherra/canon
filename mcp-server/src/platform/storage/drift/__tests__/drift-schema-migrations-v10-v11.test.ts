/**
 * drift-schema.ts migration tests — v10 (cliff_events) and v11 (violation lifecycle)
 *
 * Covers upgrade paths v9→v10, v10→v11, and v9→v11 (both applied in sequence).
 * Uses in-memory SQLite (:memory:) for speed and isolation.
 *
 * Test plan:
 * - v10 migration creates cliff_events table with correct schema
 * - v11 migration adds lifecycle columns to violations table + idx_violations_open
 * - v9→v10→v11 full upgrade path works end-to-end
 * - Both migrations are idempotent
 */

import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { columnExists, initDriftDb, runDriftMigrations } from "../drift-schema.ts";

// Helper: create a v9 database (all migrations through v9)
function createV9Db(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");

  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.exec(`INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')`);
  db.exec(`CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT, review_id TEXT NOT NULL UNIQUE,
    timestamp TEXT NOT NULL, files TEXT NOT NULL, honored TEXT NOT NULL,
    score TEXT NOT NULL, verdict TEXT NOT NULL, pr_number INTEGER,
    branch TEXT, last_reviewed_sha TEXT, file_priorities TEXT, recommendations TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS violations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id TEXT NOT NULL REFERENCES reviews(review_id),
    principle_id TEXT NOT NULL, severity TEXT NOT NULL,
    file_path TEXT, impact_score REAL, message TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS flow_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL UNIQUE,
    flow TEXT NOT NULL, tier TEXT NOT NULL, task TEXT NOT NULL,
    started TEXT NOT NULL, completed TEXT NOT NULL, total_duration_ms INTEGER NOT NULL,
    state_durations TEXT NOT NULL, state_iterations TEXT NOT NULL, skipped_states TEXT NOT NULL,
    total_spawns INTEGER NOT NULL, gate_pass_rate REAL, postcondition_pass_rate REAL,
    total_violations INTEGER, total_test_results TEXT, total_files_changed INTEGER
  )`);
  // v2
  db.exec(`CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, decision_id TEXT NOT NULL UNIQUE,
    run_id TEXT, flow TEXT, task TEXT, title TEXT NOT NULL, content TEXT NOT NULL,
    file_path TEXT, timestamp TEXT NOT NULL
  )`);
  db.exec(`ALTER TABLE flow_runs ADD COLUMN commits TEXT`);
  db.exec(`ALTER TABLE flow_runs ADD COLUMN diff_stat TEXT`);
  db.exec(`UPDATE meta SET value = '2' WHERE key = 'schema_version'`);
  // v3
  db.exec(`CREATE TABLE IF NOT EXISTS build_archives (
    id INTEGER PRIMARY KEY AUTOINCREMENT, archive_id TEXT NOT NULL UNIQUE,
    branch TEXT NOT NULL, sanitized_branch TEXT NOT NULL, slug TEXT NOT NULL,
    flow TEXT NOT NULL DEFAULT '', tier TEXT NOT NULL DEFAULT '',
    task TEXT NOT NULL DEFAULT '', archived_at TEXT NOT NULL, archive_path TEXT NOT NULL,
    artifact_types TEXT NOT NULL DEFAULT '[]', has_run_summary INTEGER NOT NULL DEFAULT 0,
    source_run_id TEXT
  )`);
  db.exec(`UPDATE meta SET value = '3' WHERE key = 'schema_version'`);
  // v4
  db.exec(`CREATE TABLE IF NOT EXISTS file_violation_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL,
    principle_id TEXT NOT NULL, violation_count INTEGER NOT NULL DEFAULT 0,
    last_seen TEXT NOT NULL, first_seen TEXT NOT NULL, UNIQUE(file_path, principle_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS path_effects (
    id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL UNIQUE,
    total_violations INTEGER NOT NULL DEFAULT 0, total_reviews INTEGER NOT NULL DEFAULT 0,
    last_violation_at TEXT, last_clean_at TEXT, clean_streak INTEGER NOT NULL DEFAULT 0,
    violation_streak INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec(`UPDATE meta SET value = '4' WHERE key = 'schema_version'`);
  // v5
  db.exec(`CREATE TABLE IF NOT EXISTS predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, prediction_id TEXT NOT NULL UNIQUE,
    workspace TEXT, flow_id TEXT, file_paths TEXT NOT NULL, principle_ids TEXT NOT NULL,
    signals_json TEXT NOT NULL, timestamp TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0,
    resolved_at TEXT, outcome TEXT
  )`);
  db.exec(`UPDATE meta SET value = '5' WHERE key = 'schema_version'`);
  // v6
  db.exec(`CREATE TABLE IF NOT EXISTS error_fixes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL, principle_id TEXT NOT NULL,
    error_pattern TEXT NOT NULL, fix_pattern TEXT NOT NULL, occurrences INTEGER NOT NULL DEFAULT 0,
    last_seen TEXT NOT NULL, first_seen TEXT NOT NULL, UNIQUE(file_path, principle_id)
  )`);
  db.exec(`UPDATE meta SET value = '6' WHERE key = 'schema_version'`);
  // v7
  db.exec(`CREATE TABLE IF NOT EXISTS violation_outcomes (
    file_path TEXT NOT NULL, principle_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('fix', 'acknowledge', 'defer')),
    slug TEXT NOT NULL, timestamp TEXT NOT NULL, PRIMARY KEY (file_path, principle_id, slug)
  )`);
  db.exec(`UPDATE meta SET value = '7' WHERE key = 'schema_version'`);
  // v8
  db.exec(`CREATE TABLE IF NOT EXISTS area_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, subsystem_key TEXT NOT NULL,
    content TEXT NOT NULL, source TEXT NOT NULL, workflow_slug TEXT, created_at TEXT NOT NULL,
    injected_count INTEGER NOT NULL DEFAULT 0, last_injected_at TEXT
  )`);
  db.exec(`UPDATE meta SET value = '8' WHERE key = 'schema_version'`);
  // v9
  db.exec(`CREATE TABLE IF NOT EXISTS craft_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT, subsystem_key TEXT NOT NULL, source TEXT NOT NULL,
    flow TEXT, run_id TEXT, ratings TEXT NOT NULL, rollup REAL, created_at TEXT NOT NULL
  )`);
  db.exec(`UPDATE meta SET value = '9' WHERE key = 'schema_version'`);

  return db;
}

// Helper: create a v10 database (all migrations through v10 — cliff_events)
function createV10Db(): Database.Database {
  const v10db = createV9Db();
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

// v9 → v11 full upgrade (both v10 and v11 apply in sequence)

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
