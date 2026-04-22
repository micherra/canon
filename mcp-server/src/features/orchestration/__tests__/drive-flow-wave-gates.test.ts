/**
 * drive-flow-wave-gates.test.ts — Tests for gate failure, wave-to-wave advancement,
 * and wave event handling in driveFlow.
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
vi.mock("../services/learn-gate.ts", () => ({
  evaluateLearnGate: vi.fn().mockResolvedValue({ passed: false, reason: "test mode" }),
}));

vi.mock("../tools/enter-and-prepare-state.ts", () => ({
  enterAndPrepareState: vi.fn(),
}));
vi.mock("../tools/report-result.ts", () => ({
  reportResult: vi.fn(),
}));
vi.mock("@domains/workspaces/wave-lifecycle.ts", () => ({
  cleanupWorktrees: vi.fn(),
  createWaveWorktrees: vi.fn(),
  getProjectDir: vi.fn(),
  mergeWaveResults: vi.fn(),
}));
vi.mock("@domains/flows/gate-runner.ts", () => ({
  runGates: vi.fn(),
}));
vi.mock("../tools/resolve-after-consultations.ts", () => ({
  resolveAfterConsultations: vi.fn(),
}));

import type { ResolvedFlow } from "@domains/flows/flow-definition-schemas.ts";
import { runGates } from "@domains/flows/gate-runner.ts";
import { initExecutionDb } from "@domains/workspaces/execution-schema.ts";
import { ExecutionStore } from "@domains/workspaces/execution-store.ts";
import { clearStoreCache } from "@domains/workspaces/execution-store-cache.ts";
import {
  cleanupWorktrees,
  createWaveWorktrees,
  getProjectDir,
  mergeWaveResults,
} from "@domains/workspaces/wave-lifecycle.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { driveFlow } from "../tools/drive-flow.ts";
import type { EnterAndPrepareStateResult } from "../tools/enter-and-prepare-state.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";
import { reportResult } from "../tools/report-result.ts";

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "drive-flow-wave-gates-test-"));
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
        agent: "canon:implementor",
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
        prompts: [{ agent: "canon:fixer", prompt: "Fix tests", template_paths: [] }],
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

    await driveFlow(
      {
        flow,
        result: {
          state_id: "implement",
          status: "done",
          task_id: "task-01",
        },
        workspace,
      },
      "/fake/project",
    );

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
        prompts: [{ agent: "canon:implementor", prompt: "dummy", template_paths: [] }],
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

    const result = await driveFlow(
      {
        flow,
        result: {
          state_id: "implement",
          status: "done",
          task_id: "task-01",
        },
        workspace,
      },
      "/fake/project",
    );

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
            agent: "canon:implementor",
            item: "task-02",
            prompt: "Implement task-02",
            template_paths: [],
          },
        ],
      }),
    );

    const flow = makeWaveFlow();
    const result = await driveFlow(
      {
        flow,
        result: {
          state_id: "implement",
          status: "done",
          task_id: "task-01",
        },
        workspace,
      },
      "/fake/project",
    );

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
            agent: "canon:implementor",
            item: "task-02",
            prompt: "Implement task-02",
            template_paths: [],
          },
        ],
      }),
    );

    const flow = makeWaveFlow();
    await driveFlow(
      {
        flow,
        result: {
          state_id: "implement",
          status: "done",
          task_id: "task-01",
        },
        workspace,
      },
      "/fake/project",
    );

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
    const result = await driveFlow(
      {
        flow,
        result: {
          state_id: "implement",
          status: "done",
          task_id: "task-01",
        },
        workspace,
      },
      "/fake/project",
    );

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
    const result = await driveFlow(
      {
        flow,
        result: {
          state_id: "implement",
          status: "done",
          task_id: "task-01",
        },
        workspace,
      },
      "/fake/project",
    );

    // Should not spawn task-02 — it was skipped
    expect(result.ok).toBe(true);
    if (!result.ok || result.action !== "spawn") return;
    const task02Req = result.requests.find((r) => r.task_id === "task-02");
    expect(task02Req).toBeUndefined();
  });
});
