/**
 * Execution DB SQLite Schema — orchestration.db
 *
 * One database per workspace directory. Replaces board.json, session.json,
 * progress.md, messages, wave events, and event log.
 *
 * All DDL uses IF NOT EXISTS — idempotent on re-init.
 * Schema version is stored in the meta table for future migrations.
 */

import Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Schema version — increment when DDL changes require a migration
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = "1";

// ---------------------------------------------------------------------------
// DDL statements
// ---------------------------------------------------------------------------

const DDL_STATEMENTS = [
  // Meta table for schema versioning
  `CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  `INSERT INTO meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}') ON CONFLICT(key) DO UPDATE SET value = excluded.value`,

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
    rolled_back_to  TEXT,
    worktree_path   TEXT,
    worktree_branch TEXT
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
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  // Busy timeout: wait up to 5s on write contention instead of failing
  db.pragma("busy_timeout = 5000");

  // Apply all DDL inside a single transaction for atomicity and speed
  const applySchema = db.transaction(() => {
    for (const stmt of DDL_STATEMENTS) {
      db.exec(stmt);
    }
  });

  applySchema();

  return db;
}
