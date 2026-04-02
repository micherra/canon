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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "rr-diagnostics-test-"));
  tmpDirs.push(dir);
  return dir;
}

/** Minimal flow with a single state that transitions done → terminal */
function makeFlow(overrides?: Partial<ResolvedFlow>): ResolvedFlow {
  return {
    name: "diag-flow",
    description: "Diagnostics test flow",
    entry: "impl",
    spawn_instructions: {},
    states: {
      impl: {
        type: "single",
        transitions: { done: "ship" },
      },
      ship: { type: "terminal" },
    },
    ...overrides,
  } as ResolvedFlow;
}

/** Flow where the impl state uses same_status stuck detection */
function makeFlowWithStuck(): ResolvedFlow {
  return {
    name: "diag-stuck-flow",
    description: "Stuck detection test flow",
    entry: "impl",
    spawn_instructions: {},
    states: {
      impl: {
        type: "single",
        stuck_when: "same_status",
        transitions: {
          done: "ship",
          blocked: "impl", // loop back to trigger stuck
        },
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
    flow: flow.name,
    task: "test task",
    entry: flow.entry,
    current_state: flow.entry,
    base_commit: "abc123",
    started: now,
    last_updated: now,
    branch: "feat/test",
    sanitized: "feat-test",
    created: now,
    tier: "medium",
    flow_name: flow.name,
    slug: "test-slug",
  });

  for (const stateId of Object.keys(flow.states)) {
    store.upsertState(stateId, { status: "pending", entries: 0 });
  }
}

/** Seed a workspace where impl has iterations enabled (needed for stuck detection) */
function setupWorkspaceWithIterations(workspace: string, flow: ResolvedFlow): void {
  setupWorkspace(workspace, flow);
  const store = getExecutionStore(workspace);
  store.upsertState("impl", { status: "in_progress", entries: 1 });
  store.upsertIteration("impl", { count: 0, max: 5, history: [], cannot_fix: [] });
}

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
  flowEventBus.removeAllListeners();
});

// ---------------------------------------------------------------------------
// 1. ADR-003a metrics stored in board state
// ---------------------------------------------------------------------------

describe("report_result: ADR-003a metrics", () => {
  it("stores ADR-003a agent performance fields in board state metrics", async () => {
    const workspace = makeTmpWorkspace();
    setupWorkspace(workspace, makeFlow());

    const store = getExecutionStore(workspace);
    store.upsertState("impl", { status: "in_progress", entries: 1 });

    const result = await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "done",
      flow: makeFlow(),
      metrics: {
        duration_ms: 5000,
        spawns: 1,
        model: "claude-sonnet",
        tool_calls: 42,
        orientation_calls: 3,
        input_tokens: 10000,
        output_tokens: 2000,
        cache_read_tokens: 8000,
        cache_write_tokens: 500,
        turns: 7,
      },
    });

    assertOk(result);

    const board = store.getBoard();
    const metrics = board?.states["impl"]?.metrics;
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
    store.upsertState("impl", { status: "in_progress", entries: 1 });

    const result = await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "done",
      flow: makeFlow(),
      // No metrics provided at all
    });

    assertOk(result);

    const board = store.getBoard();
    // metrics should be absent since no metrics fields were provided
    expect(board?.states["impl"]?.metrics).toBeUndefined();
  });

  it("stores only ADR-003a fields when no legacy metrics fields provided", async () => {
    const workspace = makeTmpWorkspace();
    setupWorkspace(workspace, makeFlow());

    const store = getExecutionStore(workspace);
    store.upsertState("impl", { status: "in_progress", entries: 1 });

    const result = await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "done",
      flow: makeFlow(),
      metrics: {
        duration_ms: 0,
        spawns: 0,
        model: "claude-sonnet",
        tool_calls: 10,
        turns: 2,
      },
    });

    assertOk(result);

    const board = store.getBoard();
    const metrics = board?.states["impl"]?.metrics;
    expect(metrics?.tool_calls).toBe(10);
    expect(metrics?.turns).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2. stuck_detected event emission
// ---------------------------------------------------------------------------

describe("report_result: stuck_detected event", () => {
  it("emits stuck_detected event when stuck detection triggers", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithStuck();
    setupWorkspaceWithIterations(workspace, flow);

    // First call — seeds history with status "blocked"
    const r1 = await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "blocked",
      flow,
    });
    assertOk(r1);

    // Collect stuck_detected events after second call
    const stuckEvents: unknown[] = [];
    flowEventBus.on("stuck_detected", (e) => stuckEvents.push(e));

    // Second call with same status — should trigger stuck detection
    const r2 = await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "blocked",
      flow,
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
      workspace,
      state_id: "impl",
      status_keyword: "blocked",
      flow,
    });

    let capturedEvent: unknown;
    flowEventBus.on("stuck_detected", (e) => {
      capturedEvent = e;
    });

    // Second call triggers stuck
    await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "blocked",
      flow,
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
      workspace,
      state_id: "impl",
      status_keyword: "blocked",
      flow,
    });

    await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "blocked",
      flow,
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
      workspace,
      state_id: "impl",
      status_keyword: "blocked",
      flow,
    });

    let capturedEvent: unknown;
    flowEventBus.on("stuck_detected", (e) => {
      capturedEvent = e;
    });

    await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "blocked",
      flow,
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
    store.upsertState("impl", { status: "in_progress", entries: 1 });

    const stuckEvents: unknown[] = [];
    flowEventBus.on("stuck_detected", (e) => stuckEvents.push(e));

    const result = await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "done",
      flow,
    });

    assertOk(result);
    expect(result.stuck).toBe(false);
    expect(stuckEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. correlation_id in state_completed and transition_evaluated events
// ---------------------------------------------------------------------------

describe("report_result: correlation_id in events", () => {
  it("state_completed event includes correlation_id when execution has one", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlow();
    setupWorkspace(workspace, flow);
    const store = getExecutionStore(workspace);
    store.upsertState("impl", { status: "in_progress", entries: 1 });
    const correlationId = store.getCorrelationId();
    expect(correlationId).not.toBeNull();

    let capturedEvent: unknown;
    flowEventBus.on("state_completed", (e) => {
      capturedEvent = e;
    });

    const result = await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "done",
      flow,
      metrics: { duration_ms: 1000, spawns: 1, model: "claude-sonnet" },
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
    store.upsertState("impl", { status: "in_progress", entries: 1 });
    const correlationId = store.getCorrelationId();
    expect(correlationId).not.toBeNull();

    let capturedEvent: unknown;
    flowEventBus.on("transition_evaluated", (e) => {
      capturedEvent = e;
    });

    const result = await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "done",
      flow,
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
    store.upsertState("impl", { status: "in_progress", entries: 1 });
    const correlationId = store.getCorrelationId();
    expect(correlationId).not.toBeNull();

    await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "done",
      flow,
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
    store.upsertState("impl", { status: "in_progress", entries: 1 });
    const correlationId = store.getCorrelationId();
    expect(correlationId).not.toBeNull();

    await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "done",
      flow,
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
    store.upsertState("impl", { status: "in_progress", entries: 1 });
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
      workspace,
      state_id: "impl",
      status_keyword: "done",
      flow,
    });

    const se = stateEvent as Record<string, unknown>;
    const te = transEvent as Record<string, unknown>;
    expect(se.correlation_id).toBe(correlationId);
    expect(te.correlation_id).toBe(correlationId);
  });
});
