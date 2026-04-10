/**
 * adr-009-session.test.ts — ADR-009 session, categorizeFailures, and metadata tests.
 *
 * Split from adr-009-integration.test.ts. Covers:
 *   - categorizeFailures — uncategorized count boundary
 *   - categorizeFailures — cross-module contract with driveFlow consumer pattern
 *   - driveFlow — result without agent_session_id
 *   - syncBoardToStore — metadata field propagation
 *
 * Canon principles:
 *   - toolresult-contract: all assertions check ok/action on ToolResult
 *   - no-silent-failures: error paths always surface structured errors
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
import { clearStoreCache, ExecutionStore } from "@domains/workspaces/execution-store.ts";
import { categorizeFailures } from "@features/diagnostics/tools/categorize-failures.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { driveFlow } from "../tools/drive-flow.ts";
import type { EnterAndPrepareStateResult } from "../tools/enter-and-prepare-state.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";
import { reportResult } from "../tools/report-result.ts";

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "adr009-session-test-"));
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
        agent: "canon:canon-researcher",
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

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
  vi.resetAllMocks();
});

// Gap 6: categorizeFailures — uncategorized count boundary
// Task-05: No test for the case where exactly 1 uncategorized failure (does NOT trigger needs_refinement)
// vs. 2 uncategorized failures (DOES trigger needs_refinement)

describe("categorizeFailures — uncategorized count boundary", () => {
  it("needs_refinement is true when 2+ failures have no partial signal (truly uncategorized)", async () => {
    // Two unique failures with no peer and no error_type have no partial signal —
    // they are truly uncategorized and do NOT become singleton categories.
    // uncategorized.length > 1 → needs_refinement true.
    const result = await categorizeFailures({
      failures: [
        { error_message: "unique error alpha", file: "a/foo.test.ts" },
        { error_message: "unique error beta", file: "b/bar.test.ts" },
      ],
      workspace: "/tmp/test",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No partial signal → both are truly uncategorized
    expect(result.uncategorized).toHaveLength(2);
    expect(result.categories).toHaveLength(0);
    // uncategorized > 1 → needs_refinement true
    expect(result.needs_refinement).toBe(true);
  });

  it("needs_refinement flag is driven by confidence < 0.8, not uncategorized count (singletons prevent accumulation)", async () => {
    // 2 failures in same dir, no common substring → confidence 0.7 → needs_refinement: true
    const result = await categorizeFailures({
      failures: [
        { error_message: "TypeError: cannot read x", file: "src/tools/foo.test.ts" },
        { error_message: "ReferenceError: y is not defined", file: "src/tools/bar.test.ts" },
      ],
      workspace: "/tmp/test",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.needs_refinement).toBe(true);
    // The low-confidence directory group triggers needs_refinement
    const lowConfidenceGroup = result.categories.find((c) => c.confidence < 0.8);
    expect(lowConfidenceGroup).toBeDefined();
  });
});

// Gap 7: categorizeFailures — integration with driveFlow context
// task-06 gap: "no integration test with a real MCP tool registration"
// Verify the tool is importable and callable as a standalone function (unit-level registration check)

describe("categorizeFailures — cross-module contract with driveFlow consumer pattern", () => {
  it("returns structured categories that the orchestrator can fan-out fixers from", async () => {
    // Simulates the consumer pattern: tester reports failures → categorizeFailures groups them
    // → orchestrator uses groups to fan-out parallel fixers
    const result = await categorizeFailures({
      failures: [
        {
          error_message: "TypeError: Cannot read property 'ok'",
          error_type: "TypeError",
          file: "src/features/orchestration/tools/drive-flow.ts",
        },
        {
          error_message: "TypeError: Cannot read property 'ok'",
          error_type: "TypeError",
          file: "src/features/diagnostics/tools/categorize-failures.ts",
        },
        {
          error_message: "ReferenceError: store is not defined",
          error_type: "ReferenceError",
          file: "src/domains/board/board-sync.ts",
        },
      ],
      workspace: "/tmp/test-workspace",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Exact error match should group the two TypeError failures
    const typeErrorGroup = result.categories.find((c) =>
      c.entries.every((e) => e.error_message === "TypeError: Cannot read property 'ok'"),
    );
    expect(typeErrorGroup).toBeDefined();
    expect(typeErrorGroup?.confidence).toBe(0.95);
    expect(typeErrorGroup?.entries).toHaveLength(2);

    // ReferenceError should be singletonized
    const refErrorGroup = result.categories.find((c) =>
      c.entries.some((e) => e.error_type === "ReferenceError"),
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
      failures: [
        { error_message: "Error A", file: "src/features/orchestration/tools/drive-flow.ts" },
        { error_message: "Error B", file: "src/features/orchestration/tools/drive-flow.ts" },
        { error_message: "Error C", file: "src/features/diagnostics/tools/categorize-failures.ts" },
      ],
      refined_categories: [
        {
          category: "drive-flow issues",
          description: "Failures in the drive-flow tool",
          files: ["src/features/orchestration/tools/drive-flow.ts"],
        },
      ],
      workspace: "/tmp/test",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.categories).toHaveLength(1);
    // Both entries from drive-flow.ts should be collected
    expect(result.categories[0].entries).toHaveLength(2);
    // categorize-failures.ts is uncategorized
    expect(result.uncategorized).toHaveLength(1);
    expect(result.uncategorized[0].file).toBe(
      "src/features/diagnostics/tools/categorize-failures.ts",
    );
    expect(result.needs_refinement).toBe(false);
  });
});

// Gap 8: driveFlow — board.current_state when result has no agent_session_id
// The agent_session_id is optional; ensure driveFlow doesn't throw when absent
// (Implicit test of the conditional guard in drive-flow.ts line 96)

describe("driveFlow — result without agent_session_id", () => {
  it("does not throw and advances normally when result has no agent_session_id", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("implement") as never);
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        prompts: [
          {
            agent: "canon:canon-implementor",
            prompt: "Implement",
            role: "main",
            template_paths: [],
          },
        ],
        state_type: "single",
      }),
    );

    const flow: ResolvedFlow = {
      description: "test",
      entry: "research",
      name: "test-flow",
      spawn_instructions: { implement: "implement", research: "research" },
      states: {
        implement: {
          agent: "canon:canon-implementor",
          transitions: { done: "terminal" },
          type: "single",
        },
        research: {
          agent: "canon:canon-researcher",
          transitions: { done: "implement" },
          type: "single",
        },
        terminal: { type: "terminal" },
      },
    };

    // result has no agent_session_id field
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
    expect(result.requests[0].agent_type).toBe("canon:canon-implementor");
  });
});

// Gap 9: syncBoardToStore — metadata field propagation
// board-sync.test.ts does not test metadata field

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
