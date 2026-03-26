/**
 * Tests for analytics.ts — FlowRunEntry enrichment and computeAnalytics aggregation.
 *
 * Covers:
 * 1. FlowRunEntry with new aggregated fields persists and reads back from JSONL
 * 2. computeAnalytics computes avg_gate_pass_rate from runs with gate data
 * 3. computeAnalytics computes avg_postcondition_pass_rate from runs with postcondition data
 * 4. Backward compat: old FlowRunEntry without new fields still works
 * 5. update-board complete_flow aggregates metrics from board states into FlowRunEntry correctly
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Hoist mocks before module imports
// ---------------------------------------------------------------------------

vi.mock("../orchestration/workspace.js", () => ({
  withBoardLock: vi.fn(async (_workspace: string, fn: () => Promise<unknown>) => fn()),
  writeSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../orchestration/event-bus-instance.js", () => ({
  flowEventBus: {
    emit: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock("../orchestration/events.js", () => ({
  createJsonlLogger: vi.fn(() => vi.fn().mockResolvedValue(undefined)),
}));

import { withBoardLock } from "../orchestration/workspace.ts";
import { appendFlowRun, computeAnalytics, type FlowRunEntry } from "../drift/analytics.ts";
import { writeBoard } from "../orchestration/board.ts";
import { updateBoard } from "../tools/update-board.ts";
import { CANON_DIR } from "../constants.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "qg-analytics-"));
}

function makeBaseFlowRunEntry(): FlowRunEntry {
  return {
    run_id: "run_test_01",
    flow: "test-flow",
    tier: "small",
    task: "test task",
    started: new Date(Date.now() - 60000).toISOString(),
    completed: new Date().toISOString(),
    total_duration_ms: 60000,
    state_durations: { impl: 50000 },
    state_iterations: { impl: 1 },
    skipped_states: [],
    total_spawns: 2,
  };
}

function makeBoard(withMetrics = true) {
  const states: Record<string, any> = {
    impl: {
      status: "in_progress" as const,
      entries: 1,
      entered_at: new Date().toISOString(),
    },
  };

  if (withMetrics) {
    states.impl.metrics = {
      duration_ms: 5000,
      spawns: 2,
      model: "claude-sonnet",
      gate_results: [
        { passed: true, gate: "tsc", command: "npx tsc --noEmit", output: "ok", exitCode: 0 },
        { passed: true, gate: "tests", command: "npm test", output: "ok", exitCode: 0 },
        { passed: false, gate: "lint", command: "npx eslint .", output: "2 errors", exitCode: 1 },
      ],
      postcondition_results: [
        { passed: true, name: "output exists", type: "file_exists", output: "found" },
        { passed: true, name: "no console.log", type: "no_pattern", output: "clean" },
      ],
      violation_count: 3,
      files_changed: 5,
      test_results: { passed: 20, failed: 2, skipped: 1 },
    };
  }

  return {
    flow: "test-flow",
    task: "test task",
    entry: "impl",
    current_state: "impl",
    base_commit: "abc123",
    started: new Date(Date.now() - 60000).toISOString(),
    last_updated: new Date().toISOString(),
    states,
    iterations: {
      impl: { count: 1, max: 3, history: [] },
    },
    blocked: null,
    concerns: [],
    skipped: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("analytics.ts: FlowRunEntry enrichment", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTmpDir();
    mkdirSync(join(projectDir, CANON_DIR), { recursive: true });
    vi.clearAllMocks();
    vi.mocked(withBoardLock).mockImplementation(async (_ws, fn) => fn());
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. FlowRunEntry with new fields persists and reads back
  // -------------------------------------------------------------------------
  it("FlowRunEntry with new aggregated fields persists to JSONL and reads back correctly", async () => {
    const entry: FlowRunEntry = {
      ...makeBaseFlowRunEntry(),
      gate_pass_rate: 0.667,
      postcondition_pass_rate: 1.0,
      total_violations: 3,
      total_test_results: { passed: 20, failed: 2, skipped: 1 },
      total_files_changed: 5,
    };

    await appendFlowRun(projectDir, entry);

    const jsonlPath = join(projectDir, CANON_DIR, "flow-runs.jsonl");
    const raw = await readFile(jsonlPath, "utf-8");
    const parsed = JSON.parse(raw.trim());

    expect(parsed.gate_pass_rate).toBeCloseTo(0.667);
    expect(parsed.postcondition_pass_rate).toBe(1.0);
    expect(parsed.total_violations).toBe(3);
    expect(parsed.total_test_results).toEqual({ passed: 20, failed: 2, skipped: 1 });
    expect(parsed.total_files_changed).toBe(5);
  });

  // -------------------------------------------------------------------------
  // 2. computeAnalytics computes avg_gate_pass_rate
  // -------------------------------------------------------------------------
  it("computeAnalytics computes avg_gate_pass_rate from runs with gate data", async () => {
    // Two runs: 0.667 and 1.0 → avg = 0.8335
    await appendFlowRun(projectDir, {
      ...makeBaseFlowRunEntry(),
      run_id: "run_001",
      gate_pass_rate: 0.667,
    });
    await appendFlowRun(projectDir, {
      ...makeBaseFlowRunEntry(),
      run_id: "run_002",
      gate_pass_rate: 1.0,
    });
    // One run without gate data → should be excluded from avg
    await appendFlowRun(projectDir, {
      ...makeBaseFlowRunEntry(),
      run_id: "run_003",
    });

    const analytics = await computeAnalytics(projectDir);
    expect(analytics.avg_gate_pass_rate).toBeDefined();
    expect(analytics.avg_gate_pass_rate).toBeCloseTo(0.8335, 3);
  });

  // -------------------------------------------------------------------------
  // 3. computeAnalytics computes avg_postcondition_pass_rate
  // -------------------------------------------------------------------------
  it("computeAnalytics computes avg_postcondition_pass_rate from runs with postcondition data", async () => {
    await appendFlowRun(projectDir, {
      ...makeBaseFlowRunEntry(),
      run_id: "run_001",
      postcondition_pass_rate: 0.5,
    });
    await appendFlowRun(projectDir, {
      ...makeBaseFlowRunEntry(),
      run_id: "run_002",
      postcondition_pass_rate: 0.75,
    });

    const analytics = await computeAnalytics(projectDir);
    expect(analytics.avg_postcondition_pass_rate).toBeDefined();
    expect(analytics.avg_postcondition_pass_rate).toBeCloseTo(0.625, 3);
  });

  // -------------------------------------------------------------------------
  // 4. Backward compat: old FlowRunEntry without new fields still works
  // -------------------------------------------------------------------------
  it("old FlowRunEntry without new fields still works in computeAnalytics", async () => {
    // Old entry — no gate_pass_rate, no postcondition_pass_rate, etc.
    await appendFlowRun(projectDir, makeBaseFlowRunEntry());

    const analytics = await computeAnalytics(projectDir);
    expect(analytics.total_runs).toBe(1);
    // No gate data → avg_gate_pass_rate should be undefined or null
    expect(analytics.avg_gate_pass_rate == null).toBe(true);
    expect(analytics.avg_postcondition_pass_rate == null).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 5. update-board complete_flow aggregates metrics from board states
  // -------------------------------------------------------------------------
  it("update-board complete_flow aggregates gate/postcondition/violation metrics from board states", async () => {
    const workspace = makeTmpDir();

    try {
      const board = makeBoard(true);
      await writeBoard(workspace, board);

      // Create a session.json so complete_flow can read tier
      mkdirSync(join(workspace), { recursive: true });
      const sessionData = JSON.stringify({
        branch: "feat/test",
        sanitized: "feat-test",
        created: new Date().toISOString(),
        task: "test task",
        original_task: "test task",
        tier: "small",
        flow: "test-flow",
        slug: "test-task",
        status: "active",
      });
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(workspace, "session.json"), sessionData, "utf-8");

      await updateBoard({
        workspace,
        action: "complete_flow",
        project_dir: projectDir,
      });

      // Read the flow-runs.jsonl and verify aggregation
      const jsonlPath = join(projectDir, CANON_DIR, "flow-runs.jsonl");
      const raw = await readFile(jsonlPath, "utf-8");
      const entry = JSON.parse(raw.trim());

      // 3 gates, 2 passed → pass rate = 2/3 ≈ 0.667
      expect(entry.gate_pass_rate).toBeCloseTo(2 / 3, 3);
      // 2 postconditions, 2 passed → pass rate = 1.0
      expect(entry.postcondition_pass_rate).toBeCloseTo(1.0, 3);
      // violation_count = 3
      expect(entry.total_violations).toBe(3);
      // files_changed = 5
      expect(entry.total_files_changed).toBe(5);
      // test_results aggregated
      expect(entry.total_test_results).toEqual({ passed: 20, failed: 2, skipped: 1 });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 6. update-board complete_flow with no metric states → zero aggregation
  // -------------------------------------------------------------------------
  it("update-board complete_flow with no metrics in board states → no gate_pass_rate in FlowRunEntry", async () => {
    const workspace = makeTmpDir();

    try {
      const board = makeBoard(false); // no metrics
      await writeBoard(workspace, board);

      const sessionData = JSON.stringify({
        branch: "feat/test",
        sanitized: "feat-test",
        created: new Date().toISOString(),
        task: "test task",
        original_task: "test task",
        tier: "small",
        flow: "test-flow",
        slug: "test-task",
        status: "active",
      });
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(workspace, "session.json"), sessionData, "utf-8");

      await updateBoard({
        workspace,
        action: "complete_flow",
        project_dir: projectDir,
      });

      const jsonlPath = join(projectDir, CANON_DIR, "flow-runs.jsonl");
      const raw = await readFile(jsonlPath, "utf-8");
      const entry = JSON.parse(raw.trim());

      // No gate data → gate_pass_rate undefined or absent
      expect(entry.gate_pass_rate == null).toBe(true);
      expect(entry.postcondition_pass_rate == null).toBe(true);
      expect(entry.total_violations == null || entry.total_violations === 0).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
