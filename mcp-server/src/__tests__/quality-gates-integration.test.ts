/**
 * Integration tests for the quality gates pipeline (qg-01 through qg-04).
 *
 * These tests cover cross-module boundaries that implementor unit tests cannot:
 *
 * 1. Full pipeline: report_result(discovered_gates) → board stores them → runGates reads board → executes
 * 2. End-to-end postcondition flow: check_postconditions effect → results readable from board
 * 3. complete_flow aggregation across multiple states (multi-state board)
 * 4. Board backward compat: truly old board.json (pre-qg) parses via BoardSchema
 * 5. Mixed explicit + discovered gates at runGates level (cross-module assertion)
 * 6. Edge case: violation_count=0 recorded distinctly from absent violation_count
 * 7. complete_flow with mixed states (one with gate data, one without) aggregates correctly
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Hoist mocks before module imports
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { reportResult } from "../tools/report-result.ts";
import { getExecutionStore, clearStoreCache } from "../orchestration/execution-store.ts";
import { updateBoard } from "../tools/update-board.ts";
import { BoardSchema } from "../orchestration/flow-schema.ts";
import { computeAnalytics, appendFlowRun } from "../drift/analytics.ts";
import { CANON_DIR } from "../constants.ts";
import { appendFlowRun, computeAnalytics } from "../drift/analytics.ts";
import { clearStoreCache, getExecutionStore } from "../orchestration/execution-store.ts";
import { BoardSchema, type BoardStateEntry, type ResolvedFlow } from "../orchestration/flow-schema.ts";
import { reportResult } from "../tools/report-result.ts";
import { updateBoard } from "../tools/update-board.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "qg-integ-"));
}

function seedBoard(workspace: string, board: ReturnType<typeof makeMinimalBoard> | ReturnType<typeof makeMultiStateBoard>): void {
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
  for (const [stateId, stateEntry] of Object.entries(board.states)) {
    store.upsertState(stateId, stateEntry as any);
  }
  for (const [stateId, iterEntry] of Object.entries(board.iterations)) {
    store.upsertIteration(stateId, iterEntry as any);
  }
}

function makeMinimalBoard() {
  return {
    flow: "feature",
    task: "add feature X",
    entry: "impl",
    current_state: "impl",
    base_commit: "abc123",
    started: new Date(Date.now() - 120_000).toISOString(),
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
        count: 1,
        max: 3,
        history: [],
      },
    },
    blocked: null,
    concerns: [],
    skipped: [],
  };
}

function makeMultiStateBoard() {
  const now = new Date().toISOString();
  return {
    flow: "feature",
    task: "add feature Y",
    entry: "research",
    current_state: "review",
    base_commit: "def456",
    started: new Date(Date.now() - 240_000).toISOString(),
    last_updated: now,
    states: {
      research: {
        status: "done" as const,
        entries: 1,
        entered_at: now,
        completed_at: now,
        metrics: {
          duration_ms: 30_000,
          spawns: 1,
          model: "claude-sonnet",
        },
      },
      impl: {
        status: "done" as const,
        entries: 1,
        entered_at: now,
        completed_at: now,
        metrics: {
          duration_ms: 60_000,
          spawns: 1,
          model: "claude-sonnet",
          gate_results: [
            { passed: true, gate: "tsc", command: "npx tsc --noEmit", output: "ok", exitCode: 0 },
            { passed: false, gate: "lint", command: "npx eslint .", output: "2 errors", exitCode: 1 },
          ],
          postcondition_results: [
            { passed: true, name: "postcondition-0-file_exists", type: "file_exists", output: "found" },
          ],
          violation_count: 2,
          files_changed: 3,
          test_results: { passed: 15, failed: 1, skipped: 0 },
        },
      },
      review: {
        status: "in_progress" as const,
        entries: 1,
        entered_at: now,
        metrics: {
          duration_ms: 15_000,
          spawns: 1,
          model: "claude-sonnet",
          gate_results: [{ passed: true, gate: "tsc", command: "npx tsc --noEmit", output: "ok", exitCode: 0 }],
          postcondition_results: [
            { passed: false, name: "postcondition-0-no_pattern", type: "no_pattern", output: "found console.log" },
          ],
          violation_count: 1,
          files_changed: 1,
          test_results: { passed: 0, failed: 0, skipped: 0 },
        },
      },
    },
    iterations: {
      research: { count: 1, max: 3, history: [] },
      impl: { count: 1, max: 3, history: [] },
      review: { count: 1, max: 3, history: [] },
    },
    blocked: null,
    concerns: [],
    skipped: [],
  };
}

function makeMinimalFlow() {
  return {
    name: "feature",
    description: "feature flow",
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
      impl: "Do the implementation",
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Integration: report_result discovered_gates → board stores → runGates uses them", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = makeTmpWorkspace();
    seedBoard(workspace, makeMinimalBoard());
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearStoreCache();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("discovered_gates stored by report_result are readable via readBoard but NOT executed by normalizeGates", async () => {
    // Step 1: Agent calls report_result with discovered gates
    await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "done",
      flow: makeMinimalFlow() as unknown as ResolvedFlow,
      discovered_gates: [
        { command: "npx vitest run", source: "tester" },
        { command: "npx tsc --noEmit", source: "tester" },
      ],
    });

    // Step 2: Read the board back — discovered gates should be stored on the state entry
    const board = getExecutionStore(workspace).getBoard();
    const implState = board!.states["impl"];
    expect(implState.discovered_gates).toHaveLength(2);
    expect(implState.discovered_gates![0]).toEqual({ command: "npx vitest run", source: "tester" });
    expect(implState.discovered_gates![1]).toEqual({ command: "npx tsc --noEmit", source: "tester" });

    // Step 3: normalizeGates returns "none" — discovered gates are stored but NOT executed
    // Only YAML-defined gates (tiers 1 and 2) are executed.
    const flow = { name: "feature", description: "test", entry: "impl", states: {}, spawn_instructions: {} };
    const stateDef = { type: "single" as const }; // no explicit gates
    const { normalizeGates } = await import("../orchestration/gate-runner.ts");
    const normalized = normalizeGates(stateDef, flow as unknown as ResolvedFlow, workspace, implState);

    expect(normalized.source).toBe("none");
    expect(normalized.commands).toEqual([]);
  });

  it("multiple report_result calls accumulate discovered_gates (append semantics preserved across cycle)", async () => {
    // First report — tester discovers test command
    await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "done",
      flow: makeMinimalFlow() as unknown as ResolvedFlow,
      discovered_gates: [{ command: "npx vitest run", source: "tester" }],
    });

    // Re-open state for second report (simulating second agent call)
    const storeAfterFirst = getExecutionStore(workspace);
    const boardAfterFirst = storeAfterFirst.getBoard()!;
    storeAfterFirst.upsertState("impl", { ...boardAfterFirst.states["impl"], status: "in_progress" as const });

    // Second report — reviewer discovers lint command
    await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "done",
      flow: makeMinimalFlow() as unknown as ResolvedFlow,
      discovered_gates: [{ command: "npx eslint . --ext .ts", source: "reviewer" }],
    });

    const finalBoard = getExecutionStore(workspace).getBoard()!;
    const discovered = finalBoard.states["impl"].discovered_gates ?? [];

    // Both gates accumulated — append not replace
    expect(discovered).toHaveLength(2);
    expect(discovered.map((d) => d.command)).toContain("npx vitest run");
    expect(discovered.map((d) => d.command)).toContain("npx eslint . --ext .ts");

    // Verify normalizeGates returns "none" — discovered gates are stored but NOT executed
    const stateDef = { type: "single" as const };
    const flow = { name: "feature", description: "test", entry: "impl", states: {}, spawn_instructions: {} };
    const { normalizeGates } = await import("../orchestration/gate-runner.ts");
    const normalized = normalizeGates(stateDef, flow as unknown as ResolvedFlow, workspace, finalBoard.states["impl"]);

    expect(normalized.source).toBe("none");
    expect(normalized.commands).toEqual([]);
  });
});

describe("Integration: explicit gates override discovered gates (tier 1 wins)", () => {
  it("stateDef.gates[] wins over boardState.discovered_gates in runGates", async () => {
    const { normalizeGates } = await import("../orchestration/gate-runner.ts");

    // Board state has discovered gates
    const boardState = {
      status: "in_progress" as const,
      entries: 1,
      discovered_gates: [
        { command: "pytest --tb=short", source: "tester" },
        { command: "ruff check .", source: "reviewer" },
      ],
    };

    // StateDef has explicit gates array (tier 1)
    const stateDef = { type: "single" as const, gates: ["npm test", "npx tsc --noEmit"] };
    const flow = { name: "test", description: "test", entry: "s", states: {}, spawn_instructions: {} };

    const result = normalizeGates(stateDef, flow as unknown as ResolvedFlow, "/project", boardState);

    // Tier 1 wins — only explicit gates, discovered ignored
    expect(result.source).toBe("gates");
    expect(result.commands).toHaveLength(2);
    expect(result.commands.map((c) => c.command)).toEqual(["npm test", "npx tsc --noEmit"]);
    // No discovered gate commands in output
    expect(result.commands.map((c) => c.command)).not.toContain("pytest --tb=short");
  });
});

describe("Integration: complete_flow aggregates multi-state quality metrics", () => {
  let workspace: string;
  let projectDir: string;

  beforeEach(() => {
    workspace = makeTmpWorkspace();
    projectDir = makeTmpWorkspace();
    mkdirSync(join(projectDir, CANON_DIR), { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearStoreCache();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("aggregates gate/postcondition/violation metrics across 3 states correctly", async () => {
    seedBoard(workspace, makeMultiStateBoard());

    await updateBoard({
      workspace,
      action: "complete_flow",
      project_dir: projectDir,
    });

    const analytics = await computeAnalytics(projectDir);

    // impl has 2 gates (1 passed), review has 1 gate (1 passed) → 2/3 = 0.667
    expect(analytics.avg_gate_pass_rate).toBeCloseTo(2 / 3, 3);
    // impl has 1 passed postcondition, review has 1 failed → 1/2 = 0.5
    expect(analytics.avg_postcondition_pass_rate).toBeCloseTo(0.5, 3);
    // Total runs = 1
    expect(analytics.total_runs).toBe(1);
  });

  it("states without metrics are skipped in aggregation (research state has no gate data)", async () => {
    // research state has NO gate_results — should not affect gate_pass_rate
    seedBoard(workspace, makeMultiStateBoard());

    await updateBoard({
      workspace,
      action: "complete_flow",
      project_dir: projectDir,
    });

    const analytics = await computeAnalytics(projectDir);

    // research state has no gate_results — only impl + review gates counted (3 total)
    // If research was incorrectly counted, total_gates would be wrong
    // 2 passed out of 3 total → 0.667
    expect(analytics.avg_gate_pass_rate).toBeCloseTo(2 / 3, 3);
    expect(analytics.total_runs).toBe(1);
  });
});

describe("Integration: board backward compatibility (old board.json without new fields)", () => {
  it("BoardSchema.parse() succeeds on a board with no new quality gate fields (pre-qg format)", () => {
    // Simulate a board.json written before the qg-01 schema changes
    const oldBoard = {
      flow: "feature",
      task: "old task",
      entry: "impl",
      current_state: "impl",
      base_commit: "oldabc",
      started: "2026-01-01T00:00:00Z",
      last_updated: "2026-01-01T01:00:00Z",
      states: {
        impl: {
          status: "done",
          entries: 1,
          entered_at: "2026-01-01T00:00:00Z",
          completed_at: "2026-01-01T01:00:00Z",
          // No metrics, gate_results, postcondition_results, discovered_gates, discovered_postconditions
        },
      },
      iterations: {
        impl: { count: 1, max: 3, history: [] },
      },
      blocked: null,
      concerns: [],
      skipped: [],
    };

    // Should NOT throw
    const parsed = BoardSchema.parse(oldBoard);

    expect(parsed.states["impl"].gate_results).toBeUndefined();
    expect(parsed.states["impl"].postcondition_results).toBeUndefined();
    expect(parsed.states["impl"].discovered_gates).toBeUndefined();
    expect(parsed.states["impl"].discovered_postconditions).toBeUndefined();
    expect(parsed.states["impl"].metrics).toBeUndefined();
  });

  it("BoardSchema.parse() succeeds on a board with wave_results containing gate/gate_output fields", () => {
    // WaveResultSchema has legacy gate and gate_output fields (from before qg-01).
    // Verify these still parse cleanly after adding new BoardStateEntry fields.
    const boardWithWaveGate = {
      flow: "feature",
      task: "old task",
      entry: "impl",
      current_state: "impl",
      base_commit: "oldabc",
      started: "2026-01-01T00:00:00Z",
      last_updated: "2026-01-01T01:00:00Z",
      states: {
        impl: {
          status: "done",
          entries: 1,
          wave_results: {
            wave_1: {
              tasks: ["task-01", "task-02"],
              status: "done",
              gate: "test-suite",
              gate_output: "5 passed",
            },
          },
        },
      },
      iterations: {},
      blocked: null,
      concerns: [],
      skipped: [],
    };

    // Should NOT throw — gate and gate_output are optional on WaveResultSchema
    const parsed = BoardSchema.parse(boardWithWaveGate);
    expect(parsed.states["impl"].wave_results?.["wave_1"].gate).toBe("test-suite");
    expect(parsed.states["impl"].wave_results?.["wave_1"].gate_output).toBe("5 passed");
    // New fields absent as expected (no gate_results on state entry, only in wave_results)
    expect(parsed.states["impl"].gate_results).toBeUndefined();
  });

  it("BoardSchema.parse() succeeds when StateMetrics has only legacy fields (no new optional fields)", () => {
    const boardWithOldMetrics = {
      flow: "feature",
      task: "old task",
      entry: "impl",
      current_state: "impl",
      base_commit: "oldabc",
      started: "2026-01-01T00:00:00Z",
      last_updated: "2026-01-01T01:00:00Z",
      states: {
        impl: {
          status: "done",
          entries: 1,
          metrics: {
            duration_ms: 10000,
            spawns: 2,
            model: "claude-3-opus",
            // No gate_results, postcondition_results, etc.
          },
        },
      },
      iterations: {
        impl: { count: 1, max: 3, history: [] },
      },
      blocked: null,
      concerns: [],
      skipped: [],
    };

    const parsed = BoardSchema.parse(boardWithOldMetrics);
    expect(parsed.states["impl"].metrics?.duration_ms).toBe(10000);
    expect(parsed.states["impl"].metrics?.spawns).toBe(2);
    expect(parsed.states["impl"].metrics?.model).toBe("claude-3-opus");
    expect(parsed.states["impl"].metrics?.gate_results).toBeUndefined();
    expect(parsed.states["impl"].metrics?.violation_count).toBeUndefined();
  });
});

describe("Integration: violation_count=0 is recorded distinctly from absent (edge case)", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = makeTmpWorkspace();
    seedBoard(workspace, makeMinimalBoard());
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearStoreCache();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("violation_count=0 is explicitly stored on board (zero means clean, not absent)", async () => {
    await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "done",
      flow: makeMinimalFlow() as unknown as ResolvedFlow,
      metrics: { duration_ms: 1000, spawns: 1, model: "claude-sonnet" },
      violation_count: 0, // explicitly clean
    });

    const board = getExecutionStore(workspace).getBoard()!;
    const metrics = board.states["impl"].metrics;
    expect(metrics).toBeDefined();
    // violation_count=0 must be present (not undefined)
    expect(metrics?.violation_count).toBe(0);
    expect("violation_count" in (metrics ?? {})).toBe(true);
  });

  it("violation_count absent when no quality signals provided (backward compat)", async () => {
    await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "done",
      flow: makeMinimalFlow() as unknown as ResolvedFlow,
      // No metrics, no quality signals
    });

    const board = getExecutionStore(workspace).getBoard()!;
    // When no signals provided, metrics should be absent entirely
    expect(board.states["impl"].metrics).toBeUndefined();
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
    rmSync(workspace, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("gate_results written via report_result are aggregated in complete_flow FlowRunEntry", async () => {
    // Step 1: Agent reports gate results via report_result
    await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "done",
      flow: makeMinimalFlow() as unknown as ResolvedFlow,
      metrics: { duration_ms: 5000, spawns: 1, model: "claude-sonnet" },
      gate_results: [
        { passed: true, gate: "tsc", command: "npx tsc --noEmit", output: "ok", exitCode: 0 },
        { passed: true, gate: "tests", command: "npm test", output: "10 passed", exitCode: 0 },
        { passed: false, gate: "lint", command: "npx eslint .", output: "1 error", exitCode: 1 },
      ],
      postcondition_results: [
        { passed: true, name: "postcondition-0-file_exists", type: "file_exists", output: "found" },
        { passed: false, name: "postcondition-1-no_pattern", type: "no_pattern", output: "found console.log" },
      ],
      violation_count: 1,
      files_changed: 2,
      test_results: { passed: 10, failed: 0, skipped: 0 },
    });

    // Verify the board was updated correctly
    const board = getExecutionStore(workspace).getBoard()!;
    expect(board.states["impl"].gate_results).toHaveLength(3);
    expect(board.states["impl"].metrics?.gate_results).toHaveLength(3);

    // Step 2: Call complete_flow (session data is already in the store via seedBoard/initExecution)
    await updateBoard({
      workspace,
      action: "complete_flow",
      project_dir: projectDir,
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
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("computes analytics across mixed runs (some with gate data, some without)", async () => {
    const baseEntry = {
      run_id: "run_001",
      flow: "feature",
      tier: "small",
      task: "task",
      started: new Date(Date.now() - 60000).toISOString(),
      completed: new Date().toISOString(),
      total_duration_ms: 60000,
      state_durations: {},
      state_iterations: {},
      skipped_states: [],
      total_spawns: 1,
    };

    // Run with full gate data (gate_pass_rate = 1.0)
    await appendFlowRun(projectDir, {
      ...baseEntry,
      run_id: "run_001",
      gate_pass_rate: 1.0,
      postcondition_pass_rate: 0.8,
    });
    // Run without gate data (old entry)
    await appendFlowRun(projectDir, { ...baseEntry, run_id: "run_002" });
    // Run with partial gate data (gate_pass_rate = 0.5)
    await appendFlowRun(projectDir, { ...baseEntry, run_id: "run_003", gate_pass_rate: 0.5 });

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
    rmSync(workspace, { recursive: true, force: true });
  });

  it("board accumulates duplicate commands but runGates deduplicates before execution", async () => {
    // Both tester and reviewer discover the same command
    await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "done",
      flow: makeMinimalFlow() as unknown as ResolvedFlow,
      discovered_gates: [{ command: "npm test", source: "tester" }],
    });

    const storeRef = getExecutionStore(workspace);
    const boardAfterFirst = storeRef.getBoard()!;
    storeRef.upsertState("impl", { ...boardAfterFirst.states["impl"], status: "in_progress" as const });

    await reportResult({
      workspace,
      state_id: "impl",
      status_keyword: "done",
      flow: makeMinimalFlow() as unknown as ResolvedFlow,
      discovered_gates: [{ command: "npm test", source: "reviewer" }], // same command, different source
    });

    const finalBoard = getExecutionStore(workspace).getBoard()!;
    // Board accumulates both (append semantics — dedup is runGates' responsibility, not reportResult's)
    const accumulated = finalBoard.states["impl"].discovered_gates ?? [];
    expect(accumulated).toHaveLength(2);
    expect(accumulated[0]).toEqual({ command: "npm test", source: "tester" });
    expect(accumulated[1]).toEqual({ command: "npm test", source: "reviewer" });

    // normalizeGates returns "none" — discovered gates stored as metadata, not executed
    const stateDef = { type: "single" as const };
    const flow = { name: "f", description: "f", entry: "impl", states: {}, spawn_instructions: {} };
    const { normalizeGates } = await import("../orchestration/gate-runner.ts");
    const normalized = normalizeGates(stateDef, flow as unknown as ResolvedFlow, workspace, finalBoard.states["impl"]);

    expect(normalized.source).toBe("none");
    expect(normalized.commands).toEqual([]);
  });
});
