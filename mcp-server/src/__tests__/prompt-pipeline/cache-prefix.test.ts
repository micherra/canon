/**
 * Tests for ADR-006a cache prefix infrastructure:
 * - Schema migration v4 adds cache_prefix column
 * - ExecutionStore.getCachePrefix / setCachePrefix
 * - init-workspace computes and stores prefix
 *
 * Tests use in-memory SQLite or temp dirs for isolation.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import {
  initExecutionDb,
  SCHEMA_VERSION,
  columnExists,
  runMigrations,
} from "../../orchestration/execution-schema.ts";
import { ExecutionStore, getExecutionStore, clearStoreCache } from "../../orchestration/execution-store.ts";

// ---------------------------------------------------------------------------
// Mock loadAndResolveFlow + git adapter so initWorkspaceFlow is testable
// ---------------------------------------------------------------------------

vi.mock("../../orchestration/flow-parser.ts", () => ({
  loadAndResolveFlow: vi.fn().mockResolvedValue({
    name: "fast-path",
    description: "A fast single-agent pipeline for small tasks.",
    entry: "build",
    states: {
      build: { type: "single", transitions: { done: "done" } },
      done: { type: "terminal" },
    },
    spawn_instructions: {},
  }),
}));

vi.mock("../../adapters/git-adapter.ts", () => ({
  gitStatus: vi.fn().mockReturnValue({ ok: true, stdout: "", stderr: "", exitCode: 0, timedOut: false }),
  gitWorktreeAdd: vi.fn().mockReturnValue({ ok: false }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpDir(prefix = "cache-prefix-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function makeTmpProjectDir(): string {
  return makeTmpDir("cache-prefix-ws-");
}

/** Creates a v3 database (schema before cache_prefix column) to simulate an existing workspace. */
function createV3Db(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");

  // Create meta table at v3
  db.exec(`CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
  db.exec(`INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '3')`);

  // Create execution table WITHOUT cache_prefix column (v3 state)
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
    rolled_back_to  TEXT,
    correlation_id  TEXT
  )`);

  // Create iteration_results table (required by v3 migration check)
  db.exec(`CREATE TABLE IF NOT EXISTS iteration_results (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    state_id  TEXT NOT NULL,
    iteration INTEGER NOT NULL,
    status    TEXT NOT NULL,
    data      TEXT NOT NULL DEFAULT '{}',
    timestamp TEXT NOT NULL,
    UNIQUE(state_id, iteration)
  )`);

  return db;
}

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

// ---------------------------------------------------------------------------
// 1. Schema migration v4 adds cache_prefix column
// ---------------------------------------------------------------------------

describe("schema migration v4 — cache_prefix column", () => {
  it("SCHEMA_VERSION is '5' (v4 adds cache_prefix, v5 adds transcript_path)", () => {
    expect(SCHEMA_VERSION).toBe("5");
  });

  it("fresh DB has cache_prefix column on execution table", () => {
    const db = initExecutionDb(":memory:");
    expect(columnExists(db, "execution", "cache_prefix")).toBe(true);
    db.close();
  });

  it("fresh DB meta has schema_version '5'", () => {
    const db = initExecutionDb(":memory:");
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    expect(row?.value).toBe("5");
    db.close();
  });

  it("v3 DB migrates to v4: cache_prefix column added", () => {
    const dbPath = join(makeTmpDir(), "orchestration.db");
    const v3db = createV3Db(dbPath);
    v3db.close();

    const db = initExecutionDb(dbPath);
    expect(columnExists(db, "execution", "cache_prefix")).toBe(true);
    db.close();
  });

  it("v3 DB migrates to v5: schema_version updated to '5'", () => {
    const dbPath = join(makeTmpDir(), "orchestration.db");
    const v3db = createV3Db(dbPath);
    v3db.close();

    const db = initExecutionDb(dbPath);
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    expect(row?.value).toBe("5");
    db.close();
  });

  it("migration preserves existing execution row data", () => {
    const dbPath = join(makeTmpDir(), "orchestration.db");
    const v3db = createV3Db(dbPath);

    const now = new Date().toISOString();
    v3db.prepare(
      `INSERT INTO execution
        (id, flow, task, entry, current_state, base_commit, started, last_updated,
         branch, sanitized, created, tier, flow_name, slug)
       VALUES (1, 'fast-path', 'test task', 'build', 'build', 'deadbeef',
               ?, ?, 'main', 'main', ?, 'small', 'fast-path', 'test-task')`
    ).run(now, now, now);
    v3db.close();

    const db = initExecutionDb(dbPath);
    const row = db.prepare("SELECT flow, task, cache_prefix FROM execution WHERE id = 1").get() as
      { flow: string; task: string; cache_prefix: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.flow).toBe("fast-path");
    expect(row!.task).toBe("test task");
    // Existing row gets DEFAULT '' from column default
    expect(row!.cache_prefix).toBe("");
    db.close();
  });

  it("migration is idempotent: running twice does not error", () => {
    const dbPath = join(makeTmpDir(), "orchestration.db");
    const db1 = initExecutionDb(dbPath);
    db1.close();

    expect(() => {
      const db2 = initExecutionDb(dbPath);
      db2.close();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. ExecutionStore — getCachePrefix / setCachePrefix
// ---------------------------------------------------------------------------

describe("ExecutionStore getCachePrefix / setCachePrefix", () => {
  function makeStoreWithRow(): ExecutionStore {
    const db = initExecutionDb(":memory:");
    const store = new ExecutionStore(db);

    const now = new Date().toISOString();
    store.initExecution({
      flow: "fast-path",
      task: "test task",
      entry: "build",
      current_state: "build",
      base_commit: "abc123",
      started: now,
      last_updated: now,
      branch: "main",
      sanitized: "main",
      created: now,
      tier: "small",
      flow_name: "fast-path",
      slug: "test-slug",
    });

    return store;
  }

  it("getCachePrefix returns empty string when no prefix set (new workspace)", () => {
    const store = makeStoreWithRow();
    expect(store.getCachePrefix()).toBe("");
  });

  it("setCachePrefix stores and getCachePrefix retrieves the prefix text", () => {
    const store = makeStoreWithRow();
    const prefix = "## Flow: fast-path\n\nA fast path for small tasks.\n\n---\n\n## Workspace\n\n- Task: test task";
    store.setCachePrefix(prefix);
    expect(store.getCachePrefix()).toBe(prefix);
  });

  it("setCachePrefix overwrites previous prefix on second call", () => {
    const store = makeStoreWithRow();
    store.setCachePrefix("first prefix");
    store.setCachePrefix("second prefix");
    expect(store.getCachePrefix()).toBe("second prefix");
  });

  it("getCachePrefix returns empty string when no execution row exists", () => {
    const db = initExecutionDb(":memory:");
    const store = new ExecutionStore(db);
    // No initExecution called — singleton row absent
    expect(store.getCachePrefix()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 3. initWorkspaceFlow computes and stores cache prefix
// ---------------------------------------------------------------------------

describe("initWorkspaceFlow — cache prefix computation", () => {
  async function initWs(projectDir: string) {
    const { initWorkspaceFlow } = await import("../../tools/init-workspace.ts");
    return initWorkspaceFlow(
      {
        flow_name: "fast-path",
        task: "fix the bug",
        branch: "main",
        base_commit: "abc123",
        tier: "small" as const,
      },
      projectDir,
      projectDir, // use projectDir as pluginDir (no CLAUDE.md present — graceful degradation)
    );
  }

  it("initWorkspaceFlow returns cache_prefix_hash in result", async () => {
    const projectDir = makeTmpProjectDir();
    const result = await initWs(projectDir);
    expect(result.cache_prefix_hash).toBeDefined();
    expect(typeof result.cache_prefix_hash).toBe("string");
    // SHA-256 hex truncated to 12 chars
    expect(result.cache_prefix_hash).toHaveLength(12);
    expect(result.cache_prefix_hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("prefix content includes flow description", async () => {
    const projectDir = makeTmpProjectDir();
    const result = await initWs(projectDir);

    // Read prefix from store
    const store = getExecutionStore(result.workspace);
    const prefix = store.getCachePrefix();

    expect(prefix).toContain("fast-path");
    expect(prefix).toContain("A fast single-agent pipeline for small tasks.");
  });

  it("prefix content includes workspace metadata (task, branch, slug)", async () => {
    const projectDir = makeTmpProjectDir();
    const result = await initWs(projectDir);

    const store = getExecutionStore(result.workspace);
    const prefix = store.getCachePrefix();

    expect(prefix).toContain("fix the bug");
    expect(prefix).toContain("main");
    expect(prefix).toContain(result.slug);
  });

  it("prefix content does NOT include progress-like content", async () => {
    const projectDir = makeTmpProjectDir();
    const result = await initWs(projectDir);

    const store = getExecutionStore(result.workspace);
    const prefix = store.getCachePrefix();

    // Progress is append-only and changes per state — must not be in prefix
    expect(prefix).not.toMatch(/^## Progress:/m);
    expect(prefix).not.toContain("Progress:");
    expect(prefix).not.toContain("entered_at");
    expect(prefix).not.toContain("current_state");
  });

  it("prefix is available after workspace resume (getCachePrefix on re-opened store)", async () => {
    const projectDir = makeTmpProjectDir();
    const result = await initWs(projectDir);

    // Clear the store cache to simulate a process restart / new connection
    clearStoreCache();

    // Re-open the store from the same workspace path
    const resumedStore = getExecutionStore(result.workspace);
    const prefix = resumedStore.getCachePrefix();

    // Should still have the prefix from original init
    expect(prefix.length).toBeGreaterThan(0);
    expect(prefix).toContain("fast-path");
  });

  it("prefix is non-empty (at least flow + workspace metadata parts assembled)", async () => {
    const projectDir = makeTmpProjectDir();
    const result = await initWs(projectDir);

    const store = getExecutionStore(result.workspace);
    const prefix = store.getCachePrefix();

    expect(prefix.length).toBeGreaterThan(20);
    expect(prefix).toContain("---");  // separator between parts
  });
});
