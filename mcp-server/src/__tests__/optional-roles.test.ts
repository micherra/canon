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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aggregateParallelPerResults, isRoleOptional } from "../orchestration/transitions.ts";

// ---------------------------------------------------------------------------
// Hoist mocks before module imports for reportResult integration tests
// ---------------------------------------------------------------------------

vi.mock("../orchestration/event-bus-instance.ts", () => ({
  flowEventBus: {
    emit: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock("../orchestration/effects.ts", () => ({
  executeEffects: vi.fn().mockResolvedValue(undefined),
}));

import { getExecutionStore } from "../orchestration/execution-store.ts";
import type { ResolvedFlow } from "../orchestration/flow-schema.ts";
import { reportResult } from "../tools/report-result.ts";
import { assertOk } from "../utils/tool-result.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "optional-roles-test-"));
}

function seedWorkspace(workspace: string, flow: ResolvedFlow): void {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();
  store.initExecution({
    flow: flow.name,
    task: "test task",
    entry: flow.entry,
    current_state: flow.entry,
    base_commit: "abc1234",
    started: now,
    last_updated: now,
    branch: "main",
    sanitized: "main",
    created: now,
    tier: "medium",
    flow_name: flow.name,
    slug: "test-slug",
  });
  for (const stateId of Object.keys(flow.states)) {
    store.upsertState(stateId, { status: "pending", entries: 0 });
  }
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
        roles: ["required-reviewer", { name: "optional-reviewer", optional: true }],
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
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("does not block when only optional roles report blocked status", async () => {
    const flow = makeFlowWithOptionalRoles();
    seedWorkspace(workspace, flow);

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
    assertOk(result);

    expect(result.transition_condition).toBe("done");
    expect(result.next_state).toBe("ship");
    expect(result.hitl_required).toBe(false);
  });

  it("blocks when a required role reports blocked status", async () => {
    const flow = makeFlowWithOptionalRoles();
    seedWorkspace(workspace, flow);

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
    assertOk(result);

    expect(result.transition_condition).toBe("blocked");
    expect(result.next_state).toBe("hitl");
  });

  it("transitions to done when all required roles done and optional role needs_context", async () => {
    const flow = makeFlowWithOptionalRoles();
    seedWorkspace(workspace, flow);

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
    assertOk(result);

    // needs_context normalizes to hitl, but since it's from an optional role it should not block
    // The parallel_results status "needs_context" is treated as blocked for aggregation purposes
    // Verifying that aggregation passes the optional roles filter correctly
    expect(result.transition_condition).toBe("done");
    expect(result.hitl_required).toBe(false);
  });
});
