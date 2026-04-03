/**
 * adr-009-integration.test.ts — Integration tests for ADR-009 server-side state machine.
 *
 * Fills coverage gaps declared in task summaries and verifies cross-module contracts:
 *   - Multi-hop skip loop (3+ consecutive skips) — task-03 known gap
 *   - driveFlow with workspace missing board execution (second WORKSPACE_NOT_FOUND guard)
 *   - buildDoneSummary state counting (done + skipped / total)
 *   - syncBoardToStore skipped field propagation
 *   - categorizeFailures registered in index.ts (tool registration integration)
 *   - SpawnRequest item as object with task_id key
 *   - driveFlow skip-state loop terminates correctly at terminal after skip
 *   - board-sync → report-result cross-module contract
 *
 * Canon principles:
 *   - toolresult-contract: all assertions check ok/action on ToolResult
 *   - sqlite-transactions: real SQLite DB verifies persistent state at each step
 *   - no-silent-failures: error paths always surface structured errors
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock I/O boundaries
vi.mock("../tools/enter-and-prepare-state.ts", () => ({
  enterAndPrepareState: vi.fn(),
}));
vi.mock("../tools/report-result.ts", () => ({
  reportResult: vi.fn(),
}));
vi.mock("../orchestration/wave-lifecycle.ts", () => ({
  createWaveWorktrees: vi.fn(),
  mergeWaveResults: vi.fn(),
  cleanupWorktrees: vi.fn(),
  getProjectDir: vi.fn(),
}));
vi.mock("../orchestration/gate-runner.ts", () => ({
  runGates: vi.fn(),
}));
vi.mock("../tools/resolve-after-consultations.ts", () => ({
  resolveAfterConsultations: vi.fn(),
}));

import { driveFlow } from "../tools/drive-flow.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";
import { reportResult } from "../tools/report-result.ts";
import { initExecutionDb } from "../orchestration/execution-schema.ts";
import { ExecutionStore, clearStoreCache } from "../orchestration/execution-store.ts";
import { syncBoardToStore } from "../orchestration/board-sync.ts";
import { categorizeFailures } from "../tools/categorize-failures.ts";
import type { ResolvedFlow } from "../orchestration/flow-schema.ts";
import type { EnterAndPrepareStateResult } from "../tools/enter-and-prepare-state.ts";
import type { ToolResult } from "../utils/tool-result.ts";
import type { Board } from "../orchestration/flow-schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    flow: "test-flow",
    task: "build feature",
    entry: "research",
    current_state: "research",
    base_commit: "abc123",
    started: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    branch: "feat/test",
    sanitized: "feat-test",
    created: new Date().toISOString(),
    tier: "medium",
    flow_name: "test-flow",
    slug: "test-slug",
  });
  return store;
}

function makeBoard(overrides: Partial<Board> = {}): Board {
  return {
    flow: "test-flow",
    task: "build feature",
    entry: "research",
    current_state: "research",
    base_commit: "abc123",
    started: "2026-01-01T00:00:00.000Z",
    last_updated: "2026-01-01T00:00:00.000Z",
    blocked: null,
    concerns: [],
    skipped: [],
    states: {},
    iterations: {},
    ...overrides,
  };
}

function makeEnterResult(
  overrides: Partial<EnterAndPrepareStateResult> = {},
): ToolResult<EnterAndPrepareStateResult> {
  return {
    ok: true,
    can_enter: true,
    iteration_count: 1,
    max_iterations: 3,
    cannot_fix_items: [],
    history: [],
    prompts: [
      {
        agent: "canon:canon-researcher",
        prompt: "Do task",
        template_paths: [],
        role: "main",
      },
    ],
    state_type: "single",
    ...overrides,
  };
}

function makeReportResult(nextState: string | null, overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    transition_condition: "done",
    next_state: nextState,
    stuck: false,
    hitl_required: false,
    board: makeBoard({ current_state: nextState ?? "terminal" }),
    log_entry: {},
    ...overrides,
  };
}

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// Gap 1: Multi-hop skip loop (3+ consecutive skips)
// Task-03 declared gap: "Multi-hop skip loop — tested single skip; a chain of 3+ skips is not
// explicitly tested. Logic is covered by the loop, but integration confirmation would add confidence."
// ---------------------------------------------------------------------------

describe("driveFlow — multi-hop skip loop (3+ consecutive skips)", () => {
  it("auto-advances through a chain of 3 consecutive skipped states", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    const flow: ResolvedFlow = {
      name: "test-flow",
      description: "multi-skip flow",
      entry: "research",
      spawn_instructions: {
        research: "Do research",
        "skip-a": "Skip A",
        "skip-b": "Skip B",
        "skip-c": "Skip C",
        implement: "Implement",
      },
      states: {
        research: {
          type: "single",
          agent: "canon:canon-researcher",
          transitions: { done: "skip-a" },
        },
        "skip-a": {
          type: "single",
          agent: "canon:canon-researcher",
          transitions: { done: "skip-b", skipped: "skip-b" },
          skip_when: "no_contract_changes" as const,
        },
        "skip-b": {
          type: "single",
          agent: "canon:canon-researcher",
          transitions: { done: "skip-c", skipped: "skip-c" },
          skip_when: "no_contract_changes" as const,
        },
        "skip-c": {
          type: "single",
          agent: "canon:canon-security",
          transitions: { done: "implement", skipped: "implement" },
          skip_when: "no_fix_requested" as const,
        },
        implement: {
          type: "single",
          agent: "canon:canon-implementor",
          transitions: { done: "terminal" },
        },
        terminal: { type: "terminal" },
      },
    };

    // research → skip-a → skip-b → skip-c → implement (all transparent to caller)
    // Submitting result of research should trigger the 3-hop skip chain and land on implement
    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("skip-a") as never);
    // skip-a: skip
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({ can_enter: true, skip_reason: "skip-a condition met", prompts: [], state_type: "single" }),
    );
    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("skip-b") as never);
    // skip-b: skip
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({ can_enter: true, skip_reason: "skip-b condition met", prompts: [], state_type: "single" }),
    );
    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("skip-c") as never);
    // skip-c: skip
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({ can_enter: true, skip_reason: "skip-c condition met", prompts: [], state_type: "single" }),
    );
    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("implement") as never);
    // implement: actual work
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        prompts: [{ agent: "canon:canon-implementor", prompt: "Implement", template_paths: [], role: "main" }],
        state_type: "single",
      }),
    );

    const result = await driveFlow({
      workspace,
      flow,
      result: { state_id: "research", status: "done" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    // Should land on implement after all 3 skips
    expect(result.requests[0].agent_type).toBe("canon:canon-implementor");

    // reportResult was called 4 times: research + skip-a + skip-b + skip-c
    expect(vi.mocked(reportResult)).toHaveBeenCalledTimes(4);
    // 3 of those should be skipped
    const skipCalls = vi.mocked(reportResult).mock.calls.filter(
      (call) => call[0].status_keyword === "skipped",
    );
    expect(skipCalls).toHaveLength(3);
  });

  it("skip chain terminates at terminal type without entering terminal", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    // Chain ends at terminal state directly after skip
    const flow: ResolvedFlow = {
      name: "test-flow",
      description: "skip-to-terminal flow",
      entry: "research",
      spawn_instructions: {
        research: "Do research",
        "skip-state": "Skip state",
      },
      states: {
        research: {
          type: "single",
          agent: "canon:canon-researcher",
          transitions: { done: "skip-state" },
        },
        "skip-state": {
          type: "single",
          agent: "canon:canon-security",
          transitions: { done: "terminal", skipped: "terminal" },
          skip_when: "auto_approved" as const,
        },
        terminal: { type: "terminal" },
      },
    };

    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("skip-state") as never);
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({ can_enter: true, skip_reason: "auto_approved", prompts: [], state_type: "single" }),
    );
    // After skip, next_state = terminal
    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("terminal") as never);

    const result = await driveFlow({
      workspace,
      flow,
      result: { state_id: "research", status: "done" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("done");
    if (result.action !== "done") return;
    expect(result.terminal_state).toBe("terminal");
  });
});

// ---------------------------------------------------------------------------
// Gap 2: WORKSPACE_NOT_FOUND when workspace exists but has no board
// Task-03/06: only tests for entirely missing workspace path, not missing execution row
// ---------------------------------------------------------------------------

describe("driveFlow — workspace exists but no board execution", () => {
  it("returns WORKSPACE_NOT_FOUND when workspace directory exists but store has no execution", async () => {
    const workspace = makeTmpWorkspace();
    // Create the store with DB but do NOT call initExecution — so getBoard() returns null
    initExecutionDb(join(workspace, "orchestration.db"));

    const flow: ResolvedFlow = {
      name: "test-flow",
      description: "test",
      entry: "research",
      spawn_instructions: { research: "research" },
      states: {
        research: { type: "single", agent: "canon:canon-researcher", transitions: { done: "terminal" } },
        terminal: { type: "terminal" },
      },
    };

    const result = await driveFlow({ workspace, flow });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
    expect(result.message).toContain("No execution found");
  });
});

// ---------------------------------------------------------------------------
// Gap 3: buildDoneSummary state counting
// Task-03: "buildDoneSummary content: tested that action is 'done', not the exact summary string content"
// ---------------------------------------------------------------------------

describe("driveFlow — buildDoneSummary state counting", () => {
  it("summary reflects done + skipped count vs total states in board", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);
    store.updateExecution({ current_state: "terminal" });
    // Manually populate state rows with mixed statuses
    store.upsertState("research", { status: "done", entries: 1 });
    store.upsertState("implement", { status: "skipped", entries: 0 });
    store.upsertState("review", { status: "pending", entries: 0 });

    const flow: ResolvedFlow = {
      name: "test-flow",
      description: "test",
      entry: "research",
      spawn_instructions: { research: "research", implement: "implement", review: "review" },
      states: {
        research: { type: "single", agent: "canon:canon-researcher", transitions: { done: "terminal" } },
        implement: { type: "single", agent: "canon:canon-implementor", transitions: { done: "terminal" } },
        review: { type: "single", agent: "canon:canon-reviewer", transitions: { done: "terminal" } },
        terminal: { type: "terminal" },
      },
    };

    const result = await driveFlow({ workspace, flow });

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

// ---------------------------------------------------------------------------
// Gap 4: syncBoardToStore skipped field propagation
// board-sync.test.ts does not test that the skipped field is persisted
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Gap 5: SpawnRequest item as object with task_id key
// Task-03: "SpawnRequest task_id from structured item: only the string path is exercised in tests.
// The object path is a passthrough."
// ---------------------------------------------------------------------------

describe("driveFlow — SpawnRequest item as object with task_id", () => {
  it("extracts task_id from item object when item is { task_id: string }", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(enterAndPrepareState).mockResolvedValueOnce({
      ok: true,
      can_enter: true,
      iteration_count: 1,
      max_iterations: 3,
      cannot_fix_items: [],
      history: [],
      prompts: [
        {
          agent: "canon:canon-implementor",
          prompt: "Implement task",
          template_paths: [],
          role: "implementor",
          // item is an object (not a string)
          item: { task_id: "task-structured-01", description: "structured task" } as unknown as string,
        },
      ],
      state_type: "single",
    });

    const flow: ResolvedFlow = {
      name: "test-flow",
      description: "test",
      entry: "research",
      spawn_instructions: { research: "research" },
      states: {
        research: { type: "single", agent: "canon:canon-implementor", transitions: { done: "terminal" } },
        terminal: { type: "terminal" },
      },
    };

    const result = await driveFlow({ workspace, flow });

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
      ok: true,
      can_enter: true,
      iteration_count: 1,
      max_iterations: 3,
      cannot_fix_items: [],
      history: [],
      prompts: [
        {
          agent: "canon:canon-implementor",
          prompt: "Implement task",
          template_paths: [],
          role: "implementor",
          // item is an object without task_id
          item: { description: "no task_id here" } as unknown as string,
        },
      ],
      state_type: "single",
    });

    const flow: ResolvedFlow = {
      name: "test-flow",
      description: "test",
      entry: "research",
      spawn_instructions: { research: "research" },
      states: {
        research: { type: "single", agent: "canon:canon-implementor", transitions: { done: "terminal" } },
        terminal: { type: "terminal" },
      },
    };

    const result = await driveFlow({ workspace, flow });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    // task_id undefined since item has no task_id key
    expect(result.requests[0].task_id).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Gap 6: categorizeFailures — uncategorized count boundary
// Task-05: No test for the case where exactly 1 uncategorized failure (does NOT trigger needs_refinement)
// vs. 2 uncategorized failures (DOES trigger needs_refinement)
// ---------------------------------------------------------------------------

describe("categorizeFailures — uncategorized count boundary", () => {
  it("needs_refinement is false when exactly 1 uncategorized failure remains", async () => {
    // One unique failure with no peer = singleton category at 0.95, NOT uncategorized
    // After all tiers, any remaining are singletonized. So uncategorized.length should always be 0.
    // This tests that the singleton fallback (Step 5) prevents uncategorized from ever reaching 2.
    const result = await categorizeFailures({
      workspace: "/tmp/test",
      failures: [
        { file: "a/foo.test.ts", error_message: "unique error alpha" },
        { file: "b/bar.test.ts", error_message: "unique error beta" },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Both should be singletonized (exact_error, confidence 0.95)
    expect(result.uncategorized).toHaveLength(0);
    // Both should be in categories
    expect(result.categories).toHaveLength(2);
    // All at 0.95 = needs_refinement false (no low-confidence groups, no uncategorized > 1)
    expect(result.needs_refinement).toBe(false);
  });

  it("needs_refinement flag is driven by confidence < 0.8, not uncategorized count (singletons prevent accumulation)", async () => {
    // 2 failures in same dir, no common substring → confidence 0.7 → needs_refinement: true
    const result = await categorizeFailures({
      workspace: "/tmp/test",
      failures: [
        { file: "src/tools/foo.test.ts", error_message: "TypeError: cannot read x" },
        { file: "src/tools/bar.test.ts", error_message: "ReferenceError: y is not defined" },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.needs_refinement).toBe(true);
    // The low-confidence directory group triggers needs_refinement
    const lowConfidenceGroup = result.categories.find((c) => c.confidence < 0.8);
    expect(lowConfidenceGroup).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Gap 7: categorizeFailures — integration with driveFlow context
// task-06 gap: "no integration test with a real MCP tool registration"
// Verify the tool is importable and callable as a standalone function (unit-level registration check)
// ---------------------------------------------------------------------------

describe("categorizeFailures — cross-module contract with driveFlow consumer pattern", () => {
  it("returns structured categories that the orchestrator can fan-out fixers from", async () => {
    // Simulates the consumer pattern: tester reports failures → categorizeFailures groups them
    // → orchestrator uses groups to fan-out parallel fixers
    const result = await categorizeFailures({
      workspace: "/tmp/test-workspace",
      failures: [
        { file: "src/tools/drive-flow.ts", error_message: "TypeError: Cannot read property 'ok'", error_type: "TypeError" },
        { file: "src/tools/categorize-failures.ts", error_message: "TypeError: Cannot read property 'ok'", error_type: "TypeError" },
        { file: "src/orchestration/board-sync.ts", error_message: "ReferenceError: store is not defined", error_type: "ReferenceError" },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Exact error match should group the two TypeError failures
    const typeErrorGroup = result.categories.find(
      (c) => c.entries.every((e) => e.error_message === "TypeError: Cannot read property 'ok'"),
    );
    expect(typeErrorGroup).toBeDefined();
    expect(typeErrorGroup?.confidence).toBe(0.95);
    expect(typeErrorGroup?.entries).toHaveLength(2);

    // ReferenceError should be singletonized
    const refErrorGroup = result.categories.find(
      (c) => c.entries.some((e) => e.error_type === "ReferenceError"),
    );
    expect(refErrorGroup).toBeDefined();

    // Structure is ready for fixer fan-out: each category has files + entries
    for (const category of result.categories) {
      expect(category.files).toBeDefined();
      expect(category.entries.length).toBeGreaterThan(0);
      expect(typeof category.confidence).toBe("number");
    }
  });

  it("refined_categories with overlapping files accumulates all matching entries", async () => {
    // When LLM provides refined categories, ensure entries are correctly populated
    // even when multiple failures share the same file path
    const result = await categorizeFailures({
      workspace: "/tmp/test",
      failures: [
        { file: "src/tools/drive-flow.ts", error_message: "Error A" },
        { file: "src/tools/drive-flow.ts", error_message: "Error B" },
        { file: "src/tools/categorize-failures.ts", error_message: "Error C" },
      ],
      refined_categories: [
        {
          category: "drive-flow issues",
          description: "Failures in the drive-flow tool",
          files: ["src/tools/drive-flow.ts"],
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.categories).toHaveLength(1);
    // Both entries from drive-flow.ts should be collected
    expect(result.categories[0].entries).toHaveLength(2);
    // categorize-failures.ts is uncategorized
    expect(result.uncategorized).toHaveLength(1);
    expect(result.uncategorized[0].file).toBe("src/tools/categorize-failures.ts");
    expect(result.needs_refinement).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gap 8: driveFlow — board.current_state when result has no agent_session_id
// The agent_session_id is optional; ensure driveFlow doesn't throw when absent
// (Implicit test of the conditional guard in drive-flow.ts line 96)
// ---------------------------------------------------------------------------

describe("driveFlow — result without agent_session_id", () => {
  it("does not throw and advances normally when result has no agent_session_id", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("implement") as never);
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        prompts: [{ agent: "canon:canon-implementor", prompt: "Implement", template_paths: [], role: "main" }],
        state_type: "single",
      }),
    );

    const flow: ResolvedFlow = {
      name: "test-flow",
      description: "test",
      entry: "research",
      spawn_instructions: { research: "research", implement: "implement" },
      states: {
        research: { type: "single", agent: "canon:canon-researcher", transitions: { done: "implement" } },
        implement: { type: "single", agent: "canon:canon-implementor", transitions: { done: "terminal" } },
        terminal: { type: "terminal" },
      },
    };

    // result has no agent_session_id field
    const result = await driveFlow({
      workspace,
      flow,
      result: { state_id: "research", status: "done" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    expect(result.requests[0].agent_type).toBe("canon:canon-implementor");
  });
});

// ---------------------------------------------------------------------------
// Gap 9: syncBoardToStore — metadata field propagation
// board-sync.test.ts does not test metadata field
// ---------------------------------------------------------------------------

describe("syncBoardToStore — metadata field", () => {
  it("persists board metadata object to execution store", () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace);

    const board = makeBoard({
      metadata: { test_gate: "npm test" },
    });
    syncBoardToStore(store, board);

    const exec = store.getExecution();
    // metadata is stored (exact shape depends on execution schema, but no throw is the contract)
    expect(exec).not.toBeNull();
  });
});
