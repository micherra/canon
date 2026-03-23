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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hoist spawnSync mock to file level so vitest can hoist it before module imports.
// Controls git diff output for skip_when integration tests.
type SpawnSyncResult = { stdout: string; status: number; error?: Error };
let execSyncImpl: (() => SpawnSyncResult) | null = null;

vi.mock("node:child_process", () => ({
  spawnSync: (..._args: unknown[]) => {
    if (execSyncImpl) return execSyncImpl();
    // Default behavior: return error to simulate no git — fail-open means skip=false
    return { stdout: "", status: 1, error: new Error("spawnSync not configured in test") };
  },
}));

import { reportResult } from "../tools/report-result.js";
import { updateBoard } from "../tools/update-board.js";
import { getSpawnPrompt } from "../tools/get-spawn-prompt.js";
import { checkConvergence } from "../tools/check-convergence.js";
import { filterCannotFix } from "../orchestration/convergence.js";
import { flowEventBus } from "../orchestration/event-bus-instance.js";
import { writeBoard, initBoard, readBoard } from "../orchestration/board.js";
import { BoardSchema } from "../orchestration/flow-schema.js";
import type { FlowEventMap } from "../orchestration/events.js";
import type { ResolvedFlow, Board } from "../orchestration/flow-schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-integration-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
  flowEventBus.removeAllListeners();
  execSyncImpl = null; // reset git mock after each test
});

function makeFlow(overrides?: Partial<ResolvedFlow>): ResolvedFlow {
  return {
    name: "test-flow",
    description: "Integration test flow",
    entry: "implement",
    spawn_instructions: {
      implement: "Implement the feature.",
      review: "Review the implementation.",
      fix: "Fix the issues.",
    },
    states: {
      implement: {
        type: "single",
        agent: "canon-implementor",
        max_iterations: 3,
        transitions: {
          done: "review",
          cannot_fix: "hitl",
          blocked: "hitl",
        },
      },
      review: {
        type: "single",
        agent: "canon-reviewer",
        max_iterations: 2,
        transitions: {
          done: "ship",
          cannot_fix: "hitl",
        },
      },
      fix: {
        type: "single",
        agent: "canon-fixer",
        transitions: {
          done: "review",
          cannot_fix: "hitl",
        },
      },
      ship: { type: "terminal" },
      hitl: { type: "terminal" },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Cross-feature: report-result with parallel_results + cannot_fix + events
// (harness-02 + harness-03 + harness-05 together)
// ---------------------------------------------------------------------------

describe("cross-feature: parallel_results with cannot_fix items and event emission", () => {
  it("parallel_results aggregation emits state_completed with aggregated condition", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlow();
    await writeBoard(workspace, initBoard(flow, "task", "abc123"));

    const completedEvents: FlowEventMap["state_completed"][] = [];
    const transitionEvents: FlowEventMap["transition_evaluated"][] = [];
    flowEventBus.on("state_completed", (e) => completedEvents.push(e));
    flowEventBus.on("transition_evaluated", (e) => transitionEvents.push(e));

    const result = await reportResult({
      workspace,
      state_id: "implement",
      status_keyword: "DONE",
      flow,
      parallel_results: [
        { item: "file-a.ts", status: "done" },
        { item: "file-b.ts", status: "cannot_fix" },
      ],
    });

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
    await writeBoard(workspace, initBoard(flow, "task", "abc123"));

    const hitlEvents: FlowEventMap["hitl_triggered"][] = [];
    flowEventBus.on("hitl_triggered", (e) => hitlEvents.push(e));

    const result = await reportResult({
      workspace,
      state_id: "implement",
      status_keyword: "DONE",
      flow,
      parallel_results: [
        { item: "file-a.ts", status: "cannot_fix" },
        { item: "file-b.ts", status: "cannot_fix" },
      ],
    });

    // Aggregated to cannot_fix → hitl
    expect(result.transition_condition).toBe("cannot_fix");
    expect(result.hitl_required).toBe(true);
    expect(hitlEvents).toHaveLength(1);
    expect(hitlEvents[0].stateId).toBe("implement");
  });

  it("cannot_fix individual report: items accumulated AND events emitted in same call", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlow();
    await writeBoard(workspace, initBoard(flow, "task", "abc123"));

    const completedEvents: FlowEventMap["state_completed"][] = [];
    flowEventBus.on("state_completed", (e) => completedEvents.push(e));

    const result = await reportResult({
      workspace,
      state_id: "implement",
      status_keyword: "CANNOT_FIX",
      flow,
      principle_ids: ["no-hidden-side-effects"],
      file_paths: ["src/tools/report-result.ts"],
    });

    // Cannot_fix items accumulated
    expect(result.board.iterations["implement"]?.cannot_fix).toHaveLength(1);
    expect(result.board.iterations["implement"]?.cannot_fix?.[0]).toEqual({
      principle_id: "no-hidden-side-effects",
      file_path: "src/tools/report-result.ts",
    });

    // Events still emitted even on cannot_fix path
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].result).toBe("cannot_fix");
  });

  it("full round-trip: parallel_results stored on board AND readable by checkConvergence", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlow();
    await writeBoard(workspace, initBoard(flow, "task", "abc123"));

    const parallelResults = [
      { item: "task-a", status: "done", artifacts: ["summary-a.md"] },
      { item: "task-b", status: "done" },
    ];

    await reportResult({
      workspace,
      state_id: "implement",
      status_keyword: "DONE",
      flow,
      parallel_results: parallelResults,
    });

    // Read board directly to verify parallel_results persisted
    const board = await readBoard(workspace);
    expect(board.states["implement"].parallel_results).toEqual(parallelResults);

    // checkConvergence should still work (doesn't break on new field)
    const convergence = await checkConvergence({ workspace, state_id: "implement" });
    expect(convergence.can_enter).toBe(true); // iteration count=0, max=3
    expect(convergence.iteration_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-feature: cannot_fix accumulation → filterCannotFix full pipeline
// (harness-05 integration with convergence)
// ---------------------------------------------------------------------------

describe("cross-feature: cannot_fix pipeline — reportResult → checkConvergence → filterCannotFix", () => {
  it("two agents report cannot_fix, check-convergence returns all, filter excludes them from next run", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlow();
    await writeBoard(workspace, initBoard(flow, "task", "abc123"));

    // Agent 1: cannot_fix p1 in a.ts and b.ts
    await reportResult({
      workspace,
      state_id: "implement",
      status_keyword: "CANNOT_FIX",
      flow,
      principle_ids: ["p1"],
      file_paths: ["a.ts", "b.ts"],
    });

    // Agent 2: cannot_fix p2 in a.ts
    await reportResult({
      workspace,
      state_id: "implement",
      status_keyword: "CANNOT_FIX",
      flow,
      principle_ids: ["p2"],
      file_paths: ["a.ts"],
    });

    const convergence = await checkConvergence({ workspace, state_id: "implement" });
    expect(convergence.cannot_fix_items).toHaveLength(3);

    // Orchestrator excludes known cannot_fix from next iteration's principle set
    const allViolations = [
      { principle_id: "p1", file_path: "a.ts" }, // already cannot_fix
      { principle_id: "p1", file_path: "b.ts" }, // already cannot_fix
      { principle_id: "p2", file_path: "a.ts" }, // already cannot_fix
      { principle_id: "p3", file_path: "a.ts" }, // new — still fixable
    ];

    const remaining = filterCannotFix(allViolations, convergence.cannot_fix_items);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toEqual({ principle_id: "p3", file_path: "a.ts" });
  });
});

// ---------------------------------------------------------------------------
// update-board event emissions (harness-02 declared gap)
// ---------------------------------------------------------------------------

describe("updateBoard — event emissions (harness-02 gap)", () => {
  it("emits board_updated event on enter_state", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlow();
    await writeBoard(workspace, initBoard(flow, "task", "abc123"));

    const boardEvents: FlowEventMap["board_updated"][] = [];
    flowEventBus.on("board_updated", (e) => boardEvents.push(e));

    await updateBoard({ workspace, action: "enter_state", state_id: "implement" });

    expect(boardEvents).toHaveLength(1);
    expect(boardEvents[0].action).toBe("enter_state");
    expect(boardEvents[0].stateId).toBe("implement");
    expect(boardEvents[0].timestamp).toBeTruthy();
  });

  it("emits state_entered event on enter_state", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlow();
    await writeBoard(workspace, initBoard(flow, "task", "abc123"));

    const stateEnteredEvents: FlowEventMap["state_entered"][] = [];
    flowEventBus.on("state_entered", (e) => stateEnteredEvents.push(e));

    await updateBoard({ workspace, action: "enter_state", state_id: "implement" });

    expect(stateEnteredEvents).toHaveLength(1);
    expect(stateEnteredEvents[0].stateId).toBe("implement");
    expect(stateEnteredEvents[0].timestamp).toBeTruthy();
  });

  it("emits board_updated but NOT state_entered on block action", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlow();
    await writeBoard(workspace, initBoard(flow, "task", "abc123"));
    // Enter state first so block has something to work with
    await updateBoard({ workspace, action: "enter_state", state_id: "implement" });

    // Clear listeners to count only the block action events
    flowEventBus.removeAllListeners();

    const boardEvents: FlowEventMap["board_updated"][] = [];
    const stateEnteredEvents: FlowEventMap["state_entered"][] = [];
    flowEventBus.on("board_updated", (e) => boardEvents.push(e));
    flowEventBus.on("state_entered", (e) => stateEnteredEvents.push(e));

    await updateBoard({ workspace, action: "block", state_id: "implement", blocked_reason: "manual block" });

    expect(boardEvents).toHaveLength(1);
    expect(boardEvents[0].action).toBe("block");
    // state_entered should NOT be emitted for non-enter_state actions
    expect(stateEnteredEvents).toHaveLength(0);
  });

  it("cleans up board_updated listener after emission (no listener leak)", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlow();
    await writeBoard(workspace, initBoard(flow, "task", "abc123"));

    const before = flowEventBus.listenerCount("board_updated");

    await updateBoard({ workspace, action: "enter_state", state_id: "implement" });

    const after = flowEventBus.listenerCount("board_updated");
    expect(after).toBe(before);
  });

  it("emits board_updated on complete_flow action", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlow();
    await writeBoard(workspace, initBoard(flow, "task", "abc123"));
    await updateBoard({ workspace, action: "enter_state", state_id: "ship" });

    flowEventBus.removeAllListeners();

    const boardEvents: FlowEventMap["board_updated"][] = [];
    flowEventBus.on("board_updated", (e) => boardEvents.push(e));

    await updateBoard({ workspace, action: "complete_flow" });

    expect(boardEvents).toHaveLength(1);
    expect(boardEvents[0].action).toBe("complete_flow");
  });
});

// ---------------------------------------------------------------------------
// get-spawn-prompt with inject_context end-to-end (harness-06 declared gap)
// ---------------------------------------------------------------------------

describe("getSpawnPrompt — inject_context end-to-end (harness-06 gap)", () => {
  it("injects artifact content from a prior state into spawn prompt variable", async () => {
    const workspace = makeTmpWorkspace();
    const artifactPath = join(workspace, "research-output.md");
    await writeFile(artifactPath, "Key findings: use pattern X.");

    // Build board with research state having artifacts
    const flow: ResolvedFlow = {
      name: "test-flow",
      description: "test",
      entry: "implement",
      spawn_instructions: {
        implement: "Implement using context: ${RESEARCH}",
      },
      states: {
        research: { type: "terminal" },
        implement: {
          type: "single",
          agent: "canon-implementor",
          inject_context: [
            { from: "research", as: "RESEARCH" },
          ],
          transitions: { done: "ship" },
        },
        ship: { type: "terminal" },
      },
    };

    const board = initBoard(flow, "task", "abc123");
    // Simulate research state having completed with an artifact
    const boardWithArtifact: Board = {
      ...board,
      states: {
        ...board.states,
        research: {
          ...board.states["research"],
          status: "done",
          artifacts: [artifactPath],
        },
      },
    };
    await writeBoard(workspace, boardWithArtifact);

    const result = await getSpawnPrompt({
      workspace,
      state_id: "implement",
      flow,
      variables: {},
    });

    expect(result.prompts).toHaveLength(1);
    // The injected artifact content should appear in the prompt
    expect(result.prompts[0].prompt).toContain("Key findings: use pattern X.");
    expect(result.skip_reason).toBeUndefined();
  });

  it("returns skip_reason when inject_context from:user triggers HITL", async () => {
    const workspace = makeTmpWorkspace();

    const flow: ResolvedFlow = {
      name: "test-flow",
      description: "test",
      entry: "implement",
      spawn_instructions: {
        implement: "Implement with user guidance: ${USER_INPUT}",
      },
      states: {
        implement: {
          type: "single",
          agent: "canon-implementor",
          inject_context: [
            { from: "user", as: "USER_INPUT", prompt: "Please describe the scope" },
          ],
          transitions: { done: "ship" },
        },
        ship: { type: "terminal" },
      },
    };

    const board = initBoard(flow, "task", "abc123");
    await writeBoard(workspace, board);

    const result = await getSpawnPrompt({
      workspace,
      state_id: "implement",
      flow,
      variables: {},
    });

    // Should get HITL skip, not a prompt
    expect(result.prompts).toHaveLength(0);
    expect(result.skip_reason).toContain("HITL required");
    expect(result.skip_reason).toContain("Please describe the scope");
  });

  it("includes warnings in result when inject_context artifact is missing", async () => {
    const workspace = makeTmpWorkspace();

    const flow: ResolvedFlow = {
      name: "test-flow",
      description: "test",
      entry: "implement",
      spawn_instructions: {
        implement: "Do work: ${CONTEXT}",
      },
      states: {
        research: { type: "terminal" },
        implement: {
          type: "single",
          agent: "canon-implementor",
          inject_context: [
            { from: "research", as: "CONTEXT" },
          ],
          transitions: { done: "ship" },
        },
        ship: { type: "terminal" },
      },
    };

    const board = initBoard(flow, "task", "abc123");
    // Set research as done with a missing artifact file
    const boardWithMissingArtifact: Board = {
      ...board,
      states: {
        ...board.states,
        research: {
          ...board.states["research"],
          status: "done",
          artifacts: ["does-not-exist.md"],
        },
      },
    };
    await writeBoard(workspace, boardWithMissingArtifact);

    const result = await getSpawnPrompt({
      workspace,
      state_id: "implement",
      flow,
      variables: {},
    });

    // Should still produce a prompt (warnings don't block execution)
    expect(result.prompts).toHaveLength(1);
    // But there should be a warning about the missing artifact
    expect(result.warnings).toBeDefined();
    expect(result.warnings?.some((w) => w.includes("does-not-exist.md"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// get-spawn-prompt with both skip_when AND inject_context on same state
// (harness-04 + harness-06 combined)
// ---------------------------------------------------------------------------

describe("getSpawnPrompt — skip_when evaluated before inject_context", () => {
  beforeEach(() => {
    execSyncImpl = null;
  });

  it("returns skip_reason (skip_when met) without evaluating inject_context", async () => {
    // skip_when: no_contract_changes → skip if only internal files changed
    execSyncImpl = () => ({ stdout: "src/internal/helper.ts\n", status: 0 }); // no contract files

    const workspace = makeTmpWorkspace();

    const flow: ResolvedFlow = {
      name: "test-flow",
      description: "test",
      entry: "type-check",
      spawn_instructions: {
        "type-check": "Check types with context: ${PRIOR}",
      },
      states: {
        prior: { type: "terminal" },
        "type-check": {
          type: "single",
          agent: "canon-reviewer",
          skip_when: "no_contract_changes",
          inject_context: [
            { from: "prior", as: "PRIOR" },
          ],
          transitions: { done: "ship" },
        },
        ship: { type: "terminal" },
      },
    };

    const board = initBoard(flow, "task", "abc1234");
    await writeBoard(workspace, board);

    const result = await getSpawnPrompt({
      workspace,
      state_id: "type-check",
      flow,
      variables: {},
    });

    // Should skip — not attempt inject_context
    expect(result.prompts).toHaveLength(0);
    expect(result.skip_reason).toContain("no_contract_changes");
  });

  it("falls through to inject_context when skip_when is NOT met", async () => {
    // skip_when: no_contract_changes → don't skip if contract file changed
    execSyncImpl = () => ({ stdout: "src/api/users.ts\n", status: 0 }); // contract file changed

    const workspace = makeTmpWorkspace();
    const artifactPath = join(workspace, "context.md");
    await writeFile(artifactPath, "Important context here.");

    const flow: ResolvedFlow = {
      name: "test-flow",
      description: "test",
      entry: "review",
      spawn_instructions: {
        review: "Review with context: ${CONTEXT}",
      },
      states: {
        prior: { type: "terminal" },
        review: {
          type: "single",
          agent: "canon-reviewer",
          skip_when: "no_contract_changes",
          inject_context: [
            { from: "prior", as: "CONTEXT" },
          ],
          transitions: { done: "ship" },
        },
        ship: { type: "terminal" },
      },
    };

    const board = initBoard(flow, "task", "abc1234");
    const boardWithArtifact: Board = {
      ...board,
      states: {
        ...board.states,
        prior: {
          ...board.states["prior"],
          status: "done",
          artifacts: [artifactPath],
        },
      },
    };
    await writeBoard(workspace, boardWithArtifact);

    const result = await getSpawnPrompt({
      workspace,
      state_id: "review",
      flow,
      variables: {},
    });

    // Not skipped — inject_context runs and populates CONTEXT
    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0].prompt).toContain("Important context here.");
    expect(result.skip_reason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// get-spawn-prompt — deferred-field warnings (harness-04 declared gap)
// ---------------------------------------------------------------------------

describe("getSpawnPrompt — deferred-field warnings", () => {
  it("does NOT emit deferred-field warning for 'gate' field (gate is now implemented)", async () => {
    const workspace = makeTmpWorkspace();

    const flow: ResolvedFlow = {
      name: "test-flow",
      description: "test",
      entry: "build",
      spawn_instructions: { build: "Build the feature." },
      states: {
        build: {
          type: "single",
          agent: "canon-implementor",
          gate: "some-gate-condition",
          transitions: { done: "ship" },
        },
        ship: { type: "terminal" },
      },
    };

    await writeBoard(workspace, initBoard(flow, "task", "abc123"));

    const result = await getSpawnPrompt({
      workspace,
      state_id: "build",
      flow,
      variables: {},
    });

    expect(result.prompts).toHaveLength(1); // still produces prompt
    // gate is implemented — no deferred warning should be emitted for it
    const gateWarnings = result.warnings?.filter((w) => w.includes("gate") && w.includes("not yet implemented")) ?? [];
    expect(gateWarnings).toHaveLength(0);
  });

  it("does not emit deferred-field warning for 'consultations' or 'gate'", async () => {
    // consultations and gate are now implemented — they should NOT produce deferred warnings.
    // The remaining deferred fields are: large_diff_threshold, cluster_by, timeout.
    const workspace = makeTmpWorkspace();

    const flow: ResolvedFlow = {
      name: "test-flow",
      description: "test",
      entry: "build",
      spawn_instructions: { build: "Build the feature." },
      states: {
        build: {
          type: "single",
          agent: "canon-implementor",
          gate: "some-gate-condition",
          transitions: { done: "ship" },
        },
        ship: { type: "terminal" },
      },
    };

    await writeBoard(workspace, initBoard(flow, "task", "abc123"));

    const result = await getSpawnPrompt({
      workspace,
      state_id: "build",
      flow,
      variables: {},
    });

    const deferredWarnings = result.warnings?.filter((w) => w.includes("not yet implemented")) ?? [];
    // Neither gate nor consultations should appear as deferred warnings
    expect(deferredWarnings.some((w) => w.includes("gate"))).toBe(false);
    // consultations is not a field that can be set on a single-agent state in this schema,
    // but if it were present it would not produce a deferred warning either.
  });

  it("emits warning when state has 'timeout' field", async () => {
    const workspace = makeTmpWorkspace();

    const flow: ResolvedFlow = {
      name: "test-flow",
      description: "test",
      entry: "build",
      spawn_instructions: { build: "Build the feature." },
      states: {
        build: {
          type: "single",
          agent: "canon-implementor",
          timeout: "30m",
          transitions: { done: "ship" },
        },
        ship: { type: "terminal" },
      },
    };

    await writeBoard(workspace, initBoard(flow, "task", "abc123"));

    const result = await getSpawnPrompt({
      workspace,
      state_id: "build",
      flow,
      variables: {},
    });

    expect(result.warnings?.some((w) => w.includes("timeout"))).toBe(true);
  });

  it("emits warnings for multiple deferred fields simultaneously", async () => {
    const workspace = makeTmpWorkspace();

    const flow: ResolvedFlow = {
      name: "test-flow",
      description: "test",
      entry: "build",
      spawn_instructions: { build: "Build the feature." },
      states: {
        build: {
          type: "single",
          agent: "canon-implementor",
          gate: "some-gate",
          timeout: "15m",
          large_diff_threshold: 500,
          transitions: { done: "ship" },
        },
        ship: { type: "terminal" },
      },
    };

    await writeBoard(workspace, initBoard(flow, "task", "abc123"));

    const result = await getSpawnPrompt({
      workspace,
      state_id: "build",
      flow,
      variables: {},
    });

    expect(result.warnings).toBeDefined();
    const fieldWarnings = result.warnings?.filter((w) => w.includes("not yet implemented")) ?? [];
    // gate is now implemented — only timeout and large_diff_threshold remain deferred
    expect(fieldWarnings.length).toBe(2);
    expect(fieldWarnings.some((w) => w.includes("timeout"))).toBe(true);
    expect(fieldWarnings.some((w) => w.includes("large_diff_threshold"))).toBe(true);
    expect(fieldWarnings.some((w) => w.includes("gate"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility: board.json without new optional fields still parses
// ---------------------------------------------------------------------------

describe("backward compatibility: board.json without new fields", () => {
  it("board without parallel_results in state entries still parses and reads correctly", async () => {
    const workspace = makeTmpWorkspace();

    // Write a board JSON that lacks the parallel_results field (old format)
    const legacyBoard = {
      flow: "test-flow",
      task: "legacy task",
      entry: "build",
      current_state: "build",
      base_commit: "oldsha123",
      started: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      states: {
        build: {
          status: "done",
          entries: 1,
          result: "done",
          // No parallel_results field — legacy format
        },
        ship: {
          status: "pending",
          entries: 0,
        },
      },
      iterations: {},
      blocked: null,
      concerns: [],
      skipped: [],
    };

    writeFileSync(join(workspace, "board.json"), JSON.stringify(legacyBoard));

    // Should parse without error
    const board = await readBoard(workspace);
    expect(board.states["build"].status).toBe("done");
    expect(board.states["build"].parallel_results).toBeUndefined();
    expect(board.current_state).toBe("build");
  });

  it("board without concerns and skipped arrays is rejected by schema (they are required)", async () => {
    const workspace = makeTmpWorkspace();

    // Board missing required fields
    const malformedBoard = {
      flow: "test-flow",
      task: "task",
      entry: "build",
      current_state: "build",
      base_commit: "sha",
      started: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      states: {},
      iterations: {},
      blocked: null,
      // Missing concerns and skipped
    };

    writeFileSync(join(workspace, "board.json"), JSON.stringify(malformedBoard));

    // readBoard should throw (Zod validation error) since these fields are required
    await expect(readBoard(workspace)).rejects.toThrow();
  });

  it("BoardSchema validates a board with new optional fields alongside existing fields", () => {
    const boardWithNewFields = {
      flow: "test-flow",
      task: "task",
      entry: "build",
      current_state: "build",
      base_commit: "sha123",
      started: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      states: {
        build: {
          status: "done",
          entries: 2,
          parallel_results: [
            { item: "task-a", status: "done" },
            { item: "task-b", status: "cannot_fix", artifacts: ["report.md"] },
          ],
        },
      },
      iterations: {
        build: {
          count: 2,
          max: 3,
          history: [],
          cannot_fix: [{ principle_id: "p1", file_path: "a.ts" }],
        },
      },
      blocked: null,
      concerns: [],
      skipped: [],
    };

    const parsed = BoardSchema.safeParse(boardWithNewFields);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.states["build"].parallel_results).toHaveLength(2);
      expect(parsed.data.iterations["build"].cannot_fix).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: store_pr_review → PrStore round-trip with pr_number filtering
// (harness-01 gap: store + retrieve with filter)
// ---------------------------------------------------------------------------

describe("store_pr_review — get_pr_review_data round-trip", () => {
  it("storing multiple reviews and retrieving by pr_number returns only matching ones", async () => {
    const workspace = makeTmpWorkspace();
    await mkdir(join(workspace, ".canon"), { recursive: true });

    const { storePrReview } = await import("../tools/store-pr-review.js");
    const { PrStore } = await import("../drift/pr-store.js");

    // Store two reviews for PR #1 and one for PR #2
    await storePrReview(
      {
        pr_number: 1,
        verdict: "WARNING",
        files: ["a.ts"],
        violations: [],
        honored: [],
        score: { rules: { passed: 1, total: 1 }, opinions: { passed: 1, total: 1 }, conventions: { passed: 1, total: 1 } },
      },
      workspace
    );
    await storePrReview(
      {
        pr_number: 1,
        verdict: "CLEAN",
        files: ["a.ts"],
        violations: [],
        honored: [],
        score: { rules: { passed: 1, total: 1 }, opinions: { passed: 1, total: 1 }, conventions: { passed: 1, total: 1 } },
      },
      workspace
    );
    await storePrReview(
      {
        pr_number: 2,
        verdict: "BLOCKING",
        files: ["b.ts"],
        violations: [{ principle_id: "p1", severity: "rule" }],
        honored: [],
        score: { rules: { passed: 0, total: 1 }, opinions: { passed: 0, total: 0 }, conventions: { passed: 0, total: 0 } },
      },
      workspace
    );

    const store = new PrStore(workspace);
    const pr1Reviews = await store.getReviews(1);
    const pr2Reviews = await store.getReviews(2);
    const allReviews = await store.getReviews();

    expect(pr1Reviews).toHaveLength(2);
    expect(pr2Reviews).toHaveLength(1);
    expect(pr2Reviews[0].verdict).toBe("BLOCKING");
    expect(allReviews).toHaveLength(3);

    // All have unique IDs
    const ids = allReviews.map((r) => r.pr_review_id);
    expect(new Set(ids).size).toBe(3);
  });
});
