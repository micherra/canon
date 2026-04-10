/**
 * drive-flow-wave-accumulation.test.ts — Tests for wave result accumulation
 * and merge conflict handling in driveFlow.
 *
 * Covers:
 * - Wave task result accumulation: partial results wait, all results trigger merge
 * - Merge conflict returns HITL breakpoint when on_conflict is "hitl"
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
import { clearStoreCache, ExecutionStore } from "@domains/workspaces/execution-store.ts";
import {
  cleanupWorktrees,
  getProjectDir,
  mergeWaveResults,
} from "@domains/workspaces/wave-lifecycle.ts";
import { driveFlow } from "../tools/drive-flow.ts";
import { reportResult } from "../tools/report-result.ts";

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "drive-flow-wave-acc-test-"));
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
      terminal: { type: "terminal" },
    },
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
    const result = await driveFlow(
      {
        flow,
        result: {
          state_id: "implement",
          status: "done",
          task_id: "task-02",
        },
        workspace,
      },
      "/fake/project",
    );

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
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].task_id).toBe("task-01");
    // persistWaveTaskResult always stores convention worktree_path → isolation: "none"
    expect(result.requests[0].isolation).toBe("none");
  });

  it("conflict retry uses isolation: 'none' when worktree_path is present in wave_results", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    writeIndexMd(workspace, "epic-slug", [{ task_id: "task-01", wave: 1 }]);

    store.upsertState("implement", {
      entries: 1,
      status: "in_progress",
      wave: 1,
      wave_results: {
        "task-01": {
          status: "done",
          tasks: ["task-01"],
          worktree_entries: [
            {
              branch: "canon-wave/task-01",
              status: "merged",
              task_id: "task-01",
              worktree_path: "/project/.canon/worktrees/task-01",
            },
          ],
        },
      },
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
    expect(result.requests).toHaveLength(1);
    // worktree_path present in wave_results → isolation: "none"
    expect(result.requests[0].isolation).toBe("none");
    expect(result.requests[0].worktree_path).toBe("/project/.canon/worktrees/task-01");
  });
});
