/**
 * drive-flow-artifacts.test.ts — Unit tests for driveFlow state_artifacts and consultation prompts.
 * See drive-flow.test.ts for first call, result, HITL, skip-state, and terminal state tests.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  getProjectDir: vi.fn().mockReturnValue("/fake/project"),
  mergeWaveResults: vi.fn(),
}));

import type { ResolvedFlow } from "@domains/flows/flow-definition-schemas.ts";
import { initExecutionDb } from "@domains/workspaces/execution-schema.ts";
import { ExecutionStore } from "@domains/workspaces/execution-store.ts";
import { clearStoreCache } from "@domains/workspaces/execution-store-cache.ts";
import { createWaveWorktrees } from "@domains/workspaces/wave-lifecycle.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { beforeEach } from "vitest";
import { driveFlow } from "../tools/drive-flow.ts";
import type { EnterAndPrepareStateResult } from "../tools/enter-and-prepare-state.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "drive-flow-artifacts-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeStore(workspace: string): ExecutionStore {
  const db = initExecutionDb(join(workspace, "orchestration.db"));
  const store = new ExecutionStore(db);
  store.initExecution({
    base_commit: "abc123",
    branch: "feat/test",
    created: new Date().toISOString(),
    current_state: "research",
    entry: "research",
    flow: "test-flow",
    flow_name: "test-flow",
    last_updated: new Date().toISOString(),
    sanitized: "feat-test",
    slug: "test-slug",
    started: new Date().toISOString(),
    task: "build feature",
    tier: "medium",
  });
  return store;
}

function makeFlow(overrides: Partial<ResolvedFlow> = {}): ResolvedFlow {
  return {
    description: "test",
    entry: "research",
    name: "test-flow",
    spawn_instructions: {
      implement: "Do implement",
      research: "Do research",
    },
    states: {
      implement: {
        agent: "canon:implementor",
        transitions: { done: "terminal" },
        type: "single",
      },
      research: {
        agent: "canon:researcher",
        transitions: { done: "implement" },
        type: "single",
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
    max_iterations: 3,
    ok: true,
    prompts: [
      {
        agent: "canon:researcher",
        prompt: "Do research task",
        role: "main",
        template_paths: [],
      },
    ],
    state_type: "single",
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(createWaveWorktrees).mockResolvedValue([
    {
      branch: "canon-wave/test-slug-implement",
      task_id: "test-slug-implement",
      worktree_path: "/fake/project/.canon/worktrees/test-slug-implement",
    },
  ]);
});

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
  vi.resetAllMocks();
});

// state_artifacts in done action

describe("driveFlow — state_artifacts in done", () => {
  it("includes state_artifacts map with artifact paths from board states", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    store.upsertState("research", {
      artifacts: ["research/findings.md"],
      entries: 1,
      status: "done",
    });
    store.upsertState("implement", {
      artifacts: ["plans/task-01/SUMMARY.md", "plans/task-02/SUMMARY.md"],
      entries: 1,
      status: "done",
    });
    store.updateExecution({ current_state: "terminal" });

    const flow = makeFlow();
    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("done");
    if (result.action !== "done") return;
    expect(result.state_artifacts).toBeDefined();
    expect(result.state_artifacts?.research).toEqual(["research/findings.md"]);
    expect(result.state_artifacts?.implement).toEqual([
      "plans/task-01/SUMMARY.md",
      "plans/task-02/SUMMARY.md",
    ]);
  });

  it("omits states with no artifacts from state_artifacts map", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    store.upsertState("research", {
      artifacts: ["research/findings.md"],
      entries: 1,
      status: "done",
    });
    store.upsertState("implement", {
      entries: 1,
      status: "done",
    });
    store.updateExecution({ current_state: "terminal" });

    const flow = makeFlow();
    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("done");
    if (result.action !== "done") return;
    expect(result.state_artifacts).toBeDefined();
    expect(result.state_artifacts?.research).toEqual(["research/findings.md"]);
    expect(result.state_artifacts?.implement).toBeUndefined();
  });

  it("omits state_artifacts when no states have artifacts (field absent signals no artifacts)", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    store.updateExecution({ current_state: "terminal" });

    const flow = makeFlow();
    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("done");
    if (result.action !== "done") return;
    expect(result.state_artifacts).toBeUndefined();
  });
});

// Consultation prompts

describe("driveFlow — consultation prompts", () => {
  it("includes consultation prompts in SpawnRequest array with role consultation", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        consultation_prompts: [
          {
            agent: "canon:security",
            name: "security-check",
            prompt: "Check security",
            role: "consultation",
          },
        ],
        prompts: [
          {
            agent: "canon:researcher",
            prompt: "Research task",
            role: "main",
            template_paths: [],
          },
        ],
      }),
    );

    const flow = makeFlow();
    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    expect(result.requests).toHaveLength(2);
    const consultationReq = result.requests.find((r) => r.role === "consultation");
    expect(consultationReq).toBeDefined();
    expect(consultationReq?.agent_type).toBe("canon:security");
    expect(consultationReq?.prompt).toBe("Check security");
  });
});
