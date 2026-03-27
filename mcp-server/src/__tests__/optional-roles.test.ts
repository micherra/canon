/**
 * Tests for optional role handling in parallel failure aggregation.
 *
 * Covers:
 * 1. aggregateParallelPerResults: optional role failures are ignored (don't block)
 * 2. aggregateParallelPerResults: required role failures still block
 * 3. aggregateParallelPerResults: optional roles excluded from cannot_fix propagation
 * 4. isRoleOptional: correctly identifies optional roles from RoleEntry
 * 5. reportResult: threads optional roles from state definition into aggregation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateParallelPerResults, isRoleOptional } from "../orchestration/transitions.ts";

// ---------------------------------------------------------------------------
// Hoist mocks before module imports for reportResult integration tests
// ---------------------------------------------------------------------------

vi.mock("../orchestration/workspace.js", () => ({
  withBoardLock: vi.fn(async (_workspace: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("../orchestration/event-bus-instance.js", () => ({
  flowEventBus: {
    emit: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock("../orchestration/events.js", () => ({
  createJsonlLogger: vi.fn(() => vi.fn().mockResolvedValue(undefined)),
}));

vi.mock("../orchestration/effects.js", () => ({
  executeEffects: vi.fn().mockResolvedValue(undefined),
}));

import { withBoardLock } from "../orchestration/workspace.ts";
import { reportResult } from "../tools/report-result.ts";
import { readBoard, writeBoard, initBoard } from "../orchestration/board.ts";
import type { ResolvedFlow } from "../orchestration/flow-schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "optional-roles-test-"));
}

function makeFlowWithOptionalRoles(): ResolvedFlow {
  return {
    name: "test-flow",
    description: "test",
    entry: "review",
    states: {
      review: {
        type: "parallel",
        agents: ["canon:canon-reviewer"],
        roles: [
          "required-reviewer",
          { name: "optional-reviewer", optional: true },
        ],
        transitions: {
          done: "ship",
          blocked: "hitl",
        },
      },
      ship: { type: "terminal" },
      hitl: { type: "terminal" },
    },
    spawn_instructions: {
      review: "Review from role ${role}",
    },
  };
}

// ---------------------------------------------------------------------------
// Unit tests: aggregateParallelPerResults with optionalRoles
// ---------------------------------------------------------------------------

describe("aggregateParallelPerResults — optional roles", () => {
  it("does not block when only optional roles are blocked", () => {
    const results = [
      { status: "done", item: "required-reviewer" },
      { status: "blocked", item: "optional-reviewer" },
    ];
    const optionalRoles = new Set(["optional-reviewer"]);
    const result = aggregateParallelPerResults(results, optionalRoles);
    expect(result.condition).toBe("done");
    expect(result.cannotFixItems).toEqual([]);
  });

  it("blocks when a required role is blocked (optional role also blocked)", () => {
    const results = [
      { status: "blocked", item: "required-reviewer" },
      { status: "blocked", item: "optional-reviewer" },
    ];
    const optionalRoles = new Set(["optional-reviewer"]);
    const result = aggregateParallelPerResults(results, optionalRoles);
    expect(result.condition).toBe("blocked");
  });

  it("blocks when a required role is blocked (optional role is done)", () => {
    const results = [
      { status: "blocked", item: "required-reviewer" },
      { status: "done", item: "optional-reviewer" },
    ];
    const optionalRoles = new Set(["optional-reviewer"]);
    const result = aggregateParallelPerResults(results, optionalRoles);
    expect(result.condition).toBe("blocked");
  });

  it("excludes optional roles from cannot_fix items", () => {
    const results = [
      { status: "done", item: "required-reviewer" },
      { status: "cannot_fix", item: "optional-reviewer" },
    ];
    const optionalRoles = new Set(["optional-reviewer"]);
    const result = aggregateParallelPerResults(results, optionalRoles);
    // optional cannot_fix does not count — required is done → overall done
    expect(result.condition).toBe("done");
    expect(result.cannotFixItems).toEqual([]);
  });

  it("counts required cannot_fix items even when optional role is blocked", () => {
    const results = [
      { status: "cannot_fix", item: "required-reviewer" },
      { status: "blocked", item: "optional-reviewer" },
    ];
    const optionalRoles = new Set(["optional-reviewer"]);
    const result = aggregateParallelPerResults(results, optionalRoles);
    // required is cannot_fix, optional blocked is ignored → all required results are cannot_fix
    expect(result.condition).toBe("cannot_fix");
    expect(result.cannotFixItems).toEqual(["required-reviewer"]);
  });

  it("preserves existing behavior when no optional roles provided", () => {
    // Same as existing test: blocked result blocks everything
    const results = [
      { status: "done", item: "a" },
      { status: "blocked", item: "b" },
    ];
    expect(aggregateParallelPerResults(results)).toEqual({
      condition: "blocked",
      cannotFixItems: [],
    });
  });

  it("preserves existing behavior when optional roles set is empty", () => {
    const results = [
      { status: "done", item: "a" },
      { status: "blocked", item: "b" },
    ];
    expect(aggregateParallelPerResults(results, new Set())).toEqual({
      condition: "blocked",
      cannotFixItems: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Unit tests: isRoleOptional helper
// ---------------------------------------------------------------------------

describe("isRoleOptional", () => {
  it("returns false for string role entries", () => {
    expect(isRoleOptional("required-role")).toBe(false);
  });

  it("returns true for object role with optional: true", () => {
    expect(isRoleOptional({ name: "optional-role", optional: true })).toBe(true);
  });

  it("returns false for object role with optional: false", () => {
    expect(isRoleOptional({ name: "required-role", optional: false })).toBe(false);
  });

  it("returns false for object role with no optional field", () => {
    expect(isRoleOptional({ name: "required-role" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: reportResult threads optional roles through aggregation
// ---------------------------------------------------------------------------

describe("reportResult — optional roles in parallel state", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = makeTmpWorkspace();
    vi.clearAllMocks();
    vi.mocked(withBoardLock).mockImplementation(async (_ws, fn) => fn());
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("does not block when only optional roles report blocked status", async () => {
    const flow = makeFlowWithOptionalRoles();
    const board = initBoard(flow, "test task", "abc123");
    await writeBoard(workspace, board);

    const result = await reportResult({
      workspace,
      state_id: "review",
      status_keyword: "done",
      flow,
      parallel_results: [
        { item: "required-reviewer", status: "done" },
        { item: "optional-reviewer", status: "blocked" },
      ],
    });

    expect(result.transition_condition).toBe("done");
    expect(result.next_state).toBe("ship");
    expect(result.hitl_required).toBe(false);
  });

  it("blocks when a required role reports blocked status", async () => {
    const flow = makeFlowWithOptionalRoles();
    const board = initBoard(flow, "test task", "abc123");
    await writeBoard(workspace, board);

    const result = await reportResult({
      workspace,
      state_id: "review",
      status_keyword: "done",
      flow,
      parallel_results: [
        { item: "required-reviewer", status: "blocked" },
        { item: "optional-reviewer", status: "done" },
      ],
    });

    expect(result.transition_condition).toBe("blocked");
    expect(result.next_state).toBe("hitl");
  });

  it("transitions to done when all required roles done and optional role needs_context", async () => {
    const flow = makeFlowWithOptionalRoles();
    const board = initBoard(flow, "test task", "abc123");
    await writeBoard(workspace, board);

    const result = await reportResult({
      workspace,
      state_id: "review",
      status_keyword: "done",
      flow,
      parallel_results: [
        { item: "required-reviewer", status: "done" },
        { item: "optional-reviewer", status: "needs_context" },
      ],
    });

    // needs_context normalizes to hitl, but since it's from an optional role it should not block
    // The parallel_results status "needs_context" is treated as blocked for aggregation purposes
    // Verifying that aggregation passes the optional roles filter correctly
    expect(result.transition_condition).toBe("done");
    expect(result.hitl_required).toBe(false);
  });
});
