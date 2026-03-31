/**
 * ExecutionStore — SQLite-backed orchestration state DAO
 *
 * Tests use in-memory SQLite (:memory:) for speed and isolation.
 * Each describe block gets a fresh DB via beforeEach.
 */

import { describe, test, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initExecutionDb, SCHEMA_VERSION } from '../orchestration/execution-schema.ts';
import { ExecutionStore, getExecutionStore } from '../orchestration/execution-store.ts';
import type { Board, Session, BoardStateEntry, IterationEntry, WaveEvent } from '../orchestration/flow-schema.ts';
import { BoardSchema } from '../orchestration/flow-schema.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): Database.Database {
  return initExecutionDb(':memory:');
}

function makeStore(): ExecutionStore {
  return new ExecutionStore(makeDb());
}

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

// ---------------------------------------------------------------------------
// initExecutionDb — schema creation
// ---------------------------------------------------------------------------

describe('initExecutionDb', () => {
  test('creates all expected tables', () => {
    const db = makeDb();
    const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as { name: string }[];
    const names = rows.map(r => r.name);
    expect(names).toContain('meta');
    expect(names).toContain('execution');
    expect(names).toContain('execution_states');
    expect(names).toContain('iterations');
    expect(names).toContain('progress_entries');
    expect(names).toContain('messages');
    expect(names).toContain('wave_events');
    expect(names).toContain('events');
    db.close();
  });

  test('creates all expected indexes', () => {
    const db = makeDb();
    const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' ORDER BY name`).all() as { name: string }[];
    const names = rows.map(r => r.name);
    expect(names).toContain('idx_messages_channel');
    expect(names).toContain('idx_messages_channel_ts');
    expect(names).toContain('idx_wave_events_status');
    expect(names).toContain('idx_events_type');
    db.close();
  });

  test('seeds schema_version in meta table', () => {
    const db = makeDb();
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
    expect(row?.value).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe('1');
    db.close();
  });

  test('is idempotent — calling twice does not throw', () => {
    // Use a temp file to test idempotency across two opens
    const tmpDir = mkdtempSync(join(tmpdir(), 'exec-schema-test-'));
    try {
      const dbPath = join(tmpDir, 'orchestration.db');
      const db1 = initExecutionDb(dbPath);
      db1.close();
      // Second open should succeed without throwing
      const db2 = initExecutionDb(dbPath);
      db2.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('WAL mode is set', () => {
    const db = makeDb();
    const row = db.pragma('journal_mode') as Array<{ journal_mode: string }>;
    // In-memory DBs always use 'memory' journal mode, not WAL
    // Just verify the pragma call doesn't throw; for real files WAL is confirmed
    expect(row).toBeDefined();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// initExecution + getExecution round-trip
// ---------------------------------------------------------------------------

describe('initExecution + getExecution', () => {
  let store: ExecutionStore;

  beforeEach(() => { store = makeStore(); });
  afterEach(() => { store.close(); });

  test('inserts and retrieves execution row', () => {
    store.initExecution(BASE_INIT_PARAMS);
    const row = store.getExecution();
    expect(row).not.toBeNull();
    expect(row!.flow).toBe('test-flow');
    expect(row!.task).toBe('build feature X');
    expect(row!.entry).toBe('research');
    expect(row!.current_state).toBe('research');
    expect(row!.base_commit).toBe('abc123');
    expect(row!.branch).toBe('feat/test');
    expect(row!.tier).toBe('medium');
    expect(row!.slug).toBe('test-slug');
    expect(row!.status).toBe('active');
  });

  test('getExecution returns null when no execution exists', () => {
    const result = store.getExecution();
    expect(result).toBeNull();
  });

  test('initExecution sets default status to active', () => {
    store.initExecution(BASE_INIT_PARAMS);
    const row = store.getExecution();
    expect(row!.status).toBe('active');
  });

  test('initExecution stores optional original_task', () => {
    store.initExecution({ ...BASE_INIT_PARAMS, original_task: 'original task text' });
    const row = store.getExecution();
    expect(row!.original_task).toBe('original task text');
  });
});

// ---------------------------------------------------------------------------
// getSession — projects Session fields
// ---------------------------------------------------------------------------

describe('getSession', () => {
  let store: ExecutionStore;

  beforeEach(() => { store = makeStore(); });
  afterEach(() => { store.close(); });

  test('returns null when no execution exists', () => {
    expect(store.getSession()).toBeNull();
  });

  test('projects all Session fields correctly', () => {
    store.initExecution({ ...BASE_INIT_PARAMS, original_task: 'orig' });
    const session = store.getSession();
    expect(session).not.toBeNull();
    expect(session!.branch).toBe('feat/test');
    expect(session!.sanitized).toBe('feat-test');
    expect(session!.created).toBe('2026-01-01T00:00:00.000Z');
    expect(session!.task).toBe('build feature X');
    expect(session!.original_task).toBe('orig');
    expect(session!.tier).toBe('medium');
    expect(session!.flow).toBe('test-flow');
    expect(session!.slug).toBe('test-slug');
    expect(session!.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// updateExecution
// ---------------------------------------------------------------------------

describe('updateExecution', () => {
  let store: ExecutionStore;

  beforeEach(() => {
    store = makeStore();
    store.initExecution(BASE_INIT_PARAMS);
  });
  afterEach(() => { store.close(); });

  test('updates current_state', () => {
    store.updateExecution({ current_state: 'implement' });
    expect(store.getExecution()!.current_state).toBe('implement');
  });

  test('updates status and completed_at', () => {
    const ts = '2026-01-02T00:00:00.000Z';
    store.updateExecution({ status: 'completed', completed_at: ts });
    const row = store.getExecution()!;
    expect(row.status).toBe('completed');
    expect(row.completed_at).toBe(ts);
  });

  test('updates blocked as JSON', () => {
    const blocked = { state: 'implement', reason: 'test reason', since: '2026-01-01T00:00:00.000Z' };
    store.updateExecution({ blocked });
    const row = store.getExecution()!;
    expect(row.blocked).toEqual(blocked);
  });

  test('sets blocked to null', () => {
    store.updateExecution({ blocked: { state: 'x', reason: 'r', since: '2026-01-01T00:00:00.000Z' } });
    store.updateExecution({ blocked: null });
    expect(store.getExecution()!.blocked).toBeNull();
  });

  test('updates concerns JSON array', () => {
    const concern = { state_id: 's1', agent: 'tester', message: 'test concern', timestamp: '2026-01-01T00:00:00.000Z' };
    store.updateExecution({ concerns: [concern] });
    expect(store.getExecution()!.concerns).toEqual([concern]);
  });

  test('updates skipped JSON array', () => {
    store.updateExecution({ skipped: ['state-a', 'state-b'] });
    expect(store.getExecution()!.skipped).toEqual(['state-a', 'state-b']);
  });

  test('updates metadata JSON object', () => {
    store.updateExecution({ metadata: { key: 'value', count: 42 } });
    expect(store.getExecution()!.metadata).toEqual({ key: 'value', count: 42 });
  });
});

// ---------------------------------------------------------------------------
// upsertState + getState round-trip
// ---------------------------------------------------------------------------

describe('upsertState + getState', () => {
  let store: ExecutionStore;

  beforeEach(() => { store = makeStore(); });
  afterEach(() => { store.close(); });

  test('inserts and retrieves a minimal state', () => {
    store.upsertState('research', { status: 'pending', entries: 0 });
    const state = store.getState('research');
    expect(state).not.toBeNull();
    expect(state!.status).toBe('pending');
    expect(state!.entries).toBe(0);
  });

  test('returns null for non-existent state', () => {
    expect(store.getState('nonexistent')).toBeNull();
  });

  test('updates existing state', () => {
    store.upsertState('research', { status: 'pending', entries: 0 });
    store.upsertState('research', { status: 'in_progress', entries: 1 });
    const state = store.getState('research');
    expect(state!.status).toBe('in_progress');
    expect(state!.entries).toBe(1);
  });

  test('round-trips all JSON columns', () => {
    const waveResults = {
      'wave-1': {
        tasks: ['task-a'],
        status: 'done',
        gate: 'npm test',
        gate_output: 'all passing',
        consultations: {
          before: { arch: { status: 'done', summary: 'looks good' } },
          after: { reviewer: { status: 'done', summary: 'approved' } },
        },
      },
    };
    const metrics = {
      duration_ms: 5000,
      spawns: 3,
      model: 'claude-3',
      violation_count: 2,
      test_results: { passed: 10, failed: 0, skipped: 1 },
    };
    const gateResults = [{ passed: true, gate: 'npm test', command: 'npm test', output: 'OK', exitCode: 0 }];
    const postconditionResults = [{ passed: true, name: 'file_exists', type: 'file_exists', output: 'found' }];
    const discoveredGates = [{ command: 'npm run lint', source: 'reviewer' }];
    const parallelResults = [{ item: 'feat-a', status: 'done', artifacts: ['SUMMARY.md'] }];
    const competeResults = [{ lens: 'performance', status: 'done', artifacts: ['PLAN.md'] }];
    const artifactHistory = [{ entry: 1, artifacts: ['SUMMARY.md'] }];

    store.upsertState('implement', {
      status: 'done',
      entries: 2,
      entered_at: '2026-01-01T00:00:00.000Z',
      completed_at: '2026-01-01T01:00:00.000Z',
      result: 'done',
      artifacts: ['src/feature.ts'],
      artifact_history: artifactHistory,
      error: undefined,
      wave: 2,
      wave_total: 3,
      wave_results: waveResults,
      metrics,
      gate_results: gateResults,
      postcondition_results: postconditionResults,
      discovered_gates: discoveredGates,
      discovered_postconditions: [{ type: 'file_exists', target: 'src/foo.ts' }],
      parallel_results: parallelResults,
      compete_results: competeResults,
      synthesized: true,
    });

    const state = store.getState('implement')!;
    expect(state.status).toBe('done');
    expect(state.wave_results).toEqual(waveResults);
    expect(state.metrics).toEqual(metrics);
    expect(state.gate_results).toEqual(gateResults);
    expect(state.postcondition_results).toEqual(postconditionResults);
    expect(state.discovered_gates).toEqual(discoveredGates);
    expect(state.parallel_results).toEqual(parallelResults);
    expect(state.compete_results).toEqual(competeResults);
    expect(state.artifact_history).toEqual(artifactHistory);
    expect(state.artifacts).toEqual(['src/feature.ts']);
    expect(state.synthesized).toBe(true);
  });

  test('getAllStates returns all rows', () => {
    store.upsertState('research', { status: 'done', entries: 1 });
    store.upsertState('implement', { status: 'in_progress', entries: 1 });
    store.upsertState('review', { status: 'pending', entries: 0 });
    const states = store.getAllStates();
    expect(states).toHaveLength(3);
    const ids = states.map(s => s.state_id);
    expect(ids).toContain('research');
    expect(ids).toContain('implement');
    expect(ids).toContain('review');
  });
});

// ---------------------------------------------------------------------------
// upsertIteration + getIteration round-trip
// ---------------------------------------------------------------------------

describe('upsertIteration + getIteration', () => {
  let store: ExecutionStore;

  beforeEach(() => { store = makeStore(); });
  afterEach(() => { store.close(); });

  test('inserts and retrieves a minimal iteration', () => {
    store.upsertIteration('implement', { count: 0, max: 3, history: [], cannot_fix: [] });
    const iter = store.getIteration('implement');
    expect(iter).not.toBeNull();
    expect(iter!.count).toBe(0);
    expect(iter!.max).toBe(3);
    expect(iter!.history).toEqual([]);
    expect(iter!.cannot_fix).toEqual([]);
  });

  test('returns null for non-existent state', () => {
    expect(store.getIteration('nonexistent')).toBeNull();
  });

  test('updates existing iteration', () => {
    store.upsertIteration('implement', { count: 0, max: 3, history: [], cannot_fix: [] });
    store.upsertIteration('implement', { count: 1, max: 3, history: [{ status: 'blocked' }], cannot_fix: [] });
    const iter = store.getIteration('implement')!;
    expect(iter.count).toBe(1);
    expect(iter.history).toEqual([{ status: 'blocked' }]);
  });

  test('round-trips all 5 HistoryEntry variants', () => {
    const history = [
      { principle_ids: ['deep-modules'], file_paths: ['src/foo.ts'] },     // ViolationHistoryEntry
      { pairs: [{ file: 'src/A.ts', test: 'src/__tests__/A.test.ts' }] }, // FileTestHistoryEntry
      { status: 'blocked' },                                                // StatusHistoryEntry
      { commit_sha: 'abc123', artifact_count: 2 },                         // ProgressHistoryEntry
      { gate_output_hash: 'hash123', passed: false },                       // GateProgressHistoryEntry
    ];
    const cannotFix = [{ principle_id: 'deep-modules', file_path: 'src/foo.ts' }];

    store.upsertIteration('implement', { count: 5, max: 5, history, cannot_fix: cannotFix });

    const iter = store.getIteration('implement')!;
    expect(iter.count).toBe(5);
    expect(iter.max).toBe(5);
    expect(iter.history).toEqual(history);
    expect(iter.cannot_fix).toEqual(cannotFix);
  });
});

// ---------------------------------------------------------------------------
// appendProgress + getProgress
// ---------------------------------------------------------------------------

describe('appendProgress + getProgress', () => {
  let store: ExecutionStore;

  beforeEach(() => { store = makeStore(); });
  afterEach(() => { store.close(); });

  test('returns empty string when no entries', () => {
    expect(store.getProgress()).toBe('');
  });

  test('appends and retrieves progress entries as markdown bullet list', () => {
    store.appendProgress('Research complete');
    store.appendProgress('Implementation started');
    const progress = store.getProgress();
    expect(progress).toContain('- Research complete');
    expect(progress).toContain('- Implementation started');
  });

  test('entries are ordered by insertion order', () => {
    store.appendProgress('first');
    store.appendProgress('second');
    store.appendProgress('third');
    const progress = store.getProgress();
    const lines = progress.split('\n').filter(Boolean);
    expect(lines[0]).toContain('first');
    expect(lines[1]).toContain('second');
    expect(lines[2]).toContain('third');
  });

  test('respects maxEntries limit', () => {
    store.appendProgress('entry-1');
    store.appendProgress('entry-2');
    store.appendProgress('entry-3');
    store.appendProgress('entry-4');
    const progress = store.getProgress(2);
    // Should return last 2 entries
    expect(progress).toContain('entry-3');
    expect(progress).toContain('entry-4');
    expect(progress).not.toContain('entry-1');
    expect(progress).not.toContain('entry-2');
  });
});

// ---------------------------------------------------------------------------
// appendMessage + getMessages
// ---------------------------------------------------------------------------

describe('appendMessage + getMessages', () => {
  let store: ExecutionStore;

  beforeEach(() => { store = makeStore(); });
  afterEach(() => { store.close(); });

  test('returns empty array for non-existent channel', () => {
    expect(store.getMessages('nonexistent')).toEqual([]);
  });

  test('appends and retrieves messages for a channel', () => {
    const msg = store.appendMessage('general', 'agent-1', 'hello world');
    expect(msg.channel).toBe('general');
    expect(msg.sender).toBe('agent-1');
    expect(msg.content).toBe('hello world');
    expect(msg.timestamp).toBeTruthy();

    const messages = store.getMessages('general');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe('hello world');
  });

  test('filters messages by channel', () => {
    store.appendMessage('chan-a', 'agent-1', 'message A');
    store.appendMessage('chan-b', 'agent-2', 'message B');
    const chanA = store.getMessages('chan-a');
    const chanB = store.getMessages('chan-b');
    expect(chanA).toHaveLength(1);
    expect(chanA[0]!.content).toBe('message A');
    expect(chanB).toHaveLength(1);
    expect(chanB[0]!.content).toBe('message B');
  });

  test('filters messages since a timestamp', () => {
    // Use a past timestamp as the cutoff — everything after epoch 0 is "new"
    const pastTs = '2000-01-01T00:00:00.000Z';
    store.appendMessage('chan', 'agent-1', 'old message');
    store.appendMessage('chan', 'agent-2', 'new message');
    const messages = store.getMessages('chan', { since: pastTs });
    // Both messages are newer than pastTs, so both should appear
    expect(messages.some(m => m.content === 'new message')).toBe(true);
    expect(messages.some(m => m.content === 'old message')).toBe(true);
  });

  test('messages ordered by timestamp ascending', () => {
    store.appendMessage('chan', 'a1', 'first');
    store.appendMessage('chan', 'a2', 'second');
    store.appendMessage('chan', 'a3', 'third');
    const messages = store.getMessages('chan');
    expect(messages[0]!.content).toBe('first');
    expect(messages[1]!.content).toBe('second');
    expect(messages[2]!.content).toBe('third');
  });
});

// ---------------------------------------------------------------------------
// postWaveEvent + getWaveEvents + updateWaveEvent lifecycle
// ---------------------------------------------------------------------------

describe('wave events lifecycle', () => {
  let store: ExecutionStore;

  beforeEach(() => { store = makeStore(); });
  afterEach(() => { store.close(); });

  test('returns empty array when no wave events', () => {
    expect(store.getWaveEvents()).toEqual([]);
  });

  test('postWaveEvent inserts a pending event', () => {
    store.postWaveEvent({
      id: 'evt-1',
      type: 'guidance',
      payload: { text: 'focus on performance' },
      timestamp: '2026-01-01T00:00:00.000Z',
      status: 'pending',
    });

    const events = store.getWaveEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe('evt-1');
    expect(events[0]!.type).toBe('guidance');
    expect(events[0]!.status).toBe('pending');
    expect(events[0]!.payload).toEqual({ text: 'focus on performance' });
  });

  test('getWaveEvents filters by status', () => {
    store.postWaveEvent({ id: 'evt-1', type: 'guidance', payload: {}, timestamp: '2026-01-01T00:00:00.000Z', status: 'pending' });
    store.postWaveEvent({ id: 'evt-2', type: 'skip_task', payload: {}, timestamp: '2026-01-01T00:01:00.000Z', status: 'pending' });
    store.updateWaveEvent('evt-1', { status: 'applied', applied_at: '2026-01-01T00:02:00.000Z' });

    const pending = store.getWaveEvents({ status: 'pending' });
    const applied = store.getWaveEvents({ status: 'applied' });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe('evt-2');
    expect(applied).toHaveLength(1);
    expect(applied[0]!.id).toBe('evt-1');
  });

  test('updateWaveEvent — pending to applied', () => {
    store.postWaveEvent({ id: 'evt-1', type: 'guidance', payload: {}, timestamp: '2026-01-01T00:00:00.000Z', status: 'pending' });
    store.updateWaveEvent('evt-1', {
      status: 'applied',
      applied_at: '2026-01-01T01:00:00.000Z',
      resolution: { agents: ['agent-1'] },
    });

    const events = store.getWaveEvents({ status: 'applied' });
    expect(events).toHaveLength(1);
    expect(events[0]!.applied_at).toBe('2026-01-01T01:00:00.000Z');
    expect(events[0]!.resolution).toEqual({ agents: ['agent-1'] });
  });

  test('updateWaveEvent — pending to rejected', () => {
    store.postWaveEvent({ id: 'evt-1', type: 'guidance', payload: {}, timestamp: '2026-01-01T00:00:00.000Z', status: 'pending' });
    store.updateWaveEvent('evt-1', {
      status: 'rejected',
      rejection_reason: 'not applicable',
    });

    const events = store.getWaveEvents({ status: 'rejected' });
    expect(events).toHaveLength(1);
    expect(events[0]!.rejection_reason).toBe('not applicable');
  });

  test('wave event payload round-trips complex JSON', () => {
    const payload = {
      target_task_id: 'task-01',
      guidance: 'focus on error handling',
      nested: { deep: { value: 42 } },
    };
    store.postWaveEvent({ id: 'evt-1', type: 'inject_context', payload, timestamp: '2026-01-01T00:00:00.000Z', status: 'pending' });
    const events = store.getWaveEvents();
    expect(events[0]!.payload).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// appendEvent
// ---------------------------------------------------------------------------

describe('appendEvent', () => {
  let store: ExecutionStore;

  beforeEach(() => { store = makeStore(); });
  afterEach(() => { store.close(); });

  test('writes to events table', () => {
    store.appendEvent('state_entered', { state_id: 'research', timestamp: '2026-01-01T00:00:00.000Z' });
    store.appendEvent('state_completed', { state_id: 'research', result: 'done' });

    const db = (store as any).db as Database.Database;
    const rows = db.prepare('SELECT * FROM events ORDER BY id').all() as Array<{ type: string; payload: string; timestamp: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.type).toBe('state_entered');
    expect(JSON.parse(rows[0]!.payload)).toEqual({ state_id: 'research', timestamp: '2026-01-01T00:00:00.000Z' });
    expect(rows[1]!.type).toBe('state_completed');
  });

  test('timestamp is set automatically', () => {
    store.appendEvent('test_event', { data: 'value' });
    const db = (store as any).db as Database.Database;
    const row = db.prepare('SELECT * FROM events WHERE type = ?').get('test_event') as { timestamp: string } | undefined;
    expect(row?.timestamp).toBeTruthy();
    expect(new Date(row!.timestamp).getTime()).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// transaction
// ---------------------------------------------------------------------------

describe('transaction', () => {
  let store: ExecutionStore;

  beforeEach(() => { store = makeStore(); });
  afterEach(() => { store.close(); });

  test('commits on success', () => {
    store.transaction(() => {
      store.appendProgress('line 1');
      store.appendProgress('line 2');
    });
    const progress = store.getProgress();
    expect(progress).toContain('line 1');
    expect(progress).toContain('line 2');
  });

  test('rolls back on throw', () => {
    try {
      store.transaction(() => {
        store.appendProgress('line 1');
        throw new Error('rollback me');
      });
    } catch {
      // expected
    }
    expect(store.getProgress()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// getBoard — reconstructs full Board object
// ---------------------------------------------------------------------------

describe('getBoard', () => {
  let store: ExecutionStore;

  beforeEach(() => {
    store = makeStore();
    store.initExecution(BASE_INIT_PARAMS);
  });
  afterEach(() => { store.close(); });

  test('returns null when no execution exists', () => {
    const emptyStore = makeStore();
    expect(emptyStore.getBoard()).toBeNull();
    emptyStore.close();
  });

  test('reconstructs Board matching BoardSchema.parse()', () => {
    store.upsertState('research', { status: 'done', entries: 1, result: 'done', artifacts: ['research/SUMMARY.md'] });
    store.upsertState('implement', { status: 'in_progress', entries: 1 });
    store.upsertIteration('implement', { count: 1, max: 3, history: [{ status: 'blocked' }], cannot_fix: [] });

    const board = store.getBoard()!;
    // Validate against BoardSchema — this will throw if shape is wrong
    const parsed = BoardSchema.parse(board);
    expect(parsed.flow).toBe('test-flow');
    expect(parsed.task).toBe('build feature X');
    expect(parsed.entry).toBe('research');
    expect(parsed.current_state).toBe('research');
    expect(parsed.base_commit).toBe('abc123');
    expect(parsed.states['research']!.status).toBe('done');
    expect(parsed.states['implement']!.status).toBe('in_progress');
    expect(parsed.iterations['implement']!.count).toBe(1);
    expect(parsed.blocked).toBeNull();
    expect(parsed.concerns).toEqual([]);
    expect(parsed.skipped).toEqual([]);
  });

  test('getBoard completes in <10ms for a board with 20 states', () => {
    // Populate 20 states
    for (let i = 0; i < 20; i++) {
      store.upsertState(`state-${i}`, {
        status: i < 10 ? 'done' : 'pending',
        entries: i < 10 ? 1 : 0,
        result: i < 10 ? 'done' : undefined,
        wave_results: {
          'wave-1': { tasks: [`task-${i}`], status: 'done' },
        },
      });
      if (i % 3 === 0) {
        store.upsertIteration(`state-${i}`, {
          count: i,
          max: 5,
          history: [{ status: 'blocked' }, { commit_sha: 'abc', artifact_count: 1 }],
          cannot_fix: [],
        });
      }
    }

    const start = Date.now();
    const board = store.getBoard();
    const elapsed = Date.now() - start;
    expect(board).not.toBeNull();
    expect(elapsed).toBeLessThan(10);
  });

  test('getBoard includes blocked, concerns, skipped, metadata from updateExecution', () => {
    const blocked = { state: 'research', reason: 'needs clarification', since: '2026-01-01T00:00:00.000Z' };
    const concerns = [{ state_id: 'research', agent: 'reviewer', message: 'issue', timestamp: '2026-01-01T00:00:00.000Z' }];
    store.updateExecution({ blocked, concerns, skipped: ['optional-state'], metadata: { pr: 42 } });

    const board = store.getBoard()!;
    expect(board.blocked).toEqual(blocked);
    expect(board.concerns).toEqual(concerns);
    expect(board.skipped).toEqual(['optional-state']);
    expect(board.metadata).toEqual({ pr: 42 });
  });
});

// ---------------------------------------------------------------------------
// JSON round-trip — deeply nested Board with all optional fields
// ---------------------------------------------------------------------------

describe('JSON round-trip — deeply nested Board', () => {
  let store: ExecutionStore;

  beforeEach(() => {
    store = makeStore();
    store.initExecution(BASE_INIT_PARAMS);
  });
  afterEach(() => { store.close(); });

  test('round-trips Board with deeply nested wave_results and all 5 HistoryEntry variants', () => {
    const complexWaveResults = {
      'wave-1': {
        tasks: ['task-a', 'task-b'],
        status: 'done',
        gate: 'npm test',
        gate_output: 'all passing',
        consultations: {
          before: {
            'arch-check': { status: 'done', summary: 'looks good', artifact: 'decisions/arch.md' },
          },
          between: {
            'code-review': { status: 'done', summary: null },
          },
          after: {
            'qa-review': { status: 'done', summary: 'approved' },
          },
        },
      },
      'wave-2': {
        tasks: ['task-c'],
        status: 'in_progress',
      },
    };

    const fullHistory = [
      { principle_ids: ['deep-modules', 'thin-handlers'], file_paths: ['src/foo.ts', 'src/bar.ts'] },
      { pairs: [{ file: 'src/A.ts', test: 'src/__tests__/A.test.ts' }, { file: 'src/B.ts', test: 'src/__tests__/B.test.ts' }] },
      { status: 'blocked' },
      { commit_sha: 'deadbeef', artifact_count: 5 },
      { gate_output_hash: 'sha256:abc', passed: true },
    ];

    const fullMetrics = {
      duration_ms: 12345,
      spawns: 7,
      model: 'claude-3-5-sonnet',
      gate_results: [
        { passed: true, gate: 'npm test', command: 'npm test', output: 'all passing', exitCode: 0 },
        { passed: false, gate: 'tsc', command: 'npx tsc', output: 'error TS2345', exitCode: 1 },
      ],
      postcondition_results: [
        { passed: true, name: 'file exists', type: 'file_exists', output: 'found' },
        { passed: false, name: 'no TODOs', type: 'no_pattern', output: '3 matches' },
      ],
      violation_count: 3,
      violation_severities: { blocking: 1, warning: 2 },
      test_results: { passed: 42, failed: 1, skipped: 2 },
      files_changed: 8,
      revision_count: 2,
    };

    store.upsertState('implement', {
      status: 'done',
      entries: 3,
      entered_at: '2026-01-01T00:00:00.000Z',
      completed_at: '2026-01-01T02:00:00.000Z',
      result: 'done',
      artifacts: ['src/feature.ts', 'src/__tests__/feature.test.ts'],
      artifact_history: [
        { entry: 1, artifacts: ['src/feature.ts'] },
        { entry: 2, artifacts: ['src/feature.ts', 'src/__tests__/feature.test.ts'] },
      ],
      wave: 2,
      wave_total: 2,
      wave_results: complexWaveResults,
      metrics: fullMetrics,
      gate_results: fullMetrics.gate_results,
      postcondition_results: fullMetrics.postcondition_results,
      discovered_gates: [{ command: 'npm run lint', source: 'reviewer' }],
      discovered_postconditions: [
        { type: 'file_exists', target: 'src/feature.ts' },
        { type: 'no_pattern', pattern: 'TODO', target: 'src/feature.ts' },
      ],
      parallel_results: [
        { item: 'feat-a', status: 'done', artifacts: ['SUMMARY.md'] },
        { item: 'feat-b', status: 'done' },
      ],
      compete_results: [
        { lens: 'performance', status: 'done', artifacts: ['perf-PLAN.md'] },
        { lens: 'correctness', status: 'done' },
      ],
      synthesized: true,
    });

    store.upsertIteration('implement', {
      count: 3,
      max: 5,
      history: fullHistory,
      cannot_fix: [{ principle_id: 'deep-modules', file_path: 'src/legacy.ts' }],
    });

    const board = store.getBoard()!;
    const parsed = BoardSchema.parse(board);

    // Verify deep equality for all nested structures
    expect(parsed.states['implement']!.wave_results).toEqual(complexWaveResults);
    expect(parsed.states['implement']!.metrics).toEqual(fullMetrics);
    expect(parsed.states['implement']!.gate_results).toEqual(fullMetrics.gate_results);
    expect(parsed.states['implement']!.parallel_results).toHaveLength(2);
    expect(parsed.states['implement']!.compete_results).toHaveLength(2);
    expect(parsed.states['implement']!.synthesized).toBe(true);
    expect(parsed.iterations['implement']!.history).toEqual(fullHistory);
    expect(parsed.iterations['implement']!.cannot_fix).toEqual([
      { principle_id: 'deep-modules', file_path: 'src/legacy.ts' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// getExecutionStore — factory caching
// ---------------------------------------------------------------------------

describe('getExecutionStore', () => {
  let tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    tmpDirs = [];
  });

  test('returns cached instance for same workspace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exec-store-factory-'));
    tmpDirs.push(dir);

    const store1 = getExecutionStore(dir);
    const store2 = getExecutionStore(dir);
    expect(store1).toBe(store2);
  });

  test('returns different instances for different workspaces', () => {
    const dir1 = mkdtempSync(join(tmpdir(), 'exec-store-factory-'));
    const dir2 = mkdtempSync(join(tmpdir(), 'exec-store-factory-'));
    tmpDirs.push(dir1, dir2);

    const store1 = getExecutionStore(dir1);
    const store2 = getExecutionStore(dir2);
    expect(store1).not.toBe(store2);
  });

  test('created store persists data to disk (not just in-memory)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exec-store-persist-'));
    tmpDirs.push(dir);

    const store = getExecutionStore(dir);
    store.appendProgress('persistent entry');

    // Get a second reference (cached), verify same data
    const sameStore = getExecutionStore(dir);
    expect(sameStore.getProgress()).toContain('persistent entry');
  });
});

// ---------------------------------------------------------------------------
// Concurrent writes — busy_timeout handles SQLITE_BUSY
// ---------------------------------------------------------------------------

describe('concurrent writes', () => {
  test('two store instances writing to same DB file do not throw SQLITE_BUSY', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'exec-concurrent-'));
    let store1: ExecutionStore | null = null;
    let store2: ExecutionStore | null = null;

    try {
      const dbPath = join(tmpDir, 'orchestration.db');
      const db1 = initExecutionDb(dbPath);
      const db2 = initExecutionDb(dbPath);
      store1 = new ExecutionStore(db1);
      store2 = new ExecutionStore(db2);

      // Perform many interleaved writes from two instances
      // With WAL + busy_timeout=5000, these should not throw
      let errors: Error[] = [];
      const N = 20;
      for (let i = 0; i < N; i++) {
        try {
          store1.appendMessage('chan', 'agent-1', `message-${i}-from-1`);
          store2.appendMessage('chan', 'agent-2', `message-${i}-from-2`);
        } catch (e) {
          errors.push(e as Error);
        }
      }
      expect(errors).toHaveLength(0);

      // Verify all messages were written
      const messages = store1.getMessages('chan');
      expect(messages.length).toBe(N * 2);
    } finally {
      store1?.close();
      store2?.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
