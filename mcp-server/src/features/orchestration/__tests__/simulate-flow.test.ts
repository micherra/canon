/**
 * Tests for simulate-flow.ts — pure simulation engine and tool wrapper.
 *
 * Pure engine tests use in-memory ResolvedFlow objects (no file I/O).
 * Integration tests use real flow files via simulateFlowTool.
 */

import { resolve } from "node:path";
import type { ResolvedFlow } from "@domains/flows/flow-definition-schemas.ts";
import { isToolError } from "@shared/lib/tool-result.ts";
import { describe, expect, it } from "vitest";
import { simulateFlow, simulateFlowTool } from "../tools/simulate-flow.ts";
import { stateId as sid, flowName } from "@domains/flows/board-state-schemas.ts";

const pluginDir = resolve(process.cwd(), ".."); // mcp-server/ → project root

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFlow(overrides: Partial<ResolvedFlow> = {}): ResolvedFlow {
  return {
    description: "test",
    entry: sid("start"),
    name: flowName("test-flow"),
    spawn_instructions: { [sid("start")]: "Do the thing" },
    states: {
      [sid("end")]: { type: "terminal" },
      [sid("start")]: { agent: "agent-a", transitions: { done: "end" }, type: "single" },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure engine tests — simulateFlow()
// ---------------------------------------------------------------------------

describe("simulateFlow — happy path", () => {
  it("linear flow reaches terminal state with ok: true", () => {
    const flow = makeFlow();
    const result = simulateFlow(flow, [{ state_id: "start", status: "done" }], 50);
    expect(result.ok).toBe(true);
    expect(result.terminal_state).toBe("end");
    expect(result.path).toHaveLength(1);
    expect(result.path[0]).toMatchObject({
      next_state: "end",
      state_id: "start",
      status_input: "done",
      transition_matched: "done",
    });
    expect(result.stuck_at).toBeUndefined();
    expect(result.dead_end_at).toBeUndefined();
  });

  it("multi-step linear flow accumulates path entries", () => {
    const flow = makeFlow({
      states: {
        [sid("end")]: { type: "terminal" },
        [sid("middle")]: { agent: "agent-b", transitions: { done: "end" }, type: "single" },
        [sid("start")]: { agent: "agent-a", transitions: { done: "middle" }, type: "single" },
      },
    });
    const result = simulateFlow(
      flow,
      [
        { state_id: "start", status: "done" },
        { state_id: "middle", status: "done" },
      ],
      50,
    );
    expect(result.ok).toBe(true);
    expect(result.terminal_state).toBe("end");
    expect(result.path).toHaveLength(2);
  });
});

describe("simulateFlow — dead-end: no matching transition", () => {
  it("returns ok: false and dead_end_at when status has no matching transition", () => {
    const flow = makeFlow({
      states: {
        [sid("end")]: { type: "terminal" },
        [sid("start")]: { agent: "agent-a", transitions: { done: "end" }, type: "single" },
      },
    });
    const result = simulateFlow(flow, [{ state_id: "start", status: "blocked" }], 50);
    expect(result.ok).toBe(false);
    expect(result.dead_end_at).toBe("start");
    expect(result.terminal_state).toBeUndefined();
    expect(result.stuck_at).toBeUndefined();
  });
});

describe("simulateFlow — scenario mismatch", () => {
  it("returns ok: false and dead_end_at when scenario state_id does not match current state", () => {
    const flow = makeFlow();
    // scenario says we're at "middle" but flow starts at "start"
    const result = simulateFlow(flow, [{ state_id: "middle", status: "done" }], 50);
    expect(result.ok).toBe(false);
    expect(result.dead_end_at).toBe("start");
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("mismatch");
  });
});

describe("simulateFlow — stuck at max_iterations", () => {
  it("returns ok: false and stuck_at when max_iterations exceeded", () => {
    const flow = makeFlow({
      entry: sid("looping"),
      states: {
        [sid("end")]: { type: "terminal" },
        [sid("looping")]: {
          agent: "agent-a",
          max_iterations: 2,
          transitions: { done: "end", retry: "looping" },
          type: "single",
        },
      },
    });
    // Visit looping 3 times (exceeds max_iterations: 2)
    const result = simulateFlow(
      flow,
      [
        { state_id: "looping", status: "retry" },
        { state_id: "looping", status: "retry" },
        { state_id: "looping", status: "retry" },
      ],
      50,
    );
    expect(result.ok).toBe(false);
    expect(result.stuck_at).toBe("looping");
    expect(result.warnings.some((w) => w.includes("max_iterations"))).toBe(true);
  });
});

describe("simulateFlow — max_steps exceeded", () => {
  it("returns ok: false with stuck_at and warning when max_steps reached", () => {
    const flow = makeFlow({
      entry: sid("looping"),
      states: {
        [sid("end")]: { type: "terminal" },
        // self-loop state (no max_iterations)
        [sid("looping")]: {
          agent: "agent-a",
          transitions: { done: "end", loop: "looping" },
          type: "single",
        },
      },
    });
    // Very long scenario that would loop forever without max_steps
    const scenario = Array.from({ length: 100 }, () => ({ state_id: "looping", status: "loop" }));
    const result = simulateFlow(flow, scenario, 5);
    expect(result.ok).toBe(false);
    expect(result.stuck_at).toBe("looping");
    expect(result.warnings.some((w) => w.includes("max_steps"))).toBe(true);
  });
});

describe("simulateFlow — hitl exit (virtual sink)", () => {
  it("treats hitl as terminal success (ok: true)", () => {
    const flow = makeFlow({
      states: {
        [sid("end")]: { type: "terminal" },
        [sid("start")]: {
          agent: "agent-a",
          transitions: { blocked: "hitl", done: "end" },
          type: "single",
        },
      },
    });
    const result = simulateFlow(flow, [{ state_id: "start", status: "blocked" }], 50);
    expect(result.ok).toBe(true);
    // terminal_state is the state that exited to hitl
    expect(result.terminal_state).toBe("start");
    expect(result.path).toHaveLength(1);
    expect(result.path[0].next_state).toBe("hitl");
  });
});

describe("simulateFlow — no_items exit (virtual sink)", () => {
  it("treats no_items as terminal success (ok: true)", () => {
    const flow = makeFlow({
      states: {
        [sid("end")]: { type: "terminal" },
        [sid("start")]: {
          agent: "agent-a",
          transitions: { done: "end", no_items: "no_items" },
          type: "single",
        },
      },
    });
    const result = simulateFlow(flow, [{ state_id: "start", status: "no_items" }], 50);
    expect(result.ok).toBe(true);
    expect(result.terminal_state).toBe("start");
    expect(result.path[0].next_state).toBe("no_items");
  });
});

describe("simulateFlow — wave state warning", () => {
  it("emits warning when encountering a wave state", () => {
    const flow = makeFlow({
      entry: sid("wave_state"),
      states: {
        [sid("end")]: { type: "terminal" },
        [sid("wave_state")]: {
          transitions: { done: "end" },
          type: "wave",
        },
      },
    });
    const result = simulateFlow(flow, [{ state_id: "wave_state", status: "done" }], 50);
    expect(result.warnings.some((w) => w.includes("wave_state") && w.includes("wave"))).toBe(true);
    // Simulation continues normally
    expect(result.ok).toBe(true);
    expect(result.terminal_state).toBe("end");
  });

  it("emits warning when encountering a parallel state", () => {
    const flow = makeFlow({
      entry: sid("par_state"),
      states: {
        [sid("end")]: { type: "terminal" },
        [sid("par_state")]: {
          roles: ["role-a", "role-b"],
          transitions: { done: "end" },
          type: "parallel",
        },
      },
    });
    const result = simulateFlow(flow, [{ state_id: "par_state", status: "done" }], 50);
    expect(result.warnings.some((w) => w.includes("par_state") && w.includes("parallel"))).toBe(
      true,
    );
  });

  it("emits warning when encountering a parallel-per state", () => {
    const flow = makeFlow({
      entry: sid("ppar_state"),
      states: {
        [sid("end")]: { type: "terminal" },
        [sid("ppar_state")]: {
          roles: ["role-a"],
          transitions: { done: "end" },
          type: "parallel-per",
        },
      },
    });
    const result = simulateFlow(flow, [{ state_id: "ppar_state", status: "done" }], 50);
    expect(
      result.warnings.some((w) => w.includes("ppar_state") && w.includes("parallel-per")),
    ).toBe(true);
  });
});

describe("simulateFlow — skip_when warning", () => {
  it("emits warning when state has skip_when", () => {
    const flow = makeFlow({
      states: {
        [sid("end")]: { type: "terminal" },
        [sid("start")]: {
          agent: "agent-a",
          skip_when: "no_contract_changes",
          transitions: { done: "end" },
          type: "single",
        },
      },
    });
    const result = simulateFlow(flow, [{ state_id: "start", status: "done" }], 50);
    expect(result.warnings.some((w) => w.includes("start") && w.includes("skip_when"))).toBe(true);
    // Simulation still proceeds normally
    expect(result.ok).toBe(true);
  });
});

describe("simulateFlow — iteration tracking", () => {
  it("counts iterations_consumed correctly for looping states", () => {
    const flow = makeFlow({
      entry: sid("looping"),
      states: {
        [sid("end")]: { type: "terminal" },
        [sid("looping")]: {
          agent: "agent-a",
          transitions: { done: "end", loop: "looping" },
          type: "single",
        },
      },
    });
    const result = simulateFlow(
      flow,
      [
        { state_id: "looping", status: "loop" },
        { state_id: "looping", status: "loop" },
        { state_id: "looping", status: "done" },
      ],
      50,
    );
    expect(result.ok).toBe(true);
    expect(result.iterations_consumed.looping).toBe(3);
  });
});

describe("simulateFlow — empty scenario", () => {
  it("returns ok: false stuck_at entry state when scenario is empty and entry is not terminal", () => {
    const flow = makeFlow();
    const result = simulateFlow(flow, [], 50);
    expect(result.ok).toBe(false);
    expect(result.stuck_at).toBe("start");
    expect(result.path).toHaveLength(0);
  });

  it("returns ok: true when entry state is terminal (edge case)", () => {
    const flow = makeFlow({
      entry: sid("end"),
      states: {
        [sid("end")]: { type: "terminal" },
        [sid("start")]: { agent: "agent-a", transitions: { done: "end" }, type: "single" },
      },
    });
    const result = simulateFlow(flow, [], 50);
    expect(result.ok).toBe(true);
    expect(result.terminal_state).toBe("end");
  });
});

describe("simulateFlow — cycle traversal with iterations_consumed > 1", () => {
  it("tracks each revisited state separately and increments counters", () => {
    // A → B → A → B → terminal (A visited twice, B visited twice)
    const flow = makeFlow({
      entry: sid("stateA"),
      states: {
        [sid("end")]: { type: "terminal" },
        [sid("stateA")]: {
          agent: "agent-a",
          transitions: { continue: "stateB", done: "end" },
          type: "single",
        },
        [sid("stateB")]: { agent: "agent-b", transitions: { back: "stateA" }, type: "single" },
      },
    });
    const result = simulateFlow(
      flow,
      [
        { state_id: "stateA", status: "continue" },
        { state_id: "stateB", status: "back" },
        { state_id: "stateA", status: "continue" },
        { state_id: "stateB", status: "back" },
        { state_id: "stateA", status: "done" },
      ],
      50,
    );
    expect(result.ok).toBe(true);
    expect(result.iterations_consumed.stateA).toBe(3);
    expect(result.iterations_consumed.stateB).toBe(2);
  });
});

describe("simulateFlow — status alias normalization", () => {
  it('normalizes "fixed" to "done" via STATUS_ALIASES', () => {
    const flow = makeFlow({
      states: {
        [sid("end")]: { type: "terminal" },
        [sid("start")]: { agent: "agent-a", transitions: { done: "end" }, type: "single" },
      },
    });
    // "fixed" should alias to "done" and match the "done" transition
    const result = simulateFlow(flow, [{ state_id: "start", status: "fixed" }], 50);
    expect(result.ok).toBe(true);
    expect(result.terminal_state).toBe("end");
    expect(result.path[0].status_input).toBe("fixed");
    expect(result.path[0].transition_matched).toBe("done");
  });

  it('normalizes "DONE" (uppercase) to "done"', () => {
    const flow = makeFlow();
    const result = simulateFlow(flow, [{ state_id: "start", status: "DONE" }], 50);
    expect(result.ok).toBe(true);
    expect(result.path[0].transition_matched).toBe("done");
  });
});

describe("simulateFlow — max_iterations non-trigger", () => {
  it("does NOT produce stuck warning when state visits < max_iterations", () => {
    const flow = makeFlow({
      entry: sid("looping"),
      states: {
        [sid("end")]: { type: "terminal" },
        [sid("looping")]: {
          agent: "agent-a",
          max_iterations: 3,
          transitions: { done: "end", retry: "looping" },
          type: "single",
        },
      },
    });
    // Visit looping exactly 2 times then exit — under max_iterations: 3
    const result = simulateFlow(
      flow,
      [
        { state_id: "looping", status: "retry" },
        { state_id: "looping", status: "done" },
      ],
      50,
    );
    expect(result.ok).toBe(true);
    expect(result.stuck_at).toBeUndefined();
    expect(result.warnings.some((w) => w.includes("max_iterations"))).toBe(false);
    expect(result.iterations_consumed.looping).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tool wrapper tests — simulateFlowTool()
// ---------------------------------------------------------------------------

describe("simulateFlowTool — integration with real flow file", () => {
  it("loads fast-path flow and returns a valid SimulateFlowOutput structure", async () => {
    const result = await simulateFlowTool(
      {
        flow: flowName("fast-path"),
        max_steps: 50,
        scenario: [{ state_id: "implement", status: "done" }],
      },
      pluginDir,
    );
    // Tool should not return a FLOW_NOT_FOUND or FLOW_PARSE_ERROR
    if (isToolError(result)) {
      // Unexpected tool-level error
      expect(result.error_code).not.toBe("FLOW_NOT_FOUND");
      expect(result.error_code).not.toBe("FLOW_PARSE_ERROR");
      return;
    }
    // The result has the SimulateFlowOutput shape (ok, path, warnings, iterations_consumed)
    expect(Array.isArray(result.path)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(typeof result.iterations_consumed).toBe("object");
  });
});

describe("simulateFlowTool — invalid flow name", () => {
  it("returns FLOW_NOT_FOUND error for unknown flow", async () => {
    const result = await simulateFlowTool(
      {
        flow: flowName("nonexistent-flow-xyz"),
        scenario: [],
      },
      pluginDir,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("FLOW_NOT_FOUND");
  });
});

describe("simulateFlowTool — ToolResult contract", () => {
  it("spreads SimulateFlowOutput fields flat onto the result (no nested data wrapper)", async () => {
    const result = await simulateFlowTool(
      {
        flow: flowName("fast-path"),
        max_steps: 50,
        scenario: [],
      },
      pluginDir,
    );
    // SimulateFlowOutput fields are spread flat on result (not nested)
    // ok: false here because empty scenario → stuck (simulation didn't reach terminal)
    // — this is distinct from a tool error (which would have error_code)
    expect(isToolError(result)).toBe(false); // not a tool-level error
    if (isToolError(result)) return; // narrow for TypeScript
    expect(Array.isArray(result.path)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(typeof result.iterations_consumed).toBe("object");
    // ok: false because simulation was stuck (entry state not terminal, no scenario)
    expect(result.ok).toBe(false);
  });
});
