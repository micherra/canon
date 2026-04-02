/**
 * Drift DB SQLite Schema — project-scoped
 *
 * Manages database creation, PRAGMA configuration, and DDL execution for
 * the project-level drift.db. Stores reviews, violations, and flow runs.
 *
 * All DDL is idempotent (IF NOT EXISTS) and executed in a single transaction.
 * Pattern follows kg-schema.ts.
 */

import Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Schema version — increment when DDL changes require a migration
// ---------------------------------------------------------------------------

export const DRIFT_SCHEMA_VERSION = "1";

// ---------------------------------------------------------------------------
// DDL statements
// ---------------------------------------------------------------------------

const DDL_STATEMENTS = [
  // Meta table for schema versioning
  `CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  `INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '${DRIFT_SCHEMA_VERSION}')`,

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

// ---------------------------------------------------------------------------
// initDriftDb
// ---------------------------------------------------------------------------

/**
 * Open (or create) a better-sqlite3 database at `dbPath`, configure PRAGMAs,
 * and apply the full DDL schema in a single transaction.
 *
 * This function is synchronous — better-sqlite3 is a synchronous library.
 * All DDL statements use IF NOT EXISTS, making repeated calls idempotent.
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

  return db;
}
