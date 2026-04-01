/**
 * Tests for schema migration runner and v2 DDL
 *
 * Tests:
 * 1. Fresh DB at v2 has correlation_id columns on execution and events tables
 * 2. v1 DB (created without correlation_id) is migrated to v2 — columns exist, data preserved
 * 3. v1 DB with existing execution row gets correlation_id backfilled with valid UUID
 * 4. v1 DB with existing event rows preserves them (correlation_id is NULL)
 * 5. Migration is idempotent — running initExecutionDb twice does not error
 * 6. columnExists helper returns correct boolean for existing and non-existing columns
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import {
  initExecutionDb,
  SCHEMA_VERSION,
  columnExists,
} from "../orchestration/execution-schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpFiles: string[] = [];

function makeTmpDb(prefix = "schema-migration-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpFiles.push(dir);
  return join(dir, "orchestration.db");
}

/** Creates a v1 database without correlation_id columns, simulating a pre-v2 DB. */
function createV1Db(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");

  // Create the v1 schema manually (no correlation_id columns)
  db.exec(`CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
  db.exec(`INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')`);

  db.exec(`CREATE TABLE IF NOT EXISTS execution (
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
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    type      TEXT NOT NULL,
    payload   TEXT NOT NULL,
    timestamp TEXT NOT NULL
  )`);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)`);

  return db;
}

afterEach(() => {
  for (const dir of tmpFiles) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpFiles = [];
});

// ---------------------------------------------------------------------------
// 1. Fresh database at v2 has correlation_id columns
// ---------------------------------------------------------------------------

describe("fresh database v2 schema", () => {
  it("SCHEMA_VERSION is '2'", () => {
    expect(SCHEMA_VERSION).toBe("2");
  });

  it("fresh DB has correlation_id column on execution table", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);

    expect(columnExists(db, "execution", "correlation_id")).toBe(true);

    db.close();
  });

  it("fresh DB has correlation_id column on events table", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);

    expect(columnExists(db, "events", "correlation_id")).toBe(true);

    db.close();
  });

  it("fresh DB has correlation_id indexes on events table", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'")
      .all() as Array<{ name: string }>;

    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_events_correlation");
    expect(indexNames).toContain("idx_events_correlation_type");

    db.close();
  });

  it("fresh DB meta table has schema_version '2'", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);

    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;

    expect(row?.value).toBe("2");

    db.close();
  });
});

// ---------------------------------------------------------------------------
// 2. v1 database is migrated to v2 — columns exist, data preserved
// ---------------------------------------------------------------------------

describe("v1 to v2 migration", () => {
  it("migrates v1 DB to v2: correlation_id column exists on execution after migration", () => {
    const dbPath = makeTmpDb();
    const v1db = createV1Db(dbPath);
    v1db.close();

    // Now open with initExecutionDb — should trigger migration
    const db = initExecutionDb(dbPath);

    expect(columnExists(db, "execution", "correlation_id")).toBe(true);

    db.close();
  });

  it("migrates v1 DB to v2: correlation_id column exists on events after migration", () => {
    const dbPath = makeTmpDb();
    const v1db = createV1Db(dbPath);
    v1db.close();

    const db = initExecutionDb(dbPath);

    expect(columnExists(db, "events", "correlation_id")).toBe(true);

    db.close();
  });

  it("migrates v1 DB to v2: schema_version updated to '2' in meta table", () => {
    const dbPath = makeTmpDb();
    const v1db = createV1Db(dbPath);
    v1db.close();

    const db = initExecutionDb(dbPath);

    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;

    expect(row?.value).toBe("2");

    db.close();
  });

  it("migration preserves existing execution row data", () => {
    const dbPath = makeTmpDb();
    const v1db = createV1Db(dbPath);

    const now = new Date().toISOString();
    v1db
      .prepare(
        `INSERT INTO execution
          (id, flow, task, entry, current_state, base_commit, started, last_updated,
           branch, sanitized, created, tier, flow_name, slug)
         VALUES (1, 'quick-fix', 'test task', 'build', 'build', 'deadbeef',
                 ?, ?, 'main', 'main', ?, 'small', 'quick-fix', 'test-task')`,
      )
      .run(now, now, now);

    v1db.close();

    const db = initExecutionDb(dbPath);

    const row = db
      .prepare("SELECT flow, task, entry, current_state FROM execution WHERE id = 1")
      .get() as { flow: string; task: string; entry: string; current_state: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.flow).toBe("quick-fix");
    expect(row!.task).toBe("test task");
    expect(row!.entry).toBe("build");
    expect(row!.current_state).toBe("build");

    db.close();
  });
});

// ---------------------------------------------------------------------------
// 3. Existing execution row gets correlation_id backfilled with valid UUID
// ---------------------------------------------------------------------------

describe("correlation_id backfill", () => {
  it("existing execution row gets correlation_id backfilled with a valid UUID after migration", () => {
    const dbPath = makeTmpDb();
    const v1db = createV1Db(dbPath);

    const now = new Date().toISOString();
    v1db
      .prepare(
        `INSERT INTO execution
          (id, flow, task, entry, current_state, base_commit, started, last_updated,
           branch, sanitized, created, tier, flow_name, slug)
         VALUES (1, 'quick-fix', 'test task', 'build', 'build', 'deadbeef',
                 ?, ?, 'main', 'main', ?, 'small', 'quick-fix', 'test-task')`,
      )
      .run(now, now, now);

    v1db.close();

    const db = initExecutionDb(dbPath);

    const row = db
      .prepare("SELECT correlation_id FROM execution WHERE id = 1")
      .get() as { correlation_id: string | null } | undefined;

    expect(row).toBeDefined();
    expect(row!.correlation_id).not.toBeNull();

    // Validate it's a UUID (8-4-4-4-12 hex format)
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(row!.correlation_id).toMatch(uuidRegex);

    db.close();
  });

  it("no execution row means no backfill error (graceful no-op)", () => {
    const dbPath = makeTmpDb();
    const v1db = createV1Db(dbPath);
    v1db.close();

    // Should not throw even though execution row doesn't exist
    expect(() => initExecutionDb(dbPath)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. Existing event rows preserved (correlation_id is NULL for pre-v2 rows)
// ---------------------------------------------------------------------------

describe("existing event rows preserved after migration", () => {
  it("pre-migration event rows have NULL correlation_id after migration", () => {
    const dbPath = makeTmpDb();
    const v1db = createV1Db(dbPath);

    const now = new Date().toISOString();
    v1db
      .prepare(
        `INSERT INTO events (type, payload, timestamp)
         VALUES ('state_completed', '{"stateId":"build"}', ?)`,
      )
      .run(now);

    v1db
      .prepare(
        `INSERT INTO events (type, payload, timestamp)
         VALUES ('transition_evaluated', '{"condition":"done"}', ?)`,
      )
      .run(now);

    v1db.close();

    const db = initExecutionDb(dbPath);

    const events = db
      .prepare("SELECT type, payload, correlation_id FROM events ORDER BY id ASC")
      .all() as Array<{ type: string; payload: string; correlation_id: string | null }>;

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("state_completed");
    expect(events[0].correlation_id).toBeNull();
    expect(events[1].type).toBe("transition_evaluated");
    expect(events[1].correlation_id).toBeNull();

    db.close();
  });
});

// ---------------------------------------------------------------------------
// 5. Migration is idempotent
// ---------------------------------------------------------------------------

describe("migration idempotency", () => {
  it("calling initExecutionDb twice on the same DB does not throw", () => {
    const dbPath = makeTmpDb();

    const db1 = initExecutionDb(dbPath);
    db1.close();

    // Second call should not error
    expect(() => {
      const db2 = initExecutionDb(dbPath);
      db2.close();
    }).not.toThrow();
  });

  it("running migration on already-migrated v1 DB is idempotent", () => {
    const dbPath = makeTmpDb();
    const v1db = createV1Db(dbPath);
    v1db.close();

    const db1 = initExecutionDb(dbPath);
    db1.close();

    // Second open should not error (migration already applied)
    expect(() => {
      const db2 = initExecutionDb(dbPath);
      db2.close();
    }).not.toThrow();
  });

  it("schema_version is still '2' after two consecutive inits", () => {
    const dbPath = makeTmpDb();

    const db1 = initExecutionDb(dbPath);
    db1.close();

    const db2 = initExecutionDb(dbPath);

    const row = db2
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;

    expect(row?.value).toBe("2");

    db2.close();
  });
});

// ---------------------------------------------------------------------------
// 6. columnExists helper
// ---------------------------------------------------------------------------

describe("columnExists helper", () => {
  it("returns true for a column that exists on the table", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);

    // Known existing columns
    expect(columnExists(db, "execution", "id")).toBe(true);
    expect(columnExists(db, "execution", "flow")).toBe(true);
    expect(columnExists(db, "events", "type")).toBe(true);
    expect(columnExists(db, "events", "payload")).toBe(true);

    db.close();
  });

  it("returns false for a column that does not exist on the table", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);

    expect(columnExists(db, "execution", "nonexistent_column")).toBe(false);
    expect(columnExists(db, "events", "bogus_field")).toBe(false);

    db.close();
  });

  it("returns false for a column on a nonexistent table (does not throw)", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);

    // Nonexistent table — should return false, not throw
    expect(columnExists(db, "nonexistent_table", "some_column")).toBe(false);

    db.close();
  });

  it("throws on table names containing non-identifier characters (SQL injection guard)", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);

    // Table names with SQL metacharacters must be rejected
    expect(() => columnExists(db, "execution; DROP TABLE meta", "id")).toThrow();
    expect(() => columnExists(db, "execution--comment", "id")).toThrow();
    expect(() => columnExists(db, "execution' OR '1'='1", "id")).toThrow();

    db.close();
  });

  it("accepts valid identifier characters (letters, digits, underscores)", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);

    // Valid table names that exist — should work fine
    expect(() => columnExists(db, "execution", "id")).not.toThrow();
    expect(() => columnExists(db, "execution_states", "state_id")).not.toThrow();
    expect(() => columnExists(db, "wave_events", "id")).not.toThrow();

    db.close();
  });
});

// ---------------------------------------------------------------------------
// 7. Schema version integer comparison
// ---------------------------------------------------------------------------

describe("schema version comparison uses integer parsing", () => {
  it("runMigrations runs migration when stored version is '1' (integer 1 < 2)", () => {
    // Create a DB that stays at v1 (no correlation_id columns yet)
    const dbPath = makeTmpDb();
    const v1db = createV1Db(dbPath);
    v1db.close();

    // Opening with initExecutionDb triggers migration — should NOT throw
    // and should produce schema version '2'
    const db = initExecutionDb(dbPath);

    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;

    // Migration ran — version upgraded to 2
    expect(row?.value).toBe("2");
    db.close();
  });

  it("runMigrations does NOT run migration when stored version is '2' (already migrated)", () => {
    // Fresh DB — already at v2 after initExecutionDb
    const dbPath = makeTmpDb();
    const db1 = initExecutionDb(dbPath);
    // Both correlation_id indexes exist after first init
    const indexesBefore = (db1
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'")
      .all() as Array<{ name: string }>).map((i) => i.name);
    db1.close();

    // Second init must not error (idempotent)
    const db2 = initExecutionDb(dbPath);
    const indexesAfter = (db2
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'")
      .all() as Array<{ name: string }>).map((i) => i.name);
    db2.close();

    // Index count must not change — migration did not re-run
    expect(indexesBefore.length).toEqual(indexesAfter.length);
  });
});
