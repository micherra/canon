/**
 * Integration tests for the quality gates pipeline (qg-01 through qg-04).
 *
 * These tests cover cross-module boundaries that implementor unit tests cannot:
 *
 * 1. Full pipeline: report_result(discovered_gates) → board stores them → runGates reads board → executes
 * 2. End-to-end postcondition flow: check_postconditions effect → results readable from board
 * 3. complete_flow aggregation across multiple states (multi-state board)
 * 4. Board backward compat: truly old board.json (pre-qg) parses via BoardSchema
 *
 * Postcondition, violation, analytics, and dedup tests moved to quality-gates-postconditions.test.ts
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

import { BoardSchema } from "@domains/flows/board-state-schemas.ts";
import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { computeAnalytics } from "@platform/storage/drift/analytics.ts";
import { CANON_DIR } from "@shared/constants.ts";
import { reportResult } from "../tools/report-result.ts";
import { updateBoard } from "../tools/update-board.ts";

function makeTmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "qg-integ-"));
}

function seedBoard(
  workspace: string,
  board: ReturnType<typeof makeMinimalBoard> | ReturnType<typeof makeMultiStateBoard>,
): void {
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

function makeMultiStateBoard() {
  const now = new Date().toISOString();
  return {
    base_commit: "def456",
    blocked: null,
    concerns: [],
    current_state: "review",
    entry: "research",
    flow: "feature",
    iterations: {
      impl: { count: 1, history: [], max: 3 },
      research: { count: 1, history: [], max: 3 },
      review: { count: 1, history: [], max: 3 },
    },
    last_updated: now,
    skipped: [],
    started: new Date(Date.now() - 240_000).toISOString(),
    states: {
      impl: {
        completed_at: now,
        entered_at: now,
        entries: 1,
        metrics: {
          duration_ms: 60_000,
          files_changed: 3,
          gate_results: [
            { command: "npx tsc --noEmit", exitCode: 0, gate: "tsc", output: "ok", passed: true },
            {
              command: "npx eslint .",
              exitCode: 1,
              gate: "lint",
              output: "2 errors",
              passed: false,
            },
          ],
          model: "claude-sonnet",
          postcondition_results: [
            {
              name: "postcondition-0-file_exists",
              output: "found",
              passed: true,
              type: "file_exists",
            },
          ],
          spawns: 1,
          test_results: { failed: 1, passed: 15, skipped: 0 },
          violation_count: 2,
        },
        status: "done" as const,
      },
      research: {
        completed_at: now,
        entered_at: now,
        entries: 1,
        metrics: {
          duration_ms: 30_000,
          model: "claude-sonnet",
          spawns: 1,
        },
        status: "done" as const,
      },
      review: {
        entered_at: now,
        entries: 1,
        metrics: {
          duration_ms: 15_000,
          files_changed: 1,
          gate_results: [
            { command: "npx tsc --noEmit", exitCode: 0, gate: "tsc", output: "ok", passed: true },
          ],
          model: "claude-sonnet",
          postcondition_results: [
            {
              name: "postcondition-0-no_pattern",
              output: "found console.log",
              passed: false,
              type: "no_pattern",
            },
          ],
          spawns: 1,
          test_results: { failed: 0, passed: 0, skipped: 0 },
          violation_count: 1,
        },
        status: "in_progress" as const,
      },
    },
    task: "add feature Y",
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
        agent: "canon:implementor",
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

describe("Integration: report_result discovered_gates → board stores → runGates uses them", () => {
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

  it("discovered_gates stored by report_result are readable via readBoard but NOT executed by normalizeGates", async () => {
    // Step 1: Agent calls report_result with discovered gates
    await reportResult({
      discovered_gates: [
        { command: "npx vitest run", source: "tester" },
        { command: "npx tsc --noEmit", source: "tester" },
      ],
      flow: makeMinimalFlow() as any,
      state_id: "impl",
      status_keyword: "done",
      workspace,
    });

    // Step 2: Read the board back — discovered gates should be stored on the state entry
    const board = getExecutionStore(workspace).getBoard();
    const implState = board!.states.impl;
    expect(implState.discovered_gates).toHaveLength(2);
    expect(implState.discovered_gates![0]).toEqual({ command: "npx vitest run", source: "tester" });
    expect(implState.discovered_gates![1]).toEqual({
      command: "npx tsc --noEmit",
      source: "tester",
    });

    // Step 3: normalizeGates returns "none" — discovered gates are stored but NOT executed
    // Only YAML-defined gates (tiers 1 and 2) are executed.
    const flow = {
      description: "test",
      entry: "impl",
      name: "feature",
      spawn_instructions: {},
      states: {},
    };
    const stateDef = { type: "single" as const }; // no explicit gates
    const { normalizeGates } = await import("@domains/flows/gate-runner.ts");
    const normalized = normalizeGates(stateDef, flow as any, workspace, implState);

    expect(normalized.source).toBe("none");
    expect(normalized.commands).toEqual([]);
  });

  it("multiple report_result calls accumulate discovered_gates (append semantics preserved across cycle)", async () => {
    // First report — tester discovers test command
    await reportResult({
      discovered_gates: [{ command: "npx vitest run", source: "tester" }],
      flow: makeMinimalFlow() as any,
      state_id: "impl",
      status_keyword: "done",
      workspace,
    });

    // Re-open state for second report (simulating second agent call)
    const storeAfterFirst = getExecutionStore(workspace);
    const boardAfterFirst = storeAfterFirst.getBoard()!;
    storeAfterFirst.upsertState("impl", {
      ...boardAfterFirst.states.impl,
      status: "in_progress" as const,
    });

    // Second report — reviewer discovers lint command
    await reportResult({
      discovered_gates: [{ command: "npx eslint . --ext .ts", source: "reviewer" }],
      flow: makeMinimalFlow() as any,
      state_id: "impl",
      status_keyword: "done",
      workspace,
    });

    const finalBoard = getExecutionStore(workspace).getBoard()!;
    const discovered = finalBoard.states.impl.discovered_gates ?? [];

    // Both gates accumulated — append not replace
    expect(discovered).toHaveLength(2);
    expect(discovered.map((d) => d.command)).toContain("npx vitest run");
    expect(discovered.map((d) => d.command)).toContain("npx eslint . --ext .ts");

    // Verify normalizeGates returns "none" — discovered gates are stored but NOT executed
    const stateDef = { type: "single" as const };
    const flow = {
      description: "test",
      entry: "impl",
      name: "feature",
      spawn_instructions: {},
      states: {},
    };
    const { normalizeGates } = await import("@domains/flows/gate-runner.ts");
    const normalized = normalizeGates(stateDef, flow as any, workspace, finalBoard.states.impl);

    expect(normalized.source).toBe("none");
    expect(normalized.commands).toEqual([]);
  });
});

describe("Integration: explicit gates override discovered gates (tier 1 wins)", () => {
  it("stateDef.gates[] wins over boardState.discovered_gates in runGates", async () => {
    const { normalizeGates } = await import("@domains/flows/gate-runner.ts");

    // Board state has discovered gates
    const boardState = {
      discovered_gates: [
        { command: "pytest --tb=short", source: "tester" },
        { command: "ruff check .", source: "reviewer" },
      ],
      entries: 1,
      status: "in_progress" as const,
    };

    // StateDef has explicit gates array (tier 1)
    const stateDef = { gates: ["npm test", "npx tsc --noEmit"], type: "single" as const };
    const flow = {
      description: "test",
      entry: "s",
      name: "test",
      spawn_instructions: {},
      states: {},
    };

    const result = normalizeGates(stateDef, flow as any, "/project", boardState);

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
    rmSync(workspace, { force: true, recursive: true });
    rmSync(projectDir, { force: true, recursive: true });
  });

  it("aggregates gate/postcondition/violation metrics across 3 states correctly", async () => {
    seedBoard(workspace, makeMultiStateBoard());

    await updateBoard({
      action: "complete_flow",
      project_dir: projectDir,
      workspace,
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
      action: "complete_flow",
      project_dir: projectDir,
      workspace,
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
      base_commit: "oldabc",
      blocked: null,
      concerns: [],
      current_state: "impl",
      entry: "impl",
      flow: "feature",
      iterations: {
        impl: { count: 1, history: [], max: 3 },
      },
      last_updated: "2026-01-01T01:00:00Z",
      skipped: [],
      started: "2026-01-01T00:00:00Z",
      states: {
        impl: {
          completed_at: "2026-01-01T01:00:00Z",
          entered_at: "2026-01-01T00:00:00Z",
          entries: 1,
          status: "done",
          // No metrics, gate_results, postcondition_results, discovered_gates, discovered_postconditions
        },
      },
      task: "old task",
    };

    // Should NOT throw
    const parsed = BoardSchema.parse(oldBoard);

    expect(parsed.states.impl.gate_results).toBeUndefined();
    expect(parsed.states.impl.postcondition_results).toBeUndefined();
    expect(parsed.states.impl.discovered_gates).toBeUndefined();
    expect(parsed.states.impl.discovered_postconditions).toBeUndefined();
    expect(parsed.states.impl.metrics).toBeUndefined();
  });

  it("BoardSchema.parse() succeeds on a board with wave_results containing gate/gate_output fields", () => {
    // WaveResultSchema has legacy gate and gate_output fields (from before qg-01).
    // Verify these still parse cleanly after adding new BoardStateEntry fields.
    const boardWithWaveGate = {
      base_commit: "oldabc",
      blocked: null,
      concerns: [],
      current_state: "impl",
      entry: "impl",
      flow: "feature",
      iterations: {},
      last_updated: "2026-01-01T01:00:00Z",
      skipped: [],
      started: "2026-01-01T00:00:00Z",
      states: {
        impl: {
          entries: 1,
          status: "done",
          wave_results: {
            wave_1: {
              gate: "test-suite",
              gate_output: "5 passed",
              status: "done",
              tasks: ["task-01", "task-02"],
            },
          },
        },
      },
      task: "old task",
    };

    // Should NOT throw — gate and gate_output are optional on WaveResultSchema
    const parsed = BoardSchema.parse(boardWithWaveGate);
    expect(parsed.states.impl.wave_results?.wave_1.gate).toBe("test-suite");
    expect(parsed.states.impl.wave_results?.wave_1.gate_output).toBe("5 passed");
    // New fields absent as expected (no gate_results on state entry, only in wave_results)
    expect(parsed.states.impl.gate_results).toBeUndefined();
  });

  it("BoardSchema.parse() succeeds when StateMetrics has only legacy fields (no new optional fields)", () => {
    const boardWithOldMetrics = {
      base_commit: "oldabc",
      blocked: null,
      concerns: [],
      current_state: "impl",
      entry: "impl",
      flow: "feature",
      iterations: {
        impl: { count: 1, history: [], max: 3 },
      },
      last_updated: "2026-01-01T01:00:00Z",
      skipped: [],
      started: "2026-01-01T00:00:00Z",
      states: {
        impl: {
          entries: 1,
          metrics: {
            duration_ms: 10000,
            model: "claude-3-opus",
            spawns: 2,
            // No gate_results, postcondition_results, etc.
          },
          status: "done",
        },
      },
      task: "old task",
    };

    const parsed = BoardSchema.parse(boardWithOldMetrics);
    expect(parsed.states.impl.metrics?.duration_ms).toBe(10000);
    expect(parsed.states.impl.metrics?.spawns).toBe(2);
    expect(parsed.states.impl.metrics?.model).toBe("claude-3-opus");
    expect(parsed.states.impl.metrics?.gate_results).toBeUndefined();
    expect(parsed.states.impl.metrics?.violation_count).toBeUndefined();
  });
});
