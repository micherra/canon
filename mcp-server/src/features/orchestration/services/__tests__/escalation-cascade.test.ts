/**
 * escalation-cascade — unit tests.
 *
 * Tests cover:
 *  1. getNextStrategy: empty state returns add_primer (first in cascade)
 *  2. getNextStrategy: after add_primer returns increase_budget
 *  3. getNextStrategy: all strategies attempted returns hitl
 *  4. getNextStrategy: timeout exceeded returns hitl regardless of attempts
 *  5. getNextStrategy: skip_strategies skips those strategies
 *  6. getNextStrategy: security flow (skip narrow_scope) returns correct sequence
 *  7. initEscalationState: creates valid initial state
 *  8. recordAttempt: preserves existing attempts and appends new one (immutable)
 *  9. readEscalationState / writeEscalationState: round-trip through execution store metrics
 *
 * Test strategy:
 *  - Pure functions tested directly (no mocks needed)
 *  - Persistence tested with a real in-memory SQLite ExecutionStore
 *  - vi.setSystemTime used for deterministic time-elapsed assertions
 */

import { initExecutionDb } from "@domains/workspaces/execution-schema.ts";
import { ExecutionStore } from "@domains/workspaces/execution-store.ts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { EscalationConfig, EscalationState } from "../escalation-cascade.ts";
import {
  getNextStrategy,
  initEscalationState,
  readEscalationState,
  recordAttempt,
  writeEscalationState,
} from "../escalation-cascade.ts";

// ---- Test helpers ----

function makeStore(): ExecutionStore {
  return new ExecutionStore(initExecutionDb(":memory:"));
}

/** Build a state with specific strategies already attempted. */
function stateWithAttempts(
  strategies: Array<"add_primer" | "increase_budget" | "escalate_model" | "narrow_scope" | "hitl">,
  overrides?: Partial<EscalationState>,
): EscalationState {
  const base = initEscalationState("test-step");
  const attempts = strategies.map((strategy, i) => ({
    attempted_at: new Date(Date.now() + i * 1000).toISOString(),
    step_id: "test-step",
    strategy,
  }));
  return { ...base, attempts, ...overrides };
}

// ---- Tests ----

describe("getNextStrategy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("empty state returns add_primer (first in cascade)", () => {
    const state = initEscalationState("step-1");
    const result = getNextStrategy(state);

    expect(result.strategy).toBe("add_primer");
    expect(result.is_terminal).toBe(false);
    expect(result.attempts_so_far).toBe(0);
    expect(result.time_elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(result.reasoning).toContain("primer");
  });

  test("after add_primer returns increase_budget (second in cascade)", () => {
    const state = stateWithAttempts(["add_primer"]);
    const result = getNextStrategy(state);

    expect(result.strategy).toBe("increase_budget");
    expect(result.is_terminal).toBe(false);
    expect(result.attempts_so_far).toBe(1);
  });

  test("all strategies attempted returns hitl", () => {
    const state = stateWithAttempts([
      "add_primer",
      "increase_budget",
      "escalate_model",
      "narrow_scope",
      "hitl",
    ]);
    const result = getNextStrategy(state);

    expect(result.strategy).toBe("hitl");
    expect(result.is_terminal).toBe(true);
    expect(result.reasoning).toContain("exhausted");
  });

  test("timeout exceeded returns hitl regardless of prior attempts", () => {
    // Start at base time, then advance 3 minutes past the 2-minute timeout
    const startTime = new Date("2026-05-20T10:00:00.000Z");
    vi.setSystemTime(startTime);

    const state = initEscalationState("step-timeout");
    // Advance 3 minutes
    vi.setSystemTime(new Date(startTime.getTime() + 3 * 60 * 1000));

    const result = getNextStrategy(state, { timeout_ms: 120_000 });

    expect(result.strategy).toBe("hitl");
    expect(result.is_terminal).toBe(true);
    expect(result.reasoning).toContain("timeout");
    expect(result.time_elapsed_ms).toBeGreaterThanOrEqual(120_000);
  });

  test("skip_strategies skips specified strategies", () => {
    const state = initEscalationState("step-skip");
    const config: EscalationConfig = { skip_strategies: ["add_primer", "increase_budget"] };
    const result = getNextStrategy(state, config);

    expect(result.strategy).toBe("escalate_model");
    expect(result.is_terminal).toBe(false);
  });

  test("security flow (skip narrow_scope) returns correct sequence", () => {
    const config: EscalationConfig = { skip_strategies: ["narrow_scope"] };

    const empty = initEscalationState("sec-step");
    expect(getNextStrategy(empty, config).strategy).toBe("add_primer");

    const afterPrimer = stateWithAttempts(["add_primer"]);
    expect(getNextStrategy(afterPrimer, config).strategy).toBe("increase_budget");

    const afterBudget = stateWithAttempts(["add_primer", "increase_budget"]);
    expect(getNextStrategy(afterBudget, config).strategy).toBe("escalate_model");

    // After escalate_model, narrow_scope is skipped → hitl
    const afterModel = stateWithAttempts(["add_primer", "increase_budget", "escalate_model"]);
    const result = getNextStrategy(afterModel, config);
    expect(result.strategy).toBe("hitl");
    expect(result.is_terminal).toBe(true);
  });
});

describe("initEscalationState", () => {
  test("creates valid initial state with empty attempts", () => {
    const state = initEscalationState("my-step");

    expect(state.current_step_id).toBe("my-step");
    expect(state.attempts).toHaveLength(0);
    expect(state.cascade_started_at).toBeDefined();
    // Should be a valid ISO date
    expect(() => new Date(state.cascade_started_at)).not.toThrow();
    expect(new Date(state.cascade_started_at).toISOString()).toBe(state.cascade_started_at);
  });
});

describe("recordAttempt", () => {
  test("preserves existing attempts and appends new one (immutable)", () => {
    const original = initEscalationState("step-x");
    const afterFirst = recordAttempt(original, "add_primer", "step-x");

    expect(afterFirst.attempts).toHaveLength(1);
    expect(afterFirst.attempts[0].strategy).toBe("add_primer");
    expect(afterFirst.attempts[0].step_id).toBe("step-x");

    // original is not mutated
    expect(original.attempts).toHaveLength(0);

    const afterSecond = recordAttempt(afterFirst, "increase_budget", "step-x");
    expect(afterSecond.attempts).toHaveLength(2);
    expect(afterSecond.attempts[1].strategy).toBe("increase_budget");

    // afterFirst is not mutated
    expect(afterFirst.attempts).toHaveLength(1);

    // current_step_id updated
    expect(afterFirst.current_step_id).toBe("step-x");
    expect(afterSecond.current_step_id).toBe("step-x");
  });

  test("each attempt has a valid ISO timestamp", () => {
    const state = initEscalationState("ts-step");
    const updated = recordAttempt(state, "add_primer", "ts-step");

    const timestamp = updated.attempts[0].attempted_at;
    expect(() => new Date(timestamp)).not.toThrow();
    expect(new Date(timestamp).toISOString()).toBe(timestamp);
  });
});

describe("readEscalationState / writeEscalationState", () => {
  test("round-trips escalation state through execution store metrics", () => {
    const store = makeStore();

    // Create a state row first (required for updateStateMetrics to have a row)
    store.upsertState("step-persist", { entries: 0, status: "pending" });

    // No state written yet
    expect(readEscalationState(store, "step-persist")).toBeNull();

    // Write a state
    const state = initEscalationState("step-persist");
    const stateWithAttempt = recordAttempt(state, "add_primer", "step-persist");
    writeEscalationState(store, "step-persist", stateWithAttempt);

    // Read back and verify
    const roundTripped = readEscalationState(store, "step-persist");
    expect(roundTripped).not.toBeNull();
    expect(roundTripped!.current_step_id).toBe("step-persist");
    expect(roundTripped!.attempts).toHaveLength(1);
    expect(roundTripped!.attempts[0].strategy).toBe("add_primer");
    expect(roundTripped!.cascade_started_at).toBe(stateWithAttempt.cascade_started_at);
  });

  test("returns null for a non-existent state row", () => {
    const store = makeStore();
    expect(readEscalationState(store, "nonexistent-step")).toBeNull();
  });

  test("overwrites existing state on second write", () => {
    const store = makeStore();
    store.upsertState("step-overwrite", { entries: 0, status: "pending" });

    const state = initEscalationState("step-overwrite");
    writeEscalationState(store, "step-overwrite", state);

    const withOne = recordAttempt(state, "add_primer", "step-overwrite");
    writeEscalationState(store, "step-overwrite", withOne);

    const result = readEscalationState(store, "step-overwrite");
    expect(result!.attempts).toHaveLength(1);
  });

  test("returns null when stored JSON is valid but not an EscalationState shape (validate-at-trust-boundaries)", () => {
    // Manually inject corrupt/wrong-shape data into the metrics key
    const store = makeStore();
    store.upsertState("step-corrupt", { entries: 0, status: "pending" });
    // Inject a JSON string that parses but is NOT an EscalationState
    store.updateStateMetrics("step-corrupt", {
      escalation_state: JSON.stringify({ num: 42, unexpected: "field" }),
    });
    // Should return null, not crash or return a mistyped object
    expect(readEscalationState(store, "step-corrupt")).toBeNull();
  });

  test("returns null when stored JSON is a JSON array, not an object", () => {
    const store = makeStore();
    store.upsertState("step-array", { entries: 0, status: "pending" });
    store.updateStateMetrics("step-array", {
      escalation_state: JSON.stringify([{ strategy: "add_primer" }]),
    });
    expect(readEscalationState(store, "step-array")).toBeNull();
  });

  test("returns null when cascade_started_at is a non-empty invalid date string", () => {
    // An invalid date string (non-empty, passes typeof check) that produces NaN
    // when parsed — this would cause getNextStrategy to compute NaN elapsed time
    // and bypass the timeout check.
    const store = makeStore();
    store.upsertState("step-bad-ts", { entries: 0, status: "pending" });
    store.updateStateMetrics("step-bad-ts", {
      escalation_state: JSON.stringify({
        attempts: [],
        cascade_started_at: "not-a-date",
        current_step_id: "step-bad-ts",
      }),
    });
    expect(readEscalationState(store, "step-bad-ts")).toBeNull();
  });

  test("drops null and malformed attempt elements, retains well-formed ones", () => {
    // A stored state where attempts includes null and an object missing strategy —
    // the type guard should filter those out rather than returning null or crashing.
    const store = makeStore();
    store.upsertState("step-bad-attempts", { entries: 0, status: "pending" });
    store.updateStateMetrics("step-bad-attempts", {
      escalation_state: JSON.stringify({
        attempts: [
          null,
          { attempted_at: "2026-05-20T10:00:00Z", step_id: "step-bad-attempts" }, // missing strategy
          {
            attempted_at: "2026-05-20T10:01:00Z",
            step_id: "step-bad-attempts",
            strategy: "add_primer",
          },
        ],
        cascade_started_at: new Date().toISOString(),
        current_step_id: "step-bad-attempts",
      }),
    });
    const result = readEscalationState(store, "step-bad-attempts");
    // Should return a valid state (not null) with only the well-formed attempt
    expect(result).not.toBeNull();
    expect(result!.attempts).toHaveLength(1);
    expect(result!.attempts[0].strategy).toBe("add_primer");
  });

  test("getNextStrategy returns correct result when read state has filtered attempts", () => {
    // End-to-end: write corrupt state, read it back, call getNextStrategy
    const store = makeStore();
    store.upsertState("step-e2e-filter", { entries: 0, status: "pending" });
    store.updateStateMetrics("step-e2e-filter", {
      escalation_state: JSON.stringify({
        attempts: [
          null, // invalid — dropped
          {
            attempted_at: "2026-05-20T10:00:00Z",
            step_id: "step-e2e-filter",
            strategy: "add_primer",
          }, // valid
        ],
        cascade_started_at: new Date().toISOString(),
        current_step_id: "step-e2e-filter",
      }),
    });
    const state = readEscalationState(store, "step-e2e-filter");
    expect(state).not.toBeNull();

    // add_primer was (the only valid) attempted — next should be increase_budget
    const result = getNextStrategy(state!);
    expect(result.strategy).toBe("increase_budget");
    expect(result.is_terminal).toBe(false);
  });
});
