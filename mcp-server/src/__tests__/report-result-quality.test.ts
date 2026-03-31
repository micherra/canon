/**
 * Tests for enriched quality metrics and discovery fields in report_result.
 *
 * Covers:
 * 1. gate_results stored on board state entry when provided
 * 2. postcondition_results stored on board state entry when provided
 * 3. discovered_gates accumulated (append, not replace) across multiple reports
 * 4. discovered_postconditions accumulated (append, not replace) across multiple reports
 * 5. metrics enriched with violation_count, violation_severities, test_results, files_changed
 * 6. revision_count auto-computed from iteration entries (not caller-supplied)
 * 7. Backward compat — existing callers without new fields work unchanged
 * 8. Board round-trip: write enriched metrics, read back, schema validates
 * 9. Log entry includes new fields when provided
 * 10. Log entry omits new fields when not provided
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Hoist mocks before module imports
// ---------------------------------------------------------------------------

vi.mock("../orchestration/workspace.ts", () => ({
  withBoardLock: vi.fn(async (_workspace: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("../orchestration/event-bus-instance.ts", () => ({
  flowEventBus: {
    emit: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock("../orchestration/events.ts", () => ({
  createJsonlLogger: vi.fn(() => vi.fn().mockResolvedValue(undefined)),
}));

vi.mock("../orchestration/effects.ts", () => ({
  executeEffects: vi.fn().mockResolvedValue(undefined),
}));

import { withBoardLock } from "../orchestration/workspace.ts";
import { flowEventBus } from "../orchestration/event-bus-instance.ts";
import { createJsonlLogger } from "../orchestration/events.ts";
import { reportResult } from "../tools/report-result.ts";
import { getExecutionStore } from "../orchestration/execution-store.ts";
import { BoardSchema } from "../orchestration/flow-schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "qg-report-result-"));
  return dir;
}

function makeMinimalBoard() {
  return {
    flow: "test-flow",
    task: "test task",
    entry: "impl",
    current_state: "impl",
    base_commit: "abc123",
    started: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    states: {
      impl: {
        status: "in_progress" as const,
        entries: 1,
        entered_at: new Date().toISOString(),
      },
    },
    iterations: {
      impl: {
        count: 2,
        max: 3,
        history: [],
      },
    },
    blocked: null,
    concerns: [],
    skipped: [],
  };
}

function makeMinimalFlow() {
  return {
    name: "test-flow",
    description: "test",
    entry: "impl",
    states: {
      impl: {
        type: "single" as const,
        agent: "canon:canon-implementor",
        transitions: {
          done: "terminal",
        },
      },
      terminal: {
        type: "terminal" as const,
      },
    },
    spawn_instructions: {
      impl: "Do the thing",
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("report_result: quality metrics enrichment", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = makeTmpWorkspace();
    const board = makeMinimalBoard();
    const store = getExecutionStore(workspace);
    const now = new Date().toISOString();
    store.initExecution({
      flow: board.flow,
      task: board.task,
      entry: board.entry,
      current_state: board.current_state,
      base_commit: board.base_commit,
      started: board.started,
      last_updated: board.last_updated,
      branch: "main",
      sanitized: "main",
      created: now,
      tier: "medium",
      flow_name: board.flow,
      slug: "test-slug",
    });
    store.upsertState("impl", { status: "in_progress", entries: 1 });
    store.upsertIteration("impl", { count: 2, max: 3, history: [], cannot_fix: [] });
    // Reset mock call counts
    vi.clearAllMocks();
    // withBoardLock pass-through
    vi.mocked(withBoardLock).mockImplementation(async (_ws, fn) => fn());
    // createJsonlLogger pass-through
    vi.mocked(createJsonlLogger).mockReturnValue(vi.fn().mockResolvedValue(undefined));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. gate_results stored on board state entry
  // -------------------------------------------------------------------------
  it("stores gate_results on board state entry when provided", async () => {
    const gateResults = [
      { passed: true, gate: "tsc", command: "npx tsc --noEmit", output: "ok", exitCode: 0 },
      { passed: false, gate: "tests", command: "npm test", output: "2 failed", exitCode: 1 },
    ];

    const result = await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "done",
      flow: makeMinimalFlow() as any,
      gate_results: gateResults,
    });

    expect(result.board.states["impl"].gate_results).toEqual(gateResults);
  });

  // -------------------------------------------------------------------------
  // 2. postcondition_results stored on board state entry
  // -------------------------------------------------------------------------
  it("stores postcondition_results on board state entry when provided", async () => {
    const postconditionResults = [
      { passed: true, name: "output file exists", type: "file_exists", output: "found" },
      { passed: false, name: "no console.log", type: "no_pattern", output: "found 2 matches" },
    ];

    const result = await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "done",
      flow: makeMinimalFlow() as any,
      postcondition_results: postconditionResults,
    });

    expect(result.board.states["impl"].postcondition_results).toEqual(postconditionResults);
  });

  // -------------------------------------------------------------------------
  // 3. discovered_gates accumulate (append, not replace)
  // -------------------------------------------------------------------------
  it("accumulates discovered_gates across multiple reports (append, not replace)", async () => {
    const flow = makeMinimalFlow() as any;

    // First report — implementor discovers a gate
    await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "done",
      flow,
      discovered_gates: [{ command: "npm test", source: "tester" }],
    });

    // Read board back and verify first gate was stored
    const storeAfterFirst = getExecutionStore(workspace);
    const stateAfterFirst = storeAfterFirst.getState("impl");
    expect(stateAfterFirst?.discovered_gates).toHaveLength(1);

    // Reset board state to in_progress so we can call reportResult again
    storeAfterFirst.upsertState("impl", {
      ...(stateAfterFirst ?? {}),
      status: "in_progress" as const,
      entries: stateAfterFirst?.entries ?? 1,
    });

    // Second report — reviewer discovers another gate
    await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "done",
      flow,
      discovered_gates: [{ command: "npx eslint .", source: "reviewer" }],
    });

    const boardAfterSecond = getExecutionStore(workspace).getBoard()!;
    expect(boardAfterSecond.states["impl"].discovered_gates).toHaveLength(2);
    expect(boardAfterSecond.states["impl"].discovered_gates).toEqual(
      expect.arrayContaining([
        { command: "npm test", source: "tester" },
        { command: "npx eslint .", source: "reviewer" },
      ])
    );
  });

  // -------------------------------------------------------------------------
  // 4. discovered_postconditions accumulate (append, not replace)
  // -------------------------------------------------------------------------
  it("accumulates discovered_postconditions across multiple reports (append, not replace)", async () => {
    const flow = makeMinimalFlow() as any;

    // First report
    await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "done",
      flow,
      discovered_postconditions: [
        { type: "file_exists" as const, target: "dist/index.js" },
      ],
    });

    const storeAfterFirst2 = getExecutionStore(workspace);
    const stateAfterFirst2 = storeAfterFirst2.getState("impl");
    expect(stateAfterFirst2?.discovered_postconditions).toHaveLength(1);

    // Reset state for second call
    storeAfterFirst2.upsertState("impl", {
      ...(stateAfterFirst2 ?? {}),
      status: "in_progress" as const,
      entries: stateAfterFirst2?.entries ?? 1,
    });

    // Second report
    await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "done",
      flow,
      discovered_postconditions: [
        { type: "no_pattern" as const, target: "src/**/*.ts", pattern: "console\\.log" },
      ],
    });

    const boardAfterSecond = getExecutionStore(workspace).getBoard()!;
    expect(boardAfterSecond.states["impl"].discovered_postconditions).toHaveLength(2);
    expect(boardAfterSecond.states["impl"].discovered_postconditions).toEqual(
      expect.arrayContaining([
        { type: "file_exists", target: "dist/index.js" },
        { type: "no_pattern", target: "src/**/*.ts", pattern: "console\\.log" },
      ])
    );
  });

  // -------------------------------------------------------------------------
  // 5. Metrics enriched with violation_count, violation_severities, test_results, files_changed
  // -------------------------------------------------------------------------
  it("enriches metrics with violation_count, violation_severities, test_results, files_changed", async () => {
    const result = await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "done",
      flow: makeMinimalFlow() as any,
      metrics: { duration_ms: 5000, spawns: 1, model: "claude-sonnet" },
      violation_count: 3,
      violation_severities: { blocking: 1, warning: 2 },
      test_results: { passed: 10, failed: 1, skipped: 2 },
      files_changed: 4,
    });

    const m = result.board.states["impl"].metrics;
    expect(m).toBeDefined();
    expect(m?.duration_ms).toBe(5000);
    expect(m?.violation_count).toBe(3);
    expect(m?.violation_severities).toEqual({ blocking: 1, warning: 2 });
    expect(m?.test_results).toEqual({ passed: 10, failed: 1, skipped: 2 });
    expect(m?.files_changed).toBe(4);
  });

  // -------------------------------------------------------------------------
  // 6. revision_count auto-computed from board.iterations (not caller-supplied)
  // -------------------------------------------------------------------------
  it("auto-computes revision_count from iteration entries", async () => {
    // Board has count=2 in iterations for 'impl'
    const result = await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "done",
      flow: makeMinimalFlow() as any,
      metrics: { duration_ms: 1000, spawns: 1, model: "claude-sonnet" },
    });

    const m = result.board.states["impl"].metrics;
    expect(m?.revision_count).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 7. Backward compat — no new fields → existing behavior unchanged
  // -------------------------------------------------------------------------
  it("preserves existing behavior when no new fields are provided", async () => {
    const result = await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "done",
      flow: makeMinimalFlow() as any,
      artifacts: ["dist/index.js"],
    });

    expect(result.transition_condition).toBe("done");
    expect(result.next_state).toBe("terminal");
    expect(result.stuck).toBe(false);
    expect(result.hitl_required).toBe(false);

    // No new fields on board state entry
    expect(result.board.states["impl"].gate_results).toBeUndefined();
    expect(result.board.states["impl"].postcondition_results).toBeUndefined();
    expect(result.board.states["impl"].discovered_gates).toBeUndefined();
    expect(result.board.states["impl"].discovered_postconditions).toBeUndefined();
    // metrics should be undefined when not provided
    expect(result.board.states["impl"].metrics).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 8. Board round-trip: enriched metrics validate with BoardSchema
  // -------------------------------------------------------------------------
  it("board round-trip: enriched metrics survive BoardSchema.parse()", async () => {
    await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "done",
      flow: makeMinimalFlow() as any,
      metrics: { duration_ms: 2000, spawns: 2, model: "claude-sonnet" },
      gate_results: [
        { passed: true, gate: "tsc", command: "npx tsc --noEmit", output: "ok", exitCode: 0 },
      ],
      postcondition_results: [
        { passed: true, name: "output exists", type: "file_exists", output: "found" },
      ],
      discovered_gates: [{ command: "npm test", source: "tester" }],
      discovered_postconditions: [{ type: "file_exists" as const, target: "dist/index.js" }],
      violation_count: 0,
      violation_severities: { blocking: 0, warning: 0 },
      test_results: { passed: 5, failed: 0, skipped: 0 },
      files_changed: 2,
    });

    // Read back from store and parse with BoardSchema
    const board = getExecutionStore(workspace).getBoard();
    const parsed = BoardSchema.parse(board);

    expect(parsed.states["impl"].gate_results).toHaveLength(1);
    expect(parsed.states["impl"].postcondition_results).toHaveLength(1);
    expect(parsed.states["impl"].discovered_gates).toHaveLength(1);
    expect(parsed.states["impl"].discovered_postconditions).toHaveLength(1);
    expect(parsed.states["impl"].metrics?.violation_count).toBe(0);
    expect(parsed.states["impl"].metrics?.test_results).toEqual({ passed: 5, failed: 0, skipped: 0 });
    expect(parsed.states["impl"].metrics?.files_changed).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 9. Log entry includes new fields when provided
  // -------------------------------------------------------------------------
  it("log entry includes new metric fields when provided", async () => {
    const result = await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "done",
      flow: makeMinimalFlow() as any,
      metrics: { duration_ms: 3000, spawns: 1, model: "claude-sonnet" },
      gate_results: [
        { passed: true, gate: "tsc", command: "npx tsc --noEmit", output: "ok", exitCode: 0 },
      ],
      postcondition_results: [
        { passed: true, name: "output exists", type: "file_exists", output: "found" },
      ],
      violation_count: 2,
      violation_severities: { blocking: 1, warning: 1 },
      test_results: { passed: 8, failed: 2, skipped: 0 },
      files_changed: 3,
      discovered_gates: [{ command: "npm test", source: "tester" }],
      discovered_postconditions: [{ type: "file_exists" as const, target: "dist/index.js" }],
    });

    const log_entry = result.log_entry as any;
    expect(log_entry.gate_results).toHaveLength(1);
    expect(log_entry.postcondition_results).toHaveLength(1);
    expect(log_entry.violation_count).toBe(2);
    expect(log_entry.violation_severities).toEqual({ blocking: 1, warning: 1 });
    expect(log_entry.test_results).toEqual({ passed: 8, failed: 2, skipped: 0 });
    expect(log_entry.files_changed).toBe(3);
    expect(log_entry.discovered_gates_count).toBe(1);
    expect(log_entry.discovered_postconditions_count).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 10. Log entry omits new fields when not provided
  // -------------------------------------------------------------------------
  it("log entry omits new metric fields when not provided", async () => {
    const result = await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "done",
      flow: makeMinimalFlow() as any,
    });

    const log_entry = result.log_entry as any;
    expect(log_entry.gate_results).toBeUndefined();
    expect(log_entry.postcondition_results).toBeUndefined();
    expect(log_entry.violation_count).toBeUndefined();
    expect(log_entry.violation_severities).toBeUndefined();
    expect(log_entry.test_results).toBeUndefined();
    expect(log_entry.files_changed).toBeUndefined();
    expect(log_entry.discovered_gates_count).toBeUndefined();
    expect(log_entry.discovered_postconditions_count).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 11. gate_results also stored in metrics
  // -------------------------------------------------------------------------
  it("stores gate_results in metrics when provided alongside regular metrics", async () => {
    const gateResults = [
      { passed: false, gate: "lint", command: "npx eslint .", output: "3 errors", exitCode: 1 },
    ];

    const result = await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "done",
      flow: makeMinimalFlow() as any,
      metrics: { duration_ms: 1500, spawns: 1, model: "claude-sonnet" },
      gate_results: gateResults,
    });

    // gate_results should be on both top-level BoardStateEntry and inside metrics
    expect(result.board.states["impl"].gate_results).toEqual(gateResults);
    expect(result.board.states["impl"].metrics?.gate_results).toEqual(gateResults);
  });

  // -------------------------------------------------------------------------
  // 12. state_completed event emitted with new signal fields
  // -------------------------------------------------------------------------
  it("emits state_completed event with new signal fields", async () => {
    const emitMock = vi.mocked(flowEventBus.emit);

    await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "done",
      flow: makeMinimalFlow() as any,
      metrics: { duration_ms: 1000, spawns: 1, model: "claude-sonnet" },
      violation_count: 5,
      test_results: { passed: 20, failed: 0, skipped: 1 },
      discovered_gates: [{ command: "npm test", source: "tester" }],
    });

    const stateCompletedCall = emitMock.mock.calls.find(
      (call) => call[0] === "state_completed"
    );
    expect(stateCompletedCall).toBeDefined();
    const eventPayload = stateCompletedCall![1] as any;
    expect(eventPayload.violation_count).toBe(5);
    expect(eventPayload.test_results).toEqual({ passed: 20, failed: 0, skipped: 1 });
    expect(eventPayload.discovered_gates_count).toBe(1);
  });
});
