/**
 * Execution DB SQLite Schema — orchestration.db
 *
 * One database per workspace directory. Replaces board.json, session.json,
 * progress.md, messages, wave events, and event log.
 *
 * All DDL uses IF NOT EXISTS — idempotent on re-init.
 * Schema version is stored in the meta table for future migrations.
 *
 * Migration strategy (ADR dd-01):
 * - DDL_STATEMENTS contain the v1 base tables (no correlation_id).
 * - After applySchema() runs, the migration runner reads schema_version from meta.
 * - If the stored version is < 2, migrateV1ToV2 runs ALTER TABLE ADD COLUMN.
 * - This approach handles both fresh DBs (v1 DDL runs, then v2 migration adds columns)
 *   and existing v1 DBs (IF NOT EXISTS skips tables, migration adds missing columns).
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Schema version — increment when DDL changes require a migration
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = '2';

// ---------------------------------------------------------------------------
// DDL statements — v1 base tables (no correlation_id)
//
// IMPORTANT: Keep these as v1 base DDL. The migration runner adds new columns
// via ALTER TABLE after applySchema() completes. This ensures that:
// - Fresh DBs: v1 tables created, then migration immediately runs to add v2 columns
// - Existing v1 DBs: IF NOT EXISTS skips table creation, migration adds missing columns
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
// columnExists — PRAGMA table_info helper
//
// SQLite does not support ALTER TABLE ADD COLUMN IF NOT EXISTS, so we check
// whether a column exists before running ALTER TABLE to ensure idempotency.
// ---------------------------------------------------------------------------

/**
 * Returns true if the given column exists on the given table.
 * Returns false if the table does not exist or the column is absent.
 * Never throws.
 */
export function columnExists(
  db: Database.Database,
  table: string,
  column: string,
): boolean {
  try {
    const rows = db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    return rows.some((row) => row.name === column);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// migrateV1ToV2 — adds correlation_id columns and indexes
// ---------------------------------------------------------------------------

/**
 * Migrates a v1 database to v2.
 *
 * Changes:
 * - ALTER TABLE execution ADD COLUMN correlation_id TEXT
 * - ALTER TABLE events ADD COLUMN correlation_id TEXT
 * - CREATE INDEX idx_events_correlation ON events(correlation_id)
 * - CREATE INDEX idx_events_correlation_type ON events(correlation_id, type)
 * - Backfill existing execution row (id = 1) with a UUID if correlation_id is NULL
 * - UPDATE meta SET value = '2' WHERE key = 'schema_version'
 *
 * Uses columnExists() to guard ALTER TABLE calls for idempotency.
 * Wrapped in a transaction for atomicity.
 */
function migrateV1ToV2(db: Database.Database): void {
  const migrate = db.transaction(() => {
    // Add correlation_id to execution if not already present
    if (!columnExists(db, 'execution', 'correlation_id')) {
      db.exec(`ALTER TABLE execution ADD COLUMN correlation_id TEXT`);
    }

    // Add correlation_id to events if not already present
    if (!columnExists(db, 'events', 'correlation_id')) {
      db.exec(`ALTER TABLE events ADD COLUMN correlation_id TEXT`);
    }

    // Create indexes (IF NOT EXISTS for idempotency)
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_events_correlation ON events(correlation_id)`,
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_events_correlation_type ON events(correlation_id, type)`,
    );

    // Backfill existing execution row with a UUID (only if row exists and correlation_id is NULL)
    db.prepare(
      `UPDATE execution SET correlation_id = ? WHERE id = 1 AND correlation_id IS NULL`,
    ).run(randomUUID());

    // Bump schema version
    db.prepare(
      `UPDATE meta SET value = '2' WHERE key = 'schema_version'`,
    ).run();
  });

  migrate();
}

// ---------------------------------------------------------------------------
// initExecutionDb
// ---------------------------------------------------------------------------

/**
 * Open (or create) a better-sqlite3 database at `dbPath`, configure PRAGMAs,
 * apply the full DDL schema, and run any pending migrations.
 *
 * Synchronous — better-sqlite3 is a synchronous library.
 * All DDL statements use IF NOT EXISTS, making repeated calls idempotent.
 *
 * Migration strategy:
 * 1. applySchema() runs v1 base DDL (IF NOT EXISTS — safe to re-run)
 * 2. Read schema_version from meta table
 * 3. If version < 2, run migrateV1ToV2()
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

  // Run pending migrations
  const versionRow = db
    .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
    .get() as { value: string } | undefined;

  const storedVersion = versionRow?.value ?? '1';

  if (storedVersion < '2') {
    migrateV1ToV2(db);
  }

  return db;
}
