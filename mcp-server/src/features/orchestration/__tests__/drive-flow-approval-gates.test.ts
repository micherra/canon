/**
 * drive-flow-approval-gates.test.ts — Tests for ADR-017 approval gate integration and edge cases.
 *
 * Covers:
 * - Branch A: approval breakpoint returned when gated state completes
 * - Branch A: approved/revise responses advance normally
 * - Approval gate does NOT fire when next_state === state_id (parallel wait)
 * - Approval decision statuses do NOT re-trigger the gate (no infinite loop)
 * - Self-transition on single state (revise: design)
 * - STATUS_ALIASES — "approve" maps to "approved"
 * - init-workspace iteration persistence for max_revisions
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// shouldApprovalGate and shouldApprovalGateWaveBoundary (pure functions)

import { initBoard } from "@domains/board/board.ts";
import type { ResolvedFlow } from "@domains/flows/flow-definition-schemas.ts";

// driveFlow — Branch A approval gate intercept

vi.mock("../services/learn-gate.ts", () => ({
  evaluateLearnGate: vi.fn().mockResolvedValue({ passed: false, reason: "test mode" }),
}));

vi.mock("../tools/enter-and-prepare-state.ts", () => ({
  enterAndPrepareState: vi.fn(),
}));
vi.mock("../tools/report-result.ts", () => ({
  reportResult: vi.fn(),
}));

import { initExecutionDb } from "@domains/workspaces/execution-schema.ts";
import { clearStoreCache, ExecutionStore } from "@domains/workspaces/execution-store.ts";
import { driveFlow } from "../tools/drive-flow.ts";
import type { EnterAndPrepareStateResult } from "../tools/enter-and-prepare-state.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";
import { reportResult } from "../tools/report-result.ts";

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "drive-flow-approval-test-"));
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
    current_state: "design",
    entry: "design",
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

function makeApprovalFlow(tier: "small" | "medium" | "large" | undefined = "medium"): ResolvedFlow {
  return {
    description: "test",
    entry: "design",
    name: "test-flow",
    spawn_instructions: {
      design: "Design something",
      implement: "Implement it",
    },
    states: {
      design: {
        agent: "canon-architect",
        approval_gate: true,
        transitions: {
          approved: "implement",
          done: "implement",
          revise: "design",
        },
        type: "single",
      },
      implement: {
        agent: "canon:canon-implementor",
        transitions: { done: "terminal" },
        type: "single",
      },
      terminal: {
        type: "terminal",
      },
    },
    tier,
  } as unknown as ResolvedFlow;
}

function makeEnterResult(
  overrides: Partial<EnterAndPrepareStateResult> = {},
): { ok: true } & EnterAndPrepareStateResult {
  return {
    can_enter: true,
    cannot_fix_items: [],
    history: [],
    iteration_count: 1,
    max_iterations: 3,
    ok: true,
    prompts: [
      {
        agent: "canon-architect",
        prompt: "Design the feature",
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
      entry: "design",
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
  vi.clearAllMocks();
  for (const d of tmpDirs) {
    rmSync(d, { force: true, recursive: true });
  }
  tmpDirs = [];
});

describe("driveFlow Branch A — approval gate intercept", () => {
  it("returns { action: 'approval' } when gated state completes with status 'done'", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(enterAndPrepareState).mockResolvedValue(makeEnterResult());
    vi.mocked(reportResult).mockResolvedValue(makeReportResult("implement") as any);

    const flow = makeApprovalFlow("medium");

    const result = await driveFlow(
      {
        flow,
        result: {
          artifacts: ["/workspace/plan.md"],
          state_id: "design",
          status: "done",
        },
        workspace,
      },
      "/fake/project",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("approval");
    if (result.action !== "approval") return;
    expect(result.breakpoint.state_id).toBe("design");
    expect(result.breakpoint.options).toEqual(["approved", "revise", "reject"]);
    expect(result.breakpoint.artifacts).toEqual(["/workspace/plan.md"]);
    expect(result.breakpoint.summary).toContain("design");
    expect(result.breakpoint.summary).toContain("done");
  });

  it("approval gate does NOT fire when next_state === state_id on a parallel-type state (parallel wait)", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(reportResult).mockResolvedValue(makeReportResult("parallel-review") as any);

    // Build a flow where the state with same next_state is type: parallel
    const flowWithParallel: ResolvedFlow = {
      description: "test",
      entry: "parallel-review",
      name: "test-flow",
      spawn_instructions: { "parallel-review": "Review in parallel" },
      states: {
        "parallel-review": {
          approval_gate: true,
          transitions: { done: "terminal" },
          type: "parallel",
        },
        terminal: { type: "terminal" },
      },
      tier: "medium",
    } as unknown as ResolvedFlow;

    const result = await driveFlow(
      {
        flow: flowWithParallel,
        result: {
          state_id: "parallel-review",
          status: "done",
        },
        workspace,
      },
      "/fake/project",
    );

    // parallel wait — should return empty spawn, not approval
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    expect(result.requests).toEqual([]);
  });

  it("advances normally when status is 'approved' (no second gate)", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(enterAndPrepareState).mockResolvedValue(
      makeEnterResult({
        prompts: [
          {
            agent: "canon:canon-implementor",
            prompt: "Implement",
            role: "main",
            template_paths: [],
          },
        ],
      }),
    );
    vi.mocked(reportResult).mockResolvedValue(
      makeReportResult("implement", { transition_condition: "approved" }) as any,
    );

    const flowWithoutGate: ResolvedFlow = {
      description: "test",
      entry: "design",
      name: "test-flow",
      spawn_instructions: { design: "Design", implement: "Implement" },
      states: {
        design: {
          agent: "canon:canon-researcher",
          transitions: { approved: "implement" },
          type: "single",
        },
        implement: {
          agent: "canon:canon-implementor",
          transitions: { done: "terminal" },
          type: "single",
        },
        terminal: { type: "terminal" },
      },
    } as unknown as ResolvedFlow;

    const result = await driveFlow(
      {
        flow: flowWithoutGate,
        result: {
          state_id: "design",
          status: "approved",
        },
        workspace,
      },
      "/fake/project",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    expect(result.requests.length).toBeGreaterThan(0);
    expect(result.requests[0]!.agent_type).toBe("canon:canon-implementor");
  });

  it("does not fire approval gate on architect state on small tier", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(enterAndPrepareState).mockResolvedValue(
      makeEnterResult({
        prompts: [
          {
            agent: "canon:canon-implementor",
            prompt: "Implement",
            role: "main",
            template_paths: [],
          },
        ],
      }),
    );
    vi.mocked(reportResult).mockResolvedValue(makeReportResult("implement") as any);

    const flow: ResolvedFlow = {
      description: "test",
      entry: "design",
      name: "test-flow",
      spawn_instructions: { design: "Design", implement: "Implement" },
      states: {
        design: {
          agent: "canon-architect",
          transitions: { done: "implement" },
          type: "single",
        },
        implement: {
          agent: "canon:canon-implementor",
          transitions: { done: "terminal" },
          type: "single",
        },
        terminal: { type: "terminal" },
      },
      tier: "small",
    } as unknown as ResolvedFlow;

    const result = await driveFlow(
      {
        flow,
        result: {
          state_id: "design",
          status: "done",
        },
        workspace,
      },
      "/fake/project",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    expect(result.requests[0]?.agent_type).toBe("canon:canon-implementor");
  });
});

// Infinite loop fix: approval decision statuses skip the gate (fix #1)

describe("driveFlow — approval decision statuses do NOT re-trigger the gate", () => {
  it("'approved' status on an approval_gate: true state skips the gate (no infinite loop)", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(enterAndPrepareState).mockResolvedValue(
      makeEnterResult({
        prompts: [
          {
            agent: "canon:canon-implementor",
            prompt: "Implement",
            role: "main",
            template_paths: [],
          },
        ],
      }),
    );
    vi.mocked(reportResult).mockResolvedValue(
      makeReportResult("implement", { transition_condition: "approved" }) as any,
    );

    // approval_gate: true on design — but status is "approved", so gate must NOT fire again
    const flow = makeApprovalFlow("medium");

    const result = await driveFlow(
      {
        flow,
        result: {
          state_id: "design",
          status: "approved",
        },
        workspace,
      },
      "/fake/project",
    );

    // Must advance to implement — NOT produce another "approval" breakpoint
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).not.toBe("approval");
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    expect(result.requests[0]?.agent_type).toBe("canon:canon-implementor");
  });

  it("'revise' status on an approval_gate: true state skips the gate", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(enterAndPrepareState).mockResolvedValue(makeEnterResult());
    vi.mocked(reportResult).mockResolvedValue(
      makeReportResult("design", { transition_condition: "revise" }) as any,
    );

    const flow = makeApprovalFlow("medium");

    const result = await driveFlow(
      {
        flow,
        result: {
          state_id: "design",
          status: "revise",
        },
        workspace,
      },
      "/fake/project",
    );

    // "revise" is an approval decision — gate must not re-fire
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).not.toBe("approval");
  });

  it("'reject' status on an approval_gate: true state skips the gate", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(reportResult).mockResolvedValue(
      makeReportResult(null, {
        hitl_reason: "Design rejected",
        hitl_required: true,
        transition_condition: "reject",
      }) as any,
    );

    const flow = makeApprovalFlow("medium");

    const result = await driveFlow(
      {
        flow,
        result: {
          state_id: "design",
          status: "reject",
        },
        workspace,
      },
      "/fake/project",
    );

    // "reject" is an approval decision — gate must not re-fire (hitl comes from report_result)
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).not.toBe("approval");
  });
});

// Self-transition: revise: design re-enters the same state (fix #2)

describe("driveFlow — self-transition on single state (revise: design)", () => {
  it("'revise' self-transition on a single state re-enters same state (not empty spawn)", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(enterAndPrepareState).mockResolvedValue(makeEnterResult());
    // report-result says next_state === state_id (self-transition: revise: design)
    vi.mocked(reportResult).mockResolvedValue(
      makeReportResult("design", { transition_condition: "revise" }) as any,
    );

    // Flow where design is a single state with a self-transition on revise
    const flowWithSelfTransition: ResolvedFlow = {
      description: "test",
      entry: "design",
      name: "test-flow",
      spawn_instructions: { design: "Design something" },
      states: {
        design: {
          agent: "canon-architect",
          // Explicit approval_gate: false so only the revise path is tested
          approval_gate: false,
          transitions: {
            done: "terminal",
            revise: "design", // self-transition
          },
          type: "single",
        },
        terminal: { type: "terminal" },
      },
      tier: "medium",
    } as unknown as ResolvedFlow;

    const result = await driveFlow(
      {
        flow: flowWithSelfTransition,
        result: {
          state_id: "design",
          status: "revise",
        },
        workspace,
      },
      "/fake/project",
    );

    // Self-transition on a single state should re-enter and spawn (not return empty [])
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    // Should have spawned something (re-entered design), not returned empty waiting list
    expect(result.requests.length).toBeGreaterThan(0);
    expect(result.requests[0]?.agent_type).toContain("architect");
  });
});

// Fix 4: STATUS_ALIASES — "approve" maps to "approved"

import { STATUS_ALIASES } from "@domains/flows/flow-definition-schemas.ts";

describe("STATUS_ALIASES — approve alias", () => {
  it("'approve' maps to 'approved'", () => {
    expect(STATUS_ALIASES.approve).toBe("approved");
  });

  it("existing aliases are preserved", () => {
    expect(STATUS_ALIASES.fixed).toBe("done");
    expect(STATUS_ALIASES.needs_context).toBe("hitl");
    expect(STATUS_ALIASES.epic_complete).toBe("epic_complete");
  });
});

// Fix 5: init-workspace iteration persistence for max_revisions

describe("init-workspace — iteration persistence matches initBoard for approval gates", () => {
  it("initBoard creates iteration from max_revisions (not just max_iterations)", () => {
    const flow = {
      description: "test",
      entry: "design",
      name: "test-flow",
      spawn_instructions: {},
      states: {
        design: { max_revisions: 5, type: "single" as const },
        terminal: { type: "terminal" as const },
      },
    } as ResolvedFlow;
    const board = initBoard(flow, "task", "abc");
    expect(board.iterations.design).toBeDefined();
    expect(board.iterations.design!.max).toBe(5);
  });

  it("initBoard creates default iteration (max: 3) for approval_gate: true without explicit limits", () => {
    const flow = {
      description: "test",
      entry: "design",
      name: "test-flow",
      spawn_instructions: {},
      states: {
        design: { approval_gate: true, type: "single" as const },
        terminal: { type: "terminal" as const },
      },
    } as ResolvedFlow;
    const board = initBoard(flow, "task", "abc");
    expect(board.iterations.design).toBeDefined();
    expect(board.iterations.design!.max).toBe(3);
    expect(board.iterations.design!.count).toBe(0);
  });

  it("initBoard does NOT create iteration for terminal state with approval_gate", () => {
    const flow = {
      description: "test",
      entry: "start",
      name: "test-flow",
      spawn_instructions: {},
      states: {
        start: { type: "single" as const },
        terminal: { approval_gate: true, type: "terminal" as const },
      },
    } as ResolvedFlow;
    const board = initBoard(flow, "task", "abc");
    expect(board.iterations.terminal).toBeUndefined();
  });
});
