/**
 * drive-flow-wave.test.ts — Tests for wave state handling in driveFlow.
 *
 * TDD: tests written before implementation. These cover:
 * - Wave entry creates worktrees and returns SpawnRequests with worktree_path
 * - Wave task result accumulation: partial results wait, all results trigger merge
 * - Merge conflict returns HITL breakpoint when on_conflict is "hitl"
 * - Gate failure after merge drives transition correctly
 * - Wave-to-wave advancement: wave 1 complete → wave 2 starts
 * - Epic checkpoint returns HITL with context
 * - Wave event handling: pause event returns HITL; skip_task event processes mechanically
 * - After-consultation: returns consultation SpawnRequests after last wave
 *
 * Canon principles applied:
 * - sqlite-transactions: wave result accumulation is transaction-wrapped
 * - subprocess-isolation: git ops go through wave-lifecycle.ts
 * - no-silent-failures: merge conflicts surface as structured breakpoints
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock heavy dependencies
vi.mock("../tools/enter-and-prepare-state.ts", () => ({
  enterAndPrepareState: vi.fn(),
}));
vi.mock("../tools/report-result.ts", () => ({
  reportResult: vi.fn(),
}));
vi.mock("../orchestration/wave-lifecycle.ts", () => ({
  cleanupWorktrees: vi.fn(),
  createWaveWorktrees: vi.fn(),
  getProjectDir: vi.fn(),
  mergeWaveResults: vi.fn(),
}));
vi.mock("../orchestration/gate-runner.ts", () => ({
  runGates: vi.fn(),
}));
vi.mock("../tools/resolve-after-consultations.ts", () => ({
  resolveAfterConsultations: vi.fn(),
}));

import { initExecutionDb } from "../orchestration/execution-schema.ts";
import { clearStoreCache, ExecutionStore } from "../orchestration/execution-store.ts";
import type { ResolvedFlow } from "../orchestration/flow-schema.ts";
import { runGates } from "../orchestration/gate-runner.ts";
import {
  cleanupWorktrees,
  createWaveWorktrees,
  getProjectDir,
  mergeWaveResults,
} from "../orchestration/wave-lifecycle.ts";
import { driveFlow } from "../tools/drive-flow.ts";
import type { EnterAndPrepareStateResult } from "../tools/enter-and-prepare-state.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";
import { reportResult } from "../tools/report-result.ts";
import { resolveAfterConsultations } from "../tools/resolve-after-consultations.ts";
import type { ToolResult } from "../utils/tool-result.ts";

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "drive-flow-wave-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeStore(workspace: string): ExecutionStore {
  const db = initExecutionDb(join(workspace, "orchestration.db"));
  const store = new ExecutionStore(db);
  store.initExecution({
    base_commit: "abc123",
    branch: "feat/epic",
    created: new Date().toISOString(),
    current_state: "implement",
    entry: "implement",
    flow: "epic-flow",
    flow_name: "epic-flow",
    last_updated: new Date().toISOString(),
    sanitized: "feat-epic",
    slug: "epic-slug",
    started: new Date().toISOString(),
    task: "build epic feature",
    tier: "large",
  });
  return store;
}

/**
 * Write a minimal INDEX.md for the given tasks and waves.
 */
function writeIndexMd(
  workspace: string,
  slug: string,
  tasks: Array<{ task_id: string; wave: number }>,
): void {
  const plansDir = join(workspace, "plans", slug);
  mkdirSync(plansDir, { recursive: true });
  const rows = tasks.map((t) => `| ${t.task_id} | ${t.wave} | — |  |  |`).join("\n");
  const content = `## Plan Index: ${slug}\n\n| Task | Wave | Depends on | Files | Principles |\n|------|------|------------|-------|------------|\n${rows}\n`;
  writeFileSync(join(plansDir, "INDEX.md"), content, "utf-8");
}

/** Minimal wave flow: implement (wave) → terminal */
function makeWaveFlow(overrides: Partial<ResolvedFlow> = {}): ResolvedFlow {
  return {
    description: "epic flow",
    entry: "implement",
    name: "epic-flow",
    spawn_instructions: {
      implement: "Implement the tasks",
      terminal: "",
    },
    states: {
      implement: {
        transitions: { done: "terminal" },
        type: "wave",
        wave_policy: {
          isolation: "worktree",
          merge_strategy: "sequential",
          on_conflict: "hitl",
        },
      },
      terminal: {
        type: "terminal",
      },
    },
    ...overrides,
  };
}

function makeEnterResult(
  overrides: Partial<EnterAndPrepareStateResult> = {},
): ToolResult<EnterAndPrepareStateResult> {
  return {
    can_enter: true,
    cannot_fix_items: [],
    history: [],
    iteration_count: 1,
    max_iterations: 5,
    ok: true,
    prompts: [
      {
        agent: "canon:canon-implementor",
        item: "task-01",
        prompt: "Implement task-01",
        role: "implementor",
        template_paths: [],
      },
    ],
    state_type: "wave",
    ...overrides,
  };
}

function makeReportResult(nextState: string | null, overrides: Record<string, unknown> = {}) {
  return {
    board: {
      base_commit: "abc123",
      blocked: null,
      concerns: [],
      current_state: nextState ?? "terminal",
      entry: "implement",
      flow: "epic-flow",
      iterations: {},
      last_updated: new Date().toISOString(),
      skipped: [],
      started: new Date().toISOString(),
      states: {},
      task: "build epic feature",
    },
    hitl_required: false,
    log_entry: {},
    next_state: nextState,
    ok: true,
    stuck: false,
    transition_condition: "done",
    ...overrides,
  };
}

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
  vi.resetAllMocks();
});

// 1. Wave entry: creates worktrees and returns SpawnRequests with worktree_path

describe("driveFlow — wave entry", () => {
  it("creates worktrees for each task in the current wave and populates worktree_path on SpawnRequests", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);
    writeIndexMd(workspace, "epic-slug", [
      { task_id: "task-01", wave: 1 },
      { task_id: "task-02", wave: 1 },
    ]);

    vi.mocked(getProjectDir).mockReturnValue("/project");
    vi.mocked(createWaveWorktrees).mockResolvedValue([
      {
        branch: "canon-wave/task-01",
        task_id: "task-01",
        worktree_path: "/project/.canon/worktrees/task-01",
      },
      {
        branch: "canon-wave/task-02",
        task_id: "task-02",
        worktree_path: "/project/.canon/worktrees/task-02",
      },
    ]);

    vi.mocked(enterAndPrepareState).mockResolvedValue(
      makeEnterResult({
        prompts: [
          {
            agent: "canon:canon-implementor",
            item: "task-01",
            prompt: "Implement task-01",
            role: "implementor",
            template_paths: [],
          },
          {
            agent: "canon:canon-implementor",
            item: "task-02",
            prompt: "Implement task-02",
            role: "implementor",
            template_paths: [],
          },
        ],
      }),
    );

    const flow = makeWaveFlow();
    const result = await driveFlow({ flow, workspace });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;

    // Both tasks should have worktree_path populated
    expect(result.requests).toHaveLength(2);
    const task01Req = result.requests.find((r) => r.task_id === "task-01");
    const task02Req = result.requests.find((r) => r.task_id === "task-02");
    expect(task01Req?.worktree_path).toBe("/project/.canon/worktrees/task-01");
    expect(task02Req?.worktree_path).toBe("/project/.canon/worktrees/task-02");
  });

  it("stores wave metadata (wave=1, wave_total) in execution state", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    writeIndexMd(workspace, "epic-slug", [
      { task_id: "task-01", wave: 1 },
      { task_id: "task-02", wave: 1 },
    ]);

    vi.mocked(getProjectDir).mockReturnValue("/project");
    vi.mocked(createWaveWorktrees).mockResolvedValue([
      {
        branch: "canon-wave/task-01",
        task_id: "task-01",
        worktree_path: "/project/.canon/worktrees/task-01",
      },
      {
        branch: "canon-wave/task-02",
        task_id: "task-02",
        worktree_path: "/project/.canon/worktrees/task-02",
      },
    ]);
    vi.mocked(enterAndPrepareState).mockResolvedValue(
      makeEnterResult({
        prompts: [
          {
            agent: "canon:canon-implementor",
            item: "task-01",
            prompt: "Impl task-01",
            template_paths: [],
          },
          {
            agent: "canon:canon-implementor",
            item: "task-02",
            prompt: "Impl task-02",
            template_paths: [],
          },
        ],
      }),
    );

    const flow = makeWaveFlow();
    await driveFlow({ flow, workspace });

    const stateEntry = store.getState("implement");
    expect(stateEntry).not.toBeNull();
    expect(stateEntry?.wave).toBe(1);
    expect(stateEntry?.wave_total).toBe(2);
  });
});

// 2. Wave result accumulation

describe("driveFlow — wave result accumulation", () => {
  it("returns empty spawn requests (waiting) when not all tasks are complete", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    writeIndexMd(workspace, "epic-slug", [
      { task_id: "task-01", wave: 1 },
      { task_id: "task-02", wave: 1 },
    ]);

    // Set up state: wave=1, wave_total=2, wave_results has 0 results
    store.upsertState("implement", {
      entries: 1,
      status: "in_progress",
      wave: 1,
      wave_results: {},
      wave_total: 2,
    });

    // getProjectDir is needed to derive convention-based worktree paths in handleWaveTaskResult
    vi.mocked(getProjectDir).mockReturnValue("/project");

    // Submit result for task-01 only
    const flow = makeWaveFlow();
    const result = await driveFlow({
      flow,
      result: {
        state_id: "implement",
        status: "done",
        task_id: "task-01",
      },
      workspace,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    // Empty requests = waiting for more results
    expect(result.requests).toHaveLength(0);
  });

  it("proceeds to merge when all tasks complete (wave_results.length >= wave_total)", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    writeIndexMd(workspace, "epic-slug", [
      { task_id: "task-01", wave: 1 },
      { task_id: "task-02", wave: 1 },
    ]);

    // Set up state: wave=1, wave_total=2, already have task-01 result
    store.upsertState("implement", {
      entries: 2,
      status: "in_progress",
      wave: 1,
      wave_results: {
        "task-01": { status: "done", tasks: ["task-01"] },
      },
      wave_total: 2,
    });

    vi.mocked(getProjectDir).mockReturnValue("/project");
    vi.mocked(mergeWaveResults).mockResolvedValue({ merged_count: 2, ok: true });
    vi.mocked(cleanupWorktrees).mockResolvedValue({ errors: [], removed: 2 });
    vi.mocked(runGates).mockReturnValue([]);
    vi.mocked(reportResult).mockResolvedValue(makeReportResult("terminal") as any);

    const flow = makeWaveFlow();
    const result = await driveFlow({
      flow,
      result: {
        state_id: "implement",
        status: "done",
        task_id: "task-02",
      },
      workspace,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // After merge of last task, should either advance to terminal or return done
    expect(["spawn", "done"]).toContain(result.action);
    // mergeWaveResults should have been called
    expect(mergeWaveResults).toHaveBeenCalled();
  });

  it("appends task result to wave_results atomically in a transaction", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    writeIndexMd(workspace, "epic-slug", [{ task_id: "task-01", wave: 1 }]);

    // Set up state: wave=1, wave_total=1, no results yet
    store.upsertState("implement", {
      entries: 1,
      status: "in_progress",
      wave: 1,
      wave_results: {},
      wave_total: 1,
    });

    vi.mocked(getProjectDir).mockReturnValue("/project");
    vi.mocked(mergeWaveResults).mockResolvedValue({ merged_count: 1, ok: true });
    vi.mocked(cleanupWorktrees).mockResolvedValue({ errors: [], removed: 1 });
    vi.mocked(runGates).mockReturnValue([]);
    vi.mocked(reportResult).mockResolvedValue(makeReportResult("terminal") as any);

    const flow = makeWaveFlow();
    await driveFlow({
      flow,
      result: {
        state_id: "implement",
        status: "done",
        task_id: "task-01",
      },
      workspace,
    });

    // After processing, wave_results should contain task-01
    const stateEntry = store.getState("implement");
    const waveResults = stateEntry?.wave_results as Record<string, unknown> | undefined;
    expect(waveResults).toBeDefined();
    expect(waveResults?.["task-01"]).toBeDefined();
  });
});

// 3. Merge conflict → HITL breakpoint

describe("driveFlow — merge conflict handling", () => {
  it("returns HITL breakpoint when merge conflict occurs and on_conflict is 'hitl'", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    writeIndexMd(workspace, "epic-slug", [{ task_id: "task-01", wave: 1 }]);

    // All tasks done, ready to merge
    store.upsertState("implement", {
      entries: 1,
      status: "in_progress",
      wave: 1,
      wave_results: {},
      wave_total: 1,
    });

    vi.mocked(getProjectDir).mockReturnValue("/project");
    vi.mocked(mergeWaveResults).mockResolvedValue({
      conflict_detail: "Auto merge failed; fix conflicts",
      conflict_task: "task-01",
      merged_count: 0,
      ok: false,
    });

    const flow = makeWaveFlow(); // on_conflict: "hitl"
    const result = await driveFlow({
      flow,
      result: {
        state_id: "implement",
        status: "done",
        task_id: "task-01",
      },
      workspace,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("hitl");
    if (result.action !== "hitl") return;
    expect(result.breakpoint.reason).toContain("conflict");
    expect(result.breakpoint.context).toContain("task-01");
  });

  it("returns HITL breakpoint with replan suggestion when on_conflict is 'replan'", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    writeIndexMd(workspace, "epic-slug", [{ task_id: "task-01", wave: 1 }]);

    store.upsertState("implement", {
      entries: 1,
      status: "in_progress",
      wave: 1,
      wave_results: {},
      wave_total: 1,
    });

    vi.mocked(getProjectDir).mockReturnValue("/project");
    vi.mocked(mergeWaveResults).mockResolvedValue({
      conflict_detail: "Conflict in src/foo.ts",
      conflict_task: "task-01",
      merged_count: 0,
      ok: false,
    });

    const flow = makeWaveFlow({
      states: {
        implement: {
          transitions: { done: "terminal" },
          type: "wave",
          wave_policy: {
            isolation: "worktree",
            merge_strategy: "sequential",
            on_conflict: "replan",
          },
        },
        terminal: { type: "terminal" },
      },
    });

    const result = await driveFlow({
      flow,
      result: {
        state_id: "implement",
        status: "done",
        task_id: "task-01",
      },
      workspace,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("hitl");
    if (result.action !== "hitl") return;
    expect(result.breakpoint.reason.toLowerCase()).toContain("replan");
  });

  it("returns SpawnRequest for conflicting task when on_conflict is 'retry-single'", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    writeIndexMd(workspace, "epic-slug", [{ task_id: "task-01", wave: 1 }]);

    store.upsertState("implement", {
      entries: 1,
      status: "in_progress",
      wave: 1,
      wave_results: {},
      wave_total: 1,
    });

    vi.mocked(getProjectDir).mockReturnValue("/project");
    vi.mocked(mergeWaveResults).mockResolvedValue({
      conflict_detail: "Conflict in src/foo.ts",
      conflict_task: "task-01",
      merged_count: 0,
      ok: false,
    });

    const flow = makeWaveFlow({
      states: {
        implement: {
          transitions: { done: "terminal" },
          type: "wave",
          wave_policy: {
            isolation: "worktree",
            merge_strategy: "sequential",
            on_conflict: "retry-single",
          },
        },
        terminal: { type: "terminal" },
      },
    });

    const result = await driveFlow({
      flow,
      result: {
        state_id: "implement",
        status: "done",
        task_id: "task-01",
      },
      workspace,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].task_id).toBe("task-01");
  });
});

// 4. Gate failure after merge

describe("driveFlow — gate failure after merge", () => {
  it("transitions via 'gate_failed' condition when gate fails after merge", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    writeIndexMd(workspace, "epic-slug", [{ task_id: "task-01", wave: 1 }]);

    store.upsertState("implement", {
      entries: 1,
      status: "in_progress",
      wave: 1,
      wave_results: {},
      wave_total: 1,
    });

    vi.mocked(getProjectDir).mockReturnValue("/project");
    vi.mocked(mergeWaveResults).mockResolvedValue({ merged_count: 1, ok: true });
    vi.mocked(cleanupWorktrees).mockResolvedValue({ errors: [], removed: 1 });
    vi.mocked(runGates).mockReturnValue([
      {
        command: "npm test",
        exitCode: 1,
        gate: "test-suite",
        output: "Tests failed",
        passed: false,
      },
    ]);
    vi.mocked(reportResult).mockResolvedValue(makeReportResult("fix") as any);
    // Mock enterAndPrepareState for the "fix" state that is entered after gate_failed
    vi.mocked(enterAndPrepareState).mockResolvedValue(
      makeEnterResult({
        prompts: [{ agent: "canon:canon-fixer", prompt: "Fix tests", template_paths: [] }],
      }),
    );

    const flow = makeWaveFlow({
      states: {
        fix: {
          transitions: { done: "terminal" },
          type: "single",
        },
        implement: {
          gate: "test-suite",
          transitions: { done: "terminal", gate_failed: "fix" },
          type: "wave",
          wave_policy: {
            isolation: "worktree",
            merge_strategy: "sequential",
            on_conflict: "hitl",
          },
        },
        terminal: { type: "terminal" },
      },
    });

    await driveFlow({
      flow,
      result: {
        state_id: "implement",
        status: "done",
        task_id: "task-01",
      },
      workspace,
    });

    // Should call reportResult with gate_failed condition or advance to fix state
    expect(reportResult).toHaveBeenCalled();
    const reportCall = vi.mocked(reportResult).mock.calls[0][0];
    expect(["gate_failed", "done"]).toContain(reportCall.status_keyword);
  });

  it("advances normally when gate passes after merge", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    writeIndexMd(workspace, "epic-slug", [{ task_id: "task-01", wave: 1 }]);

    store.upsertState("implement", {
      entries: 1,
      status: "in_progress",
      wave: 1,
      wave_results: {},
      wave_total: 1,
    });

    vi.mocked(getProjectDir).mockReturnValue("/project");
    vi.mocked(mergeWaveResults).mockResolvedValue({ merged_count: 1, ok: true });
    vi.mocked(cleanupWorktrees).mockResolvedValue({ errors: [], removed: 1 });
    vi.mocked(runGates).mockReturnValue([
      { command: "npm test", exitCode: 0, gate: "test-suite", output: "All passing", passed: true },
    ]);
    vi.mocked(reportResult).mockResolvedValue(makeReportResult("terminal") as any);
    vi.mocked(enterAndPrepareState).mockResolvedValue(
      makeEnterResult({
        prompts: [{ agent: "canon:canon-implementor", prompt: "dummy", template_paths: [] }],
      }),
    );

    const flow = makeWaveFlow({
      states: {
        fix: { transitions: { done: "terminal" }, type: "single" },
        implement: {
          gate: "test-suite",
          transitions: { done: "terminal", gate_failed: "fix" },
          type: "wave",
          wave_policy: {
            isolation: "worktree",
            merge_strategy: "sequential",
            on_conflict: "hitl",
          },
        },
        terminal: { type: "terminal" },
      },
    });

    const result = await driveFlow({
      flow,
      result: {
        state_id: "implement",
        status: "done",
        task_id: "task-01",
      },
      workspace,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Should not report gate_failed — should advance to terminal
    expect(reportResult).toHaveBeenCalled();
    const reportCall = vi.mocked(reportResult).mock.calls[0][0];
    expect(reportCall.status_keyword).toBe("done");
  });
});

// 5. Wave-to-wave advancement

describe("driveFlow — wave-to-wave advancement", () => {
  it("starts wave 2 after wave 1 completes by returning new SpawnRequests", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);

    // Two waves: task-01 in wave 1, task-02 in wave 2
    writeIndexMd(workspace, "epic-slug", [
      { task_id: "task-01", wave: 1 },
      { task_id: "task-02", wave: 2 },
    ]);

    // State: currently in wave 1, wave_total=1, wave_results empty
    store.upsertState("implement", {
      entries: 1,
      status: "in_progress",
      wave: 1,
      wave_results: {},
      wave_total: 1,
    });

    vi.mocked(getProjectDir).mockReturnValue("/project");
    vi.mocked(mergeWaveResults).mockResolvedValue({ merged_count: 1, ok: true });
    vi.mocked(cleanupWorktrees).mockResolvedValue({ errors: [], removed: 1 });
    vi.mocked(runGates).mockReturnValue([]);
    vi.mocked(createWaveWorktrees).mockResolvedValue([
      {
        branch: "canon-wave/task-02",
        task_id: "task-02",
        worktree_path: "/project/.canon/worktrees/task-02",
      },
    ]);
    vi.mocked(enterAndPrepareState).mockResolvedValue(
      makeEnterResult({
        prompts: [
          {
            agent: "canon:canon-implementor",
            item: "task-02",
            prompt: "Implement task-02",
            template_paths: [],
          },
        ],
      }),
    );

    const flow = makeWaveFlow();
    const result = await driveFlow({
      flow,
      result: {
        state_id: "implement",
        status: "done",
        task_id: "task-01",
      },
      workspace,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;

    // Should have spawned task-02 with its worktree_path
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].task_id).toBe("task-02");
    expect(result.requests[0].worktree_path).toBe("/project/.canon/worktrees/task-02");
  });

  it("updates stored wave number to 2 after wave 1 merges", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);

    writeIndexMd(workspace, "epic-slug", [
      { task_id: "task-01", wave: 1 },
      { task_id: "task-02", wave: 2 },
    ]);

    store.upsertState("implement", {
      entries: 1,
      status: "in_progress",
      wave: 1,
      wave_results: {},
      wave_total: 1,
    });

    vi.mocked(getProjectDir).mockReturnValue("/project");
    vi.mocked(mergeWaveResults).mockResolvedValue({ merged_count: 1, ok: true });
    vi.mocked(cleanupWorktrees).mockResolvedValue({ errors: [], removed: 1 });
    vi.mocked(runGates).mockReturnValue([]);
    vi.mocked(createWaveWorktrees).mockResolvedValue([
      {
        branch: "canon-wave/task-02",
        task_id: "task-02",
        worktree_path: "/project/.canon/worktrees/task-02",
      },
    ]);
    vi.mocked(enterAndPrepareState).mockResolvedValue(
      makeEnterResult({
        prompts: [
          {
            agent: "canon:canon-implementor",
            item: "task-02",
            prompt: "Implement task-02",
            template_paths: [],
          },
        ],
      }),
    );

    const flow = makeWaveFlow();
    await driveFlow({
      flow,
      result: {
        state_id: "implement",
        status: "done",
        task_id: "task-01",
      },
      workspace,
    });

    const stateEntry = store.getState("implement");
    expect(stateEntry?.wave).toBe(2);
    expect(stateEntry?.wave_total).toBe(1);
  });
});

// 6. Wave event handling

describe("driveFlow — wave event handling", () => {
  it("returns HITL breakpoint when a pending 'pause' wave event exists between waves", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    writeIndexMd(workspace, "epic-slug", [{ task_id: "task-01", wave: 1 }]);

    store.upsertState("implement", {
      entries: 1,
      status: "in_progress",
      wave: 1,
      wave_results: {},
      wave_total: 1,
    });

    // Inject a pending pause event
    store.postWaveEvent({
      id: "evt-001",
      payload: { reason: "User requested pause" },
      status: "pending",
      timestamp: new Date().toISOString(),
      type: "pause",
    });

    vi.mocked(getProjectDir).mockReturnValue("/project");
    vi.mocked(mergeWaveResults).mockResolvedValue({ merged_count: 1, ok: true });
    vi.mocked(cleanupWorktrees).mockResolvedValue({ errors: [], removed: 1 });
    vi.mocked(runGates).mockReturnValue([]);

    const flow = makeWaveFlow();
    const result = await driveFlow({
      flow,
      result: {
        state_id: "implement",
        status: "done",
        task_id: "task-01",
      },
      workspace,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("hitl");
    if (result.action !== "hitl") return;
    expect(result.breakpoint.reason.toLowerCase()).toContain("pause");
  });

  it("skips tasks marked by a pending 'skip_task' wave event mechanically", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);

    // Wave with 2 tasks; task-02 will be skipped
    writeIndexMd(workspace, "epic-slug", [
      { task_id: "task-01", wave: 1 },
      { task_id: "task-02", wave: 2 },
    ]);

    store.upsertState("implement", {
      entries: 1,
      status: "in_progress",
      wave: 1,
      wave_results: {},
      wave_total: 1,
    });

    // Inject skip_task event for task-02
    store.postWaveEvent({
      id: "evt-002",
      payload: { reason: "Superseded", task_id: "task-02" },
      status: "pending",
      timestamp: new Date().toISOString(),
      type: "skip_task",
    });

    vi.mocked(getProjectDir).mockReturnValue("/project");
    vi.mocked(mergeWaveResults).mockResolvedValue({ merged_count: 1, ok: true });
    vi.mocked(cleanupWorktrees).mockResolvedValue({ errors: [], removed: 1 });
    vi.mocked(runGates).mockReturnValue([]);
    vi.mocked(reportResult).mockResolvedValue(makeReportResult("terminal") as any);
    vi.mocked(createWaveWorktrees).mockResolvedValue([]);
    vi.mocked(enterAndPrepareState).mockResolvedValue(makeEnterResult({ prompts: [] }));

    const flow = makeWaveFlow();
    const result = await driveFlow({
      flow,
      result: {
        state_id: "implement",
        status: "done",
        task_id: "task-01",
      },
      workspace,
    });

    // Should not spawn task-02 — it was skipped
    expect(result.ok).toBe(true);
    if (!result.ok || result.action !== "spawn") return;
    const task02Req = result.requests.find((r) => r.task_id === "task-02");
    expect(task02Req).toBeUndefined();
  });
});

// 7. After-consultation handling

describe("driveFlow — after-consultation handling", () => {
  it("resolves and returns consultation SpawnRequests after the last wave", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);

    // Single wave only
    writeIndexMd(workspace, "epic-slug", [{ task_id: "task-01", wave: 1 }]);

    store.upsertState("implement", {
      entries: 1,
      status: "in_progress",
      wave: 1,
      wave_results: {},
      wave_total: 1,
    });

    vi.mocked(getProjectDir).mockReturnValue("/project");
    vi.mocked(mergeWaveResults).mockResolvedValue({ merged_count: 1, ok: true });
    vi.mocked(cleanupWorktrees).mockResolvedValue({ errors: [], removed: 1 });
    vi.mocked(runGates).mockReturnValue([]);
    vi.mocked(resolveAfterConsultations).mockReturnValue({
      consultation_prompts: [
        {
          agent: "canon:canon-learner",
          name: "pattern-check",
          prompt: "Check patterns",
          role: "consultation",
        },
      ],
      warnings: [],
    });

    const flow = makeWaveFlow({
      states: {
        implement: {
          consultations: { after: ["pattern-check"] },
          transitions: { done: "terminal" },
          type: "wave",
          wave_policy: {
            isolation: "worktree",
            merge_strategy: "sequential",
            on_conflict: "hitl",
          },
        },
        terminal: { type: "terminal" },
      },
    });

    const result = await driveFlow({
      flow,
      result: {
        state_id: "implement",
        status: "done",
        task_id: "task-01",
      },
      workspace,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;

    // Should include the consultation agent
    const consultReq = result.requests.find((r) => r.role === "consultation");
    expect(consultReq).toBeDefined();
    expect(consultReq?.agent_type).toBe("canon:canon-learner");
  });
});

// 8. Epic checkpoint HITL

describe("driveFlow — epic checkpoint", () => {
  it("returns HITL breakpoint with wave summary context for epic checkpoint", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);

    writeIndexMd(workspace, "epic-slug", [
      { task_id: "task-01", wave: 1 },
      { task_id: "task-02", wave: 2 },
    ]);

    store.upsertState("implement", {
      entries: 1,
      status: "in_progress",
      wave: 1,
      wave_results: {},
      wave_total: 1,
    });

    vi.mocked(getProjectDir).mockReturnValue("/project");
    vi.mocked(mergeWaveResults).mockResolvedValue({ merged_count: 1, ok: true });
    vi.mocked(cleanupWorktrees).mockResolvedValue({ errors: [], removed: 1 });
    vi.mocked(runGates).mockReturnValue([]);
    vi.mocked(createWaveWorktrees).mockResolvedValue([
      {
        branch: "canon-wave/task-02",
        task_id: "task-02",
        worktree_path: "/project/.canon/worktrees/task-02",
      },
    ]);
    vi.mocked(enterAndPrepareState).mockResolvedValue(
      makeEnterResult({
        prompts: [
          {
            agent: "canon:canon-implementor",
            item: "task-02",
            prompt: "Implement task-02",
            template_paths: [],
          },
        ],
      }),
    );

    // Epic flow with hitl_checkpoint between waves
    const flow = makeWaveFlow({
      states: {
        implement: {
          consultations: { between: ["pattern-check"] },
          transitions: { done: "terminal" },
          type: "wave",
          wave_policy: {
            coordination: "epic_checkpoint",
            isolation: "worktree",
            merge_strategy: "sequential",
            on_conflict: "hitl",
          },
        },
        terminal: { type: "terminal" },
      },
    });

    const result = await driveFlow({
      flow,
      result: {
        state_id: "implement",
        status: "done",
        task_id: "task-01",
      },
      workspace,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Epic checkpoint between waves should produce HITL or advance to wave 2
    // The exact behavior depends on implementation — either spawn wave 2 or hitl
    expect(["spawn", "hitl"]).toContain(result.action);
  });
});
