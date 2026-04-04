/**
 * execution-schema v7 migration tests
 *
 * Tests that:
 * 1. Fresh DB gets v7 columns (worktree_path, worktree_branch) on execution table
 * 2. Existing v6 DB migrates to v8
 * 3. Double migration (running v7 twice) is safe (idempotent)
 * 4. SCHEMA_VERSION is '8'
 */

import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import {
  columnExists,
  initExecutionDb,
  runMigrations,
  SCHEMA_VERSION,
} from "../orchestration/execution-schema.ts";

describe("SCHEMA_VERSION", () => {
  test("is 8", () => {
    expect(SCHEMA_VERSION).toBe("8");
  });
});

describe("Schema v7 migration — worktree columns on execution", () => {
  test("fresh DB has worktree_path column on execution table", () => {
    const db = initExecutionDb(":memory:");
    expect(columnExists(db, "execution", "worktree_path")).toBe(true);
    db.close();
  });

  test("fresh DB has worktree_branch column on execution table", () => {
    const db = initExecutionDb(":memory:");
    expect(columnExists(db, "execution", "worktree_branch")).toBe(true);
    db.close();
  });

  test("fresh DB schema_version is 8", () => {
    const db = initExecutionDb(":memory:");
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined;
    expect(row?.value).toBe("8");
    db.close();
  });

  test("existing v6 DB migrates to v8 with worktree columns", () => {
    const db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    // Minimal tables for v6 base
    db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.exec(`INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS execution (
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
      )
    `);
    db.exec(
      `CREATE TABLE IF NOT EXISTS execution_states (state_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending', entries INTEGER NOT NULL DEFAULT 0)`,
    );
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
      `CREATE TABLE IF NOT EXISTS wave_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, timestamp TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', applied_at TEXT, resolution TEXT, rejection_reason TEXT)`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, payload TEXT NOT NULL, timestamp TEXT NOT NULL)`,
    );

    // Simulate migrations v2 through v6
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
    db.exec(`ALTER TABLE execution ADD COLUMN cache_prefix TEXT DEFAULT ''`);
    db.exec(`ALTER TABLE execution_states ADD COLUMN transcript_path TEXT`);
    db.exec(`ALTER TABLE execution_states ADD COLUMN agent_session_id TEXT`);
    db.exec(`ALTER TABLE execution_states ADD COLUMN last_agent_activity TEXT`);
    db.exec(`UPDATE meta SET value = '6' WHERE key = 'schema_version'`);

    // Verify we're at v6 (no v7 columns yet)
    expect(columnExists(db, "execution", "worktree_path")).toBe(false);
    expect(columnExists(db, "execution", "worktree_branch")).toBe(false);

    // Run migrations (should upgrade to v7)
    runMigrations(db);

    // v7 columns should now exist
    expect(columnExists(db, "execution", "worktree_path")).toBe(true);
    expect(columnExists(db, "execution", "worktree_branch")).toBe(true);

    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined;
    expect(row?.value).toBe("8");

    db.close();
  });

  test("running v7 migration twice is safe (idempotent)", () => {
    const db = initExecutionDb(":memory:");

    // Columns already exist after initExecutionDb
    expect(columnExists(db, "execution", "worktree_path")).toBe(true);
    expect(columnExists(db, "execution", "worktree_branch")).toBe(true);

    // Running migrations again should not throw
    expect(() => runMigrations(db)).not.toThrow();

    // Columns still exist and schema_version is still 8
    expect(columnExists(db, "execution", "worktree_path")).toBe(true);
    expect(columnExists(db, "execution", "worktree_branch")).toBe(true);

    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined;
    expect(row?.value).toBe("8");

    db.close();
  });

  test("worktree columns are nullable and default to null", () => {
    // Verify columns hold null when not supplied during insert
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
