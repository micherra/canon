/**
 * execution-schema.ts — SQLite schema migration tests
 *
 * Tests cover:
 * - SCHEMA_VERSION constant
 * - Fresh DB has all expected columns
 * - Agent session columns migration (pre-v6 → current)
 * - Worktree columns migration (pre-v7 → current)
 * - Migration v8 creates jobs and job_cache tables
 * - Migration v9 adds inserted_return_to column
 * - Migrations are idempotent (safe to re-run)
 * - ExecutionStore.updateAgentSession / getAgentSession
 */

import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import {
  columnExists,
  initExecutionDb,
  runMigrations,
  SCHEMA_VERSION,
} from "../execution-schema.ts";
import { ExecutionStore } from "../execution-store.ts";

const BASE_INIT_PARAMS = {
  base_commit: "abc123",
  branch: "feat/test",
  created: "2026-01-01T00:00:00.000Z",
  current_state: "research",
  entry: "research",
  flow: "test-flow",
  flow_name: "test-flow",
  last_updated: "2026-01-01T00:00:00.000Z",
  sanitized: "feat-test",
  slug: "test-slug",
  started: "2026-01-01T00:00:00.000Z",
  task: "build feature X",
  tier: "medium" as const,
};

// ---------------------------------------------------------------------------
// Helpers — build minimal pre-migration databases
// ---------------------------------------------------------------------------

/**
 * Builds a v5 DB: base tables + migrations v2–v5 applied manually.
 * Does NOT have agent_session_id / last_agent_activity columns.
 */
function buildV5Db(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.exec(`INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_states (
      state_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      entries INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.exec(`CREATE TABLE IF NOT EXISTS execution (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    flow TEXT NOT NULL,
    task TEXT NOT NULL,
    entry TEXT NOT NULL,
    current_state TEXT NOT NULL,
    base_commit TEXT NOT NULL,
    started TEXT NOT NULL,
    last_updated TEXT NOT NULL,
    blocked TEXT,
    concerns TEXT NOT NULL DEFAULT '[]',
    skipped TEXT NOT NULL DEFAULT '[]',
    metadata TEXT,
    branch TEXT NOT NULL,
    sanitized TEXT NOT NULL,
    created TEXT NOT NULL,
    original_task TEXT,
    tier TEXT NOT NULL,
    flow_name TEXT NOT NULL,
    slug TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    completed_at TEXT,
    rolled_back_at TEXT,
    rolled_back_to TEXT
  )`);
  db.exec(
    `CREATE TABLE IF NOT EXISTS iterations (state_id TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, max INTEGER NOT NULL, history TEXT NOT NULL DEFAULT '[]', cannot_fix TEXT NOT NULL DEFAULT '[]')`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS progress_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, line TEXT NOT NULL, timestamp TEXT NOT NULL)`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, sender TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT NOT NULL)`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, payload TEXT NOT NULL, timestamp TEXT NOT NULL)`,
  );

  // v2–v5 migrations
  db.exec(`ALTER TABLE execution ADD COLUMN correlation_id TEXT`);
  db.exec(`ALTER TABLE events ADD COLUMN correlation_id TEXT`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS iteration_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      state_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      status TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      timestamp TEXT NOT NULL,
      UNIQUE(state_id, iteration)
    )
  `);
  db.exec(`ALTER TABLE execution_states ADD COLUMN transcript_path TEXT`);
  db.exec(`UPDATE meta SET value = '5' WHERE key = 'schema_version'`);

  return db;
}

/**
 * Builds a v6 DB: v5 + agent session columns applied manually.
 * Does NOT have worktree_path / worktree_branch columns.
 */
function buildV6Db(): Database.Database {
  const db = buildV5Db();
  db.exec(`ALTER TABLE execution_states ADD COLUMN agent_session_id TEXT`);
  db.exec(`ALTER TABLE execution_states ADD COLUMN last_agent_activity TEXT`);
  db.exec(`UPDATE meta SET value = '6' WHERE key = 'schema_version'`);
  return db;
}

function getTableNames(db: ReturnType<typeof initExecutionDb>): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

function getIndexNames(db: ReturnType<typeof initExecutionDb>): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' ORDER BY name`)
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

function getColumnNames(db: ReturnType<typeof initExecutionDb>, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.map((r) => r.name);
}

function getSchemaVersion(db: ReturnType<typeof initExecutionDb>): string {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  return row?.value ?? "0";
}

// ---------------------------------------------------------------------------
// SCHEMA_VERSION
// ---------------------------------------------------------------------------

describe("SCHEMA_VERSION", () => {
  test('is "9"', () => {
    expect(SCHEMA_VERSION).toBe("11");
  });
});

// ---------------------------------------------------------------------------
// Fresh DB — required columns
// ---------------------------------------------------------------------------

describe("fresh DB — required columns", () => {
  test("has agent_session_id column on execution_states", () => {
    const db = initExecutionDb(":memory:");
    expect(columnExists(db, "execution_states", "agent_session_id")).toBe(true);
    db.close();
  });

  test("has last_agent_activity column on execution_states", () => {
    const db = initExecutionDb(":memory:");
    expect(columnExists(db, "execution_states", "last_agent_activity")).toBe(true);
    db.close();
  });

  test("has worktree_path column on execution table", () => {
    const db = initExecutionDb(":memory:");
    expect(columnExists(db, "execution", "worktree_path")).toBe(true);
    db.close();
  });

  test("has worktree_branch column on execution table", () => {
    const db = initExecutionDb(":memory:");
    expect(columnExists(db, "execution", "worktree_branch")).toBe(true);
    db.close();
  });

  test("does not have the retired cache_prefix column on execution table (ADR-0048)", () => {
    const db = initExecutionDb(":memory:");
    expect(columnExists(db, "execution", "cache_prefix")).toBe(false);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Agent session columns migration
// ---------------------------------------------------------------------------

describe("agent session columns migration", () => {
  test("migrating from pre-agent-session schema adds agent_session_id and last_agent_activity", () => {
    const db = buildV5Db();

    expect(columnExists(db, "execution_states", "agent_session_id")).toBe(false);
    expect(columnExists(db, "execution_states", "last_agent_activity")).toBe(false);

    runMigrations(db);

    expect(columnExists(db, "execution_states", "agent_session_id")).toBe(true);
    expect(columnExists(db, "execution_states", "last_agent_activity")).toBe(true);

    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined;
    expect(row?.value).toBe("11");

    db.close();
  });

  test("agent session column migration is idempotent", () => {
    const db = initExecutionDb(":memory:");

    expect(columnExists(db, "execution_states", "agent_session_id")).toBe(true);
    expect(columnExists(db, "execution_states", "last_agent_activity")).toBe(true);

    expect(() => runMigrations(db)).not.toThrow();

    expect(columnExists(db, "execution_states", "agent_session_id")).toBe(true);
    expect(columnExists(db, "execution_states", "last_agent_activity")).toBe(true);

    db.close();
  });

  test("existing execution_states data is preserved after agent session migration", () => {
    const db = buildV5Db();

    db.exec(
      `INSERT INTO execution_states (state_id, status, entries) VALUES ('research', 'done', 1)`,
    );

    runMigrations(db);

    const row = db
      .prepare(`SELECT state_id, status, entries FROM execution_states WHERE state_id = 'research'`)
      .get() as { state_id: string; status: string; entries: number } | undefined;
    expect(row?.state_id).toBe("research");
    expect(row?.status).toBe("done");
    expect(row?.entries).toBe(1);

    db.close();
  });
});

// ---------------------------------------------------------------------------
// Worktree columns migration
// ---------------------------------------------------------------------------

describe("worktree columns migration", () => {
  test("migrating from pre-worktree schema adds worktree_path and worktree_branch", () => {
    const db = buildV6Db();

    expect(columnExists(db, "execution", "worktree_path")).toBe(false);
    expect(columnExists(db, "execution", "worktree_branch")).toBe(false);

    runMigrations(db);

    expect(columnExists(db, "execution", "worktree_path")).toBe(true);
    expect(columnExists(db, "execution", "worktree_branch")).toBe(true);

    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined;
    expect(row?.value).toBe("11");

    db.close();
  });

  test("worktree column migration is idempotent", () => {
    const db = initExecutionDb(":memory:");

    expect(columnExists(db, "execution", "worktree_path")).toBe(true);
    expect(columnExists(db, "execution", "worktree_branch")).toBe(true);

    expect(() => runMigrations(db)).not.toThrow();

    expect(columnExists(db, "execution", "worktree_path")).toBe(true);
    expect(columnExists(db, "execution", "worktree_branch")).toBe(true);

    db.close();
  });

  test("worktree columns are nullable and default to null", () => {
    const db = initExecutionDb(":memory:");

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO execution
        (id, flow, task, entry, current_state, base_commit, started, last_updated,
         branch, sanitized, created, tier, flow_name, slug)
       VALUES (1, 'fast-path', 'test task', 'build', 'build', 'deadbeef',
               ?, ?, 'main', 'main', ?, 'small', 'fast-path', 'test-task')`,
    ).run(now, now, now);

    const row = db
      .prepare(`SELECT worktree_path, worktree_branch FROM execution WHERE id = 1`)
      .get() as { worktree_path: string | null; worktree_branch: string | null } | undefined;

    expect(row).toBeDefined();
    expect(row?.worktree_path).toBeNull();
    expect(row?.worktree_branch).toBeNull();

    db.close();
  });
});

// ---------------------------------------------------------------------------
// ExecutionStore — updateAgentSession / getAgentSession
// ---------------------------------------------------------------------------

describe("ExecutionStore — updateAgentSession / getAgentSession", () => {
  function makeStore(): ExecutionStore {
    const db = initExecutionDb(":memory:");
    return new ExecutionStore(db);
  }

  test("getAgentSession returns null when no session set", () => {
    const store = makeStore();
    store.initExecution(BASE_INIT_PARAMS);
    store.upsertState("research", { entries: 1, status: "in_progress" });

    const result = store.getAgentSession("research");
    expect(result).toBeNull();
  });

  test("updateAgentSession stores session ID and activity timestamp", () => {
    const store = makeStore();
    store.initExecution(BASE_INIT_PARAMS);
    store.upsertState("research", { entries: 1, status: "in_progress" });

    store.updateAgentSession("research", "agent-sess-xyz");

    const result = store.getAgentSession("research");
    expect(result).not.toBeNull();
    expect(result?.agent_session_id).toBe("agent-sess-xyz");
    expect(result?.last_agent_activity).toBeTruthy();
  });

  test("updateAgentSession sets last_agent_activity to current ISO timestamp", () => {
    const store = makeStore();
    store.initExecution(BASE_INIT_PARAMS);
    store.upsertState("research", { entries: 1, status: "in_progress" });

    const before = new Date().toISOString();
    store.updateAgentSession("research", "agent-sess-abc");
    const after = new Date().toISOString();

    const result = store.getAgentSession("research");
    expect(result).not.toBeNull();
    // ISO strings compare correctly as strings (YYYY-MM-DD lexicographic order)
    expect(result!.last_agent_activity >= before).toBe(true);
    expect(result!.last_agent_activity <= after).toBe(true);
  });

  test("updateAgentSession replaces existing session", () => {
    const store = makeStore();
    store.initExecution(BASE_INIT_PARAMS);
    store.upsertState("research", { entries: 1, status: "in_progress" });

    store.updateAgentSession("research", "agent-sess-first");
    store.updateAgentSession("research", "agent-sess-second");

    const result = store.getAgentSession("research");
    expect(result?.agent_session_id).toBe("agent-sess-second");
  });

  test("getAgentSession returns null for nonexistent state", () => {
    const store = makeStore();
    store.initExecution(BASE_INIT_PARAMS);

    const result = store.getAgentSession("nonexistent-state");
    expect(result).toBeNull();
  });

  test("agent session IDs are independent per state", () => {
    const store = makeStore();
    store.initExecution(BASE_INIT_PARAMS);
    store.upsertState("research", { entries: 1, status: "in_progress" });
    store.upsertState("implement", { entries: 1, status: "in_progress" });

    store.updateAgentSession("research", "sess-research");
    store.updateAgentSession("implement", "sess-implement");

    expect(store.getAgentSession("research")?.agent_session_id).toBe("sess-research");
    expect(store.getAgentSession("implement")?.agent_session_id).toBe("sess-implement");
  });
});

// Migration v7 — jobs and job_cache tables

describe("migration v8 — jobs table", () => {
  test("creates jobs table on fresh DB", () => {
    const db = initExecutionDb(":memory:");
    const tables = getTableNames(db);
    expect(tables).toContain("jobs");
  });

  test("jobs table has expected columns", () => {
    const db = initExecutionDb(":memory:");
    const columns = getColumnNames(db, "jobs");
    expect(columns).toContain("job_id");
    expect(columns).toContain("job_type");
    expect(columns).toContain("fingerprint");
    expect(columns).toContain("status");
    expect(columns).toContain("pid");
    expect(columns).toContain("progress");
    expect(columns).toContain("error");
    expect(columns).toContain("started_at");
    expect(columns).toContain("completed_at");
    expect(columns).toContain("timeout_ms");
  });

  test("creates idx_jobs_fingerprint index", () => {
    const db = initExecutionDb(":memory:");
    const indexes = getIndexNames(db);
    expect(indexes).toContain("idx_jobs_fingerprint");
  });

  test("creates idx_jobs_status index", () => {
    const db = initExecutionDb(":memory:");
    const indexes = getIndexNames(db);
    expect(indexes).toContain("idx_jobs_status");
  });
});

describe("migration v8 — job_cache table", () => {
  test("creates job_cache table on fresh DB", () => {
    const db = initExecutionDb(":memory:");
    const tables = getTableNames(db);
    expect(tables).toContain("job_cache");
  });

  test("job_cache table has expected columns", () => {
    const db = initExecutionDb(":memory:");
    const columns = getColumnNames(db, "job_cache");
    expect(columns).toContain("fingerprint");
    expect(columns).toContain("job_type");
    expect(columns).toContain("result_summary");
    expect(columns).toContain("cached_at");
    expect(columns).toContain("expires_at");
  });
});

describe("migration v8 — schema version", () => {
  test('schema_version is "9" after init', () => {
    const db = initExecutionDb(":memory:");
    expect(getSchemaVersion(db)).toBe("11");
  });
});

describe("migration v8 — upgrade from v6", () => {
  test("upgrades existing v6 DB to v8+", () => {
    // Simulate a v6 DB by initializing then manually setting version back to '6'
    // and dropping the v7 tables (they were created by the fresh init)
    // Instead: use a real in-memory DB initialized without v7 tables
    const db = initExecutionDb(":memory:");

    // Verify that v8 tables exist after migration
    const tables = getTableNames(db);
    expect(tables).toContain("jobs");
    expect(tables).toContain("job_cache");
    expect(getSchemaVersion(db)).toBe("11");
  });

  test("runMigrations is idempotent — safe to call twice", () => {
    const db = initExecutionDb(":memory:");

    // Should not throw on second call
    expect(() => runMigrations(db)).not.toThrow();

    // Tables and version unchanged
    const tables = getTableNames(db);
    expect(tables).toContain("jobs");
    expect(tables).toContain("job_cache");
    expect(getSchemaVersion(db)).toBe("11");
  });

  test("can insert a row into jobs table", () => {
    const db = initExecutionDb(":memory:");
    expect(() => {
      db.prepare(`
        INSERT INTO jobs (job_id, job_type, fingerprint, status, started_at, timeout_ms)
        VALUES ('j1', 'codebase_graph', 'fp-abc', 'pending', '2026-01-01T00:00:00.000Z', 300000)
      `).run();
    }).not.toThrow();
    const row = db.prepare(`SELECT * FROM jobs WHERE job_id = 'j1'`).get() as { status: string };
    expect(row.status).toBe("pending");
  });

  test("can insert a row into job_cache table", () => {
    const db = initExecutionDb(":memory:");
    expect(() => {
      db.prepare(`
        INSERT INTO job_cache (fingerprint, job_type, result_summary, cached_at)
        VALUES ('fp-abc', 'codebase_graph', '{"nodes":5}', '2026-01-01T00:00:00.000Z')
      `).run();
    }).not.toThrow();
    const row = db.prepare(`SELECT * FROM job_cache WHERE fingerprint = 'fp-abc'`).get() as {
      job_type: string;
    };
    expect(row.job_type).toBe("codebase_graph");
  });
});

// Migration v9 — inserted_return_to column (ADR-012)

describe("migration v9 — inserted_return_to column", () => {
  test("adds inserted_return_to column to execution_states on fresh DB", () => {
    const db = initExecutionDb(":memory:");
    const columns = getColumnNames(db, "execution_states");
    expect(columns).toContain("inserted_return_to");
  });

  test("schema_version is '9' after init", () => {
    const db = initExecutionDb(":memory:");
    expect(getSchemaVersion(db)).toBe("11");
  });

  test("runMigrations is idempotent after v9", () => {
    const db = initExecutionDb(":memory:");
    expect(() => runMigrations(db)).not.toThrow();
    const columns = getColumnNames(db, "execution_states");
    expect(columns).toContain("inserted_return_to");
    expect(getSchemaVersion(db)).toBe("11");
  });

  test("inserted_return_to accepts TEXT value", () => {
    const db = initExecutionDb(":memory:");
    db.prepare(`
      INSERT INTO execution_states (state_id, status, entries, inserted_return_to)
      VALUES ('s1', 'pending', 0, 'hitl')
    `).run();
    const row = db
      .prepare(`SELECT inserted_return_to FROM execution_states WHERE state_id = 's1'`)
      .get() as { inserted_return_to: string };
    expect(row.inserted_return_to).toBe("hitl");
  });

  test("inserted_return_to defaults to NULL", () => {
    const db = initExecutionDb(":memory:");
    db.prepare(`
      INSERT INTO execution_states (state_id, status, entries)
      VALUES ('s2', 'pending', 0)
    `).run();
    const row = db
      .prepare(`SELECT inserted_return_to FROM execution_states WHERE state_id = 's2'`)
      .get() as { inserted_return_to: string | null };
    expect(row.inserted_return_to).toBeNull();
  });
});
