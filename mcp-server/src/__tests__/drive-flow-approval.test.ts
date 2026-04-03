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

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// shouldApprovalGate and shouldApprovalGateWaveBoundary (pure functions)
// ---------------------------------------------------------------------------

import { shouldApprovalGate, shouldApprovalGateWaveBoundary } from "../tools/drive-flow.ts";
import type { Board, StateDefinition } from "../orchestration/flow-schema.ts";
import type { DriveFlowInput } from "../orchestration/drive-flow-types.ts";
import { initBoard } from "../orchestration/board.ts";
import type { ResolvedFlow } from "../orchestration/flow-schema.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeBoard(metadataOverrides?: Record<string, string | number | boolean>): Board {
  return {
    flow: "test-flow",
    task: "test",
    entry: "design",
    current_state: "design",
    base_commit: "abc",
    started: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    blocked: null,
    concerns: [],
    skipped: [],
    states: {},
    iterations: {},
    metadata: metadataOverrides,
  };
}

function makeFlow(tier: "small" | "medium" | "large" | undefined, stateOverrides?: Record<string, StateDefinition>): DriveFlowInput["flow"] {
  return {
    name: "test-flow",
    description: "test",
    entry: "design",
    tier,
    spawn_instructions: {},
    states: {
      design: {
        type: "single",
        agent: "canon-architect",
        transitions: { approved: "implement", revise: "design", reject: "terminal" },
      },
      implement: {
        type: "single",
        agent: "canon:canon-implementor",
      },
      terminal: {
        type: "terminal",
      },
      ...stateOverrides,
    },
  } as DriveFlowInput["flow"];
}

// ---------------------------------------------------------------------------
// shouldApprovalGate tests
// ---------------------------------------------------------------------------

describe("shouldApprovalGate", () => {
  it("returns true for explicit approval_gate: true", () => {
    const stateDef: StateDefinition = { type: "single", approval_gate: true };
    const flow = makeFlow("small");
    const board = makeBoard();
    expect(shouldApprovalGate(stateDef, flow, board)).toBe(true);
  });

  it("returns false for explicit approval_gate: false", () => {
    const stateDef: StateDefinition = { type: "single", approval_gate: false };
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
      type: "single", agent: "canon-architect",
      transitions: { approved: "implement", revise: "design" },
    };
    const flow = makeFlow("medium");
    const board = makeBoard();
    expect(shouldApprovalGate(stateDef, flow, board)).toBe(true);
  });

  it("returns true for architect agent on medium tier with reject transition (second check)", () => {
    const stateDef: StateDefinition = {
      type: "single", agent: "canon-architect",
      transitions: { reject: "hitl" },
    };
    const flow = makeFlow("medium");
    const board = makeBoard();
    // medium tier should gate architect states when approval transitions exist
    expect(shouldApprovalGate(stateDef, flow, board)).toBe(true);
  });

  it("returns true for architect agent on large tier with approval transitions (tier default)", () => {
    const stateDef: StateDefinition = {
      type: "single", agent: "canon-architect",
      transitions: { approved: "implement", revise: "design", reject: "hitl" },
    };
    const flow = makeFlow("large");
    const board = makeBoard();
    expect(shouldApprovalGate(stateDef, flow, board)).toBe(true);
  });

  it("returns true for architect agent on large tier with revise transition (second check)", () => {
    const stateDef: StateDefinition = {
      type: "single", agent: "canon-architect",
      transitions: { revise: "design" },
    };
    const flow = makeFlow("large");
    const board = makeBoard();
    expect(shouldApprovalGate(stateDef, flow, board)).toBe(true);
  });

  it("returns false for non-architect agent on medium tier", () => {
    const stateDef: StateDefinition = { type: "single", agent: "canon:canon-implementor" };
    const flow = makeFlow("medium");
    const board = makeBoard();
    expect(shouldApprovalGate(stateDef, flow, board)).toBe(false);
  });

  it("returns false for small tier (no tier defaults)", () => {
    const stateDef: StateDefinition = { type: "single", agent: "canon-architect" };
    const flow = makeFlow("small");
    const board = makeBoard();
    expect(shouldApprovalGate(stateDef, flow, board)).toBe(false);
  });

  it("returns false for small tier with architect agent (no tier defaults)", () => {
    const stateDef: StateDefinition = { type: "single", agent: "canon-architect" };
    const flow = makeFlow("small");
    const board = makeBoard();
    // small has no tier defaults
    expect(shouldApprovalGate(stateDef, flow, board)).toBe(false);
  });

  it("returns false when auto_approve metadata is true", () => {
    const stateDef: StateDefinition = { type: "single", approval_gate: true };
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
      type: "single",
      agent: "canon-architect",
      transitions: { done: "implement", has_questions: "hitl" },
    };
    const flow = makeFlow("medium");
    const board = makeBoard();
    expect(shouldApprovalGate(stateDef, flow, board)).toBe(false);
  });

  it("returns false for architect agent on large tier when transitions are empty", () => {
    const stateDef: StateDefinition = {
      type: "single",
      agent: "canon-architect",
      transitions: {},
    };
    const flow = makeFlow("large");
    const board = makeBoard();
    expect(shouldApprovalGate(stateDef, flow, board)).toBe(false);
  });

  it("returns true for architect agent on medium tier when transitions include 'approved'", () => {
    const stateDef: StateDefinition = {
      type: "single",
      agent: "canon-architect",
      transitions: { approved: "implement", revise: "design" },
    };
    const flow = makeFlow("medium");
    const board = makeBoard();
    expect(shouldApprovalGate(stateDef, flow, board)).toBe(true);
  });

  it("auto_approve false does not override explicit approval_gate: true", () => {
    const stateDef: StateDefinition = { type: "single", approval_gate: true };
    const flow = makeFlow("large");
    const board = makeBoard({ auto_approve: false });
    expect(shouldApprovalGate(stateDef, flow, board)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// shouldApprovalGateWaveBoundary tests
// ---------------------------------------------------------------------------

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
    const stateDef: StateDefinition = { type: "wave", approval_gate: true };
    const flow = makeFlow("medium");
    const board = makeBoard();
    expect(shouldApprovalGateWaveBoundary(stateDef, flow, board)).toBe(true);
  });

  it("returns false for explicit approval_gate: false on large tier", () => {
    const stateDef: StateDefinition = { type: "wave", approval_gate: false };
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
    const stateDef: StateDefinition = { type: "single", agent: "canon-architect" };
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

// ---------------------------------------------------------------------------
// initBoard — max_revisions and approval_gate defaults
// ---------------------------------------------------------------------------

describe("initBoard with approval gate fields", () => {
  function makeMinimalFlow(stateOverrides?: Partial<Record<string, StateDefinition>>): ResolvedFlow {
    return {
      name: "test-flow",
      description: "test",
      entry: "design",
      spawn_instructions: {},
      states: {
        design: { type: "single", agent: "canon:canon-architect" },
        terminal: { type: "terminal" },
        ...stateOverrides,
      },
    } as ResolvedFlow;
  }

  it("creates IterationEntry from max_revisions when present", () => {
    const flow = makeMinimalFlow({
      design: { type: "single", approval_gate: true, max_revisions: 5 },
    });
    const board = initBoard(flow, "task", "abc");
    expect(board.iterations.design).toEqual({
      count: 0,
      max: 5,
      history: [],
      cannot_fix: [],
    });
  });

  it("max_revisions takes precedence over max_iterations", () => {
    const flow = makeMinimalFlow({
      design: { type: "single", max_revisions: 4, max_iterations: 10 },
    });
    const board = initBoard(flow, "task", "abc");
    expect(board.iterations.design).toEqual({
      count: 0,
      max: 4,
      history: [],
      cannot_fix: [],
    });
  });

  it("creates default IterationEntry (max: 3) for approval_gate: true without explicit limits", () => {
    const flow = makeMinimalFlow({
      design: { type: "single", approval_gate: true },
    });
    const board = initBoard(flow, "task", "abc");
    expect(board.iterations.design).toEqual({
      count: 0,
      max: 3,
      history: [],
      cannot_fix: [],
    });
  });

  it("does NOT create IterationEntry for non-gated states without max_iterations", () => {
    const flow = makeMinimalFlow({
      design: { type: "single", agent: "canon:canon-architect" },
    });
    const board = initBoard(flow, "task", "abc");
    expect(board.iterations.design).toBeUndefined();
  });

  it("still uses max_iterations when approval_gate is not set", () => {
    const flow = makeMinimalFlow({
      design: { type: "single", max_iterations: 7 },
    });
    const board = initBoard(flow, "task", "abc");
    expect(board.iterations.design).toEqual({
      count: 0,
      max: 7,
      history: [],
      cannot_fix: [],
    });
  });
});

// ---------------------------------------------------------------------------
// driveFlow — Branch A approval gate intercept
// ---------------------------------------------------------------------------

vi.mock("../tools/enter-and-prepare-state.ts", () => ({
  enterAndPrepareState: vi.fn(),
}));
vi.mock("../tools/report-result.ts", () => ({
  reportResult: vi.fn(),
}));

import { driveFlow } from "../tools/drive-flow.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";
import { reportResult } from "../tools/report-result.ts";
import { initExecutionDb } from "../orchestration/execution-schema.ts";
import { ExecutionStore, clearStoreCache } from "../orchestration/execution-store.ts";
import type { EnterAndPrepareStateResult } from "../tools/enter-and-prepare-state.ts";

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
    flow: "test-flow",
    task: "build feature",
    entry: "design",
    current_state: "design",
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

function makeApprovalFlow(tier: "small" | "medium" | "large" | undefined = "medium"): ResolvedFlow {
  return {
    name: "test-flow",
    description: "test",
    entry: "design",
    tier,
    spawn_instructions: {
      design: "Design something",
      implement: "Implement it",
    },
    states: {
      design: {
        type: "single",
        agent: "canon-architect",
        approval_gate: true,
        transitions: {
          done: "implement",
          approved: "implement",
          revise: "design",
        },
      },
      implement: {
        type: "single",
        agent: "canon:canon-implementor",
        transitions: { done: "terminal" },
      },
      terminal: {
        type: "terminal",
      },
    },
  } as unknown as ResolvedFlow;
}

function makeEnterResult(
  overrides: Partial<EnterAndPrepareStateResult> = {}
): { ok: true } & EnterAndPrepareStateResult {
  return {
    ok: true,
    can_enter: true,
    iteration_count: 1,
    max_iterations: 3,
    cannot_fix_items: [],
    history: [],
    prompts: [
      {
        agent: "canon-architect",
        prompt: "Design the feature",
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
    board: {
      flow: "test-flow",
      task: "build feature",
      entry: "design",
      current_state: nextState ?? "terminal",
      base_commit: "abc123",
      started: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      blocked: null,
      concerns: [],
      skipped: [],
      states: {},
      iterations: {},
    },
    log_entry: {},
    ...overrides,
  };
}

afterEach(() => {
  clearStoreCache();
  vi.clearAllMocks();
  for (const d of tmpDirs) {
    rmSync(d, { recursive: true, force: true });
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
      workspace,
      flow,
      result: {
        state_id: "design",
        status: "done",
        artifacts: ["/workspace/plan.md"],
      },
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

    vi.mocked(reportResult).mockResolvedValue(
      makeReportResult("parallel-review") as any,
    );

    // Build a flow where the state with same next_state is type: parallel
    const flowWithParallel: ResolvedFlow = {
      name: "test-flow",
      description: "test",
      entry: "parallel-review",
      tier: "medium",
      spawn_instructions: { "parallel-review": "Review in parallel" },
      states: {
        "parallel-review": {
          type: "parallel",
          approval_gate: true,
          transitions: { done: "terminal" },
        },
        terminal: { type: "terminal" },
      },
    } as unknown as ResolvedFlow;

    const result = await driveFlow({
      workspace,
      flow: flowWithParallel,
      result: {
        state_id: "parallel-review",
        status: "done",
      },
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

    vi.mocked(enterAndPrepareState).mockResolvedValue(makeEnterResult({
      prompts: [{ agent: "canon:canon-implementor", prompt: "Implement", template_paths: [], role: "main" }],
    }));
    vi.mocked(reportResult).mockResolvedValue(
      makeReportResult("implement", { transition_condition: "approved" }) as any,
    );

    // Use a flow where design does NOT have approval_gate (simulate post-approval)
    const flowWithoutGate: ResolvedFlow = {
      name: "test-flow",
      description: "test",
      entry: "design",
      spawn_instructions: { design: "Design", implement: "Implement" },
      states: {
        design: {
          type: "single",
          agent: "canon:canon-researcher", // not architect, no tier default
          transitions: { approved: "implement" },
        },
        implement: {
          type: "single",
          agent: "canon:canon-implementor",
          transitions: { done: "terminal" },
        },
        terminal: { type: "terminal" },
      },
    } as unknown as ResolvedFlow;

    const result = await driveFlow({
      workspace,
      flow: flowWithoutGate,
      result: {
        state_id: "design",
        status: "approved",
      },
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

    vi.mocked(enterAndPrepareState).mockResolvedValue(makeEnterResult({
      prompts: [{ agent: "canon:canon-researcher", prompt: "Redesign", template_paths: [], role: "main" }],
    }));
    // revise → redesign (different state, not looping back)
    vi.mocked(reportResult).mockResolvedValue(
      makeReportResult("implement", { transition_condition: "revise" }) as any,
    );

    const flowWithRevise: ResolvedFlow = {
      name: "test-flow",
      description: "test",
      entry: "design",
      spawn_instructions: { design: "Design", implement: "Implement" },
      states: {
        design: {
          type: "single",
          agent: "canon:canon-researcher", // not architect — no tier default gate
          transitions: { revise: "implement", done: "implement" },
        },
        implement: {
          type: "single",
          agent: "canon:canon-implementor",
          transitions: { done: "terminal" },
        },
        terminal: { type: "terminal" },
      },
    } as unknown as ResolvedFlow;

    const result = await driveFlow({
      workspace,
      flow: flowWithRevise,
      result: {
        state_id: "design",
        status: "revise",
      },
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

    vi.mocked(enterAndPrepareState).mockResolvedValue(makeEnterResult({
      prompts: [{ agent: "canon:canon-implementor", prompt: "Implement", template_paths: [], role: "main" }],
    }));
    vi.mocked(reportResult).mockResolvedValue(
      makeReportResult("implement") as any,
    );

    const flow: ResolvedFlow = {
      name: "test-flow",
      description: "test",
      entry: "design",
      tier: "small",
      spawn_instructions: { design: "Design", implement: "Implement" },
      states: {
        design: {
          type: "single",
          agent: "canon-architect",
          transitions: { done: "implement" },
        },
        implement: {
          type: "single",
          agent: "canon:canon-implementor",
          transitions: { done: "terminal" },
        },
        terminal: { type: "terminal" },
      },
    } as unknown as ResolvedFlow;

    const result = await driveFlow({
      workspace,
      flow,
      result: {
        state_id: "design",
        status: "done",
      },
    });

    // No approval gate on small tier — should advance to implement
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    if (result.action !== "spawn") return;
    expect(result.requests[0]?.agent_type).toBe("canon:canon-implementor");
  });
});

// ---------------------------------------------------------------------------
// Infinite loop fix: approval decision statuses skip the gate (fix #1)
// ---------------------------------------------------------------------------

describe("driveFlow — approval decision statuses do NOT re-trigger the gate", () => {
  it("'approved' status on an approval_gate: true state skips the gate (no infinite loop)", async () => {
    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    vi.mocked(enterAndPrepareState).mockResolvedValue(makeEnterResult({
      prompts: [{ agent: "canon:canon-implementor", prompt: "Implement", template_paths: [], role: "main" }],
    }));
    vi.mocked(reportResult).mockResolvedValue(
      makeReportResult("implement", { transition_condition: "approved" }) as any,
    );

    // approval_gate: true on design — but status is "approved", so gate must NOT fire again
    const flow = makeApprovalFlow("medium");

    const result = await driveFlow({
      workspace,
      flow,
      result: {
        state_id: "design",
        status: "approved",
      },
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
      workspace,
      flow,
      result: {
        state_id: "design",
        status: "revise",
      },
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
        hitl_required: true,
        hitl_reason: "Design rejected",
        transition_condition: "reject",
      }) as any,
    );

    const flow = makeApprovalFlow("medium");

    const result = await driveFlow({
      workspace,
      flow,
      result: {
        state_id: "design",
        status: "reject",
      },
    });

    // "reject" is an approval decision — gate must not re-fire (hitl comes from report_result)
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).not.toBe("approval");
  });
});

// ---------------------------------------------------------------------------
// Self-transition: revise: design re-enters the same state (fix #2)
// ---------------------------------------------------------------------------

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
      name: "test-flow",
      description: "test",
      entry: "design",
      tier: "medium",
      spawn_instructions: { design: "Design something" },
      states: {
        design: {
          type: "single",
          agent: "canon-architect",
          // Explicit approval_gate: false so only the revise path is tested
          approval_gate: false,
          transitions: {
            revise: "design",  // self-transition
            done: "terminal",
          },
        },
        terminal: { type: "terminal" },
      },
    } as unknown as ResolvedFlow;

    const result = await driveFlow({
      workspace,
      flow: flowWithSelfTransition,
      result: {
        state_id: "design",
        status: "revise",
      },
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

// ---------------------------------------------------------------------------
// Fix 4: STATUS_ALIASES — "approve" maps to "approved"
// ---------------------------------------------------------------------------

import { STATUS_ALIASES } from "../orchestration/flow-schema.ts";

describe("STATUS_ALIASES — approve alias", () => {
  it("'approve' maps to 'approved'", () => {
    expect(STATUS_ALIASES["approve"]).toBe("approved");
  });

  it("existing aliases are preserved", () => {
    expect(STATUS_ALIASES["fixed"]).toBe("done");
    expect(STATUS_ALIASES["needs_context"]).toBe("hitl");
    expect(STATUS_ALIASES["epic_complete"]).toBe("epic_complete");
  });
});

// ---------------------------------------------------------------------------
// Fix 5: init-workspace iteration persistence for max_revisions
// ---------------------------------------------------------------------------

describe("init-workspace — iteration persistence matches initBoard for approval gates", () => {
  it("initBoard creates iteration from max_revisions (not just max_iterations)", () => {
    const flow = {
      name: "test-flow",
      description: "test",
      entry: "design",
      spawn_instructions: {},
      states: {
        design: { type: "single" as const, max_revisions: 5 },
        terminal: { type: "terminal" as const },
      },
    } as ResolvedFlow;
    const board = initBoard(flow, "task", "abc");
    expect(board.iterations.design).toBeDefined();
    expect(board.iterations.design!.max).toBe(5);
  });

  it("initBoard creates default iteration (max: 3) for approval_gate: true without explicit limits", () => {
    const flow = {
      name: "test-flow",
      description: "test",
      entry: "design",
      spawn_instructions: {},
      states: {
        design: { type: "single" as const, approval_gate: true },
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
      name: "test-flow",
      description: "test",
      entry: "start",
      spawn_instructions: {},
      states: {
        start: { type: "single" as const },
        terminal: { type: "terminal" as const, approval_gate: true },
      },
    } as ResolvedFlow;
    const board = initBoard(flow, "task", "abc");
    expect(board.iterations.terminal).toBeUndefined();
  });
});
