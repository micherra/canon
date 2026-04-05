/**
 * Integration tests for Canon MCP harness features (harness-01 through harness-06).
 *
 * Covers:
 * - Cross-feature integration: report-result with parallel_results + cannot_fix + events together
 * - End-to-end: get-spawn-prompt with skip_when AND inject_context on the same state
 * - update-board event emissions (harness-02 declared gap)
 * - get-spawn-prompt with inject_context end-to-end (harness-06 declared gap)
 * - get-spawn-prompt deferred-field warning path (harness-04 declared gap)
 * - Backward compatibility: board.json without new fields still parses
 */

import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { filterCannotFix } from "../orchestration/convergence.ts";
import { flowEventBus } from "../orchestration/event-bus-instance.ts";
import type { FlowEventMap } from "../orchestration/events.ts";
import { clearStoreCache, getExecutionStore } from "../orchestration/execution-store.ts";
import type { ResolvedFlow } from "../orchestration/flow-schema.ts";
import { BoardSchema } from "../orchestration/flow-schema.ts";
import { assertOk } from "../shared/lib/tool-result.ts";
import { checkConvergence } from "../tools/check-convergence.ts";
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
        agent: "canon-fixer",
        transitions: {
          cannot_fix: "hitl",
          done: "review",
        },
        type: "single",
      },
      hitl: { type: "terminal" },
      implement: {
        agent: "canon-implementor",
        max_iterations: 3,
        transitions: {
          blocked: "hitl",
          cannot_fix: "hitl",
          done: "review",
        },
        type: "single",
      },
      review: {
        agent: "canon-reviewer",
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
      file_paths: ["src/tools/report-result.ts"],
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
      file_path: "src/tools/report-result.ts",
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

    // checkConvergence should still work (doesn't break on new field)
    const convergenceResult = await checkConvergence({ state_id: "implement", workspace });
    assertOk(convergenceResult);
    const convergence = convergenceResult;
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

    const convergenceResult = await checkConvergence({ state_id: "implement", workspace });
    assertOk(convergenceResult);
    const convergence = convergenceResult;
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
          agent: "canon-implementor",
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
          agent: "canon-implementor",
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
          agent: "canon-implementor",
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

// get-spawn-prompt with both skip_when AND inject_context on same state
// (harness-04 + harness-06 combined)

describe("getSpawnPrompt — skip_when evaluated before inject_context", () => {
  beforeEach(() => {
    execSyncImpl = null;
  });

  it("returns skip_reason (skip_when met) without evaluating inject_context", async () => {
    // skip_when: no_contract_changes → skip if only internal files changed
    execSyncImpl = () => ({ status: 0, stdout: "src/internal/helper.ts\n" }); // no contract files

    const workspace = makeTmpWorkspace();

    const flow: ResolvedFlow = {
      description: "test",
      entry: "type-check",
      name: "test-flow",
      spawn_instructions: {
        "type-check": "Check types with context: ${PRIOR}",
      },
      states: {
        prior: { type: "terminal" },
        ship: { type: "terminal" },
        "type-check": {
          agent: "canon-reviewer",
          inject_context: [{ as: "PRIOR", from: "prior" }],
          skip_when: "no_contract_changes",
          transitions: { done: "ship" },
          type: "single",
        },
      },
    };

    setupWorkspace(workspace, flow);

    const result = await getSpawnPrompt({
      flow,
      state_id: "type-check",
      variables: {},
      workspace,
    });

    // Should skip — not attempt inject_context
    expect(result.prompts).toHaveLength(0);
    expect(result.skip_reason).toContain("no_contract_changes");
  });

  it("falls through to inject_context when skip_when is NOT met", async () => {
    // skip_when: no_contract_changes → don't skip if contract file changed
    execSyncImpl = () => ({ status: 0, stdout: "src/api/users.ts\n" }); // contract file changed

    const workspace = makeTmpWorkspace();
    const artifactPath = join(workspace, "context.md");
    await writeFile(artifactPath, "Important context here.");

    const flow: ResolvedFlow = {
      description: "test",
      entry: "review",
      name: "test-flow",
      spawn_instructions: {
        review: "Review with context: ${CONTEXT}",
      },
      states: {
        prior: { type: "terminal" },
        review: {
          agent: "canon-reviewer",
          inject_context: [{ as: "CONTEXT", from: "prior" }],
          skip_when: "no_contract_changes",
          transitions: { done: "ship" },
          type: "single",
        },
        ship: { type: "terminal" },
      },
    };

    setupWorkspace(workspace, flow);
    const store = getExecutionStore(workspace);
    store.upsertState("prior", { artifacts: [artifactPath], entries: 1, status: "done" });

    const result = await getSpawnPrompt({
      flow,
      state_id: "review",
      variables: {},
      workspace,
    });

    // Not skipped — inject_context runs and populates CONTEXT
    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0].prompt).toContain("Important context here.");
    expect(result.skip_reason).toBeUndefined();
  });
});

// get-spawn-prompt — deferred-field warnings (harness-04 declared gap)

describe("getSpawnPrompt — deferred-field warnings", () => {
  it("does NOT emit deferred-field warning for 'gate' field (gate is now implemented)", async () => {
    const workspace = makeTmpWorkspace();

    const flow: ResolvedFlow = {
      description: "test",
      entry: "build",
      name: "test-flow",
      spawn_instructions: { build: "Build the feature." },
      states: {
        build: {
          agent: "canon-implementor",
          gate: "some-gate-condition",
          transitions: { done: "ship" },
          type: "single",
        },
        ship: { type: "terminal" },
      },
    };

    setupWorkspace(workspace, flow);

    const result = await getSpawnPrompt({
      flow,
      state_id: "build",
      variables: {},
      workspace,
    });

    expect(result.prompts).toHaveLength(1); // still produces prompt
    // gate is implemented — no deferred warning should be emitted for it
    const gateWarnings =
      result.warnings?.filter((w) => w.includes("gate") && w.includes("not yet implemented")) ?? [];
    expect(gateWarnings).toHaveLength(0);
  });

  it("does not emit deferred-field warning for 'consultations' or 'gate'", async () => {
    // consultations and gate are now implemented — they should NOT produce deferred warnings.
    // The remaining deferred fields are: large_diff_threshold, cluster_by, timeout.
    const workspace = makeTmpWorkspace();

    const flow: ResolvedFlow = {
      description: "test",
      entry: "build",
      name: "test-flow",
      spawn_instructions: { build: "Build the feature." },
      states: {
        build: {
          agent: "canon-implementor",
          gate: "some-gate-condition",
          transitions: { done: "ship" },
          type: "single",
        },
        ship: { type: "terminal" },
      },
    };

    setupWorkspace(workspace, flow);

    const result = await getSpawnPrompt({
      flow,
      state_id: "build",
      variables: {},
      workspace,
    });

    const deferredWarnings =
      result.warnings?.filter((w) => w.includes("not yet implemented")) ?? [];
    // Neither gate nor consultations should appear as deferred warnings
    expect(deferredWarnings.some((w) => w.includes("gate"))).toBe(false);
    // consultations is not a field that can be set on a single-agent state in this schema,
    // but if it were present it would not produce a deferred warning either.
  });

  it("returns timeout_ms when state has valid 'timeout' field", async () => {
    const workspace = makeTmpWorkspace();

    const flow: ResolvedFlow = {
      description: "test",
      entry: "build",
      name: "test-flow",
      spawn_instructions: { build: "Build the feature." },
      states: {
        build: {
          agent: "canon-implementor",
          timeout: "30m",
          transitions: { done: "ship" },
          type: "single",
        },
        ship: { type: "terminal" },
      },
    };

    setupWorkspace(workspace, flow);

    const result = await getSpawnPrompt({
      flow,
      state_id: "build",
      variables: {},
      workspace,
    });

    expect(result.timeout_ms).toBe(1800000); // 30 minutes
    // No deferred warning for timeout — it's now implemented
    const deferredWarnings =
      result.warnings?.filter((w) => w.includes("not yet implemented")) ?? [];
    expect(deferredWarnings.some((w) => w.includes("timeout"))).toBe(false);
  });

  it("no deferred-field warnings when timeout, large_diff_threshold, and gate are all set", async () => {
    const workspace = makeTmpWorkspace();

    const flow: ResolvedFlow = {
      description: "test",
      entry: "build",
      name: "test-flow",
      spawn_instructions: { build: "Build the feature." },
      states: {
        build: {
          agent: "canon-implementor",
          gate: "some-gate",
          large_diff_threshold: 500,
          timeout: "15m",
          transitions: { done: "ship" },
          type: "single",
        },
        ship: { type: "terminal" },
      },
    };

    setupWorkspace(workspace, flow);

    const result = await getSpawnPrompt({
      flow,
      state_id: "build",
      variables: {},
      workspace,
    });

    // All three fields are now implemented — no deferred warnings
    const fieldWarnings = result.warnings?.filter((w) => w.includes("not yet implemented")) ?? [];
    expect(fieldWarnings.length).toBe(0);
    // timeout_ms should be set
    expect(result.timeout_ms).toBe(900000); // 15 minutes
  });
});

// Backward compatibility: board.json without new optional fields still parses

describe("backward compatibility: board.json without new fields", () => {
  it("board without parallel_results in state entries still parses and reads correctly", () => {
    // Write a board JSON that lacks the parallel_results field (old format)
    const legacyBoard = {
      base_commit: "oldsha123",
      blocked: null,
      concerns: [],
      current_state: "build",
      entry: "build",
      flow: "test-flow",
      iterations: {},
      last_updated: new Date().toISOString(),
      skipped: [],
      started: new Date().toISOString(),
      states: {
        build: {
          entries: 1,
          result: "done",
          status: "done",
          // No parallel_results field — legacy format
        },
        ship: {
          entries: 0,
          status: "pending",
        },
      },
      task: "legacy task",
    };

    // Should parse without error via BoardSchema
    const board = BoardSchema.parse(legacyBoard);
    expect(board.states.build.status).toBe("done");
    expect(board.states.build.parallel_results).toBeUndefined();
    expect(board.current_state).toBe("build");
  });

  it("board without concerns and skipped arrays is rejected by schema (they are required)", () => {
    // Board missing required fields
    const malformedBoard = {
      base_commit: "sha",
      blocked: null,
      current_state: "build",
      entry: "build",
      flow: "test-flow",
      iterations: {},
      last_updated: new Date().toISOString(),
      started: new Date().toISOString(),
      states: {},
      task: "task",
      // Missing concerns and skipped
    };

    // BoardSchema.safeParse should fail since these fields are required
    const result = BoardSchema.safeParse(malformedBoard);
    expect(result.success).toBe(false);
  });

  it("BoardSchema validates a board with new optional fields alongside existing fields", () => {
    const boardWithNewFields = {
      base_commit: "sha123",
      blocked: null,
      concerns: [],
      current_state: "build",
      entry: "build",
      flow: "test-flow",
      iterations: {
        build: {
          cannot_fix: [{ file_path: "a.ts", principle_id: "p1" }],
          count: 2,
          history: [],
          max: 3,
        },
      },
      last_updated: new Date().toISOString(),
      skipped: [],
      started: new Date().toISOString(),
      states: {
        build: {
          entries: 2,
          parallel_results: [
            { item: "task-a", status: "done" },
            { artifacts: ["report.md"], item: "task-b", status: "cannot_fix" },
          ],
          status: "done",
        },
      },
      task: "task",
    };

    const parsed = BoardSchema.safeParse(boardWithNewFields);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.states.build.parallel_results).toHaveLength(2);
      expect(parsed.data.iterations.build.cannot_fix).toHaveLength(1);
    }
  });
});

// Integration: store_pr_review → DriftStore round-trip with pr_number filtering
// (harness-01 gap: store + retrieve with filter)

describe("store_pr_review — get_pr_review_data round-trip", () => {
  it("storing multiple reviews and retrieving by pr_number returns only matching ones", async () => {
    const workspace = makeTmpWorkspace();
    await mkdir(join(workspace, ".canon"), { recursive: true });

    const { storePrReview } = await import("../tools/store-pr-review.js");
    const { DriftStore } = await import("../platform/storage/drift/store.js");

    // Store two reviews for PR #1 and one for PR #2
    await storePrReview(
      {
        files: ["a.ts"],
        honored: [],
        pr_number: 1,
        score: {
          conventions: { passed: 1, total: 1 },
          opinions: { passed: 1, total: 1 },
          rules: { passed: 1, total: 1 },
        },
        verdict: "WARNING",
        violations: [],
      },
      workspace,
    );
    await storePrReview(
      {
        files: ["a.ts"],
        honored: [],
        pr_number: 1,
        score: {
          conventions: { passed: 1, total: 1 },
          opinions: { passed: 1, total: 1 },
          rules: { passed: 1, total: 1 },
        },
        verdict: "CLEAN",
        violations: [],
      },
      workspace,
    );
    await storePrReview(
      {
        files: ["b.ts"],
        honored: [],
        pr_number: 2,
        score: {
          conventions: { passed: 0, total: 0 },
          opinions: { passed: 0, total: 0 },
          rules: { passed: 0, total: 1 },
        },
        verdict: "BLOCKING",
        violations: [{ principle_id: "p1", severity: "rule" }],
      },
      workspace,
    );

    const store = new DriftStore(workspace);
    const pr1Reviews = await store.getReviews({ prNumber: 1 });
    const pr2Reviews = await store.getReviews({ prNumber: 2 });
    const allReviews = await store.getReviews();

    expect(pr1Reviews).toHaveLength(2);
    expect(pr2Reviews).toHaveLength(1);
    expect(pr2Reviews[0].verdict).toBe("BLOCKING");
    expect(allReviews).toHaveLength(3);

    // All have unique IDs
    const ids = allReviews.map((r) => r.review_id);
    expect(new Set(ids).size).toBe(3);
  });
});
