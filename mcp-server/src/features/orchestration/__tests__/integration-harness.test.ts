/**
 * Integration tests for Canon MCP harness features (harness-01 through harness-06).
 *
 * Covers:
 * - Cross-feature integration: report-result with parallel_results + cannot_fix + events together
 * - End-to-end: get-spawn-prompt with skip_when AND inject_context on the same state
 * - update-board event emissions (harness-02 declared gap)
 * - get-spawn-prompt with inject_context end-to-end (harness-06 declared gap)
 *
 * Split: lifecycle and backward-compat tests moved to integration-harness-lifecycle.test.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Hoist spawnSync mock to file level so vitest can hoist it before module imports.
// Controls git diff output for skip_when integration tests.
type SpawnSyncResult = { stdout: string; status: number; error?: Error };
let execSyncImpl: (() => SpawnSyncResult) | null = null;

vi.mock("node:child_process", () => ({
  spawnSync: (..._args: unknown[]) => {
    if (execSyncImpl) return execSyncImpl();
    // Default behavior: return error to simulate no git — fail-open means skip=false
    return { error: new Error("spawnSync not configured in test"), status: 1, stdout: "" };
  },
}));

import { canEnterState } from "@domains/board/board.ts";
import type { ResolvedFlow } from "@domains/flows/flow-definition-schemas.ts";
import { flowEventBus } from "@domains/messages/event-bus-instance.ts";
import type { FlowEventMap } from "@domains/messages/events.ts";
import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { filterCannotFix } from "../engine/convergence.ts";
import { getSpawnPrompt } from "../tools/get-spawn-prompt.ts";
import { reportResult } from "../tools/report-result.ts";
import { updateBoard } from "../tools/update-board.ts";

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-integration-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
  flowEventBus.removeAllListeners();
  execSyncImpl = null; // reset git mock after each test
});

function makeFlow(overrides?: Partial<ResolvedFlow>): ResolvedFlow {
  return {
    description: "Integration test flow",
    entry: "implement",
    name: "test-flow",
    spawn_instructions: {
      fix: "Fix the issues.",
      implement: "Implement the feature.",
      review: "Review the implementation.",
    },
    states: {
      fix: {
        agent: "fixer",
        transitions: {
          cannot_fix: "hitl",
          done: "review",
        },
        type: "single",
      },
      hitl: { type: "terminal" },
      implement: {
        agent: "implementor",
        max_iterations: 3,
        transitions: {
          blocked: "hitl",
          cannot_fix: "hitl",
          done: "review",
        },
        type: "single",
      },
      review: {
        agent: "reviewer",
        max_iterations: 2,
        transitions: {
          cannot_fix: "hitl",
          done: "ship",
        },
        type: "single",
      },
      ship: { type: "terminal" },
    },
    ...overrides,
  };
}

function setupWorkspace(workspace: string, flow: ResolvedFlow): void {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();
  store.initExecution({
    base_commit: "abc1234",
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
    task: "task",
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

// Helper: inline replacement for the deleted checkConvergence wrapper.
// Replicates checkConvergence logic using canEnterState + getExecutionStore directly.
function readConvergence(workspace: string, stateId: string) {
  const board = getExecutionStore(workspace).getBoard();
  if (board === null) throw new Error(`No board found for workspace: ${workspace}`);
  const { allowed, reason } = canEnterState(board, stateId);
  const iteration = board.iterations[stateId];
  return {
    can_enter: allowed,
    cannot_fix_items: iteration?.cannot_fix ?? [],
    history: iteration?.history ?? [],
    iteration_count: iteration?.count ?? 0,
    max_iterations: iteration?.max ?? 0,
    reason,
  };
}

// Cross-feature: report-result with parallel_results + cannot_fix + events
// (harness-02 + harness-03 + harness-05 together)

describe("cross-feature: parallel_results with cannot_fix items and event emission", () => {
  it("parallel_results aggregation emits state_completed with aggregated condition", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlow();
    setupWorkspace(workspace, flow);

    const completedEvents: FlowEventMap["state_completed"][] = [];
    const transitionEvents: FlowEventMap["transition_evaluated"][] = [];
    flowEventBus.on("state_completed", (e) => completedEvents.push(e));
    flowEventBus.on("transition_evaluated", (e) => transitionEvents.push(e));

    const result = await reportResult({
      flow,
      parallel_results: [
        { item: "file-a.ts", status: "done" },
        { item: "file-b.ts", status: "cannot_fix" },
      ],
      state_id: "implement",
      status_keyword: "DONE",
      workspace,
    });
    assertOk(result);

    // Aggregated result: mixed done/cannot_fix → "done"
    expect(result.transition_condition).toBe("done");
    // Events emitted with the aggregated condition
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].result).toBe("done");
    expect(transitionEvents).toHaveLength(1);
    expect(transitionEvents[0].normalizedCondition).toBe("done");
    expect(transitionEvents[0].nextState).toBe("review");
  });

  it("all-cannot_fix parallel_results: hitl_triggered event emitted", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlow();
    setupWorkspace(workspace, flow);

    const hitlEvents: FlowEventMap["hitl_triggered"][] = [];
    flowEventBus.on("hitl_triggered", (e) => hitlEvents.push(e));

    const result = await reportResult({
      flow,
      parallel_results: [
        { item: "file-a.ts", status: "cannot_fix" },
        { item: "file-b.ts", status: "cannot_fix" },
      ],
      state_id: "implement",
      status_keyword: "DONE",
      workspace,
    });
    assertOk(result);

    // Aggregated to cannot_fix → hitl
    expect(result.transition_condition).toBe("cannot_fix");
    expect(result.hitl_required).toBe(true);
    expect(hitlEvents).toHaveLength(1);
    expect(hitlEvents[0].stateId).toBe("implement");
  });

  it("cannot_fix individual report: items accumulated AND events emitted in same call", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlow();
    setupWorkspace(workspace, flow);

    const completedEvents: FlowEventMap["state_completed"][] = [];
    flowEventBus.on("state_completed", (e) => completedEvents.push(e));

    const result = await reportResult({
      file_paths: ["src/features/orchestration/tools/report-result.ts"],
      flow,
      principle_ids: ["no-hidden-side-effects"],
      state_id: "implement",
      status_keyword: "CANNOT_FIX",
      workspace,
    });
    assertOk(result);

    // Cannot_fix items accumulated
    expect(result.board.iterations.implement?.cannot_fix).toHaveLength(1);
    expect(result.board.iterations.implement?.cannot_fix?.[0]).toEqual({
      file_path: "src/features/orchestration/tools/report-result.ts",
      principle_id: "no-hidden-side-effects",
    });

    // Events still emitted even on cannot_fix path
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].result).toBe("cannot_fix");
  });

  it("full round-trip: parallel_results stored on board AND readable by checkConvergence", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlow();
    setupWorkspace(workspace, flow);

    const parallelResults = [
      { artifacts: ["summary-a.md"], item: "task-a", status: "done" },
      { item: "task-b", status: "done" },
    ];

    await reportResult({
      flow,
      parallel_results: parallelResults,
      state_id: "implement",
      status_keyword: "DONE",
      workspace,
    });

    // Read board directly to verify parallel_results persisted
    const board = getExecutionStore(workspace).getBoard();
    expect(board?.states.implement.parallel_results).toEqual(parallelResults);

    // convergence check should still work (doesn't break on new field)
    const convergence = readConvergence(workspace, "implement");
    expect(convergence.can_enter).toBe(true); // iteration count=0, max=3
    expect(convergence.iteration_count).toBe(0);
  });
});

// Cross-feature: cannot_fix accumulation → filterCannotFix full pipeline
// (harness-05 integration with convergence)

describe("cross-feature: cannot_fix pipeline — reportResult → checkConvergence → filterCannotFix", () => {
  it("two agents report cannot_fix, check-convergence returns all, filter excludes them from next run", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlow();
    setupWorkspace(workspace, flow);

    // Agent 1: cannot_fix p1 in a.ts and b.ts
    await reportResult({
      file_paths: ["a.ts", "b.ts"],
      flow,
      principle_ids: ["p1"],
      state_id: "implement",
      status_keyword: "CANNOT_FIX",
      workspace,
    });

    // Agent 2: cannot_fix p2 in a.ts
    await reportResult({
      file_paths: ["a.ts"],
      flow,
      principle_ids: ["p2"],
      state_id: "implement",
      status_keyword: "CANNOT_FIX",
      workspace,
    });

    const convergence = readConvergence(workspace, "implement");
    expect(convergence.cannot_fix_items).toHaveLength(3);

    // Orchestrator excludes known cannot_fix from next iteration's principle set
    const allViolations = [
      { file_path: "a.ts", principle_id: "p1" }, // already cannot_fix
      { file_path: "b.ts", principle_id: "p1" }, // already cannot_fix
      { file_path: "a.ts", principle_id: "p2" }, // already cannot_fix
      { file_path: "a.ts", principle_id: "p3" }, // new — still fixable
    ];

    const remaining = filterCannotFix(allViolations, convergence.cannot_fix_items);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toEqual({ file_path: "a.ts", principle_id: "p3" });
  });
});

// update-board event emissions (harness-02 declared gap)

describe("updateBoard — event emissions (harness-02 gap)", () => {
  it("emits board_updated event on enter_state", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlow();
    setupWorkspace(workspace, flow);

    const boardEvents: FlowEventMap["board_updated"][] = [];
    flowEventBus.on("board_updated", (e) => boardEvents.push(e));

    await updateBoard({ action: "enter_state", state_id: "implement", workspace });

    expect(boardEvents).toHaveLength(1);
    expect(boardEvents[0].action).toBe("enter_state");
    expect(boardEvents[0].stateId).toBe("implement");
    expect(boardEvents[0].timestamp).toBeTruthy();
  });

  it("emits state_entered event on enter_state", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlow();
    setupWorkspace(workspace, flow);

    const stateEnteredEvents: FlowEventMap["state_entered"][] = [];
    flowEventBus.on("state_entered", (e) => stateEnteredEvents.push(e));

    await updateBoard({ action: "enter_state", state_id: "implement", workspace });

    expect(stateEnteredEvents).toHaveLength(1);
    expect(stateEnteredEvents[0].stateId).toBe("implement");
    expect(stateEnteredEvents[0].timestamp).toBeTruthy();
  });

  it("emits board_updated but NOT state_entered on block action", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlow();
    setupWorkspace(workspace, flow);
    // Enter state first so block has something to work with
    await updateBoard({ action: "enter_state", state_id: "implement", workspace });

    // Clear listeners to count only the block action events
    flowEventBus.removeAllListeners();

    const boardEvents: FlowEventMap["board_updated"][] = [];
    const stateEnteredEvents: FlowEventMap["state_entered"][] = [];
    flowEventBus.on("board_updated", (e) => boardEvents.push(e));
    flowEventBus.on("state_entered", (e) => stateEnteredEvents.push(e));

    await updateBoard({
      action: "block",
      blocked_reason: "manual block",
      state_id: "implement",
      workspace,
    });

    expect(boardEvents).toHaveLength(1);
    expect(boardEvents[0].action).toBe("block");
    // state_entered should NOT be emitted for non-enter_state actions
    expect(stateEnteredEvents).toHaveLength(0);
  });

  it("emits board_updated on complete_flow action", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlow();
    setupWorkspace(workspace, flow);
    await updateBoard({ action: "enter_state", state_id: "ship", workspace });

    flowEventBus.removeAllListeners();

    const boardEvents: FlowEventMap["board_updated"][] = [];
    flowEventBus.on("board_updated", (e) => boardEvents.push(e));

    await updateBoard({ action: "complete_flow", workspace });

    expect(boardEvents).toHaveLength(1);
    expect(boardEvents[0].action).toBe("complete_flow");
  });
});

// get-spawn-prompt with inject_context end-to-end (harness-06 declared gap)

describe("getSpawnPrompt — inject_context end-to-end (harness-06 gap)", () => {
  it("injects artifact content from a prior state into spawn prompt variable", async () => {
    const workspace = makeTmpWorkspace();
    const artifactPath = join(workspace, "research-output.md");
    await writeFile(artifactPath, "Key findings: use pattern X.");

    // Build board with research state having artifacts
    const flow: ResolvedFlow = {
      description: "test",
      entry: "implement",
      name: "test-flow",
      spawn_instructions: {
        implement: "Implement using context: ${RESEARCH}",
      },
      states: {
        implement: {
          agent: "implementor",
          inject_context: [{ as: "RESEARCH", from: "research" }],
          transitions: { done: "ship" },
          type: "single",
        },
        research: { type: "terminal" },
        ship: { type: "terminal" },
      },
    };

    // Seed workspace and set research state as done with artifact
    setupWorkspace(workspace, flow);
    const store = getExecutionStore(workspace);
    store.upsertState("research", { artifacts: [artifactPath], entries: 1, status: "done" });

    const result = await getSpawnPrompt({
      flow,
      state_id: "implement",
      variables: {},
      workspace,
    });

    expect(result.prompts).toHaveLength(1);
    // The injected artifact content should appear in the prompt
    expect(result.prompts[0].prompt).toContain("Key findings: use pattern X.");
    expect(result.skip_reason).toBeUndefined();
  });

  it("returns skip_reason when inject_context from:user triggers HITL", async () => {
    const workspace = makeTmpWorkspace();

    const flow: ResolvedFlow = {
      description: "test",
      entry: "implement",
      name: "test-flow",
      spawn_instructions: {
        implement: "Implement with user guidance: ${USER_INPUT}",
      },
      states: {
        implement: {
          agent: "implementor",
          inject_context: [{ as: "USER_INPUT", from: "user", prompt: "Please describe the scope" }],
          transitions: { done: "ship" },
          type: "single",
        },
        ship: { type: "terminal" },
      },
    };

    setupWorkspace(workspace, flow);

    const result = await getSpawnPrompt({
      flow,
      state_id: "implement",
      variables: {},
      workspace,
    });

    // Should get HITL skip, not a prompt
    expect(result.prompts).toHaveLength(0);
    expect(result.skip_reason).toContain("HITL required");
    expect(result.skip_reason).toContain("Please describe the scope");
  });

  it("includes warnings in result when inject_context artifact is missing", async () => {
    const workspace = makeTmpWorkspace();

    const flow: ResolvedFlow = {
      description: "test",
      entry: "implement",
      name: "test-flow",
      spawn_instructions: {
        implement: "Do work: ${CONTEXT}",
      },
      states: {
        implement: {
          agent: "implementor",
          inject_context: [{ as: "CONTEXT", from: "research" }],
          transitions: { done: "ship" },
          type: "single",
        },
        research: { type: "terminal" },
        ship: { type: "terminal" },
      },
    };

    // Seed workspace and set research state as done with a missing artifact file
    setupWorkspace(workspace, flow);
    const store = getExecutionStore(workspace);
    store.upsertState("research", { artifacts: ["does-not-exist.md"], entries: 1, status: "done" });

    const result = await getSpawnPrompt({
      flow,
      state_id: "implement",
      variables: {},
      workspace,
    });

    // Should still produce a prompt (warnings don't block execution)
    expect(result.prompts).toHaveLength(1);
    // But there should be a warning about the missing artifact
    expect(result.warnings).toBeDefined();
    expect(result.warnings?.some((w) => w.includes("does-not-exist.md"))).toBe(true);
  });
});
