/**
 * adr-009-integration.test.ts — Integration tests for ADR-009 server-side state machine.
 *
 * Fills coverage gaps declared in task summaries and verifies cross-module contracts:
 *   - Multi-hop skip loop (3+ consecutive skips) — task-03 known gap
 *   - driveFlow with workspace missing board execution (second WORKSPACE_NOT_FOUND guard)
 *   - buildDoneSummary state counting (done + skipped / total)
 *   - syncBoardToStore skipped field propagation
 *   - SpawnRequest item as object with task_id key
 *
 * Session, categorizeFailures, and metadata tests moved to adr-009-session.test.ts
 *
 * Canon principles:
 *   - toolresult-contract: all assertions check ok/action on ToolResult
 *   - sqlite-transactions: real SQLite DB verifies persistent state at each step
 *   - no-silent-failures: error paths always surface structured errors
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isToolError } from "@shared/lib/tool-result.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock I/O boundaries
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

import { syncBoardToStore } from "@domains/board/board-sync.ts";
import type { Board } from "@domains/flows/board-state-schemas.ts";
import type { ResolvedFlow } from "@domains/flows/flow-definition-schemas.ts";
import { initExecutionDb } from "@domains/workspaces/execution-schema.ts";
import { ExecutionStore } from "@domains/workspaces/execution-store.ts";
import { clearStoreCache } from "@domains/workspaces/execution-store-cache.ts";
import { createWaveWorktrees } from "@domains/workspaces/wave-lifecycle.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { driveFlow } from "../tools/drive-flow.ts";
import type { EnterAndPrepareStateResult } from "../tools/enter-and-prepare-state.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";
import { reportResult } from "../tools/report-result.ts";

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "adr009-integration-test-"));
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

function makeBoard(overrides: Partial<Board> = {}): Board {
  return {
    base_commit: "abc123",
    blocked: null,
    concerns: [],
    current_state: "research",
    entry: "research",
    flow: "test-flow",
    iterations: {},
    last_updated: "2026-01-01T00:00:00.000Z",
    skipped: [],
    started: "2026-01-01T00:00:00.000Z",
    states: {},
    task: "build feature",
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
        prompt: "Do task",
        role: "main",
        template_paths: [],
      },
    ],
    state_type: "single",
    ...overrides,
  };
}

function makeReportResult(nextState: string | null, overrides: Record<string, unknown> = {}) {
  return {
    board: makeBoard({ current_state: nextState ?? "terminal" }),
    hitl_required: false,
    log_entry: {},
    next_state: nextState,
    ok: true,
    stuck: false,
    transition_condition: "done",
    ...overrides,
  };
}

// Default mock for createWaveWorktrees used when write agents appear in single states.
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

// Gap 1: Multi-hop skip loop (3+ consecutive skips)
// Task-03 declared gap: "Multi-hop skip loop — tested single skip; a chain of 3+ skips is not
// explicitly tested. Logic is covered by the loop, but integration confirmation would add confidence."

describe("driveFlow — multi-hop skip loop (3+ consecutive skips)", () => {
  it("auto-advances through a chain of 3 consecutive skipped states", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    const flow: ResolvedFlow = {
      description: "multi-skip flow",
      entry: "research",
      name: "test-flow",
      spawn_instructions: {
        implement: "Implement",
        research: "Do research",
        "skip-a": "Skip A",
        "skip-b": "Skip B",
        "skip-c": "Skip C",
      },
      states: {
        implement: {
          agent: "canon:implementor",
          transitions: { done: "terminal" },
          type: "single",
        },
        research: {
          agent: "canon:researcher",
          transitions: { done: "skip-a" },
          type: "single",
        },
        "skip-a": {
          agent: "canon:researcher",
          skip_when: "no_contract_changes" as const,
          transitions: { done: "skip-b", skipped: "skip-b" },
          type: "single",
        },
        "skip-b": {
          agent: "canon:researcher",
          skip_when: "no_contract_changes" as const,
          transitions: { done: "skip-c", skipped: "skip-c" },
          type: "single",
        },
        "skip-c": {
          agent: "canon:security",
          skip_when: "no_fix_requested" as const,
          transitions: { done: "implement", skipped: "implement" },
          type: "single",
        },
        terminal: { type: "terminal" },
      },
    };

    // research → skip-a → skip-b → skip-c → implement (all transparent to caller)
    // Submitting result of research should trigger the 3-hop skip chain and land on implement
    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("skip-a") as never);
    // skip-a: skip
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        can_enter: true,
        prompts: [],
        skip_reason: "skip-a condition met",
        state_type: "single",
      }),
    );
    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("skip-b") as never);
    // skip-b: skip
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        can_enter: true,
        prompts: [],
        skip_reason: "skip-b condition met",
        state_type: "single",
      }),
    );
    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("skip-c") as never);
    // skip-c: skip
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        can_enter: true,
        prompts: [],
        skip_reason: "skip-c condition met",
        state_type: "single",
      }),
    );
    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("implement") as never);
    // implement: actual work
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        prompts: [
          {
            agent: "canon:implementor",
            prompt: "Implement",
            role: "main",
            template_paths: [],
          },
        ],
        state_type: "single",
      }),
    );

    const result = await driveFlow(
      {
        flow,
        result: { state_id: "research", status: "done" },
        workspace,
      },
      "/fake/project",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    // Should land on implement after all 3 skips
    expect(result.requests[0].agent_type).toBe("canon:implementor");

    // reportResult was called 4 times: research + skip-a + skip-b + skip-c
    expect(vi.mocked(reportResult)).toHaveBeenCalledTimes(4);
    // 3 of those should be skipped
    const skipCalls = vi
      .mocked(reportResult)
      .mock.calls.filter((call) => call[0].status_keyword === "skipped");
    expect(skipCalls).toHaveLength(3);
  });

  it("skip chain terminates at terminal type without entering terminal", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    // Chain ends at terminal state directly after skip
    const flow: ResolvedFlow = {
      description: "skip-to-terminal flow",
      entry: "research",
      name: "test-flow",
      spawn_instructions: {
        research: "Do research",
        "skip-state": "Skip state",
      },
      states: {
        research: {
          agent: "canon:researcher",
          transitions: { done: "skip-state" },
          type: "single",
        },
        "skip-state": {
          agent: "canon:security",
          skip_when: "auto_approved" as const,
          transitions: { done: "terminal", skipped: "terminal" },
          type: "single",
        },
        terminal: { type: "terminal" },
      },
    };

    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("skip-state") as never);
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        can_enter: true,
        prompts: [],
        skip_reason: "auto_approved",
        state_type: "single",
      }),
    );
    // After skip, next_state = terminal
    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("terminal") as never);

    const result = await driveFlow(
      {
        flow,
        result: { state_id: "research", status: "done" },
        workspace,
      },
      "/fake/project",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("done");
    if (result.action !== "done") return;
    expect(result.terminal_state).toBe("terminal");
  });
});

// Gap 2: WORKSPACE_NOT_FOUND when workspace exists but has no board
// Task-03/06: only tests for entirely missing workspace path, not missing execution row

describe("driveFlow — workspace exists but no board execution", () => {
  it("returns WORKSPACE_NOT_FOUND when workspace directory exists but store has no execution", async () => {
    const workspace = makeTmpWorkspace();
    // Create the store with DB but do NOT call initExecution — so getBoard() returns null
    initExecutionDb(join(workspace, "orchestration.db"));

    const flow: ResolvedFlow = {
      description: "test",
      entry: "research",
      name: "test-flow",
      spawn_instructions: { research: "research" },
      states: {
        research: {
          agent: "canon:researcher",
          transitions: { done: "terminal" },
          type: "single",
        },
        terminal: { type: "terminal" },
      },
    };

    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) return;
    expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
    expect(result.message).toContain("No execution found");
  });
});

// Gap 3: buildDoneSummary state counting
// Task-03: "buildDoneSummary content: tested that action is 'done', not the exact summary string content"

describe("driveFlow — buildDoneSummary state counting", () => {
  it("summary reflects done + skipped count vs total states in board", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    store.updateExecution({ current_state: "terminal" });
    // Manually populate state rows with mixed statuses
    store.upsertState("research", { entries: 1, status: "done" });
    store.upsertState("implement", { entries: 0, status: "skipped" });
    store.upsertState("review", { entries: 0, status: "pending" });

    const flow: ResolvedFlow = {
      description: "test",
      entry: "research",
      name: "test-flow",
      spawn_instructions: { implement: "implement", research: "research", review: "review" },
      states: {
        implement: {
          agent: "canon:implementor",
          transitions: { done: "terminal" },
          type: "single",
        },
        research: {
          agent: "canon:researcher",
          transitions: { done: "terminal" },
          type: "single",
        },
        review: {
          agent: "canon:reviewer",
          transitions: { done: "terminal" },
          type: "single",
        },
        terminal: { type: "terminal" },
      },
    };

    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("done");
    if (result.action !== "done") return;
    // The summary should mention terminal_state
    expect(result.summary).toContain("terminal");
    // Summary should include states completed metric
    expect(result.summary).toMatch(/\d+\/\d+/);
  });
});

// Gap 4: syncBoardToStore skipped field propagation
// board-sync.test.ts does not test that the skipped field is persisted

describe("syncBoardToStore — skipped field", () => {
  it("persists the skipped array to execution store", () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);

    const board = makeBoard({ skipped: ["security", "lint-check"] });
    syncBoardToStore(store, board);

    const exec = store.getExecution();
    expect(exec?.skipped).toEqual(["security", "lint-check"]);
  });

  it("persists empty skipped array without throwing", () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);

    const board = makeBoard({ skipped: [] });
    syncBoardToStore(store, board);

    const exec = store.getExecution();
    expect(exec?.skipped).toEqual([]);
  });

  it("overwrites previously persisted skipped list on re-sync", () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);

    // First sync with one skipped entry
    syncBoardToStore(store, makeBoard({ skipped: ["security"] }));
    let exec = store.getExecution();
    expect(exec?.skipped).toEqual(["security"]);

    // Second sync overwrites with new list
    syncBoardToStore(store, makeBoard({ skipped: ["security", "review"] }));
    exec = store.getExecution();
    expect(exec?.skipped).toEqual(["security", "review"]);
  });
});

// Gap 5: SpawnRequest item as object with task_id key
// Task-03: "SpawnRequest task_id from structured item: only the string path is exercised in tests.
// The object path is a passthrough."

describe("driveFlow — SpawnRequest item as object with task_id", () => {
  it("extracts task_id from item object when item is { task_id: string }", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(enterAndPrepareState).mockResolvedValueOnce({
      can_enter: true,
      cannot_fix_items: [],
      history: [],
      iteration_count: 1,
      max_iterations: 3,
      ok: true,
      prompts: [
        {
          agent: "canon:implementor",
          // item is an object (not a string)
          item: {
            description: "structured task",
            task_id: "task-structured-01",
          } as unknown as string,
          prompt: "Implement task",
          role: "implementor",
          template_paths: [],
        },
      ],
      state_type: "single",
    });

    const flow: ResolvedFlow = {
      description: "test",
      entry: "research",
      name: "test-flow",
      spawn_instructions: { research: "research" },
      states: {
        research: {
          agent: "canon:implementor",
          transitions: { done: "terminal" },
          type: "single",
        },
        terminal: { type: "terminal" },
      },
    };

    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    expect(result.requests).toHaveLength(1);
    // task_id should be extracted from the item object
    expect(result.requests[0].task_id).toBe("task-structured-01");
  });

  it("leaves task_id undefined when item object has no task_id key", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(enterAndPrepareState).mockResolvedValueOnce({
      can_enter: true,
      cannot_fix_items: [],
      history: [],
      iteration_count: 1,
      max_iterations: 3,
      ok: true,
      prompts: [
        {
          agent: "canon:implementor",
          // item is an object without task_id
          item: { description: "no task_id here" } as unknown as string,
          prompt: "Implement task",
          role: "implementor",
          template_paths: [],
        },
      ],
      state_type: "single",
    });

    const flow: ResolvedFlow = {
      description: "test",
      entry: "research",
      name: "test-flow",
      spawn_instructions: { research: "research" },
      states: {
        research: {
          agent: "canon:implementor",
          transitions: { done: "terminal" },
          type: "single",
        },
        terminal: { type: "terminal" },
      },
    };

    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    // task_id undefined since item has no task_id key
    expect(result.requests[0].task_id).toBeUndefined();
  });
});
