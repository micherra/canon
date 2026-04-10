/**
 * ExecutionStore — concurrency and optimistic-locking tests
 *
 * Split from execution-store.test.ts to keep each file under the 600-line limit.
 * Covers: withRetry, transaction, getVersion, updateExecutionVersioned.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { initExecutionDb } from "../execution-schema.ts";
import { ExecutionStore } from "../execution-store.ts";

function makeStore(): ExecutionStore {
  return new ExecutionStore(initExecutionDb(":memory:"));
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

// withRetry — SQLITE_BUSY retry behavior

describe("withRetry", () => {
  let store: ExecutionStore;

  beforeEach(() => {
    store = makeStore();
  });
  afterEach(() => {
    store.close();
  });

  test("returns result on first successful attempt", () => {
    const result = store.withRetry(() => 42);
    expect(result).toBe(42);
  });

  test("retries on SQLITE_BUSY and succeeds on second attempt", () => {
    let attempts = 0;
    const busyError = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const result = store.withRetry(() => {
      attempts++;
      if (attempts === 1) throw busyError;
      return "success";
    });
    expect(result).toBe("success");
    expect(attempts).toBe(2);
  });

  test("throws after max attempts exhausted", () => {
    const busyError = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    expect(() =>
      store.withRetry(() => {
        throw busyError;
      }, 3),
    ).toThrow("database is locked");
  });

  test("does not retry non-SQLITE_BUSY errors", () => {
    let attempts = 0;
    const otherError = new Error("some other error");
    expect(() =>
      store.withRetry(() => {
        attempts++;
        throw otherError;
      }),
    ).toThrow("some other error");
    expect(attempts).toBe(1);
  });

  test("does not retry when error has no code property", () => {
    let attempts = 0;
    const noCodeError = new Error("plain error");
    expect(() =>
      store.withRetry(() => {
        attempts++;
        throw noCodeError;
      }),
    ).toThrow("plain error");
    expect(attempts).toBe(1);
  });
});

// transaction — uses withRetry internally

describe("transaction", () => {
  let store: ExecutionStore;

  beforeEach(() => {
    store = makeStore();
    store.initExecution(BASE_INIT_PARAMS);
  });
  afterEach(() => {
    store.close();
  });

  test("wraps a function in a SQLite transaction that commits on success", () => {
    store.transaction(() => {
      store.appendProgress("inside transaction");
    });
    expect(store.getProgress()).toContain("inside transaction");
  });

  test("rolls back on throw", () => {
    try {
      store.transaction(() => {
        store.appendProgress("will be rolled back");
        throw new Error("abort");
      });
    } catch {
      // expected
    }
    expect(store.getProgress()).not.toContain("will be rolled back");
  });
});

// getVersion — reads current execution version

describe("getVersion", () => {
  let store: ExecutionStore;

  beforeEach(() => {
    store = makeStore();
    store.initExecution(BASE_INIT_PARAMS);
  });
  afterEach(() => {
    store.close();
  });

  test("returns 1 after initExecution (DEFAULT 1 from migration)", () => {
    expect(store.getVersion()).toBe(1);
  });

  test("returns 1 when no execution row exists", () => {
    const emptyStore = makeStore();
    try {
      expect(emptyStore.getVersion()).toBe(1);
    } finally {
      emptyStore.close();
    }
  });
});

// updateExecutionVersioned — optimistic locking

describe("updateExecutionVersioned", () => {
  let store: ExecutionStore;

  beforeEach(() => {
    store = makeStore();
    store.initExecution(BASE_INIT_PARAMS);
  });
  afterEach(() => {
    store.close();
  });

  test("succeeds with correct expected version and returns updated:true", () => {
    const result = store.updateExecutionVersioned({ current_state: "implement" }, 1);
    expect(result).toEqual({ newVersion: 2, updated: true });
  });

  test("increments version on success", () => {
    store.updateExecutionVersioned({ current_state: "implement" }, 1);
    expect(store.getVersion()).toBe(2);
  });

  test("returns updated:false on version mismatch (stale write)", () => {
    // Apply a first update to advance version to 2
    store.updateExecutionVersioned({ current_state: "implement" }, 1);
    // Now try to update with stale version 1
    const result = store.updateExecutionVersioned({ current_state: "review" }, 1);
    expect(result).toEqual({ currentVersion: 2, updated: false });
  });

  test("does not modify state on version mismatch", () => {
    store.updateExecutionVersioned({ current_state: "implement" }, 1);
    store.updateExecutionVersioned({ current_state: "review" }, 1); // stale
    // State should remain at implement (the successful update)
    expect(store.getExecution()!.current_state).toBe("implement");
  });

  test("sequential successful updates increment version monotonically", () => {
    store.updateExecutionVersioned({ current_state: "implement" }, 1);
    store.updateExecutionVersioned({ current_state: "review" }, 2);
    store.updateExecutionVersioned({ current_state: "done" }, 3);
    expect(store.getVersion()).toBe(4);
    expect(store.getExecution()!.current_state).toBe("done");
  });
});
