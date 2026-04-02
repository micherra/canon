import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canEnterState, filterCannotFix } from "../orchestration/convergence.ts";
import { clearStoreCache, getExecutionStore } from "../orchestration/execution-store.ts";
import type { Board, ResolvedFlow } from "../orchestration/flow-schema.ts";
import { checkConvergence } from "../tools/check-convergence.ts";
import { reportResult } from "../tools/report-result.ts";
import { assertOk } from "../utils/tool-result.ts";

function makeBoard(iterations: Board["iterations"]): Board {
  return {
    flow: "test",
    task: "test task",
    entry: "start",
    current_state: "start",
    base_commit: "abc123",
    started: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    states: {},
    iterations,
    blocked: null,
    concerns: [],
    skipped: [],
  } as Board;
}

// ---------------------------------------------------------------------------
// Workspace helpers for round-trip tests
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "convergence-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  clearStoreCache();
  for (const d of tmpDirs) {
    rmSync(d, { recursive: true, force: true });
  }
  tmpDirs = [];
});

/** Flow with a review state that has max_iterations and cannot_fix transition */
function makeFlowWithCannotFix(): ResolvedFlow {
  return {
    name: "test-flow",
    description: "A test flow",
    entry: "review",
    spawn_instructions: {},
    states: {
      review: {
        type: "single",
        max_iterations: 3,
        transitions: {
          done: "ship",
          cannot_fix: "hitl",
        },
      },
      ship: { type: "terminal" },
      hitl: { type: "terminal" },
    },
  };
}

/**
 * Seed a workspace's ExecutionStore with the given flow's initial state.
 * Replaces the old `initBoard(flow) + writeBoard(workspace, board)` pattern.
 */
function seedWorkspace(workspace: string, flow: ResolvedFlow): void {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();
  store.initExecution({
    flow: flow.name,
    task: "test task",
    entry: flow.entry,
    current_state: flow.entry,
    base_commit: "abc123",
    started: now,
    last_updated: now,
    branch: "main",
    sanitized: "main",
    created: now,
    tier: "medium",
    flow_name: flow.name,
    slug: "test-slug",
  });
  for (const [stateId, stateDef] of Object.entries(flow.states)) {
    store.upsertState(stateId, { status: "pending", entries: 0 });
    if (stateDef.max_iterations !== undefined) {
      store.upsertIteration(stateId, { count: 0, max: stateDef.max_iterations, history: [], cannot_fix: [] });
    }
  }
}

describe("canEnterState", () => {
  it("returns allowed when no iteration tracking exists for the state", () => {
    const board = makeBoard({});
    const result = canEnterState(board, "review");
    expect(result).toEqual({ allowed: true });
  });

  it("returns allowed when count < max", () => {
    const board = makeBoard({
      review: { count: 1, max: 3, history: [] },
    });
    const result = canEnterState(board, "review");
    expect(result).toEqual({ allowed: true });
  });

  it("returns not allowed when count === max", () => {
    const board = makeBoard({
      review: { count: 3, max: 3, history: [] },
    });
    const result = canEnterState(board, "review");
    expect(result).toEqual({
      allowed: false,
      reason: "Max iterations (3) reached for state 'review'",
    });
  });

  it("returns not allowed when count > max", () => {
    const board = makeBoard({
      review: { count: 5, max: 3, history: [] },
    });
    const result = canEnterState(board, "review");
    expect(result).toEqual({
      allowed: false,
      reason: "Max iterations (3) reached for state 'review'",
    });
  });
});

describe("filterCannotFix", () => {
  it("returns all items when cannotFixList is empty", () => {
    const items = [
      { principle_id: "p1", file_path: "a.ts" },
      { principle_id: "p2", file_path: "b.ts" },
    ];
    const result = filterCannotFix(items, []);
    expect(result).toEqual(items);
  });

  it("removes items that match entries in cannotFixList", () => {
    const items = [
      { principle_id: "p1", file_path: "a.ts" },
      { principle_id: "p2", file_path: "b.ts" },
    ];
    const cannotFix = [{ principle_id: "p1", file_path: "a.ts" }];
    const result = filterCannotFix(items, cannotFix);
    expect(result).toEqual([{ principle_id: "p2", file_path: "b.ts" }]);
  });

  it("keeps items that do not match any entry in cannotFixList", () => {
    const items = [
      { principle_id: "p1", file_path: "a.ts" },
      { principle_id: "p2", file_path: "b.ts" },
    ];
    const cannotFix = [{ principle_id: "p3", file_path: "c.ts" }];
    const result = filterCannotFix(items, cannotFix);
    expect(result).toEqual(items);
  });

  it("only removes exact matches from typed items", () => {
    const items = [
      { principle_id: "p1", file_path: "a.ts" },
      { principle_id: "p2", file_path: "b.ts" },
      { principle_id: "p1", file_path: "c.ts" },
    ];
    const cannotFix = [{ principle_id: "p1", file_path: "a.ts" }];
    const result = filterCannotFix(items, cannotFix);
    expect(result).toEqual([
      { principle_id: "p2", file_path: "b.ts" },
      { principle_id: "p1", file_path: "c.ts" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// report-result cannot_fix accumulation
// ---------------------------------------------------------------------------

describe("reportResult — cannot_fix accumulation", () => {
  it("accumulates CannotFixItem entries when condition is cannot_fix with principle_ids and file_paths", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithCannotFix();
    seedWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "review",
      status_keyword: "CANNOT_FIX",
      flow,
      principle_ids: ["no-hidden-side-effects"],
      file_paths: ["src/tools/report-result.ts"],
    });
    assertOk(result);

    const iteration = result.board.iterations["review"];
    expect(iteration).toBeDefined();
    expect(iteration.cannot_fix).toEqual([
      { principle_id: "no-hidden-side-effects", file_path: "src/tools/report-result.ts" },
    ]);
  });

  it("builds cartesian product of principle_ids x file_paths", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithCannotFix();
    seedWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "review",
      status_keyword: "CANNOT_FIX",
      flow,
      principle_ids: ["p1", "p2"],
      file_paths: ["a.ts", "b.ts"],
    });
    assertOk(result);

    const iteration = result.board.iterations["review"];
    expect(iteration.cannot_fix).toHaveLength(4);
    expect(iteration.cannot_fix).toEqual(
      expect.arrayContaining([
        { principle_id: "p1", file_path: "a.ts" },
        { principle_id: "p1", file_path: "b.ts" },
        { principle_id: "p2", file_path: "a.ts" },
        { principle_id: "p2", file_path: "b.ts" },
      ]),
    );
  });

  it("does not add duplicate items on repeated cannot_fix reports", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithCannotFix();
    seedWorkspace(workspace, flow);

    // First report
    await reportResult({
      workspace,
      state_id: "review",
      status_keyword: "CANNOT_FIX",
      flow,
      principle_ids: ["p1"],
      file_paths: ["a.ts"],
    });

    // Second report with same item
    const result = await reportResult({
      workspace,
      state_id: "review",
      status_keyword: "CANNOT_FIX",
      flow,
      principle_ids: ["p1"],
      file_paths: ["a.ts"],
    });
    assertOk(result);

    const iteration = result.board.iterations["review"];
    expect(iteration.cannot_fix).toHaveLength(1);
    expect(iteration.cannot_fix).toEqual([{ principle_id: "p1", file_path: "a.ts" }]);
  });

  it("skips accumulation when no iteration record exists for the state", async () => {
    const workspace = makeTmpWorkspace();
    // Flow with no max_iterations on the state being reported
    const flow: ResolvedFlow = {
      name: "test-flow",
      description: "A test flow",
      entry: "build",
      spawn_instructions: {},
      states: {
        build: {
          type: "single",
          transitions: { cannot_fix: "hitl", done: "ship" },
          // no max_iterations — no iteration record created
        },
        ship: { type: "terminal" },
        hitl: { type: "terminal" },
      },
    };
    seedWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "CANNOT_FIX",
      flow,
      principle_ids: ["p1"],
      file_paths: ["a.ts"],
    });
    assertOk(result);

    // No iteration record — nothing to accumulate
    expect(result.board.iterations["build"]).toBeUndefined();
  });

  it("skips accumulation when principle_ids is missing", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithCannotFix();
    seedWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "review",
      status_keyword: "CANNOT_FIX",
      flow,
      // no principle_ids
      file_paths: ["a.ts"],
    });
    assertOk(result);

    const iteration = result.board.iterations["review"];
    expect(iteration.cannot_fix ?? []).toHaveLength(0);
  });

  it("skips accumulation when file_paths is missing", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithCannotFix();
    seedWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "review",
      status_keyword: "CANNOT_FIX",
      flow,
      principle_ids: ["p1"],
      // no file_paths
    });
    assertOk(result);

    const iteration = result.board.iterations["review"];
    expect(iteration.cannot_fix ?? []).toHaveLength(0);
  });

  it("does not accumulate when condition is not cannot_fix", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithCannotFix();
    seedWorkspace(workspace, flow);

    const result = await reportResult({
      workspace,
      state_id: "review",
      status_keyword: "DONE",
      flow,
      principle_ids: ["p1"],
      file_paths: ["a.ts"],
    });
    assertOk(result);

    const iteration = result.board.iterations["review"];
    expect(iteration.cannot_fix ?? []).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: accumulate in report-result, read back via check-convergence
// ---------------------------------------------------------------------------

describe("cannot_fix round-trip: report-result → check-convergence", () => {
  it("check-convergence returns accumulated cannot_fix_items after report-result", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithCannotFix();
    seedWorkspace(workspace, flow);

    await reportResult({
      workspace,
      state_id: "review",
      status_keyword: "CANNOT_FIX",
      flow,
      principle_ids: ["no-hidden-side-effects"],
      file_paths: ["src/tools/check-convergence.ts"],
    });

    const convergenceResult = await checkConvergence({ workspace, state_id: "review" });
    assertOk(convergenceResult);
    const convergence = convergenceResult;

    expect(convergence.cannot_fix_items).toEqual([
      { principle_id: "no-hidden-side-effects", file_path: "src/tools/check-convergence.ts" },
    ]);
  });

  it("round-trip: multiple reports accumulate items, check-convergence returns all", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithCannotFix();
    seedWorkspace(workspace, flow);

    // First agent report
    await reportResult({
      workspace,
      state_id: "review",
      status_keyword: "CANNOT_FIX",
      flow,
      principle_ids: ["p1"],
      file_paths: ["a.ts"],
    });

    // Second agent report with different items
    await reportResult({
      workspace,
      state_id: "review",
      status_keyword: "CANNOT_FIX",
      flow,
      principle_ids: ["p2"],
      file_paths: ["b.ts"],
    });

    const convergenceResult = await checkConvergence({ workspace, state_id: "review" });
    assertOk(convergenceResult);
    const convergence = convergenceResult;

    expect(convergence.cannot_fix_items).toHaveLength(2);
    expect(convergence.cannot_fix_items).toEqual(
      expect.arrayContaining([
        { principle_id: "p1", file_path: "a.ts" },
        { principle_id: "p2", file_path: "b.ts" },
      ]),
    );
  });

  it("filterCannotFix can filter items returned by check-convergence", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithCannotFix();
    seedWorkspace(workspace, flow);

    await reportResult({
      workspace,
      state_id: "review",
      status_keyword: "CANNOT_FIX",
      flow,
      principle_ids: ["p1", "p2"],
      file_paths: ["a.ts"],
    });

    const convergenceResult = await checkConvergence({ workspace, state_id: "review" });
    assertOk(convergenceResult);
    const convergence = convergenceResult;

    // Orchestrator uses filterCannotFix to exclude items from next iteration
    const allItems = [
      { principle_id: "p1", file_path: "a.ts" },
      { principle_id: "p2", file_path: "a.ts" },
      { principle_id: "p3", file_path: "a.ts" }, // new item not yet cannot_fixed
    ];

    const remaining = filterCannotFix(allItems, convergence.cannot_fix_items);

    expect(remaining).toEqual([{ principle_id: "p3", file_path: "a.ts" }]);
  });
});
