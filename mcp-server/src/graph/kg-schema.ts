/**
 * Knowledge Graph SQLite Schema
 *
 * Manages database creation, PRAGMA configuration, and DDL execution.
 * All DDL is idempotent (IF NOT EXISTS) and executed in a single transaction.
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

// ---------------------------------------------------------------------------
// Schema version — increment when DDL changes require a migration
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = "3";

// ---------------------------------------------------------------------------
// DDL statements (v1+v2 base schema)
// ---------------------------------------------------------------------------

const DDL_STATEMENTS = [
  // Meta table for schema versioning
  `CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  // Note: schema_version is set to '3' for new databases.
  // runMigrations() will upgrade existing v1/v2 databases.
  `INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}')`,

  // Files table
  `CREATE TABLE IF NOT EXISTS files (
    file_id         INTEGER PRIMARY KEY AUTOINCREMENT,
    path            TEXT    NOT NULL UNIQUE,
    mtime_ms        REAL    NOT NULL,
    content_hash    TEXT    NOT NULL,
    language        TEXT    NOT NULL,
    layer           TEXT    NOT NULL DEFAULT 'unknown',
    last_indexed_at TEXT    NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_files_path     ON files(path)`,
  `CREATE INDEX IF NOT EXISTS idx_files_language ON files(language)`,

  // Entities table
  `CREATE TABLE IF NOT EXISTS entities (
    entity_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id            INTEGER NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
    name               TEXT    NOT NULL,
    qualified_name     TEXT    NOT NULL,
    kind               TEXT    NOT NULL,
    line_start         INTEGER,
    line_end           INTEGER,
    is_exported        INTEGER NOT NULL DEFAULT 0,
    is_default_export  INTEGER NOT NULL DEFAULT 0,
    signature          TEXT,
    metadata           TEXT,
    UNIQUE(file_id, qualified_name)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_entities_file      ON entities(file_id)`,
  `CREATE INDEX IF NOT EXISTS idx_entities_kind      ON entities(kind)`,
  `CREATE INDEX IF NOT EXISTS idx_entities_name      ON entities(name)`,
  `CREATE INDEX IF NOT EXISTS idx_entities_qualified ON entities(qualified_name)`,
  `CREATE INDEX IF NOT EXISTS idx_entities_exported  ON entities(is_exported) WHERE is_exported = 1`,

  // Entity-level edges
  `CREATE TABLE IF NOT EXISTS edges (
    edge_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source_entity_id INTEGER NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
    target_entity_id INTEGER NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
    edge_type        TEXT    NOT NULL,
    confidence       REAL    NOT NULL DEFAULT 1.0,
    metadata         TEXT,
    UNIQUE(source_entity_id, target_entity_id, edge_type)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_entity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_entity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_type   ON edges(edge_type)`,

  // File-level edges (backward compat with graph-data.json)
  `CREATE TABLE IF NOT EXISTS file_edges (
    file_edge_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    source_file_id INTEGER NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
    target_file_id INTEGER NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
    edge_type      TEXT    NOT NULL,
    confidence     REAL    NOT NULL DEFAULT 1.0,
    evidence       TEXT,
    relation       TEXT,
    UNIQUE(source_file_id, target_file_id, edge_type)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_file_edges_source ON file_edges(source_file_id)`,
  `CREATE INDEX IF NOT EXISTS idx_file_edges_target ON file_edges(target_file_id)`,

  // FTS5 virtual table for entity full-text search
  `CREATE VIRTUAL TABLE IF NOT EXISTS entity_fts USING fts5(
    name, qualified_name, signature,
    content=entities, content_rowid=entity_id
  )`,

  // FTS sync triggers — keep entity_fts consistent with entities rows
  `CREATE TRIGGER IF NOT EXISTS entities_ai AFTER INSERT ON entities BEGIN
    INSERT INTO entity_fts(rowid, name, qualified_name, signature)
    VALUES (new.entity_id, new.name, new.qualified_name, new.signature);
  END`,

  `CREATE TRIGGER IF NOT EXISTS entities_ad AFTER DELETE ON entities BEGIN
    INSERT INTO entity_fts(entity_fts, rowid, name, qualified_name, signature)
    VALUES ('delete', old.entity_id, old.name, old.qualified_name, old.signature);
  END`,

  `CREATE TRIGGER IF NOT EXISTS entities_au AFTER UPDATE ON entities BEGIN
    INSERT INTO entity_fts(entity_fts, rowid, name, qualified_name, signature)
    VALUES ('delete', old.entity_id, old.name, old.qualified_name, old.signature);
    INSERT INTO entity_fts(rowid, name, qualified_name, signature)
    VALUES (new.entity_id, new.name, new.qualified_name, new.signature);
  END`,

  // Summaries table — stores AI-generated summaries for files and entities
  `CREATE TABLE IF NOT EXISTS summaries (
    summary_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id      INTEGER NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
    entity_id    INTEGER REFERENCES entities(entity_id) ON DELETE CASCADE,
    scope        TEXT NOT NULL DEFAULT 'file',
    summary      TEXT NOT NULL,
    model        TEXT,
    content_hash TEXT,
    updated_at   TEXT NOT NULL,
    UNIQUE(file_id, entity_id, scope)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_summaries_file  ON summaries(file_id)`,
  `CREATE INDEX IF NOT EXISTS idx_summaries_scope ON summaries(scope)`,

  // vec0 virtual tables for semantic search (require sqlite-vec extension loaded)
  `CREATE VIRTUAL TABLE IF NOT EXISTS entity_vectors USING vec0(
    entity_id INTEGER PRIMARY KEY,
    embedding float[384]
  )`,

  `CREATE VIRTUAL TABLE IF NOT EXISTS summary_vectors USING vec0(
    summary_id INTEGER PRIMARY KEY,
    embedding float[384]
  )`,

  // Shadow meta tables for vector staleness tracking
  // (vec0 doesn't support extra columns, so we use separate tables)
  `CREATE TABLE IF NOT EXISTS entity_vector_meta (
    entity_id   INTEGER PRIMARY KEY REFERENCES entities(entity_id) ON DELETE CASCADE,
    text_hash   TEXT NOT NULL,
    model_id    TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS summary_vector_meta (
    summary_id  INTEGER PRIMARY KEY REFERENCES summaries(summary_id) ON DELETE CASCADE,
    text_hash   TEXT NOT NULL,
    model_id    TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  )`,
];

// ---------------------------------------------------------------------------
// Migration definitions
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
    version: "3",
    up: (db) => {
      // sqlite-vec extension must be loaded before vec0 DDL executes.
      // Load is idempotent — safe to call multiple times.
      sqliteVec.load(db);

      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS entity_vectors USING vec0(
        entity_id INTEGER PRIMARY KEY,
        embedding float[384]
      )`);

      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS summary_vectors USING vec0(
        summary_id INTEGER PRIMARY KEY,
        embedding float[384]
      )`);

      db.exec(`CREATE TABLE IF NOT EXISTS entity_vector_meta (
        entity_id   INTEGER PRIMARY KEY REFERENCES entities(entity_id) ON DELETE CASCADE,
        text_hash   TEXT NOT NULL,
        model_id    TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      )`);

      db.exec(`CREATE TABLE IF NOT EXISTS summary_vector_meta (
        summary_id  INTEGER PRIMARY KEY REFERENCES summaries(summary_id) ON DELETE CASCADE,
        text_hash   TEXT NOT NULL,
        model_id    TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      )`);

      db.exec(`UPDATE meta SET value = '3' WHERE key = 'schema_version'`);
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
  const currentRow = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  let version = currentRow?.value ?? "1";

  for (const migration of MIGRATIONS) {
    if (migration.version > version) {
      const run = db.transaction(() => migration.up(db));
      run();
      version = migration.version;
    }
  }
}

// ---------------------------------------------------------------------------
// initDatabase
// ---------------------------------------------------------------------------

/**
 * Open (or create) a better-sqlite3 database at `dbPath`, configure PRAGMAs,
 * and apply the full DDL schema in a single transaction.
 *
 * This function is synchronous — better-sqlite3 is a synchronous library.
 * All DDL statements use IF NOT EXISTS, making repeated calls idempotent.
 *
 * sqlite-vec extension is loaded before DDL execution so that vec0 virtual
 * tables can be created as part of the initial schema.
 */
export function initDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // WAL mode must be set before table creation for consistent behaviour
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  // Busy timeout: wait up to 5s on write contention instead of failing immediately
  // Prevents SQLITE_BUSY errors when child process writes concurrently with parent reads
  db.pragma("busy_timeout = 5000");

  // Load sqlite-vec extension BEFORE DDL — vec0 tables require it
  sqliteVec.load(db);

  // Execute all DDL inside a single transaction for atomicity and speed
  const applySchema = db.transaction(() => {
    for (const stmt of DDL_STATEMENTS) {
      db.exec(stmt);
    }
  });

  applySchema();

  // Run version-gated migrations (idempotent — IF NOT EXISTS guards).
  // New databases start at version '3' (the INSERT OR IGNORE above) and
  // have no pending migrations. Existing v1/v2 databases are upgraded here.
  runMigrations(db);

  return db;
}
