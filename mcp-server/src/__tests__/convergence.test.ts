import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canEnterState, filterCannotFix } from "../orchestration/convergence.ts";
import { clearStoreCache, getExecutionStore } from "../orchestration/execution-store.ts";
import type { Board, ResolvedFlow } from "../orchestration/flow-schema.ts";
import { checkConvergence } from "../tools/check-convergence.ts";
import { reportResult } from "../tools/report-result.ts";
import { assertOk } from "../shared/lib/tool-result.ts";

function makeBoard(iterations: Board["iterations"]): Board {
  return {
    base_commit: "abc123",
    blocked: null,
    concerns: [],
    current_state: "start",
    entry: "start",
    flow: "test",
    iterations,
    last_updated: new Date().toISOString(),
    skipped: [],
    started: new Date().toISOString(),
    states: {},
    task: "test task",
  } as Board;
}

// Workspace helpers for round-trip tests

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "convergence-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  clearStoreCache();
  for (const d of tmpDirs) {
    rmSync(d, { force: true, recursive: true });
  }
  tmpDirs = [];
});

/** Flow with a review state that has max_iterations and cannot_fix transition */
function makeFlowWithCannotFix(): ResolvedFlow {
  return {
    description: "A test flow",
    entry: "review",
    name: "test-flow",
    spawn_instructions: {},
    states: {
      hitl: { type: "terminal" },
      review: {
        max_iterations: 3,
        transitions: {
          cannot_fix: "hitl",
          done: "ship",
        },
        type: "single",
      },
      ship: { type: "terminal" },
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
    base_commit: "abc123",
    branch: "main",
    created: now,
    current_state: flow.entry,
    entry: flow.entry,
    flow: flow.name,
    flow_name: flow.name,
    last_updated: now,
    sanitized: "main",
    slug: "test-slug",
    started: now,
    task: "test task",
    tier: "medium",
  });
  for (const [stateId, stateDef] of Object.entries(flow.states)) {
    store.upsertState(stateId, { entries: 0, status: "pending" });
    if (stateDef.max_iterations !== undefined) {
      store.upsertIteration(stateId, {
        cannot_fix: [],
        count: 0,
        history: [],
        max: stateDef.max_iterations,
      });
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
      review: { count: 1, history: [], max: 3 },
    });
    const result = canEnterState(board, "review");
    expect(result).toEqual({ allowed: true });
  });

  it("returns not allowed when count === max", () => {
    const board = makeBoard({
      review: { count: 3, history: [], max: 3 },
    });
    const result = canEnterState(board, "review");
    expect(result).toEqual({
      allowed: false,
      reason: "Max iterations (3) reached for state 'review'",
    });
  });

  it("returns not allowed when count > max", () => {
    const board = makeBoard({
      review: { count: 5, history: [], max: 3 },
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
      { file_path: "a.ts", principle_id: "p1" },
      { file_path: "b.ts", principle_id: "p2" },
    ];
    const result = filterCannotFix(items, []);
    expect(result).toEqual(items);
  });

  it("removes items that match entries in cannotFixList", () => {
    const items = [
      { file_path: "a.ts", principle_id: "p1" },
      { file_path: "b.ts", principle_id: "p2" },
    ];
    const cannotFix = [{ file_path: "a.ts", principle_id: "p1" }];
    const result = filterCannotFix(items, cannotFix);
    expect(result).toEqual([{ file_path: "b.ts", principle_id: "p2" }]);
  });

  it("keeps items that do not match any entry in cannotFixList", () => {
    const items = [
      { file_path: "a.ts", principle_id: "p1" },
      { file_path: "b.ts", principle_id: "p2" },
    ];
    const cannotFix = [{ file_path: "c.ts", principle_id: "p3" }];
    const result = filterCannotFix(items, cannotFix);
    expect(result).toEqual(items);
  });

  it("only removes exact matches from typed items", () => {
    const items = [
      { file_path: "a.ts", principle_id: "p1" },
      { file_path: "b.ts", principle_id: "p2" },
      { file_path: "c.ts", principle_id: "p1" },
    ];
    const cannotFix = [{ file_path: "a.ts", principle_id: "p1" }];
    const result = filterCannotFix(items, cannotFix);
    expect(result).toEqual([
      { file_path: "b.ts", principle_id: "p2" },
      { file_path: "c.ts", principle_id: "p1" },
    ]);
  });
});

// report-result cannot_fix accumulation

describe("reportResult — cannot_fix accumulation", () => {
  it("accumulates CannotFixItem entries when condition is cannot_fix with principle_ids and file_paths", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithCannotFix();
    seedWorkspace(workspace, flow);

    const result = await reportResult({
      file_paths: ["src/tools/report-result.ts"],
      flow,
      principle_ids: ["no-hidden-side-effects"],
      state_id: "review",
      status_keyword: "CANNOT_FIX",
      workspace,
    });
    assertOk(result);

    const iteration = result.board.iterations.review;
    expect(iteration).toBeDefined();
    expect(iteration.cannot_fix).toEqual([
      { file_path: "src/tools/report-result.ts", principle_id: "no-hidden-side-effects" },
    ]);
  });

  it("builds cartesian product of principle_ids x file_paths", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithCannotFix();
    seedWorkspace(workspace, flow);

    const result = await reportResult({
      file_paths: ["a.ts", "b.ts"],
      flow,
      principle_ids: ["p1", "p2"],
      state_id: "review",
      status_keyword: "CANNOT_FIX",
      workspace,
    });
    assertOk(result);

    const iteration = result.board.iterations.review;
    expect(iteration.cannot_fix).toHaveLength(4);
    expect(iteration.cannot_fix).toEqual(
      expect.arrayContaining([
        { file_path: "a.ts", principle_id: "p1" },
        { file_path: "b.ts", principle_id: "p1" },
        { file_path: "a.ts", principle_id: "p2" },
        { file_path: "b.ts", principle_id: "p2" },
      ]),
    );
  });

  it("does not add duplicate items on repeated cannot_fix reports", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithCannotFix();
    seedWorkspace(workspace, flow);

    // First report
    await reportResult({
      file_paths: ["a.ts"],
      flow,
      principle_ids: ["p1"],
      state_id: "review",
      status_keyword: "CANNOT_FIX",
      workspace,
    });

    // Second report with same item
    const result = await reportResult({
      file_paths: ["a.ts"],
      flow,
      principle_ids: ["p1"],
      state_id: "review",
      status_keyword: "CANNOT_FIX",
      workspace,
    });
    assertOk(result);

    const iteration = result.board.iterations.review;
    expect(iteration.cannot_fix).toHaveLength(1);
    expect(iteration.cannot_fix).toEqual([{ file_path: "a.ts", principle_id: "p1" }]);
  });

  it("skips accumulation when no iteration record exists for the state", async () => {
    const workspace = makeTmpWorkspace();
    // Flow with no max_iterations on the state being reported
    const flow: ResolvedFlow = {
      description: "A test flow",
      entry: "build",
      name: "test-flow",
      spawn_instructions: {},
      states: {
        build: {
          transitions: { cannot_fix: "hitl", done: "ship" },
          type: "single",
          // no max_iterations — no iteration record created
        },
        hitl: { type: "terminal" },
        ship: { type: "terminal" },
      },
    };
    seedWorkspace(workspace, flow);

    const result = await reportResult({
      file_paths: ["a.ts"],
      flow,
      principle_ids: ["p1"],
      state_id: "build",
      status_keyword: "CANNOT_FIX",
      workspace,
    });
    assertOk(result);

    // No iteration record — nothing to accumulate
    expect(result.board.iterations.build).toBeUndefined();
  });

  it("skips accumulation when principle_ids is missing", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithCannotFix();
    seedWorkspace(workspace, flow);

    const result = await reportResult({
      // no principle_ids
      file_paths: ["a.ts"],
      flow,
      state_id: "review",
      status_keyword: "CANNOT_FIX",
      workspace,
    });
    assertOk(result);

    const iteration = result.board.iterations.review;
    expect(iteration.cannot_fix ?? []).toHaveLength(0);
  });

  it("skips accumulation when file_paths is missing", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithCannotFix();
    seedWorkspace(workspace, flow);

    const result = await reportResult({
      flow,
      principle_ids: ["p1"],
      state_id: "review",
      status_keyword: "CANNOT_FIX",
      workspace,
      // no file_paths
    });
    assertOk(result);

    const iteration = result.board.iterations.review;
    expect(iteration.cannot_fix ?? []).toHaveLength(0);
  });

  it("does not accumulate when condition is not cannot_fix", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithCannotFix();
    seedWorkspace(workspace, flow);

    const result = await reportResult({
      file_paths: ["a.ts"],
      flow,
      principle_ids: ["p1"],
      state_id: "review",
      status_keyword: "DONE",
      workspace,
    });
    assertOk(result);

    const iteration = result.board.iterations.review;
    expect(iteration.cannot_fix ?? []).toHaveLength(0);
  });
});

// Round-trip: accumulate in report-result, read back via check-convergence

describe("cannot_fix round-trip: report-result → check-convergence", () => {
  it("check-convergence returns accumulated cannot_fix_items after report-result", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithCannotFix();
    seedWorkspace(workspace, flow);

    await reportResult({
      file_paths: ["src/tools/check-convergence.ts"],
      flow,
      principle_ids: ["no-hidden-side-effects"],
      state_id: "review",
      status_keyword: "CANNOT_FIX",
      workspace,
    });

    const convergenceResult = await checkConvergence({ state_id: "review", workspace });
    assertOk(convergenceResult);
    const convergence = convergenceResult;

    expect(convergence.cannot_fix_items).toEqual([
      { file_path: "src/tools/check-convergence.ts", principle_id: "no-hidden-side-effects" },
    ]);
  });

  it("round-trip: multiple reports accumulate items, check-convergence returns all", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithCannotFix();
    seedWorkspace(workspace, flow);

    // First agent report
    await reportResult({
      file_paths: ["a.ts"],
      flow,
      principle_ids: ["p1"],
      state_id: "review",
      status_keyword: "CANNOT_FIX",
      workspace,
    });

    // Second agent report with different items
    await reportResult({
      file_paths: ["b.ts"],
      flow,
      principle_ids: ["p2"],
      state_id: "review",
      status_keyword: "CANNOT_FIX",
      workspace,
    });

    const convergenceResult = await checkConvergence({ state_id: "review", workspace });
    assertOk(convergenceResult);
    const convergence = convergenceResult;

    expect(convergence.cannot_fix_items).toHaveLength(2);
    expect(convergence.cannot_fix_items).toEqual(
      expect.arrayContaining([
        { file_path: "a.ts", principle_id: "p1" },
        { file_path: "b.ts", principle_id: "p2" },
      ]),
    );
  });

  it("filterCannotFix can filter items returned by check-convergence", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithCannotFix();
    seedWorkspace(workspace, flow);

    await reportResult({
      file_paths: ["a.ts"],
      flow,
      principle_ids: ["p1", "p2"],
      state_id: "review",
      status_keyword: "CANNOT_FIX",
      workspace,
    });

    const convergenceResult = await checkConvergence({ state_id: "review", workspace });
    assertOk(convergenceResult);
    const convergence = convergenceResult;

    // Orchestrator uses filterCannotFix to exclude items from next iteration
    const allItems = [
      { file_path: "a.ts", principle_id: "p1" },
      { file_path: "a.ts", principle_id: "p2" },
      { file_path: "a.ts", principle_id: "p3" }, // new item not yet cannot_fixed
    ];

    const remaining = filterCannotFix(allItems, convergence.cannot_fix_items);

    expect(remaining).toEqual([{ file_path: "a.ts", principle_id: "p3" }]);
  });
});
