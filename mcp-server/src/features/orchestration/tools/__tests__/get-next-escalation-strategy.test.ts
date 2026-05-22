/**
 * get-next-escalation-strategy — integration tests for the tool handler layer.
 *
 * Tests cover:
 *  1. Returns first strategy (add_primer) on fresh state (no prior attempts)
 *  2. Returns next strategy after a prior attempt was recorded
 *  3. Logs an auto_decision event to the execution store
 *  4. Returns hitl when all strategies exhausted
 *  5. Returns WORKSPACE_NOT_FOUND for non-existent workspace
 *
 * Mock strategy:
 *  - Mock getExecutionStore to return a real in-memory ExecutionStore so we can
 *    inspect both escalation state and auto_decision events without filesystem I/O.
 *  - The in-memory store correctly implements getState / upsertState /
 *    updateStateMetrics / appendEvent / getEvents — no stub needed.
 */

import { initExecutionDb } from "@domains/workspaces/execution-schema.ts";
import { ExecutionStore } from "@domains/workspaces/execution-store.ts";
import { afterEach, describe, expect, it, vi } from "vitest";

// ---- Module mocks (before imports) ----

// Mock getExecutionStore with a per-workspace in-memory SQLite store.
vi.mock("@domains/workspaces/execution-store-cache.ts", () => {
  const stores = new Map<string, ExecutionStore>();
  return {
    clearStoreCache: vi.fn(() => stores.clear()),
    getExecutionStore: vi.fn((workspace: string) => {
      if (workspace === "/nonexistent/workspace") {
        throw new Error("Workspace directory does not exist");
      }
      const existing = stores.get(workspace);
      if (existing) return existing;
      const db = initExecutionDb(":memory:");
      const store = new ExecutionStore(db);
      stores.set(workspace, store);
      return store;
    }),
  };
});

import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";

// Import subject under test (after mocks)
import { getNextEscalationStrategy } from "../get-next-escalation-strategy.ts";

// ---- Test helpers ----

const MOCK_WORKSPACE = "/mock/.canon/workspaces/escalation-test";

afterEach(() => {
  clearStoreCache();
});

// ---- Tests ----

describe("getNextEscalationStrategy — fresh state returns add_primer", () => {
  it("returns add_primer on fresh state (no prior escalation attempts)", async () => {
    const result = await getNextEscalationStrategy({
      step_id: "implement",
      workspace: MOCK_WORKSPACE,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.strategy).toBe("add_primer");
    expect(result.is_terminal).toBe(false);
    expect(result.attempts_so_far).toBe(0);
    expect(typeof result.reasoning).toBe("string");
    expect(result.reasoning).toContain("primer");
  });
});

describe("getNextEscalationStrategy — returns next strategy after prior attempt", () => {
  it("returns increase_budget after add_primer was already attempted", async () => {
    // First call records add_primer attempt
    const first = await getNextEscalationStrategy({
      step_id: "implement",
      workspace: MOCK_WORKSPACE,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected ok on first call");
    expect(first.strategy).toBe("add_primer");

    // Second call should advance to increase_budget
    const second = await getNextEscalationStrategy({
      step_id: "implement",
      workspace: MOCK_WORKSPACE,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected ok on second call");
    expect(second.strategy).toBe("increase_budget");
    expect(second.attempts_so_far).toBe(1);
    expect(second.is_terminal).toBe(false);
  });
});

describe("getNextEscalationStrategy — auto_decision event logging", () => {
  it("logs an auto_decision event with strategy and reasoning", async () => {
    await getNextEscalationStrategy({
      step_id: "implement",
      workspace: MOCK_WORKSPACE,
    });

    const store = getExecutionStore(MOCK_WORKSPACE);
    const events = store.getEvents({ type: "auto_decision" });
    expect(events).toHaveLength(1);

    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.decision_type).toBe("escalation");
    expect(payload.strategy).toBe("add_primer");
    expect(typeof payload.reasoning).toBe("string");
    expect(typeof payload.attempts_so_far).toBe("number");
    expect(typeof payload.time_elapsed_ms).toBe("number");
  });
});

describe("getNextEscalationStrategy — returns hitl when all strategies exhausted", () => {
  it("returns hitl after cycling through add_primer → increase_budget → escalate_model → narrow_scope → hitl", async () => {
    const args = { step_id: "implement", workspace: MOCK_WORKSPACE };

    // Exhaust all strategies via sequential calls (must be sequential: state is persisted
    // between calls so each call depends on the previous one having recorded its attempt).
    const r1 = await getNextEscalationStrategy(args);
    const r2 = await getNextEscalationStrategy(args);
    const r3 = await getNextEscalationStrategy(args);
    const r4 = await getNextEscalationStrategy(args);
    const r5 = await getNextEscalationStrategy(args);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(true);
    expect(r4.ok).toBe(true);
    expect(r5.ok).toBe(true);

    if (!r1.ok || !r2.ok || !r3.ok || !r4.ok || !r5.ok) throw new Error("expected all ok");

    // The cascade is: add_primer → increase_budget → escalate_model → narrow_scope → hitl
    expect(r1.strategy).toBe("add_primer");
    expect(r2.strategy).toBe("increase_budget");
    expect(r3.strategy).toBe("escalate_model");
    expect(r4.strategy).toBe("narrow_scope");
    expect(r5.strategy).toBe("hitl");
    expect(r5.is_terminal).toBe(true);

    // A 6th call after hitl is recorded still returns hitl (all exhausted)
    const r6 = await getNextEscalationStrategy(args);
    expect(r6.ok).toBe(true);
    if (!r6.ok) throw new Error("expected ok on sixth call");
    expect(r6.strategy).toBe("hitl");
    expect(r6.is_terminal).toBe(true);
  });
});

describe("getNextEscalationStrategy — WORKSPACE_NOT_FOUND", () => {
  it("returns WORKSPACE_NOT_FOUND for a non-existent workspace", async () => {
    const result = await getNextEscalationStrategy({
      step_id: "implement",
      workspace: "/nonexistent/workspace",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
  });
});

describe("getNextEscalationStrategy — flow_config skip_strategies", () => {
  it("skips narrow_scope when skip_strategies includes it (security flow pattern)", async () => {
    const config = { skip_strategies: ["narrow_scope" as const] };
    const args = { flow_config: config, step_id: "security-step", workspace: MOCK_WORKSPACE };

    // Exhaust the cascade, expecting narrow_scope to be skipped.
    // Must be sequential: each call depends on the previous one persisting its attempt.
    const r1 = await getNextEscalationStrategy(args);
    const r2 = await getNextEscalationStrategy(args);
    const r3 = await getNextEscalationStrategy(args);
    const r4 = await getNextEscalationStrategy(args);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(true);
    expect(r4.ok).toBe(true);
    if (!r1.ok || !r2.ok || !r3.ok || !r4.ok) throw new Error("expected all ok");

    // narrow_scope is skipped: add_primer → increase_budget → escalate_model → hitl
    expect(r1.strategy).toBe("add_primer");
    expect(r2.strategy).toBe("increase_budget");
    expect(r3.strategy).toBe("escalate_model");
    expect(r4.strategy).toBe("hitl");
    expect(r4.is_terminal).toBe(true);
  });
});
