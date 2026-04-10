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
 *
 * See drive-flow-approval-gates.test.ts for:
 * - Approval decision statuses do NOT re-trigger the gate
 * - Self-transition on single state
 * - STATUS_ALIASES
 * - init-workspace iteration persistence
 */

import { describe, expect, it } from "vitest";

// shouldApprovalGate and shouldApprovalGateWaveBoundary (pure functions)

import { initBoard } from "@domains/board/board.ts";
import type { Board } from "@domains/flows/board-state-schemas.ts";
import type { ResolvedFlow, StateDefinition } from "@domains/flows/flow-definition-schemas.ts";
import type { DriveFlowInput } from "../services/drive-flow-types.ts";
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
