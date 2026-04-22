/**
 * drive-flow-gate-states.test.ts — Unit tests for gate-only state execution in driveFlow.
 *
 * Covers:
 * 1. Gate-only state (gates + no agent) with all gates passing → auto-transitions to next state
 * 2. Gate-only state with a failing gate → returns HITL with gate output
 * 3. Gate-only state with no gates resolved (empty array) → returns HITL (fail-closed)
 * 4. Normal single state with agent and gates → does NOT trigger gate-only path (agent spawned)
 * 5. Normal single state without gates → unchanged behavior (agent spawned)
 *
 * Canon principles:
 * - fail-closed gate philosophy: empty gate results always produce HITL, never silently pass
 * - toolresult-contract: all assertions check ok/action on ToolResult
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock all heavy I/O boundaries — same pattern as drive-flow-e2e.test.ts
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
import { createWaveWorktrees, getProjectDir } from "@domains/workspaces/wave-lifecycle.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { driveFlow } from "../tools/drive-flow.ts";
import type { EnterAndPrepareStateResult } from "../tools/enter-and-prepare-state.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";
import { reportResult } from "../tools/report-result.ts";

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "drive-flow-gate-states-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeStore(workspace: string, currentState: string): ExecutionStore {
  const db = initExecutionDb(join(workspace, "orchestration.db"));
  const store = new ExecutionStore(db);
  store.initExecution({
    base_commit: "abc123",
    branch: "feat/test",
    created: new Date().toISOString(),
    current_state: currentState,
    entry: currentState,
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
    prompts: [],
    state_type: "single",
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
      entry: "check",
      flow: "test-flow",
      iterations: {},
      last_updated: new Date().toISOString(),
      skipped: [],
      started: new Date().toISOString(),
      states: {},
      task: "build feature",
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

// Test 1: Gate-only state with all gates passing → auto-transitions to next state

describe("gate-only state: all gates pass", () => {
  it("auto-reports done and transitions to the next state without spawning an agent", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace, "check");

    const flow: ResolvedFlow = {
      description: "flow with gate-only state",
      entry: "check",
      name: "test-flow",
      spawn_instructions: {
        // Note: no spawn instruction for "check" — gate-only states are exempt
        review: "Do review",
      },
      states: {
        check: {
          gates: ["npm run build"],
          transitions: { done: "review" },
          type: "single",
        },
        review: {
          agent: "canon:reviewer",
          transitions: { done: "terminal" },
          type: "single",
        },
        terminal: {
          type: "terminal",
        },
      },
    };

    vi.mocked(getProjectDir).mockReturnValue(workspace);
    vi.mocked(runGates).mockReturnValue([
      {
        command: "npm run build",
        exitCode: 0,
        gate: "npm run build",
        output: "Build succeeded",
        passed: true,
      },
    ]);
    vi.mocked(enterAndPrepareState)
      // Gate state enter
      .mockResolvedValueOnce(makeEnterResult({ prompts: [], state_type: "single" }))
      // Next state (review) enter — called from enterStateAndBuildSpawn recursion
      .mockResolvedValueOnce(
        makeEnterResult({
          prompts: [
            {
              agent: "canon:reviewer",
              prompt: "Review code",
              role: "main",
              template_paths: [],
            },
          ],
          state_type: "single",
        }),
      );
    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("review") as never);

    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Should have skipped gate-only check state and spawned the review agent
      expect(result.action).toBe("spawn");
      if (result.action === "spawn") {
        expect(result.requests).toHaveLength(1);
        expect(result.requests[0].agent_type).toBe("canon:reviewer");
      }
    }
    // reportResult should have been called with gate_results and status_keyword "done"
    expect(vi.mocked(reportResult)).toHaveBeenCalledWith(
      expect.objectContaining({
        gate_results: expect.arrayContaining([expect.objectContaining({ passed: true })]),
        status_keyword: "done",
      }),
    );
  });
});

// Test 2: Gate-only state with a failing gate → HITL with gate output

describe("gate-only state: gate fails", () => {
  it("returns HITL breakpoint with gate failure output", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace, "check");

    const flow: ResolvedFlow = {
      description: "flow with gate-only state",
      entry: "check",
      name: "test-flow",
      spawn_instructions: {
        review: "Do review",
      },
      states: {
        check: {
          gates: ["npm run build"],
          transitions: { done: "review" },
          type: "single",
        },
        review: {
          agent: "canon:reviewer",
          transitions: { done: "terminal" },
          type: "single",
        },
        terminal: {
          type: "terminal",
        },
      },
    };

    vi.mocked(getProjectDir).mockReturnValue(workspace);
    vi.mocked(runGates).mockReturnValue([
      {
        command: "npm run build",
        exitCode: 1,
        gate: "npm run build",
        output: "src/index.ts(10,5): error TS2345",
        passed: false,
      },
    ]);
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({ prompts: [], state_type: "single" }),
    );
    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("check") as never);

    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("hitl");
      if (result.action === "hitl") {
        expect(result.breakpoint.reason).toContain("Pre-launch gates failed");
        expect(result.breakpoint.reason).toContain("npm run build");
        expect(result.breakpoint.reason).toContain("src/index.ts(10,5): error TS2345");
      }
    }
    // reportResult should have been called with status_keyword "blocked"
    expect(vi.mocked(reportResult)).toHaveBeenCalledWith(
      expect.objectContaining({
        status_keyword: "blocked",
      }),
    );
  });
});

// Test 3: Gate-only state with no gates resolved and no discovered gates → HITL (fail-closed)

describe("gate-only state: no gates resolved", () => {
  it("returns HITL breakpoint when no explicit or discovered gates exist (fail-closed)", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace, "check");

    const flow: ResolvedFlow = {
      description: "flow with gate-only state",
      entry: "check",
      name: "test-flow",
      spawn_instructions: {
        review: "Do review",
      },
      states: {
        check: {
          // No gates, no agent — gate-only state that relies on discovered gates
          transitions: { done: "review" },
          type: "single",
        },
        review: {
          agent: "canon:reviewer",
          transitions: { done: "terminal" },
          type: "single",
        },
        terminal: {
          type: "terminal",
        },
      },
    };

    vi.mocked(getProjectDir).mockReturnValue(workspace);
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({ prompts: [], state_type: "single" }),
    );
    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("check") as never);

    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("hitl");
      if (result.action === "hitl") {
        expect(result.breakpoint.reason).toContain("Pre-launch gates failed");
        expect(result.breakpoint.reason).toContain("No gates were resolved");
      }
    }
  });
});

// Test 3b: Gate-only state discovers gates from prior board states → runs them

describe("gate-only state: discovered gates from prior states", () => {
  it("collects and runs discovered gates when no explicit gates declared", async () => {
    const workspace = makeTmpWorkspace();
    const store = makeStore(workspace, "check");
    // Seed a prior state with discovered gates (simulating what agents reported earlier)
    store.upsertState("implement", {
      discovered_gates: [
        { command: "pytest", source: "tester" },
        { command: "ruff check .", source: "reviewer" },
      ],
      entries: 1,
      status: "done",
    });

    const flow: ResolvedFlow = {
      description: "flow with gate-only state using discovered gates",
      entry: "check",
      name: "test-flow",
      spawn_instructions: {
        review: "Do review",
      },
      states: {
        check: {
          // No explicit gates — should use discovered gates from board
          transitions: { done: "review" },
          type: "single",
        },
        review: {
          agent: "canon:reviewer",
          transitions: { done: "terminal" },
          type: "single",
        },
        terminal: {
          type: "terminal",
        },
      },
    };

    vi.mocked(getProjectDir).mockReturnValue(workspace);
    vi.mocked(runGates).mockReturnValue([
      { command: "pytest", exitCode: 0, gate: "pytest", output: "4 passed", passed: true },
      {
        command: "ruff check .",
        exitCode: 0,
        gate: "ruff check .",
        output: "All clean",
        passed: true,
      },
    ]);
    vi.mocked(enterAndPrepareState)
      .mockResolvedValueOnce(makeEnterResult({ prompts: [], state_type: "single" }))
      .mockResolvedValueOnce(
        makeEnterResult({
          prompts: [
            {
              agent: "canon:reviewer",
              prompt: "Review code",
              role: "main",
              template_paths: [],
            },
          ],
          state_type: "single",
        }),
      );
    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("review") as never);

    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("spawn");
    }
    // runGates should have been called with a synthetic state def containing discovered gates
    expect(vi.mocked(runGates)).toHaveBeenCalledWith(
      expect.objectContaining({
        gates: ["pytest", "ruff check ."],
      }),
      expect.anything(),
      expect.anything(),
    );
  });
});

// Test 4: Normal single state with agent AND gates → agent spawned (gates not run)

describe("normal single state with agent and gates", () => {
  it("does NOT trigger gate-only path — spawns the agent normally", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace, "implement");

    const flow: ResolvedFlow = {
      description: "flow with agent + gates state",
      entry: "implement",
      name: "test-flow",
      spawn_instructions: {
        implement: "Implement the changes",
      },
      states: {
        implement: {
          agent: "canon:implementor",
          gates: ["npm test"],
          transitions: { done: "terminal" },
          type: "single",
        },
        terminal: {
          type: "terminal",
        },
      },
    };

    vi.mocked(getProjectDir).mockReturnValue(workspace);
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

    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Should spawn the implementor, not run gates
      expect(result.action).toBe("spawn");
      if (result.action === "spawn") {
        expect(result.requests[0].agent_type).toBe("canon:implementor");
      }
    }
    // runGates should NOT have been called for agent states
    expect(vi.mocked(runGates)).not.toHaveBeenCalled();
  });
});

// Test 5: Normal single state without gates → unchanged behavior

describe("normal single state without gates", () => {
  it("spawns the agent without touching gate logic", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace, "research");

    const flow: ResolvedFlow = {
      description: "normal flow without gates",
      entry: "research",
      name: "test-flow",
      spawn_instructions: {
        research: "Do research",
      },
      states: {
        research: {
          agent: "canon:researcher",
          transitions: { done: "terminal" },
          type: "single",
        },
        terminal: {
          type: "terminal",
        },
      },
    };

    vi.mocked(getProjectDir).mockReturnValue(workspace);
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        prompts: [
          { agent: "canon:researcher", prompt: "Research", role: "main", template_paths: [] },
        ],
        state_type: "single",
      }),
    );

    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("spawn");
      if (result.action === "spawn") {
        expect(result.requests[0].agent_type).toBe("canon:researcher");
      }
    }
    expect(vi.mocked(runGates)).not.toHaveBeenCalled();
  });
});
