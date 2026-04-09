/**
 * drive-flow-wave-advance.test.ts — Tests for worktree_branch tracking and
 * merge cwd bug fixes in driveFlow.
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
  const dir = mkdtempSync(join(tmpdir(), "drive-flow-wave-advance-test-"));
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

// 9. Bug fixes: worktree_branch tracking and merge cwd

describe("driveFlow — worktree_branch tracking (Bug 1+2 fix)", () => {
  it("persistWaveTaskResult uses convention branch (worktree_branch ignored)", async () => {
    // Canon creates wave worktrees on convention branches (canon-wave/{task_id}).
    // The convention branch is the authoritative merge target — agents commit to it.
    // worktree_branch is ignored; only conventionBranch is stored.
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
          worktree_branch: "worktree-agent-a4915c84", // ignored — convention branch wins
        },
        workspace,
      },
      "/fake/project",
    );

    const stateEntry = store.getState("implement");
    const waveResults = stateEntry?.wave_results as Record<string, { branch?: string }> | undefined;
    // Always convention branch — agents work in Canon's worktrees on convention branches
    expect(waveResults?.["task-01"]?.branch).toBe("canon-wave/task-01");
  });

  it("convention branch is used even when worktree_branch is not provided", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    writeIndexMd(workspace, "epic-slug", [{ task_id: "task-02", wave: 1 }]);

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
          task_id: "task-02",
          // no worktree_branch provided
        },
        workspace,
      },
      "/fake/project",
    );

    const stateEntry = store.getState("implement");
    const waveResults = stateEntry?.wave_results as Record<string, { branch?: string }> | undefined;
    // Convention branch is always used
    expect(waveResults?.["task-02"]?.branch).toBe("canon-wave/task-02");
  });
});

describe("driveFlow — merge cwd uses build-branch worktree (Bug 3 fix)", () => {
  it("passes build worktree_path as cwd to mergeWaveResults when execution has worktree_path", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    writeIndexMd(workspace, "epic-slug", [{ task_id: "task-01", wave: 1 }]);

    // Set execution worktree_path to simulate a build-branch worktree
    store.updateExecution({ worktree_path: "/project/.canon/worktrees/epic-slug" });

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

    // mergeWaveResults should be called with the build worktree path, not projectDir
    expect(mergeWaveResults).toHaveBeenCalledWith(
      expect.any(Array),
      "/project/.canon/worktrees/epic-slug",
      "sequential",
    );
  });

  it("falls back to projectDir as merge cwd when execution has no worktree_path", async () => {
    const workspace = makeTmpWorkspace();
    const storeInstance = makeStore(workspace);
    writeIndexMd(workspace, "epic-slug", [{ task_id: "task-01", wave: 1 }]);

    // No worktree_path set on execution (non-worktree build)
    storeInstance.upsertState("implement", {
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

    // mergeWaveResults should fall back to projectDir
    expect(mergeWaveResults).toHaveBeenCalledWith(expect.any(Array), "/project", "sequential");
  });
});
