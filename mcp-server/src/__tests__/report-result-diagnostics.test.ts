/**
 * Tests for ADR-003 diagnostics additions to report_result:
 *  1. ReportResultInput.metrics widened to accept ADR-003a agent performance fields
 *  2. stuck_detected event emitted after stuck detection (with correlation_id)
 *  3. state_completed event includes correlation_id
 *  4. transition_evaluated event includes correlation_id
 *  5. Backward compat — callers without new fields get old behavior
 *
 * All workspace setup uses ExecutionStore directly (no legacy readBoard/writeBoard).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { flowEventBus } from "../orchestration/event-bus-instance.ts";
import { clearStoreCache, getExecutionStore } from "../orchestration/execution-store.ts";
import type { ResolvedFlow } from "../orchestration/flow-schema.ts";
import { reportResult } from "../tools/report-result.ts";
import { assertOk } from "../utils/tool-result.ts";

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "rr-diagnostics-test-"));
  tmpDirs.push(dir);
  return dir;
}

/** Minimal flow with a single state that transitions done → terminal */
function makeFlow(overrides?: Partial<ResolvedFlow>): ResolvedFlow {
  return {
    description: "Diagnostics test flow",
    entry: "impl",
    name: "diag-flow",
    spawn_instructions: {},
    states: {
      impl: {
        transitions: { done: "ship" },
        type: "single",
      },
      ship: { type: "terminal" },
    },
    ...overrides,
  } as ResolvedFlow;
}

/** Flow where the impl state uses same_status stuck detection */
function makeFlowWithStuck(): ResolvedFlow {
  return {
    description: "Stuck detection test flow",
    entry: "impl",
    name: "diag-stuck-flow",
    spawn_instructions: {},
    states: {
      impl: {
        stuck_when: "same_status",
        transitions: {
          blocked: "impl", // loop back to trigger stuck
          done: "ship",
        },
        type: "single",
      },
      ship: { type: "terminal" },
    },
  } as ResolvedFlow;
}

/** Seed a workspace with the given flow */
function setupWorkspace(workspace: string, flow: ResolvedFlow): void {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();

  store.initExecution({
    base_commit: "abc123",
    branch: "feat/test",
    created: now,
    current_state: flow.entry,
    entry: flow.entry,
    flow: flow.name,
    flow_name: flow.name,
    last_updated: now,
    sanitized: "feat-test",
    slug: "test-slug",
    started: now,
    task: "test task",
    tier: "medium",
  });

  for (const stateId of Object.keys(flow.states)) {
    store.upsertState(stateId, { entries: 0, status: "pending" });
  }
}

/** Seed a workspace where impl has iterations enabled (needed for stuck detection) */
function setupWorkspaceWithIterations(workspace: string, flow: ResolvedFlow): void {
  setupWorkspace(workspace, flow);
  const store = getExecutionStore(workspace);
  store.upsertState("impl", { entries: 1, status: "in_progress" });
  store.upsertIteration("impl", { cannot_fix: [], count: 0, history: [], max: 5 });
}

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
  flowEventBus.removeAllListeners();
});

// 1. ADR-003a metrics stored in board state

describe("report_result: ADR-003a metrics", () => {
  it("stores ADR-003a agent performance fields in board state metrics", async () => {
    const workspace = makeTmpWorkspace();
    setupWorkspace(workspace, makeFlow());

    const store = getExecutionStore(workspace);
    store.upsertState("impl", { entries: 1, status: "in_progress" });

    const result = await reportResult({
      flow: makeFlow(),
      metrics: {
        cache_read_tokens: 8000,
        cache_write_tokens: 500,
        duration_ms: 5000,
        input_tokens: 10000,
        model: "claude-sonnet",
        orientation_calls: 3,
        output_tokens: 2000,
        spawns: 1,
        tool_calls: 42,
        turns: 7,
      },
      state_id: "impl",
      status_keyword: "done",
      workspace,
    });

    assertOk(result);

    const board = store.getBoard();
    const metrics = board?.states.impl?.metrics;
    expect(metrics).toBeDefined();
    expect(metrics?.tool_calls).toBe(42);
    expect(metrics?.orientation_calls).toBe(3);
    expect(metrics?.input_tokens).toBe(10000);
    expect(metrics?.output_tokens).toBe(2000);
    expect(metrics?.cache_read_tokens).toBe(8000);
    expect(metrics?.cache_write_tokens).toBe(500);
    expect(metrics?.turns).toBe(7);
    // Existing required fields still present
    expect(metrics?.duration_ms).toBe(5000);
    expect(metrics?.spawns).toBe(1);
    expect(metrics?.model).toBe("claude-sonnet");
  });

  it("does not write metrics when no metrics fields provided (backward compat)", async () => {
    const workspace = makeTmpWorkspace();
    setupWorkspace(workspace, makeFlow());

    const store = getExecutionStore(workspace);
    store.upsertState("impl", { entries: 1, status: "in_progress" });

    const result = await reportResult({
      flow: makeFlow(),
      state_id: "impl",
      status_keyword: "done",
      workspace,
      // No metrics provided at all
    });

    assertOk(result);

    const board = store.getBoard();
    // metrics should be absent since no metrics fields were provided
    expect(board?.states.impl?.metrics).toBeUndefined();
  });

  it("stores only ADR-003a fields when no legacy metrics fields provided", async () => {
    const workspace = makeTmpWorkspace();
    setupWorkspace(workspace, makeFlow());

    const store = getExecutionStore(workspace);
    store.upsertState("impl", { entries: 1, status: "in_progress" });

    const result = await reportResult({
      flow: makeFlow(),
      metrics: {
        duration_ms: 0,
        model: "claude-sonnet",
        spawns: 0,
        tool_calls: 10,
        turns: 2,
      },
      state_id: "impl",
      status_keyword: "done",
      workspace,
    });

    assertOk(result);

    const board = store.getBoard();
    const metrics = board?.states.impl?.metrics;
    expect(metrics?.tool_calls).toBe(10);
    expect(metrics?.turns).toBe(2);
  });
});

// 2. stuck_detected event emission

describe("report_result: stuck_detected event", () => {
  it("emits stuck_detected event when stuck detection triggers", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithStuck();
    setupWorkspaceWithIterations(workspace, flow);

    // First call — seeds history with status "blocked"
    const r1 = await reportResult({
      flow,
      state_id: "impl",
      status_keyword: "blocked",
      workspace,
    });
    assertOk(r1);

    // Collect stuck_detected events after second call
    const stuckEvents: unknown[] = [];
    flowEventBus.on("stuck_detected", (e) => stuckEvents.push(e));

    // Second call with same status — should trigger stuck detection
    const r2 = await reportResult({
      flow,
      state_id: "impl",
      status_keyword: "blocked",
      workspace,
    });
    assertOk(r2);

    expect(r2.stuck).toBe(true);
    expect(stuckEvents).toHaveLength(1);
  });

  it("stuck_detected event payload includes stateId, strategy, reason, timestamp", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithStuck();
    setupWorkspaceWithIterations(workspace, flow);

    // Seed first iteration
    await reportResult({
      flow,
      state_id: "impl",
      status_keyword: "blocked",
      workspace,
    });

    let capturedEvent: unknown;
    flowEventBus.on("stuck_detected", (e) => {
      capturedEvent = e;
    });

    // Second call triggers stuck
    await reportResult({
      flow,
      state_id: "impl",
      status_keyword: "blocked",
      workspace,
    });

    expect(capturedEvent).toBeDefined();
    const evt = capturedEvent as Record<string, unknown>;
    expect(evt.stateId).toBe("impl");
    expect(typeof evt.strategy).toBe("string");
    expect(typeof evt.reason).toBe("string");
    expect(typeof evt.timestamp).toBe("string");
    expect(evt.iteration_count).toBeGreaterThanOrEqual(0);
    expect(evt.comparison).toBeDefined();
    expect(typeof (evt.comparison as Record<string, unknown>).previous).toBe("object");
    expect(typeof (evt.comparison as Record<string, unknown>).current).toBe("object");
  });

  it("stuck_detected event persisted to store events table", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithStuck();
    setupWorkspaceWithIterations(workspace, flow);

    const store = getExecutionStore(workspace);

    await reportResult({
      flow,
      state_id: "impl",
      status_keyword: "blocked",
      workspace,
    });

    await reportResult({
      flow,
      state_id: "impl",
      status_keyword: "blocked",
      workspace,
    });

    const events = store.getEventsByType("stuck_detected");
    expect(events).toHaveLength(1);
    expect(events[0].payload.stateId).toBe("impl");
  });

  it("stuck_detected event includes correlation_id when execution has one", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithStuck();
    setupWorkspaceWithIterations(workspace, flow);

    const store = getExecutionStore(workspace);
    // The execution already has a correlation_id set by initExecution (randomUUID)
    const correlationId = store.getCorrelationId();
    expect(correlationId).not.toBeNull();

    await reportResult({
      flow,
      state_id: "impl",
      status_keyword: "blocked",
      workspace,
    });

    let capturedEvent: unknown;
    flowEventBus.on("stuck_detected", (e) => {
      capturedEvent = e;
    });

    await reportResult({
      flow,
      state_id: "impl",
      status_keyword: "blocked",
      workspace,
    });

    const evt = capturedEvent as Record<string, unknown>;
    expect(evt.correlation_id).toBe(correlationId);

    const storedEvents = store.getEventsByType("stuck_detected");
    expect(storedEvents[0].correlation_id).toBe(correlationId);
  });

  it("does not emit stuck_detected when not stuck", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlow();
    setupWorkspace(workspace, flow);
    const store = getExecutionStore(workspace);
    store.upsertState("impl", { entries: 1, status: "in_progress" });

    const stuckEvents: unknown[] = [];
    flowEventBus.on("stuck_detected", (e) => stuckEvents.push(e));

    const result = await reportResult({
      flow,
      state_id: "impl",
      status_keyword: "done",
      workspace,
    });

    assertOk(result);
    expect(result.stuck).toBe(false);
    expect(stuckEvents).toHaveLength(0);
  });
});

// 3. correlation_id in state_completed and transition_evaluated events

describe("report_result: correlation_id in events", () => {
  it("state_completed event includes correlation_id when execution has one", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlow();
    setupWorkspace(workspace, flow);
    const store = getExecutionStore(workspace);
    store.upsertState("impl", { entries: 1, status: "in_progress" });
    const correlationId = store.getCorrelationId();
    expect(correlationId).not.toBeNull();

    let capturedEvent: unknown;
    flowEventBus.on("state_completed", (e) => {
      capturedEvent = e;
    });

    const result = await reportResult({
      flow,
      metrics: { duration_ms: 1000, model: "claude-sonnet", spawns: 1 },
      state_id: "impl",
      status_keyword: "done",
      workspace,
    });

    assertOk(result);
    const evt = capturedEvent as Record<string, unknown>;
    expect(evt.correlation_id).toBe(correlationId);
  });

  it("transition_evaluated event includes correlation_id when execution has one", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlow();
    setupWorkspace(workspace, flow);
    const store = getExecutionStore(workspace);
    store.upsertState("impl", { entries: 1, status: "in_progress" });
    const correlationId = store.getCorrelationId();
    expect(correlationId).not.toBeNull();

    let capturedEvent: unknown;
    flowEventBus.on("transition_evaluated", (e) => {
      capturedEvent = e;
    });

    const result = await reportResult({
      flow,
      state_id: "impl",
      status_keyword: "done",
      workspace,
    });

    assertOk(result);
    const evt = capturedEvent as Record<string, unknown>;
    expect(evt.correlation_id).toBe(correlationId);
  });

  it("state_completed event persisted with correlation_id", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlow();
    setupWorkspace(workspace, flow);
    const store = getExecutionStore(workspace);
    store.upsertState("impl", { entries: 1, status: "in_progress" });
    const correlationId = store.getCorrelationId();
    expect(correlationId).not.toBeNull();

    await reportResult({
      flow,
      state_id: "impl",
      status_keyword: "done",
      workspace,
    });

    const events = store.getEventsByType("state_completed");
    expect(events).toHaveLength(1);
    expect(events[0].correlation_id).toBe(correlationId);
  });

  it("transition_evaluated event persisted with correlation_id", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlow();
    setupWorkspace(workspace, flow);
    const store = getExecutionStore(workspace);
    store.upsertState("impl", { entries: 1, status: "in_progress" });
    const correlationId = store.getCorrelationId();
    expect(correlationId).not.toBeNull();

    await reportResult({
      flow,
      state_id: "impl",
      status_keyword: "done",
      workspace,
    });

    const events = store.getEventsByType("transition_evaluated");
    expect(events).toHaveLength(1);
    expect(events[0].correlation_id).toBe(correlationId);
  });

  it("events carry the execution correlation_id (always a UUID from initExecution)", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlow();
    setupWorkspace(workspace, flow);
    const store = getExecutionStore(workspace);
    store.upsertState("impl", { entries: 1, status: "in_progress" });
    const correlationId = store.getCorrelationId();
    // initExecution always assigns a UUID
    expect(correlationId).toMatch(/^[0-9a-f-]{36}$/);

    let stateEvent: unknown;
    let transEvent: unknown;
    flowEventBus.on("state_completed", (e) => {
      stateEvent = e;
    });
    flowEventBus.on("transition_evaluated", (e) => {
      transEvent = e;
    });

    await reportResult({
      flow,
      state_id: "impl",
      status_keyword: "done",
      workspace,
    });

    const se = stateEvent as Record<string, unknown>;
    const te = transEvent as Record<string, unknown>;
    expect(se.correlation_id).toBe(correlationId);
    expect(te.correlation_id).toBe(correlationId);
  });
});
