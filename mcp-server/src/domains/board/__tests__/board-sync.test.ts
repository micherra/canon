/**
 * board-sync — syncBoardToStore extraction tests
 *
 * Verifies that the extracted syncBoardToStore function correctly
 * syncs Board object fields to the ExecutionStore.
 */

import type { Board } from "@domains/flows/board-state-schemas.ts";
import { initExecutionDb } from "@domains/workspaces/execution-schema.ts";
import { ExecutionStore } from "@domains/workspaces/execution-store.ts";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { syncBoardToStore } from "../board-sync.ts";

function makeStore(): ExecutionStore {
  const db = initExecutionDb(":memory:");
  return new ExecutionStore(db);
}

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

function makeBoard(overrides: Partial<Board> = {}): Board {
  return {
    base_commit: "abc123",
    blocked: null,
    concerns: [],
    current_state: "research",
    entry: "research",
    flow: "test-flow",
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
    const board = makeBoard({ current_state: "implement" });
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
          state_id: "research",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {
          agent: "canon-reviewer",
          message: "test concern 2",
          state_id: "implement",
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
        research: {
          completed_at: "2026-01-01T01:00:00.000Z",
          entered_at: "2026-01-01T00:00:00.000Z",
          entries: 1,
          result: "Research complete",
          status: "done",
        },
      },
    });
    syncBoardToStore(store, board);

    const state = store.getState("research");
    expect(state?.status).toBe("done");
    expect(state?.entries).toBe(1);
    expect(state?.result).toBe("Research complete");
  });

  test("syncs iterations to store", () => {
    const board = makeBoard({
      iterations: {
        implement: {
          cannot_fix: [],
          count: 2,
          history: [{ status: "done" }, { status: "done_with_concerns" }],
          max: 3,
        },
      },
    });
    syncBoardToStore(store, board);

    const iter = store.getIteration("implement");
    expect(iter?.count).toBe(2);
    expect(iter?.max).toBe(3);
    expect(iter?.history).toEqual([{ status: "done" }, { status: "done_with_concerns" }]);
  });

  test("syncs multiple states in one call", () => {
    const board = makeBoard({
      states: {
        implement: { entries: 1, status: "in_progress" },
        research: { entries: 1, status: "done" },
        test: { entries: 0, status: "pending" },
      },
    });
    syncBoardToStore(store, board);

    expect(store.getState("research")?.status).toBe("done");
    expect(store.getState("implement")?.status).toBe("in_progress");
    expect(store.getState("test")?.status).toBe("pending");
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

describe("syncBoardToStore — transaction and versioning", () => {
  let store: ExecutionStore;

  beforeEach(() => {
    store = makeStore();
    store.initExecution(BASE_INIT_PARAMS);
  });

  test("returns ok:true with newVersion on success", () => {
    const board = makeBoard({ current_state: "implement" });
    const result = syncBoardToStore(store, board);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.newVersion).toBe(2); // started at 1, incremented to 2
    }
  });

  test("increments version monotonically on each call", () => {
    const board = makeBoard({ current_state: "implement" });

    const r1 = syncBoardToStore(store, board);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.newVersion).toBe(2);

    const r2 = syncBoardToStore(store, makeBoard({ current_state: "test" }));
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.newVersion).toBe(3);
  });

  test("returns ok:false on version conflict", () => {
    const board = makeBoard({ current_state: "implement" });
    // Pass a stale version (0, but actual is 1)
    const result = syncBoardToStore(store, board, 0);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("version_conflict");
      expect(result.currentVersion).toBe(1);
    }
  });

  test("rolls back all writes on version conflict — no partial state", () => {
    const board = makeBoard({
      current_state: "implement",
      states: {
        research: { entries: 1, status: "done" },
      },
    });

    // First write succeeds
    syncBoardToStore(store, board);

    // Now simulate stale version by passing version 0 (current is 2)
    const conflictBoard = makeBoard({
      current_state: "test",
      states: {
        test: { entries: 1, status: "in_progress" },
      },
    });
    const result = syncBoardToStore(store, conflictBoard, 0);

    expect(result.ok).toBe(false);

    // current_state should still be "implement" — the conflicted write did not apply
    const exec = store.getExecution();
    expect(exec?.current_state).toBe("implement");

    // "test" state should NOT have been written
    const testState = store.getState("test");
    expect(testState).toBeNull();
  });

  test("wraps all writes in a single transaction — atomicity", () => {
    // Spy on upsertState to count calls
    const upsertSpy = vi.spyOn(store, "upsertState");

    const board = makeBoard({
      states: {
        implement: { entries: 1, status: "in_progress" },
        research: { entries: 1, status: "done" },
      },
    });

    const result = syncBoardToStore(store, board);

    expect(result.ok).toBe(true);
    // Both states were upserted in the same call
    expect(upsertSpy).toHaveBeenCalledTimes(2);

    upsertSpy.mockRestore();
  });

  test("reader between two syncBoardToStore calls sees consistent state", () => {
    // First sync: research done, current = implement
    const board1 = makeBoard({
      current_state: "implement",
      states: { research: { entries: 1, status: "done" } },
    });
    const r1 = syncBoardToStore(store, board1);
    expect(r1.ok).toBe(true);

    // Read mid-flight: exec should show implement, research should be done
    const exec1 = store.getExecution();
    expect(exec1?.current_state).toBe("implement");
    const researchState = store.getState("research");
    expect(researchState?.status).toBe("done");

    // Second sync: implement done, current = test
    const board2 = makeBoard({
      current_state: "test",
      states: {
        implement: { entries: 1, status: "done" },
        research: { entries: 1, status: "done" },
      },
    });
    const r2 = syncBoardToStore(store, board2);
    expect(r2.ok).toBe(true);

    const exec2 = store.getExecution();
    expect(exec2?.current_state).toBe("test");
    const implState = store.getState("implement");
    expect(implState?.status).toBe("done");
  });
});
