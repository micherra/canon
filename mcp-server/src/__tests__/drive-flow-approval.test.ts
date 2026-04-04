/**
 * drive-flow-approval.test.ts — Unit tests for ADR-017 approval gate logic.
 *
 * Covers:
 * - shouldApprovalGate() pure function behavior
 * - shouldApprovalGateWaveBoundary() pure function behavior
 * - Branch A: approval breakpoint returned when gated state completes
 * - Branch A: approved/revise responses advance normally
 * - Approval gate does NOT fire when next_state === state_id (parallel wait)
 * - initBoard: max_revisions takes precedence over max_iterations
 * - initBoard: default iteration entry (max: 3) for approval_gate: true states
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// shouldApprovalGate and shouldApprovalGateWaveBoundary (pure functions)

import { initBoard } from "../orchestration/board.ts";
import type { DriveFlowInput } from "../orchestration/drive-flow-types.ts";
import type { Board, ResolvedFlow, StateDefinition } from "../orchestration/flow-schema.ts";
import { shouldApprovalGate, shouldApprovalGateWaveBoundary } from "../tools/drive-flow.ts";

function makeBoard(metadataOverrides?: Record<string, string | number | boolean>): Board {
  return {
    base_commit: "abc",
    blocked: null,
    concerns: [],
    current_state: "design",
    entry: "design",
    flow: "test-flow",
    iterations: {},
    last_updated: new Date().toISOString(),
    metadata: metadataOverrides,
    skipped: [],
    started: new Date().toISOString(),
    states: {},
    task: "test",
  };
}

function makeFlow(
  tier: "small" | "medium" | "large" | undefined,
  stateOverrides?: Record<string, StateDefinition>,
): DriveFlowInput["flow"] {
  return {
    description: "test",
    entry: "design",
    name: "test-flow",
    spawn_instructions: {},
    states: {
      design: {
        agent: "canon-architect",
        transitions: { approved: "implement", reject: "terminal", revise: "design" },
        type: "single",
      },
      implement: {
        agent: "canon:canon-implementor",
        type: "single",
      },
      terminal: {
        type: "terminal",
      },
      ...stateOverrides,
    },
    tier,
  } as DriveFlowInput["flow"];
}

// shouldApprovalGate tests

describe("shouldApprovalGate", () => {
  it("returns true for explicit approval_gate: true", () => {
    const stateDef: StateDefinition = { approval_gate: true, type: "single" };
    const flow = makeFlow("small");
    const board = makeBoard();
    expect(shouldApprovalGate(stateDef, flow, board)).toBe(true);
  });

  it("returns false for explicit approval_gate: false", () => {
    const stateDef: StateDefinition = { approval_gate: false, type: "single" };
    const flow = makeFlow("medium");
    const board = makeBoard();
    expect(shouldApprovalGate(stateDef, flow, board)).toBe(false);
  });

  it("returns false for terminal states", () => {
    const stateDef: StateDefinition = { type: "terminal" };
    const flow = makeFlow("large");
    const board = makeBoard();
    expect(shouldApprovalGate(stateDef, flow, board)).toBe(false);
  });

  it("returns true for architect agent on medium tier with approval transitions (tier default)", () => {
    const stateDef: StateDefinition = {
      agent: "canon-architect",
      transitions: { approved: "implement", revise: "design" },
      type: "single",
    };
    const flow = makeFlow("medium");
    const board = makeBoard();
    expect(shouldApprovalGate(stateDef, flow, board)).toBe(true);
  });

  it("returns true for architect agent on medium tier with reject transition (second check)", () => {
    const stateDef: StateDefinition = {
      agent: "canon-architect",
      transitions: { reject: "hitl" },
      type: "single",
    };
    const flow = makeFlow("medium");
    const board = makeBoard();
    // medium tier should gate architect states when approval transitions exist
    expect(shouldApprovalGate(stateDef, flow, board)).toBe(true);
  });

  it("returns true for architect agent on large tier with approval transitions (tier default)", () => {
    const stateDef: StateDefinition = {
      agent: "canon-architect",
      transitions: { approved: "implement", reject: "hitl", revise: "design" },
      type: "single",
    };
    const flow = makeFlow("large");
    const board = makeBoard();
    expect(shouldApprovalGate(stateDef, flow, board)).toBe(true);
  });

  it("returns true for architect agent on large tier with revise transition (second check)", () => {
    const stateDef: StateDefinition = {
      agent: "canon-architect",
      transitions: { revise: "design" },
      type: "single",
    };
    const flow = makeFlow("large");
    const board = makeBoard();
    expect(shouldApprovalGate(stateDef, flow, board)).toBe(true);
  });

  it("returns false for non-architect agent on medium tier", () => {
    const stateDef: StateDefinition = { agent: "canon:canon-implementor", type: "single" };
    const flow = makeFlow("medium");
    const board = makeBoard();
    expect(shouldApprovalGate(stateDef, flow, board)).toBe(false);
  });

  it("returns false for small tier (no tier defaults)", () => {
    const stateDef: StateDefinition = { agent: "canon-architect", type: "single" };
    const flow = makeFlow("small");
    const board = makeBoard();
    expect(shouldApprovalGate(stateDef, flow, board)).toBe(false);
  });

  it("returns false for small tier with architect agent (no tier defaults)", () => {
    const stateDef: StateDefinition = { agent: "canon-architect", type: "single" };
    const flow = makeFlow("small");
    const board = makeBoard();
    // small has no tier defaults
    expect(shouldApprovalGate(stateDef, flow, board)).toBe(false);
  });

  it("returns false when auto_approve metadata is true", () => {
    const stateDef: StateDefinition = { approval_gate: true, type: "single" };
    const flow = makeFlow("large");
    const board = makeBoard({ auto_approve: true });
    expect(shouldApprovalGate(stateDef, flow, board)).toBe(false);
  });

  it("returns false when stateDef is undefined", () => {
    const flow = makeFlow("large");
    const board = makeBoard();
    expect(shouldApprovalGate(undefined, flow, board)).toBe(false);
  });

  it("returns false for architect agent on medium tier when transitions lack approval keys", () => {
    // Simulates flows like migrate.md where design only has done/has_questions
    const stateDef: StateDefinition = {
      agent: "canon-architect",
      transitions: { done: "implement", has_questions: "hitl" },
      type: "single",
    };
    const flow = makeFlow("medium");
    const board = makeBoard();
    expect(shouldApprovalGate(stateDef, flow, board)).toBe(false);
  });

  it("returns false for architect agent on large tier when transitions are empty", () => {
    const stateDef: StateDefinition = {
      agent: "canon-architect",
      transitions: {},
      type: "single",
    };
    const flow = makeFlow("large");
    const board = makeBoard();
    expect(shouldApprovalGate(stateDef, flow, board)).toBe(false);
  });

  it("returns true for architect agent on medium tier when transitions include 'approved'", () => {
    const stateDef: StateDefinition = {
      agent: "canon-architect",
      transitions: { approved: "implement", revise: "design" },
      type: "single",
    };
    const flow = makeFlow("medium");
    const board = makeBoard();
    expect(shouldApprovalGate(stateDef, flow, board)).toBe(true);
  });

  it("auto_approve false does not override explicit approval_gate: true", () => {
    const stateDef: StateDefinition = { approval_gate: true, type: "single" };
    const flow = makeFlow("large");
    const board = makeBoard({ auto_approve: false });
    expect(shouldApprovalGate(stateDef, flow, board)).toBe(true);
  });
});

// shouldApprovalGateWaveBoundary tests

describe("shouldApprovalGateWaveBoundary", () => {
  it("returns true for large tier (tier default)", () => {
    const stateDef: StateDefinition = { type: "wave" };
    const flow = makeFlow("large");
    const board = makeBoard();
    expect(shouldApprovalGateWaveBoundary(stateDef, flow, board)).toBe(true);
  });

  it("returns true for large tier (second check)", () => {
    const stateDef: StateDefinition = { type: "wave" };
    const flow = makeFlow("large");
    const board = makeBoard();
    expect(shouldApprovalGateWaveBoundary(stateDef, flow, board)).toBe(true);
  });

  it("returns false for medium tier", () => {
    const stateDef: StateDefinition = { type: "wave" };
    const flow = makeFlow("medium");
    const board = makeBoard();
    expect(shouldApprovalGateWaveBoundary(stateDef, flow, board)).toBe(false);
  });

  it("returns false for small tier", () => {
    const stateDef: StateDefinition = { type: "wave" };
    const flow = makeFlow("small");
    const board = makeBoard();
    expect(shouldApprovalGateWaveBoundary(stateDef, flow, board)).toBe(false);
  });

  it("returns false when auto_approve is true", () => {
    const stateDef: StateDefinition = { type: "wave" };
    const flow = makeFlow("large");
    const board = makeBoard({ auto_approve: true });
    expect(shouldApprovalGateWaveBoundary(stateDef, flow, board)).toBe(false);
  });

  it("returns true for explicit approval_gate: true even on medium tier (not large)", () => {
    const stateDef: StateDefinition = { approval_gate: true, type: "wave" };
    const flow = makeFlow("medium");
    const board = makeBoard();
    expect(shouldApprovalGateWaveBoundary(stateDef, flow, board)).toBe(true);
  });

  it("returns false for explicit approval_gate: false on large tier", () => {
    const stateDef: StateDefinition = { approval_gate: false, type: "wave" };
    const flow = makeFlow("large");
    const board = makeBoard();
    expect(shouldApprovalGateWaveBoundary(stateDef, flow, board)).toBe(false);
  });

  it("returns false when stateDef is undefined", () => {
    const flow = makeFlow("large");
    const board = makeBoard();
    expect(shouldApprovalGateWaveBoundary(undefined, flow, board)).toBe(false);
  });

  it("returns false for non-wave state type on large tier (type guard)", () => {
    const stateDef: StateDefinition = { agent: "canon-architect", type: "single" };
    const flow = makeFlow("large");
    const board = makeBoard();
    expect(shouldApprovalGateWaveBoundary(stateDef, flow, board)).toBe(false);
  });

  it("returns false for parallel state type on large tier (type guard)", () => {
    const stateDef: StateDefinition = { type: "parallel" };
    const flow = makeFlow("large");
    const board = makeBoard();
    expect(shouldApprovalGateWaveBoundary(stateDef, flow, board)).toBe(false);
  });
});

// initBoard — max_revisions and approval_gate defaults

describe("initBoard with approval gate fields", () => {
  function makeMinimalFlow(
    stateOverrides?: Partial<Record<string, StateDefinition>>,
  ): ResolvedFlow {
    return {
      description: "test",
      entry: "design",
      name: "test-flow",
      spawn_instructions: {},
      states: {
        design: { agent: "canon:canon-architect", type: "single" },
        terminal: { type: "terminal" },
        ...stateOverrides,
      },
    } as ResolvedFlow;
  }

  it("creates IterationEntry from max_revisions when present", () => {
    const flow = makeMinimalFlow({
      design: { approval_gate: true, max_revisions: 5, type: "single" },
    });
    const board = initBoard(flow, "task", "abc");
    expect(board.iterations.design).toEqual({
      cannot_fix: [],
      count: 0,
      history: [],
      max: 5,
    });
  });

  it("max_revisions takes precedence over max_iterations", () => {
    const flow = makeMinimalFlow({
      design: { max_iterations: 10, max_revisions: 4, type: "single" },
    });
    const board = initBoard(flow, "task", "abc");
    expect(board.iterations.design).toEqual({
      cannot_fix: [],
      count: 0,
      history: [],
      max: 4,
    });
  });

  it("creates default IterationEntry (max: 3) for approval_gate: true without explicit limits", () => {
    const flow = makeMinimalFlow({
      design: { approval_gate: true, type: "single" },
    });
    const board = initBoard(flow, "task", "abc");
    expect(board.iterations.design).toEqual({
      cannot_fix: [],
      count: 0,
      history: [],
      max: 3,
    });
  });

  it("does NOT create IterationEntry for non-gated states without max_iterations", () => {
    const flow = makeMinimalFlow({
      design: { agent: "canon:canon-architect", type: "single" },
    });
    const board = initBoard(flow, "task", "abc");
    expect(board.iterations.design).toBeUndefined();
  });

  it("still uses max_iterations when approval_gate is not set", () => {
    const flow = makeMinimalFlow({
      design: { max_iterations: 7, type: "single" },
    });
    const board = initBoard(flow, "task", "abc");
    expect(board.iterations.design).toEqual({
      cannot_fix: [],
      count: 0,
      history: [],
      max: 7,
    });
  });
});

// driveFlow — Branch A approval gate intercept

vi.mock("../tools/enter-and-prepare-state.ts", () => ({
  enterAndPrepareState: vi.fn(),
}));
vi.mock("../tools/report-result.ts", () => ({
  reportResult: vi.fn(),
}));

import { initExecutionDb } from "../orchestration/execution-schema.ts";
import { clearStoreCache, ExecutionStore } from "../orchestration/execution-store.ts";
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

    const result = await driveFlow({
      flow,
      result: {
        artifacts: ["/workspace/plan.md"],
        state_id: "design",
        status: "done",
      },
      workspace,
    });

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

    const result = await driveFlow({
      flow: flowWithParallel,
      result: {
        state_id: "parallel-review",
        status: "done",
      },
      workspace,
    });

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

    // Use a flow where design does NOT have approval_gate (simulate post-approval)
    const flowWithoutGate: ResolvedFlow = {
      description: "test",
      entry: "design",
      name: "test-flow",
      spawn_instructions: { design: "Design", implement: "Implement" },
      states: {
        design: {
          agent: "canon:canon-researcher", // not architect, no tier default
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

    const result = await driveFlow({
      flow: flowWithoutGate,
      result: {
        state_id: "design",
        status: "approved",
      },
      workspace,
    });

    // Should advance to implement state
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    expect(result.requests.length).toBeGreaterThan(0);
    expect(result.requests[0]!.agent_type).toBe("canon:canon-implementor");
  });

  it("revise status with transition to a different state spawns correctly", async () => {
    // When 'revise' transitions to a different state (e.g. 'redesign'),
    // the approval gate does not fire and normal spawn occurs.
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(enterAndPrepareState).mockResolvedValue(
      makeEnterResult({
        prompts: [
          { agent: "canon:canon-researcher", prompt: "Redesign", role: "main", template_paths: [] },
        ],
      }),
    );
    // revise → redesign (different state, not looping back)
    vi.mocked(reportResult).mockResolvedValue(
      makeReportResult("implement", { transition_condition: "revise" }) as any,
    );

    const flowWithRevise: ResolvedFlow = {
      description: "test",
      entry: "design",
      name: "test-flow",
      spawn_instructions: { design: "Design", implement: "Implement" },
      states: {
        design: {
          agent: "canon:canon-researcher", // not architect — no tier default gate
          transitions: { done: "implement", revise: "implement" },
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

    const result = await driveFlow({
      flow: flowWithRevise,
      result: {
        state_id: "design",
        status: "revise",
      },
      workspace,
    });

    // No approval gate on design (not architect, no explicit gate) — should advance to implement
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    expect(result.requests.length).toBeGreaterThan(0);
  });

  it("does not fire approval gate on non-architect state on small tier", async () => {
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

    const result = await driveFlow({
      flow,
      result: {
        state_id: "design",
        status: "done",
      },
      workspace,
    });

    // No approval gate on small tier — should advance to implement
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

    const result = await driveFlow({
      flow,
      result: {
        state_id: "design",
        status: "approved",
      },
      workspace,
    });

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

    const result = await driveFlow({
      flow,
      result: {
        state_id: "design",
        status: "revise",
      },
      workspace,
    });

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

    const result = await driveFlow({
      flow,
      result: {
        state_id: "design",
        status: "reject",
      },
      workspace,
    });

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

    const result = await driveFlow({
      flow: flowWithSelfTransition,
      result: {
        state_id: "design",
        status: "revise",
      },
      workspace,
    });

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

import { STATUS_ALIASES } from "../orchestration/flow-schema.ts";

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
