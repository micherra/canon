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

export const DRIFT_SCHEMA_VERSION = "12";

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
    // PRAGMA query failure (e.g., table does not exist) — treat column as absent
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
  {
    up: (db) => {
      // violation_outcomes — records user decisions on reviewer-flagged violations
      // Each workflow produces at most one outcome per (file_path, principle_id) pair.
      // Multiple workflows may record outcomes for the same pair (different slugs).
      // Primary key ensures upsert semantics: last action per workflow wins.
      db.exec(`CREATE TABLE IF NOT EXISTS violation_outcomes (
        file_path    TEXT NOT NULL,
        principle_id TEXT NOT NULL,
        action       TEXT NOT NULL CHECK(action IN ('fix', 'acknowledge', 'defer')),
        slug         TEXT NOT NULL,
        timestamp    TEXT NOT NULL,
        PRIMARY KEY (file_path, principle_id, slug)
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_vo_principle ON violation_outcomes(principle_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_vo_file ON violation_outcomes(file_path)`);
      db.exec(`UPDATE meta SET value = '7' WHERE key = 'schema_version'`);
    },
    version: "7",
  },
  {
    up: (db) => {
      // area_observations — short-term area memory for engineer context enrichment
      // Stores compact observations from reviewers and engineers about a subsystem area.
      // 7-day expiry is enforced at query time via WHERE created_at > datetime('now', '-7 days').
      // injected_count and last_injected_at track observation effectiveness for the learner.
      db.exec(`CREATE TABLE IF NOT EXISTS area_observations (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        subsystem_key    TEXT NOT NULL,
        content          TEXT NOT NULL,
        source           TEXT NOT NULL,
        workflow_slug    TEXT,
        created_at       TEXT NOT NULL,
        injected_count   INTEGER NOT NULL DEFAULT 0,
        last_injected_at TEXT
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_ao_subsystem ON area_observations(subsystem_key)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_ao_created ON area_observations(created_at)`);
      db.exec(`UPDATE meta SET value = '8' WHERE key = 'schema_version'`);
    },
    version: "8",
  },
  {
    up: (db) => {
      // craft_profiles — area-keyed craft score history
      // Stores CraftDimensionRating[] snapshots from reviewers ('review') and
      // periodic audits ('audit'). flow/run_id are review-only (nullable).
      // rollup is a derived display value (nullable). ratings stores
      // a JSON-encoded CraftDimensionRating[].
      db.exec(`CREATE TABLE IF NOT EXISTS craft_profiles (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        subsystem_key TEXT NOT NULL,
        source        TEXT NOT NULL,
        flow          TEXT,
        run_id        TEXT,
        ratings       TEXT NOT NULL,
        rollup        REAL,
        created_at    TEXT NOT NULL
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_craft_subsystem ON craft_profiles(subsystem_key)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_craft_created ON craft_profiles(created_at)`);
      db.exec(`UPDATE meta SET value = '9' WHERE key = 'schema_version'`);
    },
    version: "9",
  },
  {
    up: (db) => {
      // cliff_events — durable aggregation of cliff_detected telemetry events
      // One row per (workspace_slug, step_id); upsert semantics via UNIQUE key.
      // agent_type / missing_count / partial_count are nullable — legacy payloads
      // (pre-enrichment) lack per-step data (backward-compatible-schema-changes).
      // recovery_outcome defaults to 'unknown' (define-errors-out-of-existence).
      db.exec(`CREATE TABLE IF NOT EXISTS cliff_events (
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
      db.exec(`CREATE INDEX IF NOT EXISTS idx_cliff_events_detected ON cliff_events(detected_at)`);
      db.exec(`UPDATE meta SET value = '10' WHERE key = 'schema_version'`);
    },
    version: "10",
  },
  {
    up: (db) => {
      // Violation lifecycle columns — status + resolution provenance (closure-01)
      //
      // NOTE: SQLite ALTER TABLE ADD COLUMN cannot add a CHECK constraint to an existing
      // table reliably across versions, so we add the column with DEFAULT 'open' only.
      // The allowed-value set ('open' | 'resolved') is enforced in the DAO write layer —
      // ViolationClosureDao only ever writes 'resolved' as the non-default value.
      // A CHECK would also be incorrect here for existing databases (SQLite ignores CHECK
      // on ADD COLUMN for pre-existing rows, so it provides no safety benefit in migrations).
      if (!columnExists(db, "violations", "status")) {
        db.exec(`ALTER TABLE violations ADD COLUMN status TEXT NOT NULL DEFAULT 'open'`);
      }
      if (!columnExists(db, "violations", "resolved_at")) {
        db.exec(`ALTER TABLE violations ADD COLUMN resolved_at TEXT`);
      }
      if (!columnExists(db, "violations", "resolved_by_review_id")) {
        db.exec(`ALTER TABLE violations ADD COLUMN resolved_by_review_id TEXT`);
      }
      if (!columnExists(db, "violations", "resolution_reason")) {
        db.exec(`ALTER TABLE violations ADD COLUMN resolution_reason TEXT`);
      }
      // Partial index for fast open-count queries (used by SessionStart pulse and
      // status-filtered reads in ViolationClosureDao)
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_violations_open ON violations(status) WHERE status='open'`,
      );
      db.exec(`UPDATE meta SET value = '11' WHERE key = 'schema_version'`);
    },
    version: "11",
  },
  {
    up: (db) => {
      // applied_evolutions — durable apply-provenance for evolution-candidates.
      // One row per applied proposal; UNIQUE(proposal_id) gives idempotent upsert.
      // principle_id is nullable (null for agent-def cliff targets); apply_base_commit
      // and applying_commit are nullable — the apply command does not commit, so
      // applying_commit is back-filled later from the Canon-Evolution: trailer (ADR-0034).
      // applied_at is the cohort-split anchor for get_evolution_outcomes.
      // No quarantine column now — Inc-4 adds it in its own v13 migration
      // (no-dead-abstractions: only fields written this build).
      db.exec(`CREATE TABLE IF NOT EXISTS applied_evolutions (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        proposal_id        TEXT NOT NULL,
        target_path        TEXT NOT NULL,
        artifact_class     TEXT NOT NULL,
        principle_id       TEXT,
        before_hash        TEXT NOT NULL,
        after_hash         TEXT NOT NULL,
        holdout_baseline   INTEGER NOT NULL,
        holdout_candidate  INTEGER NOT NULL,
        apply_base_commit  TEXT,
        applying_commit    TEXT,
        applied_at         TEXT NOT NULL,
        UNIQUE(proposal_id)
      )`);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_applied_evolutions_applied ON applied_evolutions(applied_at)`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_applied_evolutions_principle ON applied_evolutions(principle_id)`,
      );
      db.exec(`UPDATE meta SET value = '12' WHERE key = 'schema_version'`);
    },
    version: "12",
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
