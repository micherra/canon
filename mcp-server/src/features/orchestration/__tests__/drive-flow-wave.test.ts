/**
 * drive-flow-wave.test.ts — Tests for wave entry in driveFlow.
 *
 * Covers:
 * - Wave entry creates worktrees and returns SpawnRequests with worktree_path
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
import { initExecutionDb } from "@domains/workspaces/execution-schema.ts";
import { clearStoreCache, ExecutionStore } from "@domains/workspaces/execution-store.ts";
import { createWaveWorktrees, getProjectDir } from "@domains/workspaces/wave-lifecycle.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { driveFlow } from "../tools/drive-flow.ts";
import type { EnterAndPrepareStateResult } from "../tools/enter-and-prepare-state.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";

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
            agent: "canon:implementor",
            item: "task-01",
            prompt: "Implement task-01",
            role: "implementor",
            template_paths: [],
          },
          {
            agent: "canon:implementor",
            item: "task-02",
            prompt: "Implement task-02",
            role: "implementor",
            template_paths: [],
          },
        ],
      }),
    );

    const flow = makeWaveFlow();
    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;

    // Both tasks should have worktree_path populated and isolation: "none"
    expect(result.requests).toHaveLength(2);
    const task01Req = result.requests.find((r) => r.task_id === "task-01");
    const task02Req = result.requests.find((r) => r.task_id === "task-02");
    expect(task01Req?.worktree_path).toBe("/project/.canon/worktrees/task-01");
    expect(task02Req?.worktree_path).toBe("/project/.canon/worktrees/task-02");
    // worktree_path presence → isolation: "none" (Canon owns the worktree; no Agent tool worktree)
    expect(task01Req?.isolation).toBe("none");
    expect(task02Req?.isolation).toBe("none");
    expect(createWaveWorktrees).toHaveBeenCalledWith(
      [{ task_id: "task-01" }, { task_id: "task-02" }],
      "/project",
      "/project",
    );
  });

  it("creates wave worktrees from the session worktree HEAD when available", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    store.updateExecution({ worktree_path: "/project/.canon/worktrees/session-branch" });
    writeIndexMd(workspace, "epic-slug", [{ task_id: "task-01", wave: 1 }]);

    vi.mocked(getProjectDir).mockReturnValue("/project");
    vi.mocked(createWaveWorktrees).mockResolvedValue([
      {
        branch: "canon-wave/task-01",
        task_id: "task-01",
        worktree_path: "/project/.canon/worktrees/task-01",
      },
    ]);
    vi.mocked(enterAndPrepareState).mockResolvedValue(makeEnterResult());

    const flow = makeWaveFlow();
    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(result.ok).toBe(true);
    expect(createWaveWorktrees).toHaveBeenCalledWith(
      [{ task_id: "task-01" }],
      "/project",
      "/project/.canon/worktrees/session-branch",
    );
  });

  it("respawns only unfinished tasks, reuses existing worktree, and injects resume context", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    writeIndexMd(workspace, "epic-slug", [
      { task_id: "task-01", wave: 1 },
      { task_id: "task-02", wave: 1 },
    ]);
    const waveResults: Record<string, { status: string; tasks: string[] }> = {
      "task-01": { status: "done", tasks: ["task-01"] },
      "task-02": { status: "blocked", tasks: ["task-02"] },
    };
    Object.assign(waveResults["task-01"], { worktree_path: "/project/.canon/worktrees/task-01" });
    Object.assign(waveResults["task-02"], { worktree_path: "/project/.canon/worktrees/task-02" });

    store.upsertState("implement", {
      entries: 1,
      status: "in_progress",
      wave: 1,
      wave_results: waveResults,
      wave_total: 2,
    });

    vi.mocked(getProjectDir).mockReturnValue("/project");
    vi.mocked(createWaveWorktrees).mockResolvedValue([]);
    vi.mocked(enterAndPrepareState).mockResolvedValue(
      makeEnterResult({
        prompts: [
          {
            agent: "canon:implementor",
            item: "task-02",
            prompt: "Implement task-02",
            role: "implementor",
            template_paths: [],
          },
        ],
      }),
    );

    const flow = makeWaveFlow();
    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].task_id).toBe("task-02");
    expect(result.requests[0].worktree_path).toBe("/project/.canon/worktrees/task-02");
    expect(result.requests[0].prompt).toContain("## Resume Context");
    expect(createWaveWorktrees).not.toHaveBeenCalled();
    expect(enterAndPrepareState).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [{ task_id: "task-02" }],
        peer_count: 1,
      }),
    );
  });

  it("treats skipped tasks as non-respawnable", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    writeIndexMd(workspace, "epic-slug", [
      { task_id: "task-01", wave: 1 },
      { task_id: "task-02", wave: 1 },
    ]);
    const waveResults: Record<string, { status: string; tasks: string[] }> = {
      "task-01": { status: "skipped", tasks: ["task-01"] },
    };
    Object.assign(waveResults["task-01"], { worktree_path: "/project/.canon/worktrees/task-01" });

    store.upsertState("implement", {
      entries: 1,
      status: "in_progress",
      wave: 1,
      wave_results: waveResults,
      wave_total: 2,
    });

    vi.mocked(getProjectDir).mockReturnValue("/project");
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
            role: "implementor",
            template_paths: [],
          },
        ],
      }),
    );

    const flow = makeWaveFlow();
    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].task_id).toBe("task-02");
    expect(result.requests[0].prompt).not.toContain("## Resume Context");
    expect(createWaveWorktrees).toHaveBeenCalledWith(
      [{ task_id: "task-02" }],
      "/project",
      "/project",
    );
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
            agent: "canon:implementor",
            item: "task-01",
            prompt: "Impl task-01",
            template_paths: [],
          },
          {
            agent: "canon:implementor",
            item: "task-02",
            prompt: "Impl task-02",
            template_paths: [],
          },
        ],
      }),
    );

    const flow = makeWaveFlow();
    await driveFlow({ flow, workspace }, "/fake/project");

    const stateEntry = store.getState("implement");
    expect(stateEntry).not.toBeNull();
    expect(stateEntry?.wave).toBe(1);
    expect(stateEntry?.wave_total).toBe(2);
  });
});
