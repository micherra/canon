/**
 * Knowledge Graph SQLite Schema
 *
 * Manages database creation, PRAGMA configuration, and DDL execution.
 * All DDL is idempotent (IF NOT EXISTS) and executed in a single transaction.
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

// Schema version — increment when DDL changes require a migration

export const SCHEMA_VERSION = "7";

// DDL statements (v1+v2 base schema)

const DDL_STATEMENTS = [
  // Meta table for schema versioning
  `CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  // Note: schema_version is set to '7' for new databases.
  // runMigrations() will upgrade existing v1–v6 databases.
  `INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}')`,

  // Files table
  `CREATE TABLE IF NOT EXISTS files (
    file_id         INTEGER PRIMARY KEY AUTOINCREMENT,
    path            TEXT    NOT NULL UNIQUE,
    mtime_ms        REAL    NOT NULL,
    content_hash    TEXT    NOT NULL,
    language        TEXT    NOT NULL,
    layer           TEXT    NOT NULL DEFAULT 'unknown',
    last_indexed_at TEXT    NOT NULL,
    community_id    INTEGER
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

  // File-level edges
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

  // Hotspot scores — churn × complexity composite scores per file
  `CREATE TABLE IF NOT EXISTS hotspot_scores (
    file_path TEXT PRIMARY KEY,
    churn_raw REAL NOT NULL,
    churn_percentile REAL NOT NULL,
    complexity_raw REAL NOT NULL,
    complexity_pctile REAL NOT NULL,
    score REAL NOT NULL,
    is_hotspot INTEGER NOT NULL DEFAULT 0,
    computed_at_commit TEXT NOT NULL,
    computed_at TEXT NOT NULL
  )`,

  // Co-change edges — statistical co-change correlations between file pairs
  `CREATE TABLE IF NOT EXISTS co_change_edges (
    file_a TEXT NOT NULL,
    file_b TEXT NOT NULL,
    co_commit_count INTEGER NOT NULL,
    jaccard REAL NOT NULL,
    computed_at_commit TEXT NOT NULL,
    computed_at TEXT NOT NULL,
    PRIMARY KEY (file_a, file_b)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_co_change_a ON co_change_edges(file_a)`,
  `CREATE INDEX IF NOT EXISTS idx_co_change_b ON co_change_edges(file_b)`,

  // File tags table — computed tags from community detection and other signals
  `CREATE TABLE IF NOT EXISTS file_tags (
    file_id    INTEGER NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
    tag        TEXT    NOT NULL,
    source     TEXT    NOT NULL,
    confidence REAL    NOT NULL DEFAULT 1.0,
    PRIMARY KEY (file_id, tag)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(tag)`,

  // ── v6: doc corpus tables ──────────────────────────────────────────────────

  // doc_chunks — one row per heading-section chunk from a markdown knowledge doc
  `CREATE TABLE IF NOT EXISTS doc_chunks (
    chunk_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    corpus        TEXT    NOT NULL,
    doc_path      TEXT    NOT NULL,
    heading_path  TEXT,
    chunk_index   INTEGER NOT NULL,
    char_start    INTEGER NOT NULL,
    char_end      INTEGER NOT NULL,
    content       TEXT    NOT NULL,
    content_hash  TEXT    NOT NULL,
    trust_tier    TEXT    NOT NULL DEFAULT 'internal',
    updated_at    TEXT    NOT NULL,
    UNIQUE(corpus, doc_path, chunk_index)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_doc_chunks_corpus   ON doc_chunks(corpus)`,
  `CREATE INDEX IF NOT EXISTS idx_doc_chunks_doc_path ON doc_chunks(corpus, doc_path)`,

  // doc_vectors — vec0 virtual table for semantic KNN over doc chunks
  `CREATE VIRTUAL TABLE IF NOT EXISTS doc_vectors USING vec0(
    chunk_id  INTEGER PRIMARY KEY,
    embedding float[384]
  )`,

  // doc_chunk_meta — shadow table for vector staleness tracking
  `CREATE TABLE IF NOT EXISTS doc_chunk_meta (
    chunk_id    INTEGER PRIMARY KEY REFERENCES doc_chunks(chunk_id) ON DELETE CASCADE,
    text_hash   TEXT NOT NULL,
    model_id    TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  )`,

  // ── v7: decisions/ADRs as a separate KG context table-pair (ADR-0046) ───────

  // context_nodes — one row per decision/ADR/build, discriminated by record_kind.
  // Separate from `files`/`entities`: a decision is not a code entity.
  `CREATE TABLE IF NOT EXISTS context_nodes (
    node_id          TEXT PRIMARY KEY,
    record_kind      TEXT NOT NULL,
    title            TEXT,
    ref_slug         TEXT,
    source_event_id  INTEGER,
    adr_number       TEXT,
    status           TEXT,
    body_excerpt     TEXT,
    updated_at       TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_context_nodes_kind ON context_nodes(record_kind)`,

  // context_edges — typed causal edges between context_nodes (and file paths,
  // by string reference — no FK, since a target may be a file path or principle id).
  `CREATE TABLE IF NOT EXISTS context_edges (
    src        TEXT NOT NULL,
    dst        TEXT NOT NULL,
    edge_type  TEXT NOT NULL,
    evidence   TEXT,
    PRIMARY KEY (src, dst, edge_type)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_context_edges_src ON context_edges(src)`,
  `CREATE INDEX IF NOT EXISTS idx_context_edges_dst ON context_edges(dst)`,
];

// Migration definitions

type Migration = {
  version: string;
  up: (db: Database.Database) => void;
};

/**
 * Ordered list of schema migrations.
 * Each migration runs only when the stored schema version is less than migration.version.
 * Versions are compared as strings — use zero-padded integers if > 9.
 */
const MIGRATIONS: Migration[] = [
  {
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
    version: "3",
  },
  {
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS hotspot_scores (
        file_path TEXT PRIMARY KEY,
        churn_raw REAL NOT NULL,
        churn_percentile REAL NOT NULL,
        complexity_raw REAL NOT NULL,
        complexity_pctile REAL NOT NULL,
        score REAL NOT NULL,
        is_hotspot INTEGER NOT NULL DEFAULT 0,
        computed_at_commit TEXT NOT NULL,
        computed_at TEXT NOT NULL
      )`);
      db.exec(`CREATE TABLE IF NOT EXISTS co_change_edges (
        file_a TEXT NOT NULL,
        file_b TEXT NOT NULL,
        co_commit_count INTEGER NOT NULL,
        jaccard REAL NOT NULL,
        computed_at_commit TEXT NOT NULL,
        computed_at TEXT NOT NULL,
        PRIMARY KEY (file_a, file_b)
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_co_change_a ON co_change_edges(file_a)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_co_change_b ON co_change_edges(file_b)`);
      db.exec(`UPDATE meta SET value = '4' WHERE key = 'schema_version'`);
    },
    version: "4",
  },
  {
    up: (db) => {
      // ALTER TABLE ADD COLUMN does not support IF NOT EXISTS in SQLite < 3.35.
      // The migration is version-gated so it runs only once, but wrap in try/catch
      // as a defensive measure against re-runs during tests or partial failures.
      try {
        db.exec(`ALTER TABLE files ADD COLUMN community_id INTEGER`);
      } catch {
        // Column already exists — idempotent no-op
      }
      db.exec(`CREATE TABLE IF NOT EXISTS file_tags (
        file_id    INTEGER NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
        tag        TEXT    NOT NULL,
        source     TEXT    NOT NULL,
        confidence REAL    NOT NULL DEFAULT 1.0,
        PRIMARY KEY (file_id, tag)
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(tag)`);
      db.exec(`UPDATE meta SET value = '5' WHERE key = 'schema_version'`);
    },
    version: "5",
  },
  {
    up: (db) => {
      // sqlite-vec must be loaded before vec0 DDL — idempotent call.
      sqliteVec.load(db);

      db.exec(`CREATE TABLE IF NOT EXISTS doc_chunks (
        chunk_id      INTEGER PRIMARY KEY AUTOINCREMENT,
        corpus        TEXT    NOT NULL,
        doc_path      TEXT    NOT NULL,
        heading_path  TEXT,
        chunk_index   INTEGER NOT NULL,
        char_start    INTEGER NOT NULL,
        char_end      INTEGER NOT NULL,
        content       TEXT    NOT NULL,
        content_hash  TEXT    NOT NULL,
        trust_tier    TEXT    NOT NULL DEFAULT 'internal',
        updated_at    TEXT    NOT NULL,
        UNIQUE(corpus, doc_path, chunk_index)
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_doc_chunks_corpus   ON doc_chunks(corpus)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_doc_chunks_doc_path ON doc_chunks(corpus, doc_path)`);
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS doc_vectors USING vec0(
        chunk_id  INTEGER PRIMARY KEY,
        embedding float[384]
      )`);
      db.exec(`CREATE TABLE IF NOT EXISTS doc_chunk_meta (
        chunk_id    INTEGER PRIMARY KEY REFERENCES doc_chunks(chunk_id) ON DELETE CASCADE,
        text_hash   TEXT NOT NULL,
        model_id    TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      )`);
      db.exec(`UPDATE meta SET value = '6' WHERE key = 'schema_version'`);
    },
    version: "6",
  },
  {
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS context_nodes (
        node_id          TEXT PRIMARY KEY,
        record_kind      TEXT NOT NULL,
        title            TEXT,
        ref_slug         TEXT,
        source_event_id  INTEGER,
        adr_number       TEXT,
        status           TEXT,
        body_excerpt     TEXT,
        updated_at       TEXT NOT NULL
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_context_nodes_kind ON context_nodes(record_kind)`);
      db.exec(`CREATE TABLE IF NOT EXISTS context_edges (
        src        TEXT NOT NULL,
        dst        TEXT NOT NULL,
        edge_type  TEXT NOT NULL,
        evidence   TEXT,
        PRIMARY KEY (src, dst, edge_type)
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_context_edges_src ON context_edges(src)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_context_edges_dst ON context_edges(dst)`);
      db.exec(`UPDATE meta SET value = '7' WHERE key = 'schema_version'`);
    },
    version: "7",
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
  const currentRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  let version = currentRow?.value ?? "1";

  for (const migration of MIGRATIONS) {
    if (migration.version > version) {
      const run = db.transaction(() => migration.up(db));
      run();
      version = migration.version;
    }
  }
}

// initDatabase

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
