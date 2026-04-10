/**
 * board-sync — syncBoardToStore extraction tests
 *
 * Verifies that the extracted syncBoardToStore function correctly
 * syncs Board object fields to the ExecutionStore.
 */

import type { Board, StateId } from "@domains/flows/board-state-schemas.ts";
import { flowName, stateId as sid } from "@domains/flows/board-state-schemas.ts";
import { initExecutionDb } from "@domains/workspaces/execution-schema.ts";
import { ExecutionStore } from "@domains/workspaces/execution-store.ts";
import { beforeEach, describe, expect, test } from "vitest";
import { syncBoardToStore } from "../board-sync.ts";

function makeStore(): ExecutionStore {
  const db = initExecutionDb(":memory:");
  return new ExecutionStore(db);
}

const BASE_INIT_PARAMS = {
  base_commit: "abc123",
  branch: "feat/test",
  created: "2026-01-01T00:00:00.000Z",
  current_state: sid("research"),
  entry: sid("research"),
  flow: "test-flow",
  flow_name: "test-flow",
  last_updated: "2026-01-01T00:00:00.000Z",
  sanitized: "feat-test",
  slug: "test-slug",
  started: "2026-01-01T00:00:00.000Z",
  task: "build feature X",
  tier: "medium" as const,
};

function makeBoard(overrides: Partial<Board> = {}): Board {
  return {
    base_commit: "abc123",
    blocked: null,
    concerns: [],
    current_state: sid("research"),
    entry: sid("research"),
    flow: flowName("test-flow"),
    iterations: {},
    last_updated: "2026-01-01T00:00:00.000Z",
    skipped: [],
    started: "2026-01-01T00:00:00.000Z",
    states: {},
    task: "build feature X",
    ...overrides,
  };
}

describe("syncBoardToStore", () => {
  let store: ExecutionStore;

  beforeEach(() => {
    store = makeStore();
    store.initExecution(BASE_INIT_PARAMS);
  });

  test("updates current_state on execution", () => {
    const board = makeBoard({ current_state: sid("implement") });
    syncBoardToStore(store, board);

    const exec = store.getExecution();
    expect(exec?.current_state).toBe("implement");
  });

  test("updates blocked on execution", () => {
    const board = makeBoard({
      blocked: {
        reason: "Needs clarification",
        since: "2026-01-01T00:00:00.000Z",
        state: "research",
      },
    });
    syncBoardToStore(store, board);

    const exec = store.getExecution();
    expect(exec?.blocked).toEqual({
      reason: "Needs clarification",
      since: "2026-01-01T00:00:00.000Z",
      state: "research",
    });
  });

  test("updates concerns on execution", () => {
    const board = makeBoard({
      concerns: [
        {
          agent: "canon-reviewer",
          message: "test concern 1",
          state_id: sid("research"),
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {
          agent: "canon-reviewer",
          message: "test concern 2",
          state_id: sid("implement"),
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    syncBoardToStore(store, board);

    const exec = store.getExecution();
    expect(exec?.concerns).toEqual([
      {
        agent: "canon-reviewer",
        message: "test concern 1",
        state_id: "research",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      {
        agent: "canon-reviewer",
        message: "test concern 2",
        state_id: "implement",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  test("syncs board states to store", () => {
    const board = makeBoard({
      states: {
        [sid("research")]: {
          completed_at: "2026-01-01T01:00:00.000Z",
          entered_at: "2026-01-01T00:00:00.000Z",
          entries: 1,
          result: "Research complete",
          status: "done",
        },
      } as Board["states"],
    });
    syncBoardToStore(store, board);

    const state = store.getState(sid("research"));
    expect(state?.status).toBe("done");
    expect(state?.entries).toBe(1);
    expect(state?.result).toBe("Research complete");
  });

  test("syncs iterations to store", () => {
    const board = makeBoard({
      iterations: {
        [sid("implement")]: {
          cannot_fix: [],
          count: 2,
          history: [{ status: "done" }, { status: "done_with_concerns" }],
          max: 3,
        },
      } as Board["iterations"],
    });
    syncBoardToStore(store, board);

    const iter = store.getIteration(sid("implement"));
    expect(iter?.count).toBe(2);
    expect(iter?.max).toBe(3);
    expect(iter?.history).toEqual([{ status: "done" }, { status: "done_with_concerns" }]);
  });

  test("syncs multiple states in one call", () => {
    const board = makeBoard({
      states: {
        [sid("implement")]: { entries: 1, status: "in_progress" },
        [sid("research")]: { entries: 1, status: "done" },
        [sid("test")]: { entries: 0, status: "pending" },
      } as Board["states"],
    });
    syncBoardToStore(store, board);

    expect(store.getState(sid("research"))?.status).toBe("done");
    expect(store.getState(sid("implement"))?.status).toBe("in_progress");
    expect(store.getState(sid("test"))?.status).toBe("pending");
  });

  test("handles empty states and iterations", () => {
    const board = makeBoard({
      iterations: {},
      states: {},
    });
    // Should not throw
    expect(() => syncBoardToStore(store, board)).not.toThrow();
  });

  test("updates last_updated timestamp", () => {
    const newTimestamp = "2026-06-01T12:00:00.000Z";
    const board = makeBoard({ last_updated: newTimestamp });
    syncBoardToStore(store, board);

    const exec = store.getExecution();
    expect(exec?.last_updated).toBe(newTimestamp);
  });
});
