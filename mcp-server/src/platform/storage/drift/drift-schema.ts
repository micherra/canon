/**
 * Drift DB SQLite Schema — project-scoped
 *
 * Manages database creation, PRAGMA configuration, DDL execution, and migrations
 * for the project-level drift.db. Stores reviews, violations, flow runs, and decisions.
 *
 * All DDL is idempotent (IF NOT EXISTS) and executed in a single transaction.
 * Migrations are version-gated and applied atomically.
 * Pattern follows execution-schema.ts.
 */

import Database from "better-sqlite3";

// Schema version — increment when DDL changes require a migration

export const DRIFT_SCHEMA_VERSION = "3";

// DDL statements — baseline schema (no decisions; decisions added in v2/v3)

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

// Migration helpers

/** Check whether a column exists on a table. */
function columnExists(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

type Migration = {
  version: string;
  run: (db: Database.Database) => void;
};

// MIGRATIONS — append only, never modify existing entries

const MIGRATIONS: Migration[] = [
  {
    // v2: Add commits + diff_stat to flow_runs; add decisions table (simplified schema)
    version: "2",
    run: (db) => {
      if (!columnExists(db, "flow_runs", "commits")) {
        db.exec(`ALTER TABLE flow_runs ADD COLUMN commits TEXT`);
      }
      if (!columnExists(db, "flow_runs", "diff_stat")) {
        db.exec(`ALTER TABLE flow_runs ADD COLUMN diff_stat TEXT`);
      }

      db.exec(`CREATE TABLE IF NOT EXISTS decisions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        decision_id  TEXT NOT NULL UNIQUE,
        run_id       TEXT REFERENCES flow_runs(run_id),
        flow         TEXT,
        task         TEXT,
        title        TEXT NOT NULL,
        content      TEXT NOT NULL,
        file_path    TEXT,
        timestamp    TEXT NOT NULL
      )`);

      db.exec(`CREATE INDEX IF NOT EXISTS idx_decisions_run ON decisions(run_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_decisions_ts  ON decisions(timestamp)`);

      db.exec(`UPDATE meta SET value = '2' WHERE key = 'schema_version'`);
    },
  },
  {
    // v3: Add ADR-019 columns to decisions table + FTS5 virtual table
    version: "3",
    run: (db) => {
      // ADR-specified columns added to the existing decisions table
      if (!columnExists(db, "decisions", "decision_type")) {
        db.exec(`ALTER TABLE decisions ADD COLUMN decision_type TEXT`);
      }
      if (!columnExists(db, "decisions", "summary")) {
        db.exec(`ALTER TABLE decisions ADD COLUMN summary TEXT`);
      }
      if (!columnExists(db, "decisions", "rationale")) {
        db.exec(`ALTER TABLE decisions ADD COLUMN rationale TEXT`);
      }
      if (!columnExists(db, "decisions", "alternatives")) {
        db.exec(`ALTER TABLE decisions ADD COLUMN alternatives TEXT`); // JSON array
      }
      if (!columnExists(db, "decisions", "evidence_ref")) {
        db.exec(`ALTER TABLE decisions ADD COLUMN evidence_ref TEXT`);
      }
      if (!columnExists(db, "decisions", "files_affected")) {
        db.exec(`ALTER TABLE decisions ADD COLUMN files_affected TEXT`); // JSON array
      }

      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_decisions_files ON decisions(files_affected)`,
      );

      // FTS5 virtual table for topic search
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(
        entity_type,
        entity_id,
        content,
        tokenize='porter unicode61'
      )`);

      db.exec(`UPDATE meta SET value = '3' WHERE key = 'schema_version'`);
    },
  },
];

// runDriftMigrations

/**
 * Run any pending migrations against the given database.
 * Reads the current schema_version from the meta table and applies
 * all migrations with a version > current. Each migration runs inside
 * its own transaction for atomicity.
 *
 * Safe to call repeatedly (no-op when already at target version).
 */
export function runDriftMigrations(db: Database.Database): void {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;

  const currentVersion = parseInt(row?.value ?? "1", 10);

  for (const migration of MIGRATIONS) {
    const migrationVersion = parseInt(migration.version, 10);
    if (migrationVersion <= currentVersion) continue;

    const applyMigration = db.transaction(() => {
      migration.run(db);
    });

    applyMigration();
  }
}

// initDriftDb

/**
 * Open (or create) a better-sqlite3 database at `dbPath`, configure PRAGMAs,
 * apply the full DDL schema in a single transaction, and run any pending
 * migrations.
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

  // Execute baseline DDL inside a single transaction for atomicity and speed
  const applySchema = db.transaction(() => {
    for (const stmt of DDL_STATEMENTS) {
      db.exec(stmt);
    }
  });

  applySchema();

  // Apply any pending migrations
  runDriftMigrations(db);

  return db;
}
