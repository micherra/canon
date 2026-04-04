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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mocks before module imports

vi.mock("../orchestration/event-bus-instance.ts", () => ({
  flowEventBus: {
    emit: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock("../orchestration/effects.ts", () => ({
  executeEffects: vi.fn().mockResolvedValue(undefined),
}));

import { flowEventBus } from "../orchestration/event-bus-instance.ts";
import { getExecutionStore } from "../orchestration/execution-store.ts";
import { BoardSchema } from "../orchestration/flow-schema.ts";
import { reportResult } from "../tools/report-result.ts";
import { assertOk } from "../utils/tool-result.ts";

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "qg-report-result-"));
  return dir;
}

function makeMinimalBoard() {
  return {
    base_commit: "abc123",
    blocked: null,
    concerns: [],
    current_state: "impl",
    entry: "impl",
    flow: "test-flow",
    iterations: {
      impl: {
        count: 2,
        history: [],
        max: 3,
      },
    },
    last_updated: new Date().toISOString(),
    skipped: [],
    started: new Date().toISOString(),
    states: {
      impl: {
        entered_at: new Date().toISOString(),
        entries: 1,
        status: "in_progress" as const,
      },
    },
    task: "test task",
  };
}

function makeMinimalFlow() {
  return {
    description: "test",
    entry: "impl",
    name: "test-flow",
    spawn_instructions: {
      impl: "Do the thing",
    },
    states: {
      impl: {
        agent: "canon:canon-implementor",
        transitions: {
          done: "terminal",
        },
        type: "single" as const,
      },
      terminal: {
        type: "terminal" as const,
      },
    },
  };
}

describe("report_result: quality metrics enrichment", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = makeTmpWorkspace();
    const board = makeMinimalBoard();
    const store = getExecutionStore(workspace);
    const now = new Date().toISOString();
    store.initExecution({
      base_commit: board.base_commit,
      branch: "main",
      created: now,
      current_state: board.current_state,
      entry: board.entry,
      flow: board.flow,
      flow_name: board.flow,
      last_updated: board.last_updated,
      sanitized: "main",
      slug: "test-slug",
      started: board.started,
      task: board.task,
      tier: "medium",
    });
    store.upsertState("impl", { entries: 1, status: "in_progress" });
    store.upsertIteration("impl", { cannot_fix: [], count: 2, history: [], max: 3 });
    // Reset mock call counts
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(workspace, { force: true, recursive: true });
  });

  // 1. gate_results stored on board state entry
  it("stores gate_results on board state entry when provided", async () => {
    const gateResults = [
      { command: "npx tsc --noEmit", exitCode: 0, gate: "tsc", output: "ok", passed: true },
      { command: "npm test", exitCode: 1, gate: "tests", output: "2 failed", passed: false },
    ];

    const result = await reportResult({
      flow: makeMinimalFlow() as any,
      gate_results: gateResults,
      state_id: "impl",
      status_keyword: "done",
      workspace,
    });
    assertOk(result);

    expect(result.board.states.impl.gate_results).toEqual(gateResults);
  });

  // 2. postcondition_results stored on board state entry
  it("stores postcondition_results on board state entry when provided", async () => {
    const postconditionResults = [
      { name: "output file exists", output: "found", passed: true, type: "file_exists" },
      { name: "no console.log", output: "found 2 matches", passed: false, type: "no_pattern" },
    ];

    const result = await reportResult({
      flow: makeMinimalFlow() as any,
      postcondition_results: postconditionResults,
      state_id: "impl",
      status_keyword: "done",
      workspace,
    });
    assertOk(result);

    expect(result.board.states.impl.postcondition_results).toEqual(postconditionResults);
  });

  // 3. discovered_gates accumulate (append, not replace)
  it("accumulates discovered_gates across multiple reports (append, not replace)", async () => {
    const flow = makeMinimalFlow() as any;

    // First report — implementor discovers a gate
    await reportResult({
      discovered_gates: [{ command: "npm test", source: "tester" }],
      flow,
      state_id: "impl",
      status_keyword: "done",
      workspace,
    });

    // Read board back and verify first gate was stored
    const storeAfterFirst = getExecutionStore(workspace);
    const stateAfterFirst = storeAfterFirst.getState("impl");
    expect(stateAfterFirst?.discovered_gates).toHaveLength(1);

    // Reset board state to in_progress so we can call reportResult again
    storeAfterFirst.upsertState("impl", {
      ...(stateAfterFirst ?? {}),
      entries: stateAfterFirst?.entries ?? 1,
      status: "in_progress" as const,
    });

    // Second report — reviewer discovers another gate
    await reportResult({
      discovered_gates: [{ command: "npx eslint .", source: "reviewer" }],
      flow,
      state_id: "impl",
      status_keyword: "done",
      workspace,
    });

    const boardAfterSecond = getExecutionStore(workspace).getBoard()!;
    expect(boardAfterSecond.states.impl.discovered_gates).toHaveLength(2);
    expect(boardAfterSecond.states.impl.discovered_gates).toEqual(
      expect.arrayContaining([
        { command: "npm test", source: "tester" },
        { command: "npx eslint .", source: "reviewer" },
      ]),
    );
  });

  // 4. discovered_postconditions accumulate (append, not replace)
  it("accumulates discovered_postconditions across multiple reports (append, not replace)", async () => {
    const flow = makeMinimalFlow() as any;

    // First report
    await reportResult({
      discovered_postconditions: [{ target: "dist/index.js", type: "file_exists" as const }],
      flow,
      state_id: "impl",
      status_keyword: "done",
      workspace,
    });

    const storeAfterFirst2 = getExecutionStore(workspace);
    const stateAfterFirst2 = storeAfterFirst2.getState("impl");
    expect(stateAfterFirst2?.discovered_postconditions).toHaveLength(1);

    // Reset state for second call
    storeAfterFirst2.upsertState("impl", {
      ...(stateAfterFirst2 ?? {}),
      entries: stateAfterFirst2?.entries ?? 1,
      status: "in_progress" as const,
    });

    // Second report
    await reportResult({
      discovered_postconditions: [
        { pattern: "console\\.log", target: "src/**/*.ts", type: "no_pattern" as const },
      ],
      flow,
      state_id: "impl",
      status_keyword: "done",
      workspace,
    });

    const boardAfterSecond = getExecutionStore(workspace).getBoard()!;
    expect(boardAfterSecond.states.impl.discovered_postconditions).toHaveLength(2);
    expect(boardAfterSecond.states.impl.discovered_postconditions).toEqual(
      expect.arrayContaining([
        { target: "dist/index.js", type: "file_exists" },
        { pattern: "console\\.log", target: "src/**/*.ts", type: "no_pattern" },
      ]),
    );
  });

  // 5. Metrics enriched with violation_count, violation_severities, test_results, files_changed
  it("enriches metrics with violation_count, violation_severities, test_results, files_changed", async () => {
    const result = await reportResult({
      files_changed: 4,
      flow: makeMinimalFlow() as any,
      metrics: { duration_ms: 5000, model: "claude-sonnet", spawns: 1 },
      state_id: "impl",
      status_keyword: "done",
      test_results: { failed: 1, passed: 10, skipped: 2 },
      violation_count: 3,
      violation_severities: { blocking: 1, warning: 2 },
      workspace,
    });
    assertOk(result);

    const m = result.board.states.impl.metrics;
    expect(m).toBeDefined();
    expect(m?.duration_ms).toBe(5000);
    expect(m?.violation_count).toBe(3);
    expect(m?.violation_severities).toEqual({ blocking: 1, warning: 2 });
    expect(m?.test_results).toEqual({ failed: 1, passed: 10, skipped: 2 });
    expect(m?.files_changed).toBe(4);
  });

  // 6. revision_count auto-computed from board.iterations (not caller-supplied)
  it("auto-computes revision_count from iteration entries", async () => {
    // Board has count=2 in iterations for 'impl'
    const result = await reportResult({
      flow: makeMinimalFlow() as any,
      metrics: { duration_ms: 1000, model: "claude-sonnet", spawns: 1 },
      state_id: "impl",
      status_keyword: "done",
      workspace,
    });
    assertOk(result);

    const m = result.board.states.impl.metrics;
    expect(m?.revision_count).toBe(2);
  });

  // 7. Backward compat — no new fields → existing behavior unchanged
  it("preserves existing behavior when no new fields are provided", async () => {
    const result = await reportResult({
      artifacts: ["dist/index.js"],
      flow: makeMinimalFlow() as any,
      state_id: "impl",
      status_keyword: "done",
      workspace,
    });
    assertOk(result);

    expect(result.transition_condition).toBe("done");
    expect(result.next_state).toBe("terminal");
    expect(result.stuck).toBe(false);
    expect(result.hitl_required).toBe(false);

    // No new fields on board state entry
    expect(result.board.states.impl.gate_results).toBeUndefined();
    expect(result.board.states.impl.postcondition_results).toBeUndefined();
    expect(result.board.states.impl.discovered_gates).toBeUndefined();
    expect(result.board.states.impl.discovered_postconditions).toBeUndefined();
    // metrics should be undefined when not provided
    expect(result.board.states.impl.metrics).toBeUndefined();
  });

  // 8. Board round-trip: enriched metrics validate with BoardSchema
  it("board round-trip: enriched metrics survive BoardSchema.parse()", async () => {
    await reportResult({
      discovered_gates: [{ command: "npm test", source: "tester" }],
      discovered_postconditions: [{ target: "dist/index.js", type: "file_exists" as const }],
      files_changed: 2,
      flow: makeMinimalFlow() as any,
      gate_results: [
        { command: "npx tsc --noEmit", exitCode: 0, gate: "tsc", output: "ok", passed: true },
      ],
      metrics: { duration_ms: 2000, model: "claude-sonnet", spawns: 2 },
      postcondition_results: [
        { name: "output exists", output: "found", passed: true, type: "file_exists" },
      ],
      state_id: "impl",
      status_keyword: "done",
      test_results: { failed: 0, passed: 5, skipped: 0 },
      violation_count: 0,
      violation_severities: { blocking: 0, warning: 0 },
      workspace,
    });

    // Read back from store and parse with BoardSchema
    const board = getExecutionStore(workspace).getBoard();
    const parsed = BoardSchema.parse(board);

    expect(parsed.states.impl.gate_results).toHaveLength(1);
    expect(parsed.states.impl.postcondition_results).toHaveLength(1);
    expect(parsed.states.impl.discovered_gates).toHaveLength(1);
    expect(parsed.states.impl.discovered_postconditions).toHaveLength(1);
    expect(parsed.states.impl.metrics?.violation_count).toBe(0);
    expect(parsed.states.impl.metrics?.test_results).toEqual({
      failed: 0,
      passed: 5,
      skipped: 0,
    });
    expect(parsed.states.impl.metrics?.files_changed).toBe(2);
  });

  // 9. Log entry includes new fields when provided
  it("log entry includes new metric fields when provided", async () => {
    const result = await reportResult({
      discovered_gates: [{ command: "npm test", source: "tester" }],
      discovered_postconditions: [{ target: "dist/index.js", type: "file_exists" as const }],
      files_changed: 3,
      flow: makeMinimalFlow() as any,
      gate_results: [
        { command: "npx tsc --noEmit", exitCode: 0, gate: "tsc", output: "ok", passed: true },
      ],
      metrics: { duration_ms: 3000, model: "claude-sonnet", spawns: 1 },
      postcondition_results: [
        { name: "output exists", output: "found", passed: true, type: "file_exists" },
      ],
      state_id: "impl",
      status_keyword: "done",
      test_results: { failed: 2, passed: 8, skipped: 0 },
      violation_count: 2,
      violation_severities: { blocking: 1, warning: 1 },
      workspace,
    });
    assertOk(result);

    const log_entry = result.log_entry as any;
    expect(log_entry.gate_results).toHaveLength(1);
    expect(log_entry.postcondition_results).toHaveLength(1);
    expect(log_entry.violation_count).toBe(2);
    expect(log_entry.violation_severities).toEqual({ blocking: 1, warning: 1 });
    expect(log_entry.test_results).toEqual({ failed: 2, passed: 8, skipped: 0 });
    expect(log_entry.files_changed).toBe(3);
    expect(log_entry.discovered_gates_count).toBe(1);
    expect(log_entry.discovered_postconditions_count).toBe(1);
  });

  // 10. Log entry omits new fields when not provided
  it("log entry omits new metric fields when not provided", async () => {
    const result = await reportResult({
      flow: makeMinimalFlow() as any,
      state_id: "impl",
      status_keyword: "done",
      workspace,
    });
    assertOk(result);

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

  // 11. gate_results also stored in metrics
  it("stores gate_results in metrics when provided alongside regular metrics", async () => {
    const gateResults = [
      { command: "npx eslint .", exitCode: 1, gate: "lint", output: "3 errors", passed: false },
    ];

    const result = await reportResult({
      flow: makeMinimalFlow() as any,
      gate_results: gateResults,
      metrics: { duration_ms: 1500, model: "claude-sonnet", spawns: 1 },
      state_id: "impl",
      status_keyword: "done",
      workspace,
    });
    assertOk(result);

    // gate_results should be on both top-level BoardStateEntry and inside metrics
    expect(result.board.states.impl.gate_results).toEqual(gateResults);
    expect(result.board.states.impl.metrics?.gate_results).toEqual(gateResults);
  });

  // 12. state_completed event emitted with new signal fields
  it("emits state_completed event with new signal fields", async () => {
    const emitMock = vi.mocked(flowEventBus.emit);

    await reportResult({
      discovered_gates: [{ command: "npm test", source: "tester" }],
      flow: makeMinimalFlow() as any,
      metrics: { duration_ms: 1000, model: "claude-sonnet", spawns: 1 },
      state_id: "impl",
      status_keyword: "done",
      test_results: { failed: 0, passed: 20, skipped: 1 },
      violation_count: 5,
      workspace,
    });

    const stateCompletedCall = emitMock.mock.calls.find((call) => call[0] === "state_completed");
    expect(stateCompletedCall).toBeDefined();
    const eventPayload = stateCompletedCall![1] as any;
    expect(eventPayload.violation_count).toBe(5);
    expect(eventPayload.test_results).toEqual({ failed: 0, passed: 20, skipped: 1 });
    expect(eventPayload.discovered_gates_count).toBe(1);
  });
});
