/**
 * board-sync — syncBoardToStore extraction tests
 *
 * Verifies that the extracted syncBoardToStore function correctly
 * syncs Board object fields to the ExecutionStore.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { initExecutionDb } from '../orchestration/execution-schema.ts';
import { ExecutionStore } from '../orchestration/execution-store.ts';
import { syncBoardToStore } from '../orchestration/board-sync.ts';
import type { Board } from '../orchestration/flow-schema.ts';

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

function makeBoard(overrides: Partial<Board> = {}): Board {
  return {
    flow: 'test-flow',
    task: 'build feature X',
    entry: 'research',
    current_state: 'research',
    base_commit: 'abc123',
    started: '2026-01-01T00:00:00.000Z',
    last_updated: '2026-01-01T00:00:00.000Z',
    blocked: null,
    concerns: [],
    skipped: [],
    states: {},
    iterations: {},
    ...overrides,
  };
}

describe('syncBoardToStore', () => {
  let store: ExecutionStore;

  beforeEach(() => {
    store = makeStore();
    store.initExecution(BASE_INIT_PARAMS);
  });

  test('updates current_state on execution', () => {
    const board = makeBoard({ current_state: 'implement' });
    syncBoardToStore(store, board);

    const exec = store.getExecution();
    expect(exec?.current_state).toBe('implement');
  });

  test('updates blocked on execution', () => {
    const board = makeBoard({
      blocked: { state: 'research', reason: 'Needs clarification', since: '2026-01-01T00:00:00.000Z' },
    });
    syncBoardToStore(store, board);

    const exec = store.getExecution();
    expect(exec?.blocked).toEqual({
      state: 'research',
      reason: 'Needs clarification',
      since: '2026-01-01T00:00:00.000Z',
    });
  });

  test('updates concerns on execution', () => {
    const board = makeBoard({
      concerns: [
        { state_id: 'research', agent: 'canon-reviewer', message: 'test concern 1', timestamp: '2026-01-01T00:00:00.000Z' },
        { state_id: 'implement', agent: 'canon-reviewer', message: 'test concern 2', timestamp: '2026-01-01T00:00:00.000Z' },
      ],
    });
    syncBoardToStore(store, board);

    const exec = store.getExecution();
    expect(exec?.concerns).toEqual([
      { state_id: 'research', agent: 'canon-reviewer', message: 'test concern 1', timestamp: '2026-01-01T00:00:00.000Z' },
      { state_id: 'implement', agent: 'canon-reviewer', message: 'test concern 2', timestamp: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  test('syncs board states to store', () => {
    const board = makeBoard({
      states: {
        research: {
          status: 'done',
          entries: 1,
          entered_at: '2026-01-01T00:00:00.000Z',
          completed_at: '2026-01-01T01:00:00.000Z',
          result: 'Research complete',
        },
      },
    });
    syncBoardToStore(store, board);

    const state = store.getState('research');
    expect(state?.status).toBe('done');
    expect(state?.entries).toBe(1);
    expect(state?.result).toBe('Research complete');
  });

  test('syncs iterations to store', () => {
    const board = makeBoard({
      iterations: {
        implement: {
          count: 2,
          max: 3,
          history: [{ status: 'done' }, { status: 'done_with_concerns' }],
          cannot_fix: [],
        },
      },
    });
    syncBoardToStore(store, board);

    const iter = store.getIteration('implement');
    expect(iter?.count).toBe(2);
    expect(iter?.max).toBe(3);
    expect(iter?.history).toEqual([{ status: 'done' }, { status: 'done_with_concerns' }]);
  });

  test('syncs multiple states in one call', () => {
    const board = makeBoard({
      states: {
        research: { status: 'done', entries: 1 },
        implement: { status: 'in_progress', entries: 1 },
        test: { status: 'pending', entries: 0 },
      },
    });
    syncBoardToStore(store, board);

    expect(store.getState('research')?.status).toBe('done');
    expect(store.getState('implement')?.status).toBe('in_progress');
    expect(store.getState('test')?.status).toBe('pending');
  });

  test('handles empty states and iterations', () => {
    const board = makeBoard({
      states: {},
      iterations: {},
    });
    // Should not throw
    expect(() => syncBoardToStore(store, board)).not.toThrow();
  });

  test('updates last_updated timestamp', () => {
    const newTimestamp = '2026-06-01T12:00:00.000Z';
    const board = makeBoard({ last_updated: newTimestamp });
    syncBoardToStore(store, board);

    const exec = store.getExecution();
    expect(exec?.last_updated).toBe(newTimestamp);
  });
});
