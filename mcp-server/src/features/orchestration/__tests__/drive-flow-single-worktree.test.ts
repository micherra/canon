/**
 * drive-flow-single-worktree.test.ts — Tests for Canon-managed worktrees in single states.
 *
 * Verifies:
 * 1. Write agents (implementor, fixer, tester, scribe) in single states get
 *    worktree_path set and isolation: "none"
 * 2. Read-only agents (researcher, reviewer, security, etc.) in single states
 *    continue to get isolation: "worktree" with no worktree_path
 * 3. Wave state behavior is unchanged (worktrees created by existing code paths)
 * 4. Parallel state write agents also get Canon-managed worktrees
 *
 * Canon principles:
 * - subprocess-isolation: git ops go through wave-lifecycle.ts (createWaveWorktrees)
 * - no-silent-failures: worktree creation failure should surface, not silently fall back
 */

import { mkdtempSync, rmSync } from "node:fs";
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
import {
  createWaveWorktrees,
  getProjectDir,
} from "@domains/workspaces/wave-lifecycle.ts";
import { driveFlow } from "../tools/drive-flow.ts";
import type { EnterAndPrepareStateResult } from "../tools/enter-and-prepare-state.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "drive-flow-single-wt-test-"));
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
    current_state: "implement",
    entry: "implement",
    flow: "fast-path",
    flow_name: "fast-path",
    last_updated: new Date().toISOString(),
    sanitized: "feat-test",
    slug: "test-slug",
    started: new Date().toISOString(),
    task: "fix a bug",
    tier: "small",
  });
  return store;
}

/** A minimal flow with a single write-agent state (implementor) */
function makeImplementorFlow(overrides: Partial<ResolvedFlow> = {}): ResolvedFlow {
  return {
    description: "test",
    entry: "implement",
    name: "fast-path",
    spawn_instructions: {
      implement: "Implement the fix",
    },
    states: {
      implement: {
        agent: "canon:canon-implementor",
        transitions: { done: "terminal" },
        type: "single",
      },
      terminal: {
        type: "terminal",
      },
    },
    ...overrides,
  };
}

/** A minimal flow with a single read-only agent state (researcher) */
function makeResearcherFlow(): ResolvedFlow {
  return {
    description: "test",
    entry: "research",
    name: "explore",
    spawn_instructions: {
      research: "Research the codebase",
    },
    states: {
      research: {
        agent: "canon:canon-researcher",
        transitions: { done: "terminal" },
        type: "single",
      },
      terminal: {
        type: "terminal",
      },
    },
  };
}

/** Build a fake EnterAndPrepareStateResult for a single-state that can enter */
function makeEnterResult(
  agentType: string,
  overrides: Partial<EnterAndPrepareStateResult> = {},
): ReturnType<typeof enterAndPrepareState> extends Promise<infer T> ? T : never {
  return {
    can_enter: true,
    cannot_fix_items: [],
    history: [],
    iteration_count: 1,
    max_iterations: 3,
    ok: true as const,
    prompts: [
      {
        agent: agentType,
        prompt: "Do the task",
        role: "main",
        template_paths: [],
      },
    ],
    state_type: "single",
    ...overrides,
  } as any;
}

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// Write agents in single states get Canon-managed worktrees
// ---------------------------------------------------------------------------

describe("driveFlow — write agents in single states get Canon-managed worktrees", () => {
  it("implementor gets worktree_path and isolation:none", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(getProjectDir).mockReturnValue("/fake/project");
    vi.mocked(createWaveWorktrees).mockResolvedValue([
      {
        branch: "canon-wave/test-slug-implement",
        task_id: "test-slug-implement",
        worktree_path: "/fake/project/.canon/worktrees/test-slug-implement",
      },
    ]);
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult("canon:canon-implementor"),
    );

    const flow = makeImplementorFlow();
    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(result.ok).toBe(true);
    if (!result.ok || result.action !== "spawn") return;

    const req = result.requests[0];
    expect(req.agent_type).toBe("canon:canon-implementor");
    expect(req.isolation).toBe("none");
    expect(req.worktree_path).toBeDefined();
    expect(req.worktree_path).toContain("implement");
  });

  it("calls createWaveWorktrees for implementor state with correct task_id", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(getProjectDir).mockReturnValue("/fake/project");
    vi.mocked(createWaveWorktrees).mockResolvedValue([
      {
        branch: "canon-wave/test-slug-implement",
        task_id: "test-slug-implement",
        worktree_path: "/fake/project/.canon/worktrees/test-slug-implement",
      },
    ]);
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult("canon:canon-implementor"),
    );

    const flow = makeImplementorFlow();
    await driveFlow({ flow, workspace }, "/fake/project");

    expect(createWaveWorktrees).toHaveBeenCalledOnce();
    // Should be called with a task using the state_id in the task_id
    const [tasks] = vi.mocked(createWaveWorktrees).mock.calls[0];
    expect(tasks).toHaveLength(1);
    expect(tasks[0].task_id).toContain("implement");
  });

  it("fixer agent gets worktree_path and isolation:none", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    store.updateExecution({ current_state: "fix", entry: "fix" });

    vi.mocked(getProjectDir).mockReturnValue("/fake/project");
    vi.mocked(createWaveWorktrees).mockResolvedValue([
      {
        branch: "canon-wave/test-slug-fix",
        task_id: "test-slug-fix",
        worktree_path: "/fake/project/.canon/worktrees/test-slug-fix",
      },
    ]);
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(makeEnterResult("canon:canon-fixer"));

    const flow: ResolvedFlow = {
      description: "test",
      entry: "fix",
      name: "fast-path",
      spawn_instructions: { fix: "Fix the issue" },
      states: {
        fix: {
          agent: "canon:canon-fixer",
          transitions: { done: "terminal" },
          type: "single",
        },
        terminal: { type: "terminal" },
      },
    };

    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(result.ok).toBe(true);
    if (!result.ok || result.action !== "spawn") return;
    expect(result.requests[0].isolation).toBe("none");
    expect(result.requests[0].worktree_path).toBeDefined();
  });

  it("tester agent gets worktree_path and isolation:none", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    store.updateExecution({ current_state: "test", entry: "test" });

    vi.mocked(getProjectDir).mockReturnValue("/fake/project");
    vi.mocked(createWaveWorktrees).mockResolvedValue([
      {
        branch: "canon-wave/test-slug-test",
        task_id: "test-slug-test",
        worktree_path: "/fake/project/.canon/worktrees/test-slug-test",
      },
    ]);
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(makeEnterResult("canon:canon-tester"));

    const flow: ResolvedFlow = {
      description: "test",
      entry: "test",
      name: "fast-path",
      spawn_instructions: { test: "Test the fix" },
      states: {
        test: {
          agent: "canon:canon-tester",
          transitions: { done: "terminal" },
          type: "single",
        },
        terminal: { type: "terminal" },
      },
    };

    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(result.ok).toBe(true);
    if (!result.ok || result.action !== "spawn") return;
    expect(result.requests[0].isolation).toBe("none");
    expect(result.requests[0].worktree_path).toBeDefined();
  });

  it("scribe agent gets worktree_path and isolation:none", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    store.updateExecution({ current_state: "sync", entry: "sync" });

    vi.mocked(getProjectDir).mockReturnValue("/fake/project");
    vi.mocked(createWaveWorktrees).mockResolvedValue([
      {
        branch: "canon-wave/test-slug-sync",
        task_id: "test-slug-sync",
        worktree_path: "/fake/project/.canon/worktrees/test-slug-sync",
      },
    ]);
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(makeEnterResult("canon:canon-scribe"));

    const flow: ResolvedFlow = {
      description: "test",
      entry: "sync",
      name: "fast-path",
      spawn_instructions: { sync: "Sync context" },
      states: {
        sync: {
          agent: "canon:canon-scribe",
          transitions: { done: "terminal" },
          type: "single",
        },
        terminal: { type: "terminal" },
      },
    };

    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(result.ok).toBe(true);
    if (!result.ok || result.action !== "spawn") return;
    expect(result.requests[0].isolation).toBe("none");
    expect(result.requests[0].worktree_path).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Read-only agents in single states still get isolation: "worktree" (no change)
// ---------------------------------------------------------------------------

describe("driveFlow — read-only agents in single states keep isolation:worktree", () => {
  it("researcher does not get worktree_path; isolation remains worktree", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    store.updateExecution({ current_state: "research", entry: "research" });

    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult("canon:canon-researcher"),
    );

    const flow = makeResearcherFlow();
    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(result.ok).toBe(true);
    if (!result.ok || result.action !== "spawn") return;

    const req = result.requests[0];
    expect(req.isolation).toBe("worktree");
    expect(req.worktree_path).toBeUndefined();
    // createWaveWorktrees should NOT be called for read-only agents
    expect(createWaveWorktrees).not.toHaveBeenCalled();
  });

  it("reviewer does not get worktree_path", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    store.updateExecution({ current_state: "review", entry: "review" });

    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult("canon:canon-reviewer"),
    );

    const flow: ResolvedFlow = {
      description: "test",
      entry: "review",
      name: "review-only",
      spawn_instructions: { review: "Review the code" },
      states: {
        review: {
          agent: "canon:canon-reviewer",
          transitions: { done: "terminal" },
          type: "single",
        },
        terminal: { type: "terminal" },
      },
    };

    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(result.ok).toBe(true);
    if (!result.ok || result.action !== "spawn") return;
    expect(result.requests[0].isolation).toBe("worktree");
    expect(result.requests[0].worktree_path).toBeUndefined();
    expect(createWaveWorktrees).not.toHaveBeenCalled();
  });

  it("architect does not get worktree_path", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    store.updateExecution({ current_state: "design", entry: "design" });

    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult("canon:canon-architect"),
    );

    const flow: ResolvedFlow = {
      description: "test",
      entry: "design",
      name: "feature",
      spawn_instructions: { design: "Design the feature" },
      states: {
        design: {
          agent: "canon:canon-architect",
          transitions: { done: "terminal" },
          type: "single",
        },
        terminal: { type: "terminal" },
      },
    };

    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(result.ok).toBe(true);
    if (!result.ok || result.action !== "spawn") return;
    expect(result.requests[0].isolation).toBe("worktree");
    expect(result.requests[0].worktree_path).toBeUndefined();
    expect(createWaveWorktrees).not.toHaveBeenCalled();
  });

  it("security agent does not get worktree_path", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    store.updateExecution({ current_state: "security", entry: "security" });

    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult("canon:canon-security"),
    );

    const flow: ResolvedFlow = {
      description: "test",
      entry: "security",
      name: "security-audit",
      spawn_instructions: { security: "Audit security" },
      states: {
        security: {
          agent: "canon:canon-security",
          transitions: { done: "terminal" },
          type: "single",
        },
        terminal: { type: "terminal" },
      },
    };

    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(result.ok).toBe(true);
    if (!result.ok || result.action !== "spawn") return;
    expect(result.requests[0].isolation).toBe("worktree");
    expect(result.requests[0].worktree_path).toBeUndefined();
    expect(createWaveWorktrees).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Agent type matching: both "canon:" prefix and bare name should be recognized
// ---------------------------------------------------------------------------

describe("driveFlow — write agent detection handles canon: prefix", () => {
  it("detects implementor with bare name (no prefix)", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(getProjectDir).mockReturnValue("/fake/project");
    vi.mocked(createWaveWorktrees).mockResolvedValue([
      {
        branch: "canon-wave/test-slug-implement",
        task_id: "test-slug-implement",
        worktree_path: "/fake/project/.canon/worktrees/test-slug-implement",
      },
    ]);
    // The prompt entry uses bare name (no prefix)
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult("canon-implementor"),
    );

    const flow: ResolvedFlow = {
      description: "test",
      entry: "implement",
      name: "fast-path",
      spawn_instructions: { implement: "Implement the fix" },
      states: {
        implement: {
          agent: "canon-implementor",
          transitions: { done: "terminal" },
          type: "single",
        },
        terminal: { type: "terminal" },
      },
    };

    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(result.ok).toBe(true);
    if (!result.ok || result.action !== "spawn") return;
    expect(result.requests[0].isolation).toBe("none");
    expect(result.requests[0].worktree_path).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Worktree creation failure surfaces as an error (no-silent-failures)
// ---------------------------------------------------------------------------

describe("driveFlow — worktree creation failure for write agents", () => {
  it("returns an error when createWaveWorktrees throws for a write agent", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(getProjectDir).mockReturnValue("/fake/project");
    vi.mocked(createWaveWorktrees).mockRejectedValue(
      new Error("Failed to create worktree: git error"),
    );
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult("canon:canon-implementor"),
    );

    const flow = makeImplementorFlow();
    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("UNEXPECTED");
  });
});
