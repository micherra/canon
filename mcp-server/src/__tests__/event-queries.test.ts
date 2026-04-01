/**
 * event-queries.test.ts
 *
 * Tests for:
 * - appendEvent with correlationId parameter
 * - getEvents() with filtering options
 * - getEventsByType() convenience method
 * - getCorrelationId() from execution table
 * - walCheckpoint() method
 */

import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { initExecutionDb } from '../orchestration/execution-schema.ts';
import { ExecutionStore } from '../orchestration/execution-store.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(): ExecutionStore {
  const db = initExecutionDb(':memory:');
  return new ExecutionStore(db);
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
// appendEvent — correlation_id storage
// ---------------------------------------------------------------------------

describe('appendEvent — correlation_id', () => {
  let store: ExecutionStore;

  beforeEach(() => {
    store = makeStore();
    store.initExecution(BASE_INIT_PARAMS);
  });

  test('stores correlation_id when provided', () => {
    store.appendEvent('state_entered', {
      stateId: 'research',
      stateType: 'research',
      timestamp: '2026-01-01T00:00:00.000Z',
      iterationCount: 1,
    }, 'corr-abc-123');

    const events = store.getEvents({ correlation_id: 'corr-abc-123' });
    expect(events).toHaveLength(1);
    expect(events[0].correlation_id).toBe('corr-abc-123');
    expect(events[0].type).toBe('state_entered');
  });

  test('stores NULL when correlationId is omitted', () => {
    store.appendEvent('board_updated', {
      action: 'enter_state',
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    const events = store.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].correlation_id).toBeNull();
  });

  test('emits console.warn but still writes when payload is invalid for known type', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // state_entered requires stateId, stateType, timestamp, iterationCount
    // Provide an invalid payload (missing required fields)
    store.appendEvent('state_entered', { unexpected_field: 'oops' });

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain('state_entered');

    // Event is still written despite validation failure
    const events = store.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('state_entered');

    warnSpy.mockRestore();
  });

  test('does not warn for unknown event types', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    store.appendEvent('custom_unknown_type', { anything: true });

    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// getEvents — filtering
// ---------------------------------------------------------------------------

describe('getEvents', () => {
  let store: ExecutionStore;

  beforeEach(() => {
    store = makeStore();
    store.initExecution(BASE_INIT_PARAMS);
  });

  test('returns all events ordered by id when called with no options', () => {
    store.appendEvent('flow_started', { flowName: 'f', task: 't', tier: 's', workspace: 'w', timestamp: '2026-01-01T00:00:00.000Z' }, 'c1');
    store.appendEvent('state_entered', { stateId: 'x', stateType: 'research', timestamp: '2026-01-01T00:01:00.000Z', iterationCount: 1 }, 'c1');
    store.appendEvent('board_updated', { action: 'update', timestamp: '2026-01-01T00:02:00.000Z' }, 'c2');

    const events = store.getEvents();
    expect(events).toHaveLength(3);
    // Ordered by id ASC
    expect(events[0].type).toBe('flow_started');
    expect(events[1].type).toBe('state_entered');
    expect(events[2].type).toBe('board_updated');
  });

  test('returns empty array when no events exist', () => {
    const events = store.getEvents();
    expect(events).toEqual([]);
  });

  test('filters by correlation_id', () => {
    store.appendEvent('flow_started', { flowName: 'f', task: 't', tier: 's', workspace: 'w', timestamp: '2026-01-01T00:00:00.000Z' }, 'corr-A');
    store.appendEvent('state_entered', { stateId: 'x', stateType: 'research', timestamp: '2026-01-01T00:01:00.000Z', iterationCount: 1 }, 'corr-B');
    store.appendEvent('board_updated', { action: 'update', timestamp: '2026-01-01T00:02:00.000Z' }, 'corr-A');

    const events = store.getEvents({ correlation_id: 'corr-A' });
    expect(events).toHaveLength(2);
    expect(events.every(e => e.correlation_id === 'corr-A')).toBe(true);
  });

  test('filters by type', () => {
    store.appendEvent('flow_started', { flowName: 'f', task: 't', tier: 's', workspace: 'w', timestamp: '2026-01-01T00:00:00.000Z' });
    store.appendEvent('board_updated', { action: 'x', timestamp: '2026-01-01T00:01:00.000Z' });
    store.appendEvent('board_updated', { action: 'y', timestamp: '2026-01-01T00:02:00.000Z' });

    const events = store.getEvents({ type: 'board_updated' });
    expect(events).toHaveLength(2);
    expect(events.every(e => e.type === 'board_updated')).toBe(true);
  });

  test('filters by since timestamp', () => {
    // Insert all events first, then record a "before all" timestamp
    const before = '2020-01-01T00:00:00.000Z';
    store.appendEvent('flow_started', { flowName: 'f', task: 't', tier: 's', workspace: 'w', timestamp: '2026-01-01T00:00:00.000Z' });
    store.appendEvent('board_updated', { action: 'x', timestamp: '2026-01-01T01:00:00.000Z' });
    store.appendEvent('board_updated', { action: 'y', timestamp: '2026-01-01T02:00:00.000Z' });

    // Since a time well before all events → returns all 3
    const allAfterBefore = store.getEvents({ since: before });
    expect(allAfterBefore).toHaveLength(3);

    // Since a time well after all events → returns nothing
    const after = '2099-01-01T00:00:00.000Z';
    const noneAfter = store.getEvents({ since: after });
    expect(noneAfter).toHaveLength(0);
  });

  test('limits results', () => {
    for (let i = 0; i < 10; i++) {
      store.appendEvent('board_updated', { action: `step-${i}`, timestamp: `2026-01-01T00:0${i}:00.000Z` });
    }

    const events = store.getEvents({ limit: 5 });
    expect(events).toHaveLength(5);
    // Should return the first 5 (ORDER BY id ASC LIMIT 5)
    const payloads = events.map(e => e.payload as Record<string, unknown>);
    expect(payloads[0].action).toBe('step-0');
    expect(payloads[4].action).toBe('step-4');
  });

  test('parses payload JSON back to object', () => {
    store.appendEvent('board_updated', { action: 'test', nested: { count: 42 }, timestamp: '2026-01-01T00:00:00.000Z' });
    const events = store.getEvents();
    expect(events[0].payload).toEqual({ action: 'test', nested: { count: 42 }, timestamp: '2026-01-01T00:00:00.000Z' });
  });

  test('returns empty array for correlation_id with no matches', () => {
    store.appendEvent('board_updated', { action: 'x', timestamp: '2026-01-01T00:00:00.000Z' }, 'other-id');
    const events = store.getEvents({ correlation_id: 'nonexistent' });
    expect(events).toEqual([]);
  });

  test('skips rows with corrupt JSON payload instead of throwing (never-throws contract)', () => {
    // Insert two valid events and one row with corrupt JSON directly via the DB
    store.appendEvent('board_updated', { action: 'before', timestamp: '2026-01-01T00:00:00.000Z' });

    // Corrupt the events table by directly inserting invalid JSON
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (store as any).db as import('better-sqlite3').Database;
    db.prepare(
      `INSERT INTO events (type, payload, timestamp) VALUES ('corrupted_event', 'NOT_VALID_JSON{{{', '2026-01-01T00:01:00.000Z')`
    ).run();

    store.appendEvent('board_updated', { action: 'after', timestamp: '2026-01-01T00:02:00.000Z' });

    // getEvents must not throw even with corrupt JSON in DB
    let events: ReturnType<typeof store.getEvents>;
    expect(() => { events = store.getEvents(); }).not.toThrow();

    // The corrupt row must be silently skipped — only valid rows returned
    expect(events!).toHaveLength(2);
    expect((events![0].payload as Record<string, unknown>).action).toBe('before');
    expect((events![1].payload as Record<string, unknown>).action).toBe('after');
  });
});

// ---------------------------------------------------------------------------
// getEventsByType
// ---------------------------------------------------------------------------

describe('getEventsByType', () => {
  let store: ExecutionStore;

  beforeEach(() => {
    store = makeStore();
    store.initExecution(BASE_INIT_PARAMS);
  });

  test('returns only events matching the given type', () => {
    store.appendEvent('flow_started', { flowName: 'f', task: 't', tier: 's', workspace: 'w', timestamp: '2026-01-01T00:00:00.000Z' });
    store.appendEvent('board_updated', { action: 'x', timestamp: '2026-01-01T00:01:00.000Z' });
    store.appendEvent('board_updated', { action: 'y', timestamp: '2026-01-01T00:02:00.000Z' });
    store.appendEvent('flow_started', { flowName: 'g', task: 't2', tier: 's', workspace: 'w', timestamp: '2026-01-01T00:03:00.000Z' });

    const events = store.getEventsByType('board_updated');
    expect(events).toHaveLength(2);
    expect(events.every(e => e.type === 'board_updated')).toBe(true);
  });

  test('returns empty array when no events match the type', () => {
    store.appendEvent('board_updated', { action: 'x', timestamp: '2026-01-01T00:00:00.000Z' });
    const events = store.getEventsByType('flow_started');
    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getCorrelationId
// ---------------------------------------------------------------------------

describe('getCorrelationId', () => {
  let store: ExecutionStore;

  beforeEach(() => {
    store = makeStore();
  });

  test('returns null when no execution row exists', () => {
    expect(store.getCorrelationId()).toBeNull();
  });

  test('returns the correlation_id from the execution row after initExecution', () => {
    store.initExecution(BASE_INIT_PARAMS);
    // initExecution() should create the execution row with a generated correlation_id (random UUID)
    const corrId = store.getCorrelationId();
    // correlation_id is a UUID string, so it should be a non-null string
    expect(typeof corrId).toBe('string');
    expect(corrId).not.toBeNull();
    // Should look like a UUID
    expect(corrId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

// ---------------------------------------------------------------------------
// walCheckpoint
// ---------------------------------------------------------------------------

describe('walCheckpoint', () => {
  test('runs without error', () => {
    const store = makeStore();
    expect(() => store.walCheckpoint()).not.toThrow();
  });

  test('can be called multiple times without error', () => {
    const store = makeStore();
    expect(() => {
      store.walCheckpoint();
      store.walCheckpoint();
      store.walCheckpoint();
    }).not.toThrow();
  });
});
