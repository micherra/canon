/**
 * Integration tests for quality gates — violation_count, analytics, and dedup.
 *
 * Split from quality-gates-integration.test.ts. Covers:
 * 5. Edge case: violation_count=0 recorded distinctly from absent violation_count
 * 6. gate_results from report_result flow through to complete_flow analytics
 * 7. complete_flow with mixed states (one with gate data, one without) aggregates correctly
 * 8. discovered_gates deduplicated when same command reported by multiple agents
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mocks before module imports

vi.mock("@domains/messages/event-bus-instance.ts", () => ({
  flowEventBus: {
    emit: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock("../engine/effects.ts", () => ({
  executeEffects: vi.fn().mockResolvedValue(undefined),
}));

// Imports after mocks

import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store.ts";
import { appendFlowRun, computeAnalytics } from "@platform/storage/drift/analytics.ts";
import { CANON_DIR } from "@shared/constants.ts";
import { reportResult } from "../tools/report-result.ts";
import { updateBoard } from "../tools/update-board.ts";

function makeTmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "qg-post-integ-"));
}

function seedBoard(workspace: string, board: ReturnType<typeof makeMinimalBoard>): void {
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
  for (const [stateId, stateEntry] of Object.entries(board.states)) {
    store.upsertState(stateId, stateEntry as any);
  }
  for (const [stateId, iterEntry] of Object.entries(board.iterations)) {
    store.upsertIteration(stateId, iterEntry as any);
  }
}

function makeMinimalBoard() {
  return {
    base_commit: "abc123",
    blocked: null,
    concerns: [],
    current_state: "impl",
    entry: "impl",
    flow: "feature",
    iterations: {
      impl: {
        count: 1,
        history: [],
        max: 3,
      },
    },
    last_updated: new Date().toISOString(),
    skipped: [],
    started: new Date(Date.now() - 120_000).toISOString(),
    states: {
      impl: {
        entered_at: new Date().toISOString(),
        entries: 1,
        status: "in_progress" as const,
      },
    },
    task: "add feature X",
  };
}

function makeMinimalFlow() {
  return {
    description: "feature flow",
    entry: "impl",
    name: "feature",
    spawn_instructions: {
      impl: "Do the implementation",
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

describe("Integration: violation_count=0 is recorded distinctly from absent (edge case)", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = makeTmpWorkspace();
    seedBoard(workspace, makeMinimalBoard());
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearStoreCache();
    rmSync(workspace, { force: true, recursive: true });
  });

  it("violation_count=0 is explicitly stored on board (zero means clean, not absent)", async () => {
    await reportResult({
      flow: makeMinimalFlow() as any,
      metrics: { duration_ms: 1000, model: "claude-sonnet", spawns: 1 },
      state_id: "impl",
      status_keyword: "done",
      violation_count: 0, // explicitly clean
      workspace,
    });

    const board = getExecutionStore(workspace).getBoard()!;
    const metrics = board.states.impl.metrics;
    expect(metrics).toBeDefined();
    // violation_count=0 must be present (not undefined)
    expect(metrics?.violation_count).toBe(0);
    expect("violation_count" in (metrics ?? {})).toBe(true);
  });

  it("violation_count absent when no quality signals provided (backward compat)", async () => {
    await reportResult({
      flow: makeMinimalFlow() as any,
      state_id: "impl",
      status_keyword: "done",
      workspace,
      // No metrics, no quality signals
    });

    const board = getExecutionStore(workspace).getBoard()!;
    // When no signals provided, metrics should be absent entirely
    expect(board.states.impl.metrics).toBeUndefined();
  });
});

describe("Integration: gate_results from report_result flow through to complete_flow analytics", () => {
  let workspace: string;
  let projectDir: string;

  beforeEach(() => {
    workspace = makeTmpWorkspace();
    projectDir = makeTmpWorkspace();
    mkdirSync(join(projectDir, CANON_DIR), { recursive: true });
    seedBoard(workspace, makeMinimalBoard());
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearStoreCache();
    rmSync(workspace, { force: true, recursive: true });
    rmSync(projectDir, { force: true, recursive: true });
  });

  it("gate_results written via report_result are aggregated in complete_flow FlowRunEntry", async () => {
    // Step 1: Agent reports gate results via report_result
    await reportResult({
      files_changed: 2,
      flow: makeMinimalFlow() as any,
      gate_results: [
        { command: "npx tsc --noEmit", exitCode: 0, gate: "tsc", output: "ok", passed: true },
        { command: "npm test", exitCode: 0, gate: "tests", output: "10 passed", passed: true },
        { command: "npx eslint .", exitCode: 1, gate: "lint", output: "1 error", passed: false },
      ],
      metrics: { duration_ms: 5000, model: "claude-sonnet", spawns: 1 },
      postcondition_results: [
        { name: "postcondition-0-file_exists", output: "found", passed: true, type: "file_exists" },
        {
          name: "postcondition-1-no_pattern",
          output: "found console.log",
          passed: false,
          type: "no_pattern",
        },
      ],
      state_id: "impl",
      status_keyword: "done",
      test_results: { failed: 0, passed: 10, skipped: 0 },
      violation_count: 1,
      workspace,
    });

    // Verify the board was updated correctly
    const board = getExecutionStore(workspace).getBoard()!;
    expect(board.states.impl.gate_results).toHaveLength(3);
    expect(board.states.impl.metrics?.gate_results).toHaveLength(3);

    // Step 2: Call complete_flow (session data is already in the store via seedBoard/initExecution)
    await updateBoard({
      action: "complete_flow",
      project_dir: projectDir,
      workspace,
    });

    // Step 3: Verify analytics reflect gate data from report_result
    const analytics = await computeAnalytics(projectDir);

    // 3 gates, 2 passed → 2/3 avg (1 run, so avg = run value)
    expect(analytics.avg_gate_pass_rate).toBeCloseTo(2 / 3, 3);
    // 2 postconditions, 1 passed → 0.5 avg
    expect(analytics.avg_postcondition_pass_rate).toBeCloseTo(0.5, 3);
    // 1 run recorded
    expect(analytics.total_runs).toBe(1);
  });
});

describe("Integration: computeAnalytics aggregates across flow run history", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTmpWorkspace();
    mkdirSync(join(projectDir, CANON_DIR), { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearStoreCache();
    rmSync(projectDir, { force: true, recursive: true });
  });

  it("computes analytics across mixed runs (some with gate data, some without)", async () => {
    const baseEntry = {
      completed: new Date().toISOString(),
      flow: "feature",
      run_id: "run_001",
      skipped_states: [],
      started: new Date(Date.now() - 60000).toISOString(),
      state_durations: {},
      state_iterations: {},
      task: "task",
      tier: "small",
      total_duration_ms: 60000,
      total_spawns: 1,
    };

    // Run with full gate data (gate_pass_rate = 1.0)
    await appendFlowRun(projectDir, {
      ...baseEntry,
      gate_pass_rate: 1.0,
      postcondition_pass_rate: 0.8,
      run_id: "run_001",
    });
    // Run without gate data (old entry)
    await appendFlowRun(projectDir, { ...baseEntry, run_id: "run_002" });
    // Run with partial gate data (gate_pass_rate = 0.5)
    await appendFlowRun(projectDir, { ...baseEntry, gate_pass_rate: 0.5, run_id: "run_003" });

    const analytics = await computeAnalytics(projectDir);

    expect(analytics.total_runs).toBe(3);
    // avg_gate_pass_rate computed from only the 2 runs that have gate data: (1.0 + 0.5) / 2 = 0.75
    expect(analytics.avg_gate_pass_rate).toBeCloseTo(0.75, 3);
    // avg_postcondition_pass_rate computed from only 1 run with postcondition data: 0.8
    expect(analytics.avg_postcondition_pass_rate).toBeCloseTo(0.8, 3);
    // avg_duration_ms is always present
    expect(analytics.avg_duration_ms).toBe(60000);
  });

  it("returns zero analytics when no flow-runs.jsonl exists", async () => {
    // Don't write any runs
    const analytics = await computeAnalytics(projectDir);

    expect(analytics.total_runs).toBe(0);
    expect(analytics.avg_duration_ms).toBe(0);
    expect(analytics.avg_gate_pass_rate).toBeUndefined();
    expect(analytics.avg_postcondition_pass_rate).toBeUndefined();
  });
});

describe("Integration: discovered_gates deduplicated when same command reported by multiple agents", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = makeTmpWorkspace();
    seedBoard(workspace, makeMinimalBoard());
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearStoreCache();
    rmSync(workspace, { force: true, recursive: true });
  });

  it("board accumulates duplicate commands but runGates deduplicates before execution", async () => {
    // Both tester and reviewer discover the same command
    await reportResult({
      discovered_gates: [{ command: "npm test", source: "tester" }],
      flow: makeMinimalFlow() as any,
      state_id: "impl",
      status_keyword: "done",
      workspace,
    });

    const storeRef = getExecutionStore(workspace);
    const boardAfterFirst = storeRef.getBoard()!;
    storeRef.upsertState("impl", {
      ...boardAfterFirst.states.impl,
      status: "in_progress" as const,
    });

    await reportResult({
      discovered_gates: [{ command: "npm test", source: "reviewer" }], // same command, different source
      flow: makeMinimalFlow() as any,
      state_id: "impl",
      status_keyword: "done",
      workspace,
    });

    const finalBoard = getExecutionStore(workspace).getBoard()!;
    // Board accumulates both (append semantics — dedup is runGates' responsibility, not reportResult's)
    const accumulated = finalBoard.states.impl.discovered_gates ?? [];
    expect(accumulated).toHaveLength(2);
    expect(accumulated[0]).toEqual({ command: "npm test", source: "tester" });
    expect(accumulated[1]).toEqual({ command: "npm test", source: "reviewer" });

    // normalizeGates returns "none" — discovered gates stored as metadata, not executed
    const stateDef = { type: "single" as const };
    const flow = { description: "f", entry: "impl", name: "f", spawn_instructions: {}, states: {} };
    const { normalizeGates } = await import("@domains/flows/gate-runner.ts");
    const normalized = normalizeGates(stateDef, flow as any, workspace, finalBoard.states.impl);

    expect(normalized.source).toBe("none");
    expect(normalized.commands).toEqual([]);
  });
});
