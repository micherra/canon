/**
 * execution-schema v6 migration tests
 *
 * Tests that:
 * 1. Fresh DB gets v6 columns (agent_session_id, last_agent_activity)
 * 2. Existing v5 DB migrates to v6
 * 3. Double migration (running v6 twice) is safe (idempotent)
 * 4. ExecutionStore.updateAgentSession / getAgentSession work correctly
 */

import { describe, test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initExecutionDb, runMigrations, SCHEMA_VERSION, columnExists } from '../orchestration/execution-schema.ts';
import { ExecutionStore } from '../orchestration/execution-store.ts';

const BASE_INIT_PARAMS = {
  flow: 'test-flow',
  task: 'build feature X',
  entry: 'research',
  current_state: 'research',
  base_commit: 'abc123',
  started: '2026-01-01T00:00:00.000Z',
  last_updated: '2026-01-01T00:00:00.000Z',
  branch: 'feat/test',
  sanitized: 'feat-test',
  created: '2026-01-01T00:00:00.000Z',
  tier: 'medium' as const,
  flow_name: 'test-flow',
  slug: 'test-slug',
};

describe('Schema v6 migration — agent session columns', () => {
  test('SCHEMA_VERSION is 7', () => {
    expect(SCHEMA_VERSION).toBe('7');
  });

  test('fresh DB has agent_session_id column on execution_states', () => {
    const db = initExecutionDb(':memory:');
    expect(columnExists(db, 'execution_states', 'agent_session_id')).toBe(true);
    db.close();
  });

  test('fresh DB has last_agent_activity column on execution_states', () => {
    const db = initExecutionDb(':memory:');
    expect(columnExists(db, 'execution_states', 'last_agent_activity')).toBe(true);
    db.close();
  });

  test('fresh DB schema_version is 7', () => {
    const db = initExecutionDb(':memory:');
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
    expect(row?.value).toBe('7');
    db.close();
  });

  test('existing v5 DB migrates to v6', () => {
    // Create a v5 DB by applying schema up to v5
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Apply base DDL manually (v1 tables)
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
    db.exec(`CREATE TABLE IF NOT EXISTS iterations (state_id TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, max INTEGER NOT NULL, history TEXT NOT NULL DEFAULT '[]', cannot_fix TEXT NOT NULL DEFAULT '[]')`);
    db.exec(`CREATE TABLE IF NOT EXISTS progress_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, line TEXT NOT NULL, timestamp TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, sender TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS wave_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, timestamp TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', applied_at TEXT, resolution TEXT, rejection_reason TEXT)`);
    db.exec(`CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, payload TEXT NOT NULL, timestamp TEXT NOT NULL)`);

    // Simulate migrations v2 through v5
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
    db.exec(`UPDATE meta SET value = '5' WHERE key = 'schema_version'`);

    // Verify we're at v5 (no v6 columns yet)
    expect(columnExists(db, 'execution_states', 'agent_session_id')).toBe(false);
    expect(columnExists(db, 'execution_states', 'last_agent_activity')).toBe(false);

    // Run migrations (should upgrade to v7 — runs v6 then v7)
    runMigrations(db);

    // Now v6 columns should exist
    expect(columnExists(db, 'execution_states', 'agent_session_id')).toBe(true);
    expect(columnExists(db, 'execution_states', 'last_agent_activity')).toBe(true);

    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
    expect(row?.value).toBe('7');

    db.close();
  });

  test('running v6 migration twice is safe (idempotent)', () => {
    const db = initExecutionDb(':memory:');

    // Columns already exist after initExecutionDb
    expect(columnExists(db, 'execution_states', 'agent_session_id')).toBe(true);
    expect(columnExists(db, 'execution_states', 'last_agent_activity')).toBe(true);

    // Running migrations again should not throw
    expect(() => runMigrations(db)).not.toThrow();

    // Columns still exist and schema_version is still 7
    expect(columnExists(db, 'execution_states', 'agent_session_id')).toBe(true);
    expect(columnExists(db, 'execution_states', 'last_agent_activity')).toBe(true);

    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
    expect(row?.value).toBe('7');

    db.close();
  });

  test('existing execution_states data is preserved after v6 migration', () => {
    // Create DB at v5 with existing data, then migrate
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Minimal tables for v5
    db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.exec(`INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS execution_states (
        state_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending',
        entries INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec(`CREATE TABLE IF NOT EXISTS execution (id INTEGER PRIMARY KEY CHECK (id = 1), flow TEXT NOT NULL, task TEXT NOT NULL, entry TEXT NOT NULL, current_state TEXT NOT NULL, base_commit TEXT NOT NULL, started TEXT NOT NULL, last_updated TEXT NOT NULL, blocked TEXT, concerns TEXT NOT NULL DEFAULT '[]', skipped TEXT NOT NULL DEFAULT '[]', metadata TEXT, branch TEXT NOT NULL, sanitized TEXT NOT NULL, created TEXT NOT NULL, original_task TEXT, tier TEXT NOT NULL, flow_name TEXT NOT NULL, slug TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', completed_at TEXT, rolled_back_at TEXT, rolled_back_to TEXT)`);
    db.exec(`CREATE TABLE IF NOT EXISTS iterations (state_id TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, max INTEGER NOT NULL, history TEXT NOT NULL DEFAULT '[]', cannot_fix TEXT NOT NULL DEFAULT '[]')`);
    db.exec(`CREATE TABLE IF NOT EXISTS progress_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, line TEXT NOT NULL, timestamp TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, sender TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS wave_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, timestamp TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', applied_at TEXT, resolution TEXT, rejection_reason TEXT)`);
    db.exec(`CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, payload TEXT NOT NULL, timestamp TEXT NOT NULL)`);
    db.exec(`ALTER TABLE execution ADD COLUMN correlation_id TEXT`);
    db.exec(`ALTER TABLE events ADD COLUMN correlation_id TEXT`);
    db.exec(`CREATE TABLE IF NOT EXISTS iteration_results (id INTEGER PRIMARY KEY AUTOINCREMENT, state_id TEXT NOT NULL, iteration INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', timestamp TEXT NOT NULL, UNIQUE(state_id, iteration))`);
    db.exec(`ALTER TABLE execution ADD COLUMN cache_prefix TEXT DEFAULT ''`);
    db.exec(`ALTER TABLE execution_states ADD COLUMN transcript_path TEXT`);
    db.exec(`UPDATE meta SET value = '5' WHERE key = 'schema_version'`);

    // Insert a state row before migration
    db.exec(`INSERT INTO execution_states (state_id, status, entries) VALUES ('research', 'done', 1)`);

    // Run migrations
    runMigrations(db);

    // Data preserved after migration
    const row = db.prepare(`SELECT state_id, status, entries FROM execution_states WHERE state_id = 'research'`).get() as { state_id: string; status: string; entries: number } | undefined;
    expect(row?.state_id).toBe('research');
    expect(row?.status).toBe('done');
    expect(row?.entries).toBe(1);

    db.close();
  });
});

describe('ExecutionStore — updateAgentSession / getAgentSession', () => {
  function makeStore(): ExecutionStore {
    const db = initExecutionDb(':memory:');
    return new ExecutionStore(db);
  }

  test('getAgentSession returns null when no session set', () => {
    const store = makeStore();
    store.initExecution(BASE_INIT_PARAMS);
    store.upsertState('research', { status: 'in_progress', entries: 1 });

    const result = store.getAgentSession('research');
    expect(result).toBeNull();
  });

  test('updateAgentSession stores session ID and activity timestamp', () => {
    const store = makeStore();
    store.initExecution(BASE_INIT_PARAMS);
    store.upsertState('research', { status: 'in_progress', entries: 1 });

    store.updateAgentSession('research', 'agent-sess-xyz');

    const result = store.getAgentSession('research');
    expect(result).not.toBeNull();
    expect(result?.agent_session_id).toBe('agent-sess-xyz');
    expect(result?.last_agent_activity).toBeTruthy();
  });

  test('updateAgentSession sets last_agent_activity to current ISO timestamp', () => {
    const store = makeStore();
    store.initExecution(BASE_INIT_PARAMS);
    store.upsertState('research', { status: 'in_progress', entries: 1 });

    const before = new Date().toISOString();
    store.updateAgentSession('research', 'agent-sess-abc');
    const after = new Date().toISOString();

    const result = store.getAgentSession('research');
    // ISO strings compare correctly as strings (YYYY-MM-DD lexicographic order)
    expect(result?.last_agent_activity! >= before).toBe(true);
    expect(result?.last_agent_activity! <= after).toBe(true);
  });

  test('updateAgentSession replaces existing session', () => {
    const store = makeStore();
    store.initExecution(BASE_INIT_PARAMS);
    store.upsertState('research', { status: 'in_progress', entries: 1 });

    store.updateAgentSession('research', 'agent-sess-v1');
    store.updateAgentSession('research', 'agent-sess-v2');

    const result = store.getAgentSession('research');
    expect(result?.agent_session_id).toBe('agent-sess-v2');
  });

  test('getAgentSession returns null for nonexistent state', () => {
    const store = makeStore();
    store.initExecution(BASE_INIT_PARAMS);

    const result = store.getAgentSession('nonexistent-state');
    expect(result).toBeNull();
  });

  test('agent session IDs are independent per state', () => {
    const store = makeStore();
    store.initExecution(BASE_INIT_PARAMS);
    store.upsertState('research', { status: 'in_progress', entries: 1 });
    store.upsertState('implement', { status: 'in_progress', entries: 1 });

    store.updateAgentSession('research', 'sess-research');
    store.updateAgentSession('implement', 'sess-implement');

    expect(store.getAgentSession('research')?.agent_session_id).toBe('sess-research');
    expect(store.getAgentSession('implement')?.agent_session_id).toBe('sess-implement');
  });
});
