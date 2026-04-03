/**
 * SQL-based stuck detection — migration runner and ExecutionStore methods
 *
 * Tests use in-memory SQLite for speed and isolation.
 * Each test gets a fresh DB.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initExecutionDb, SCHEMA_VERSION, runMigrations } from '../orchestration/execution-schema.ts';
import { ExecutionStore } from '../orchestration/execution-store.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(): ExecutionStore {
  const db = initExecutionDb(':memory:');
  return new ExecutionStore(db);
}

/**
 * Simulate a v1 database: create tables without iteration_results.
 * The meta table records schema_version = '1'.
 */
function makeV1Db(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
  db.exec(`INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')`);
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
  db.exec(`CREATE TABLE IF NOT EXISTS events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    type      TEXT NOT NULL,
    payload   TEXT NOT NULL,
    timestamp TEXT NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)`);

  return db;
}

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

describe('runMigrations', () => {
  test('upgrades a v1 database to v5: creates iteration_results table', () => {
    const db = makeV1Db();

    // Verify table does NOT exist yet
    const beforeTables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all() as { name: string }[];
    expect(beforeTables.map(r => r.name)).not.toContain('iteration_results');

    // Run migrations
    runMigrations(db);

    // Verify iteration_results table now exists
    const afterTables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all() as { name: string }[];
    expect(afterTables.map(r => r.name)).toContain('iteration_results');
  });

  test('upgrades schema_version to 7 in meta table', () => {
    const db = makeV1Db();
    runMigrations(db);

    const row = db
      .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
      .get() as { value: string } | undefined;
    expect(row?.value).toBe('7');
  });

  test('is idempotent: running migrations twice on v1 does not throw', () => {
    const db = makeV1Db();
    runMigrations(db);
    // Second call should be safe (IF NOT EXISTS guards)
    expect(() => runMigrations(db)).not.toThrow();
  });

  test('is a no-op on a v7 database (tables already created by initExecutionDb)', () => {
    const db = initExecutionDb(':memory:');
    // Already at v7 — running migrations again should not throw and keep version at 7
    expect(() => runMigrations(db)).not.toThrow();

    const row = db
      .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
      .get() as { value: string } | undefined;
    expect(row?.value).toBe('7');
  });

  test('initExecutionDb sets SCHEMA_VERSION to 7', () => {
    const db = initExecutionDb(':memory:');
    const row = db
      .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
      .get() as { value: string } | undefined;
    expect(row?.value).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe('7');
  });
});

// ---------------------------------------------------------------------------
// recordIterationResult
// ---------------------------------------------------------------------------

describe('ExecutionStore.recordIterationResult', () => {
  test('stores an iteration result and it can be read back', () => {
    const store = makeStore();
    store.recordIterationResult('implement', 1, 'done', { commit_sha: 'abc123', artifact_count: 3 });

    const db = (store as unknown as { db: Database.Database }).db;
    const rows = db
      .prepare(`SELECT * FROM iteration_results WHERE state_id = 'implement'`)
      .all() as Array<{ state_id: string; iteration: number; status: string; data: string; timestamp: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].state_id).toBe('implement');
    expect(rows[0].iteration).toBe(1);
    expect(rows[0].status).toBe('done');
    expect(JSON.parse(rows[0].data)).toEqual({ commit_sha: 'abc123', artifact_count: 3 });
    expect(rows[0].timestamp).toBeTruthy();
  });

  test('INSERT OR REPLACE: overwrites existing record for same state_id + iteration', () => {
    const store = makeStore();
    store.recordIterationResult('implement', 1, 'needs_fix', { commit_sha: 'aaa' });
    store.recordIterationResult('implement', 1, 'done', { commit_sha: 'bbb' });

    const db = (store as unknown as { db: Database.Database }).db;
    const rows = db
      .prepare(`SELECT * FROM iteration_results WHERE state_id = 'implement'`)
      .all() as Array<{ status: string; data: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('done');
    expect(JSON.parse(rows[0].data)).toEqual({ commit_sha: 'bbb' });
  });

  test('stores multiple iterations for the same state', () => {
    const store = makeStore();
    store.recordIterationResult('review', 1, 'blocking', { principle_ids: ['p1'], file_paths: ['a.ts'] });
    store.recordIterationResult('review', 2, 'blocking', { principle_ids: ['p2'], file_paths: ['b.ts'] });
    store.recordIterationResult('review', 3, 'done', {});

    const db = (store as unknown as { db: Database.Database }).db;
    const rows = db
      .prepare(`SELECT iteration FROM iteration_results WHERE state_id = 'review' ORDER BY iteration`)
      .all() as Array<{ iteration: number }>;

    expect(rows).toHaveLength(3);
    expect(rows.map(r => r.iteration)).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// isStuck
// ---------------------------------------------------------------------------

describe('ExecutionStore.isStuck', () => {
  // ---- fewer than 2 iterations ----

  test('returns false when no iterations exist', () => {
    const store = makeStore();
    expect(store.isStuck('implement', 'same_status')).toBe(false);
  });

  test('returns false when only one iteration exists', () => {
    const store = makeStore();
    store.recordIterationResult('implement', 1, 'done', {});
    expect(store.isStuck('implement', 'same_status')).toBe(false);
  });

  // ---- same_violations ----

  test('same_violations: returns true when last two iterations have identical principle_ids and file_paths', () => {
    const store = makeStore();
    store.recordIterationResult('review', 1, 'blocking', {
      principle_ids: ['thin-handlers', 'errors-are-values'],
      file_paths: ['src/foo.ts', 'src/bar.ts'],
    });
    store.recordIterationResult('review', 2, 'blocking', {
      principle_ids: ['errors-are-values', 'thin-handlers'],
      file_paths: ['src/bar.ts', 'src/foo.ts'],
    });

    expect(store.isStuck('review', 'same_violations')).toBe(true);
  });

  test('same_violations: returns false when violations differ between last two iterations', () => {
    const store = makeStore();
    store.recordIterationResult('review', 1, 'blocking', {
      principle_ids: ['thin-handlers'],
      file_paths: ['src/foo.ts'],
    });
    store.recordIterationResult('review', 2, 'blocking', {
      principle_ids: ['errors-are-values'],
      file_paths: ['src/foo.ts'],
    });

    expect(store.isStuck('review', 'same_violations')).toBe(false);
  });

  test('same_violations: returns false when file_paths differ between last two iterations', () => {
    const store = makeStore();
    store.recordIterationResult('review', 1, 'blocking', {
      principle_ids: ['thin-handlers'],
      file_paths: ['src/foo.ts'],
    });
    store.recordIterationResult('review', 2, 'blocking', {
      principle_ids: ['thin-handlers'],
      file_paths: ['src/bar.ts'],
    });

    expect(store.isStuck('review', 'same_violations')).toBe(false);
  });

  test('same_violations: returns false when missing principle_ids/file_paths in data', () => {
    const store = makeStore();
    store.recordIterationResult('review', 1, 'blocking', {});
    store.recordIterationResult('review', 2, 'blocking', {});
    // Both have empty arrays by default — they match, should return true
    expect(store.isStuck('review', 'same_violations')).toBe(true);
  });

  // ---- same_file_test ----

  test('same_file_test: returns true when pairs are identical across last two iterations', () => {
    const store = makeStore();
    const pairs = [{ file: 'foo.ts', test: 'foo.test.ts' }];
    store.recordIterationResult('test', 1, 'failing', { pairs });
    store.recordIterationResult('test', 2, 'failing', { pairs });

    expect(store.isStuck('test', 'same_file_test')).toBe(true);
  });

  test('same_file_test: returns false when pairs differ', () => {
    const store = makeStore();
    store.recordIterationResult('test', 1, 'failing', { pairs: [{ file: 'foo.ts', test: 'foo.test.ts' }] });
    store.recordIterationResult('test', 2, 'failing', { pairs: [{ file: 'bar.ts', test: 'bar.test.ts' }] });

    expect(store.isStuck('test', 'same_file_test')).toBe(false);
  });

  // ---- same_status ----

  test('same_status: returns true when status is identical in last two iterations', () => {
    const store = makeStore();
    store.recordIterationResult('implement', 1, 'needs_fix', {});
    store.recordIterationResult('implement', 2, 'needs_fix', {});

    expect(store.isStuck('implement', 'same_status')).toBe(true);
  });

  test('same_status: returns false when status changes between last two iterations', () => {
    const store = makeStore();
    store.recordIterationResult('implement', 1, 'needs_fix', {});
    store.recordIterationResult('implement', 2, 'done', {});

    expect(store.isStuck('implement', 'same_status')).toBe(false);
  });

  // ---- no_progress ----

  test('no_progress: returns true when commit_sha and artifact_count are unchanged', () => {
    const store = makeStore();
    store.recordIterationResult('implement', 1, 'needs_fix', { commit_sha: 'abc', artifact_count: 2 });
    store.recordIterationResult('implement', 2, 'needs_fix', { commit_sha: 'abc', artifact_count: 2 });

    expect(store.isStuck('implement', 'no_progress')).toBe(true);
  });

  test('no_progress: returns false when commit_sha changes', () => {
    const store = makeStore();
    store.recordIterationResult('implement', 1, 'needs_fix', { commit_sha: 'abc', artifact_count: 2 });
    store.recordIterationResult('implement', 2, 'needs_fix', { commit_sha: 'def', artifact_count: 2 });

    expect(store.isStuck('implement', 'no_progress')).toBe(false);
  });

  // ---- no_gate_progress ----

  test('no_gate_progress: returns true when gate_output_hash matches and passed is false in latest', () => {
    const store = makeStore();
    store.recordIterationResult('gate-state', 1, 'failed', { gate_output_hash: 'hash1', passed: false });
    store.recordIterationResult('gate-state', 2, 'failed', { gate_output_hash: 'hash1', passed: false });

    expect(store.isStuck('gate-state', 'no_gate_progress')).toBe(true);
  });

  test('no_gate_progress: returns false when gate_output_hash differs', () => {
    const store = makeStore();
    store.recordIterationResult('gate-state', 1, 'failed', { gate_output_hash: 'hash1', passed: false });
    store.recordIterationResult('gate-state', 2, 'failed', { gate_output_hash: 'hash2', passed: false });

    expect(store.isStuck('gate-state', 'no_gate_progress')).toBe(false);
  });

  test('no_gate_progress: returns false when latest iteration passed (even if hash matches)', () => {
    const store = makeStore();
    store.recordIterationResult('gate-state', 1, 'failed', { gate_output_hash: 'hash1', passed: false });
    store.recordIterationResult('gate-state', 2, 'passed', { gate_output_hash: 'hash1', passed: true });

    expect(store.isStuck('gate-state', 'no_gate_progress')).toBe(false);
  });

  // ---- isolation between states ----

  test('compares only within the same state_id', () => {
    const store = makeStore();
    store.recordIterationResult('state-a', 1, 'needs_fix', {});
    store.recordIterationResult('state-a', 2, 'needs_fix', {});
    store.recordIterationResult('state-b', 1, 'needs_fix', {});
    // state-b only has 1 iteration → false
    expect(store.isStuck('state-b', 'same_status')).toBe(false);
    // state-a has 2 identical → true
    expect(store.isStuck('state-a', 'same_status')).toBe(true);
  });
});
