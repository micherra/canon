/**
 * Execution DB SQLite Schema — orchestration.db
 *
 * One database per workspace directory. Replaces board.json, session.json,
 * progress.md, messages, wave events, and event log.
 *
 * All DDL uses IF NOT EXISTS — idempotent on re-init.
 * Schema version is stored in the meta table for future migrations.
 */

import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Schema version — increment when DDL changes require a migration
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = '2';

// ---------------------------------------------------------------------------
// DDL statements
// ---------------------------------------------------------------------------

const DDL_STATEMENTS = [
  // Meta table for schema versioning
  `CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  `INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')`,

  // Execution — singleton row (replaces board.json top-level fields + session.json)
  `CREATE TABLE IF NOT EXISTS execution (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    flow            TEXT NOT NULL,
    task            TEXT NOT NULL,
    entry           TEXT NOT NULL,
    current_state   TEXT NOT NULL,
    base_commit     TEXT NOT NULL,
    started         TEXT NOT NULL,
    last_updated    TEXT NOT NULL,
    blocked         TEXT,
    concerns        TEXT NOT NULL DEFAULT '[]',
    skipped         TEXT NOT NULL DEFAULT '[]',
    metadata        TEXT,
    branch          TEXT NOT NULL,
    sanitized       TEXT NOT NULL,
    created         TEXT NOT NULL,
    original_task   TEXT,
    tier            TEXT NOT NULL,
    flow_name       TEXT NOT NULL,
    slug            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active',
    completed_at    TEXT,
    rolled_back_at  TEXT,
    rolled_back_to  TEXT
  )`,

  // Execution states (replaces board.states)
  `CREATE TABLE IF NOT EXISTS execution_states (
    state_id                  TEXT PRIMARY KEY,
    status                    TEXT NOT NULL DEFAULT 'pending',
    entries                   INTEGER NOT NULL DEFAULT 0,
    entered_at                TEXT,
    completed_at              TEXT,
    result                    TEXT,
    artifacts                 TEXT,
    artifact_history          TEXT,
    error                     TEXT,
    wave                      INTEGER,
    wave_total                INTEGER,
    wave_results              TEXT,
    metrics                   TEXT,
    gate_results              TEXT,
    postcondition_results     TEXT,
    discovered_gates          TEXT,
    discovered_postconditions TEXT,
    parallel_results          TEXT,
    compete_results           TEXT,
    synthesized               INTEGER
  )`,

  // Iterations (replaces board.iterations)
  `CREATE TABLE IF NOT EXISTS iterations (
    state_id    TEXT PRIMARY KEY,
    count       INTEGER NOT NULL DEFAULT 0,
    max         INTEGER NOT NULL,
    history     TEXT NOT NULL DEFAULT '[]',
    cannot_fix  TEXT NOT NULL DEFAULT '[]'
  )`,

  // Progress entries (replaces progress.md)
  `CREATE TABLE IF NOT EXISTS progress_entries (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    line      TEXT NOT NULL,
    timestamp TEXT NOT NULL
  )`,

  // Messages (replaces messages/{channel}/*.md)
  `CREATE TABLE IF NOT EXISTS messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    channel   TEXT NOT NULL,
    sender    TEXT NOT NULL,
    content   TEXT NOT NULL,
    timestamp TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_messages_channel    ON messages(channel)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_channel_ts ON messages(channel, timestamp)`,

  // Wave events (replaces waves/events.jsonl)
  `CREATE TABLE IF NOT EXISTS wave_events (
    id               TEXT PRIMARY KEY,
    type             TEXT NOT NULL,
    payload          TEXT NOT NULL,
    timestamp        TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending',
    applied_at       TEXT,
    resolution       TEXT,
    rejection_reason TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_wave_events_status ON wave_events(status)`,

  // Event log (replaces log.jsonl)
  `CREATE TABLE IF NOT EXISTS events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    type      TEXT NOT NULL,
    payload   TEXT NOT NULL,
    timestamp TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)`,
];

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

interface Migration {
  version: string;
  up: (db: Database.Database) => void;
}

/**
 * Ordered list of schema migrations.
 * Each migration runs only when the stored schema version is less than migration.version.
 * Versions are compared as strings — use zero-padded integers if > 9.
 */
const MIGRATIONS: Migration[] = [
  {
    version: '2',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS iteration_results (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          state_id  TEXT NOT NULL,
          iteration INTEGER NOT NULL,
          status    TEXT NOT NULL,
          data      TEXT NOT NULL DEFAULT '{}',
          timestamp TEXT NOT NULL,
          UNIQUE(state_id, iteration)
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_iteration_results_state ON iteration_results(state_id)`);
      db.exec(`UPDATE meta SET value = '2' WHERE key = 'schema_version'`);
    },
  },
];

/**
 * Run any pending migrations against the given database.
 * Version gated: only runs migrations whose version is greater than the current stored version.
 * All DDL in migrations uses IF NOT EXISTS, making repeated calls safe.
 *
 * Exported for direct testing of upgrade scenarios.
 */
export function runMigrations(db: Database.Database): void {
  const currentRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  const version = currentRow?.value ?? '1';

  for (const migration of MIGRATIONS) {
    if (migration.version > version) {
      migration.up(db);
    }
  }
}

// ---------------------------------------------------------------------------
// initExecutionDb
// ---------------------------------------------------------------------------

/**
 * Open (or create) a better-sqlite3 database at `dbPath`, configure PRAGMAs,
 * and apply the full DDL schema in a single transaction.
 *
 * Synchronous — better-sqlite3 is a synchronous library.
 * All DDL statements use IF NOT EXISTS, making repeated calls idempotent.
 */
export function initExecutionDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // WAL mode for concurrent read/write; must be set before table creation
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  // Busy timeout: wait up to 5s on write contention instead of failing
  db.pragma('busy_timeout = 5000');

  // Apply all DDL inside a single transaction for atomicity and speed
  const applySchema = db.transaction(() => {
    for (const stmt of DDL_STATEMENTS) {
      db.exec(stmt);
    }
  });

  applySchema();

  // Run version-gated migrations (idempotent — IF NOT EXISTS guards).
  // New workspaces start at version '1' (the INSERT OR IGNORE above) and
  // immediately migrate to the current SCHEMA_VERSION.
  runMigrations(db);

  return db;
}
