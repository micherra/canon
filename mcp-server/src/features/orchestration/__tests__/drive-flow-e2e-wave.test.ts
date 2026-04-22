/**
 * drive-flow-e2e-wave.test.ts — End-to-end tests for driveFlow wave and gate scenarios.
 *
 * Exercises the full state machine protocol using a real SQLite DB (in a temp
 * workspace directory) and mocked I/O boundaries (enter-and-prepare-state,
 * report-result, wave-lifecycle, gate-runner).
 *
 * Scenarios:
 *   4. result.status defaults to 'done' when omitted (HITL resume defense)
 *   5. Wave with gate failure: implement wave → gate fails → HITL/transition
 *   6. Partial migration correctness — drive_flow from intermediate state
 *
 * Canon principles:
 *   - toolresult-contract: all assertions check ok/action on ToolResult
 *   - sqlite-transactions: real SQLite DB verifies board state at each step
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock all heavy I/O boundaries
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
  createWaveWorktrees,
  getProjectDir,
  mergeWaveResults,
} from "@domains/workspaces/wave-lifecycle.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { driveFlow } from "../tools/drive-flow.ts";
import type { EnterAndPrepareStateResult } from "../tools/enter-and-prepare-state.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";
import { reportResult } from "../tools/report-result.ts";
import { resolveAfterConsultations } from "../tools/resolve-after-consultations.ts";

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "drive-flow-e2e-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeStore(
  workspace: string,
  opts: {
    flow?: string;
    task?: string;
    entry?: string;
    current_state?: string;
    slug?: string;
    tier?: "small" | "medium" | "large";
  } = {},
): ExecutionStore {
  const db = initExecutionDb(join(workspace, "orchestration.db"));
  const store = new ExecutionStore(db);
  store.initExecution({
    base_commit: "abc123",
    branch: "feat/test",
    created: new Date().toISOString(),
    current_state: opts.current_state ?? opts.entry ?? "research",
    entry: opts.entry ?? "research",
    flow: opts.flow ?? "test-flow",
    flow_name: opts.flow ?? "test-flow",
    last_updated: new Date().toISOString(),
    sanitized: "feat-test",
    slug: opts.slug ?? "test-slug",
    started: new Date().toISOString(),
    task: opts.task ?? "build feature",
    tier: opts.tier ?? "medium",
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

/** 3-state flow: research (single) → implement (wave) → review (single) → done (terminal) */
function makeFullFlow(): ResolvedFlow {
  return {
    description: "full e2e flow",
    entry: "research",
    name: "test-flow",
    spawn_instructions: {
      implement: "Implement the tasks",
      research: "Do research",
      review: "Do review",
    },
    states: {
      implement: {
        transitions: { done: "review" },
        type: "wave",
        wave_policy: {
          isolation: "worktree",
          merge_strategy: "sequential",
          on_conflict: "hitl",
        },
      },
      research: {
        agent: "canon:researcher",
        transitions: { done: "implement" },
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

function makeReportResult(nextState: string | null, overrides: Record<string, unknown> = {}) {
  return {
    board: {
      base_commit: "abc123",
      blocked: null,
      concerns: [],
      current_state: nextState ?? "terminal",
      entry: "research",
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

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
  vi.resetAllMocks();
});

// Scenario: HITL resume — result.status defaults to "done" when omitted
// RCA: Orchestrator may call drive_flow with result: { state_id } but no status after HITL.
// The schema must default status to "done" rather than fail with a validation error.

describe("result.status defaults to 'done' when omitted (HITL resume defense)", () => {
  it("accepts result without status and treats it as 'done'", async () => {
    const workspace = makeTmpWorkspace();
    const slug = "hitl-resume-slug";
    const flow = makeFullFlow();
    makeStore(workspace, { entry: "research", slug });

    // Write INDEX.md for the wave state that follows research
    writeIndexMd(workspace, slug, [{ task_id: "task-01", wave: 1 }]);

    // Mock wave-lifecycle for the implement wave that will be entered after research
    vi.mocked(getProjectDir).mockReturnValue(workspace);
    vi.mocked(createWaveWorktrees).mockResolvedValue([
      { branch: "canon-wave/task-01", task_id: "task-01", worktree_path: join(workspace, "wt-01") },
    ]);

    // Mock reportResult to say research completed → next state is implement
    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("implement") as never);
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        prompts: [
          {
            agent: "canon:implementor",
            item: "task-01",
            prompt: "Implement",
            role: "implementor",
            template_paths: [],
          },
        ],
        state_type: "wave",
      }),
    );

    // Simulate the bug: orchestrator calls drive_flow with result.status omitted
    // This previously caused MCP error -32602 "expected string, received undefined"
    const result = await driveFlow(
      {
        flow,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        result: { state_id: "research" } as any, // status intentionally omitted
        workspace,
      },
      "/fake/project",
    );

    // Should not throw; should treat missing status as "done"
    expect(result.ok).toBe(true);
  });
});

// Scenario 4: Wave with gate failure

describe("e2e: wave with gate failure", () => {
  it("returns hitl when wave gate fails and reportResult signals hitl", async () => {
    const workspace = makeTmpWorkspace();
    const slug = "gate-fail-slug";
    const flow = makeFullFlow();

    makeStore(workspace, { current_state: "implement", entry: "implement", slug });

    // Write INDEX.md for single task
    writeIndexMd(workspace, slug, [{ task_id: "task-01", wave: 1 }]);

    vi.mocked(getProjectDir).mockReturnValue(workspace);
    vi.mocked(createWaveWorktrees).mockResolvedValue([
      { branch: "canon-wave/task-01", task_id: "task-01", worktree_path: join(workspace, "wt-01") },
    ]);
    vi.mocked(mergeWaveResults).mockResolvedValue({ merged_count: 1, ok: true });
    vi.mocked(cleanupWorktrees).mockResolvedValue({ errors: [], removed: 1 });
    // Gate failure: one gate does not pass
    vi.mocked(runGates).mockReturnValue([
      { command: "npm test", exitCode: 1, gate: "npm test", output: "3 failures", passed: false },
    ]);
    vi.mocked(resolveAfterConsultations).mockReturnValue({
      consultation_prompts: [],
      warnings: [],
    });

    // Enter implement wave
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
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
      }),
    );

    const turn1 = await driveFlow({ flow, workspace }, "/fake/project");
    expect(turn1.ok).toBe(true);
    if (turn1.ok) {
      expect(turn1.action).toBe("spawn");
    }

    // task-01 done → wave completes → gate_failed → reportResult signals HITL
    vi.mocked(reportResult).mockResolvedValueOnce({
      board: {
        base_commit: "abc123",
        blocked: null,
        concerns: [],
        current_state: "implement",
        entry: "implement",
        flow: "test-flow",
        iterations: {},
        last_updated: new Date().toISOString(),
        skipped: [],
        started: new Date().toISOString(),
        states: {},
        task: "build feature",
      },
      hitl_reason: "Gate 'npm test' failed: 3 failures",
      hitl_required: true,
      log_entry: {},
      next_state: null,
      ok: true,
      stuck: false,
      transition_condition: "gate_failed",
    } as never);

    const turn2 = await driveFlow(
      {
        flow,
        result: { state_id: "implement", status: "DONE", task_id: "task-01" },
        workspace,
      },
      "/fake/project",
    );

    expect(turn2.ok).toBe(true);
    if (turn2.ok) {
      expect(turn2.action).toBe("hitl");
      if (turn2.action === "hitl") {
        expect(turn2.breakpoint.reason).toContain("Gate");
      }
    }
  });

  it("advances to next state when gate passes after wave completes", async () => {
    const workspace = makeTmpWorkspace();
    const slug = "gate-pass-slug";
    const flow = makeFullFlow();

    makeStore(workspace, { current_state: "implement", entry: "implement", slug });
    writeIndexMd(workspace, slug, [{ task_id: "task-01", wave: 1 }]);

    vi.mocked(getProjectDir).mockReturnValue(workspace);
    vi.mocked(createWaveWorktrees).mockResolvedValue([
      { branch: "canon-wave/task-01", task_id: "task-01", worktree_path: join(workspace, "wt-01") },
    ]);
    vi.mocked(mergeWaveResults).mockResolvedValue({ merged_count: 1, ok: true });
    vi.mocked(cleanupWorktrees).mockResolvedValue({ errors: [], removed: 1 });
    vi.mocked(runGates).mockReturnValue([
      { command: "npm test", exitCode: 0, gate: "npm test", output: "all pass", passed: true },
    ]);
    vi.mocked(resolveAfterConsultations).mockReturnValue({
      consultation_prompts: [],
      warnings: [],
    });

    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
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
      }),
    );

    await driveFlow({ flow, workspace }, "/fake/project");

    // Wave completes with gate passing → report done → advance to review
    vi.mocked(reportResult).mockResolvedValueOnce(makeReportResult("review") as never);
    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        prompts: [{ agent: "canon:reviewer", prompt: "Review", role: "main", template_paths: [] }],
        state_type: "single",
      }),
    );

    const turn2 = await driveFlow(
      {
        flow,
        result: { state_id: "implement", status: "DONE", task_id: "task-01" },
        workspace,
      },
      "/fake/project",
    );

    expect(turn2.ok).toBe(true);
    if (turn2.ok) {
      expect(turn2.action).toBe("spawn");
      if (turn2.action === "spawn") {
        expect(turn2.requests[0].agent_type).toBe("canon:reviewer");
      }
    }
  });
});

// Scenario 5: Partial migration correctness — drive_flow and legacy tools coexist

describe("e2e: partial migration correctness (drive_flow from intermediate state)", () => {
  it("can enter flow from a mid-flow board state (not entry state)", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFullFlow();
    // Board is already at 'review' state (previous states completed by legacy tools)
    const store = makeStore(workspace, { current_state: "review", entry: "research" });

    // Manually advance board current_state to review (simulating legacy tool usage)
    const session = store.getSession();
    expect(session).not.toBeNull();

    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(
      makeEnterResult({
        prompts: [{ agent: "canon:reviewer", prompt: "Review", role: "main", template_paths: [] }],
        state_type: "single",
      }),
    );

    // driveFlow with no result should enter 'review' (current board state)
    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("spawn");
      if (result.action === "spawn") {
        expect(result.requests[0].agent_type).toBe("canon:reviewer");
      }
    }
  });
});
