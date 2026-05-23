/**
 * Drift DB SQLite Schema — project-scoped
 *
 * Manages database creation, PRAGMA configuration, and DDL execution for
 * the project-level drift.db. Stores reviews, violations, and flow runs.
 *
 * All DDL is idempotent (IF NOT EXISTS) and executed in a single transaction.
 * Pattern follows kg-schema.ts.
 *
 * Migration strategy (ADR-019):
 * - DDL_STATEMENTS contain the v1 base tables.
 * - After applySchema() runs, runDriftMigrations() reads schema_version from meta.
 * - Migrations run version-gated (only when stored version < migration.version).
 * - Each migration.up() is wrapped in db.transaction() for atomicity.
 * - columnExists() guards prevent duplicate ALTER TABLE errors (idempotency).
 */

import Database from "better-sqlite3";

// Schema version — increment when DDL changes require a migration

export const DRIFT_SCHEMA_VERSION = "6";

// DDL statements — v1 base tables
//
// IMPORTANT: Keep these as v1 base DDL. The migration runner adds new columns
// and tables via migrations after applySchema() completes. This ensures that:
// - Fresh DBs: v1 tables created, then migration immediately runs to add v2 schema
// - Existing v1 DBs: IF NOT EXISTS skips table creation, migration adds missing items

const DDL_STATEMENTS = [
  // Meta table for schema versioning
  `CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  `INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')`,

  // Reviews (replaces reviews.jsonl)
  `CREATE TABLE IF NOT EXISTS reviews (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id         TEXT NOT NULL UNIQUE,
    timestamp         TEXT NOT NULL,
    files             TEXT NOT NULL,    -- JSON array
    honored           TEXT NOT NULL,    -- JSON array
    score             TEXT NOT NULL,    -- JSON: {rules, opinions, conventions}
    verdict           TEXT NOT NULL,
    pr_number         INTEGER,
    branch            TEXT,
    last_reviewed_sha TEXT,
    file_priorities   TEXT,             -- JSON array
    recommendations   TEXT             -- JSON array
  )`,

  `CREATE INDEX IF NOT EXISTS idx_reviews_branch ON reviews(branch)`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_pr     ON reviews(pr_number)`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_ts     ON reviews(timestamp)`,

  // Violations (normalized from reviews for indexed queries)
  `CREATE TABLE IF NOT EXISTS violations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id     TEXT NOT NULL REFERENCES reviews(review_id),
    principle_id  TEXT NOT NULL,
    severity      TEXT NOT NULL,
    file_path     TEXT,
    impact_score  REAL,
    message       TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_violations_principle ON violations(principle_id)`,
  `CREATE INDEX IF NOT EXISTS idx_violations_review    ON violations(review_id)`,

  // Flow runs (replaces flow-runs.jsonl)
  `CREATE TABLE IF NOT EXISTS flow_runs (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id                   TEXT NOT NULL UNIQUE,
    flow                     TEXT NOT NULL,
    tier                     TEXT NOT NULL,
    task                     TEXT NOT NULL,
    started                  TEXT NOT NULL,
    completed                TEXT NOT NULL,
    total_duration_ms        INTEGER NOT NULL,
    state_durations          TEXT NOT NULL,   -- JSON
    state_iterations         TEXT NOT NULL,   -- JSON
    skipped_states           TEXT NOT NULL,   -- JSON array
    total_spawns             INTEGER NOT NULL,
    gate_pass_rate           REAL,
    postcondition_pass_rate  REAL,
    total_violations         INTEGER,
    total_test_results       TEXT,            -- JSON
    total_files_changed      INTEGER
  )`,

  `CREATE INDEX IF NOT EXISTS idx_flow_runs_flow ON flow_runs(flow)`,
];

// columnExists — PRAGMA table_info helper
//
// SQLite does not support ALTER TABLE ADD COLUMN IF NOT EXISTS, so we check
// whether a column exists before running ALTER TABLE to ensure idempotency.

/** Allowed characters for a SQLite table identifier. */
const IDENTIFIER_RE = /^[A-Za-z0-9_]+$/;

/**
 * Returns true if the given column exists on the given table.
 * Returns false if the table does not exist or the column is absent.
 *
 * Throws an Error if `table` contains characters outside `[A-Za-z0-9_]`
 * to prevent SQL injection via PRAGMA string interpolation.
 */
export function columnExists(db: Database.Database, table: string, column: string): boolean {
  if (!IDENTIFIER_RE.test(table)) {
    throw new Error(
      `columnExists: invalid table name "${table}" — only [A-Za-z0-9_] characters are allowed`,
    );
  }
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === column);
  } catch {
    return false;
  }
}

type Migration = {
  version: string;
  up: (db: Database.Database) => void;
};

/**
 * Ordered list of schema migrations.
 * Each migration runs only when the stored schema version is less than migration.version.
 * Versions are compared as integers to ensure correct ordering beyond v9.
 */
const MIGRATIONS: Migration[] = [
  {
    up: (db) => {
      // decisions table (ADR-019)
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

      // commits and diff_stat on flow_runs (ADR-019)
      if (!columnExists(db, "flow_runs", "commits")) {
        db.exec(`ALTER TABLE flow_runs ADD COLUMN commits TEXT`);
      }
      if (!columnExists(db, "flow_runs", "diff_stat")) {
        db.exec(`ALTER TABLE flow_runs ADD COLUMN diff_stat TEXT`);
      }

      // Index on completed for time-range queries
      db.exec(`CREATE INDEX IF NOT EXISTS idx_flow_runs_completed ON flow_runs(completed)`);

      db.exec(`UPDATE meta SET value = '2' WHERE key = 'schema_version'`);
    },
    version: "2",
  },
  {
    up: (db) => {
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
    },
    version: "3",
  },
  {
    up: (db) => {
      // file_violation_history — per-file violation aggregates
      db.exec(`CREATE TABLE IF NOT EXISTS file_violation_history (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path       TEXT NOT NULL,
        principle_id    TEXT NOT NULL,
        violation_count INTEGER NOT NULL DEFAULT 0,
        last_seen       TEXT NOT NULL,
        first_seen      TEXT NOT NULL,
        UNIQUE(file_path, principle_id)
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_fvh_file ON file_violation_history(file_path)`);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_fvh_principle ON file_violation_history(principle_id)`,
      );

      // path_effects — per-file-path metadata for signal compilation
      db.exec(`CREATE TABLE IF NOT EXISTS path_effects (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path         TEXT NOT NULL UNIQUE,
        total_violations  INTEGER NOT NULL DEFAULT 0,
        total_reviews     INTEGER NOT NULL DEFAULT 0,
        last_violation_at TEXT,
        last_clean_at     TEXT,
        clean_streak      INTEGER NOT NULL DEFAULT 0,
        violation_streak  INTEGER NOT NULL DEFAULT 0
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_pe_file ON path_effects(file_path)`);

      db.exec(`UPDATE meta SET value = '4' WHERE key = 'schema_version'`);
    },
    version: "4",
  },
  {
    up: (db) => {
      // predictions — stores recordPrediction snapshots for reconciliation
      db.exec(`CREATE TABLE IF NOT EXISTS predictions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        prediction_id   TEXT NOT NULL UNIQUE,
        workspace       TEXT,
        flow_id         TEXT,
        file_paths      TEXT NOT NULL,    -- JSON array of string
        principle_ids   TEXT NOT NULL,    -- JSON array of string
        signals_json    TEXT NOT NULL,    -- JSON: full compiled signals snapshot
        timestamp       TEXT NOT NULL,
        resolved        INTEGER NOT NULL DEFAULT 0,
        resolved_at     TEXT,
        outcome         TEXT              -- JSON: per-pair reconciliation result
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_predictions_resolved ON predictions(resolved)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_predictions_ts ON predictions(timestamp)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_predictions_pid ON predictions(prediction_id)`);
      db.exec(`UPDATE meta SET value = '5' WHERE key = 'schema_version'`);
    },
    version: "5",
  },
  {
    up: (db) => {
      // error_fixes — cross-session error/fix pattern index
      // Stores error_pattern + fix_pattern pairs observed per (file_path, principle_id),
      // with occurrence count and first_seen / last_seen timestamps.
      // UNIQUE(file_path, principle_id) — one aggregated record per file+principle pair.
      db.exec(`CREATE TABLE IF NOT EXISTS error_fixes (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path      TEXT NOT NULL,
        principle_id   TEXT NOT NULL,
        error_pattern  TEXT NOT NULL,
        fix_pattern    TEXT NOT NULL,
        occurrences    INTEGER NOT NULL DEFAULT 0,
        last_seen      TEXT NOT NULL,
        first_seen     TEXT NOT NULL,
        UNIQUE(file_path, principle_id)
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_ef_file ON error_fixes(file_path)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_ef_principle ON error_fixes(principle_id)`);
      db.exec(`UPDATE meta SET value = '6' WHERE key = 'schema_version'`);
    },
    version: "6",
  },
];

/**
 * Run any pending migrations against the given database.
 * Version gated: only runs migrations whose version is greater than the current stored version.
 * All DDL in migrations uses IF NOT EXISTS or columnExists guards, making repeated calls safe.
 *
 * Exported for direct testing of upgrade scenarios.
 */
export function runDriftMigrations(db: Database.Database): void {
  const currentRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  let version = currentRow?.value ?? "1";

  for (const migration of MIGRATIONS) {
    if (parseInt(migration.version, 10) > parseInt(version, 10)) {
      const run = db.transaction(() => migration.up(db));
      run();
      version = migration.version;
    }
  }
}

// initDriftDb

/**
 * Open (or create) a better-sqlite3 database at `dbPath`, configure PRAGMAs,
 * apply the full DDL schema, and run any pending migrations.
 *
 * This function is synchronous — better-sqlite3 is a synchronous library.
 * All DDL statements use IF NOT EXISTS, making repeated calls idempotent.
 *
 * Migration strategy:
 * 1. applySchema() runs v1 base DDL (IF NOT EXISTS — safe to re-run)
 * 2. runDriftMigrations() reads schema_version and runs pending migrations
 *
 * Pass ':memory:' for an in-memory database (useful in tests).
 */
export function initDriftDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // WAL mode must be set before table creation for consistent behaviour
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");

  // Execute all DDL inside a single transaction for atomicity and speed
  const applySchema = db.transaction(() => {
    for (const stmt of DDL_STATEMENTS) {
      db.exec(stmt);
    }
  });

  applySchema();

  // Run version-gated migrations (idempotent — IF NOT EXISTS / columnExists guards).
  // New databases start at version '1' (the INSERT OR IGNORE above) and
  // immediately migrate to DRIFT_SCHEMA_VERSION.
  runDriftMigrations(db);

  return db;
}
