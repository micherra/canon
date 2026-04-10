/**
 * Reachability analysis tests — dead-end and stuck-loop detection.
 *
 * Tests for:
 *   - buildReverseGraph: invert adjacency list
 *   - detectDeadEnds: BFS from terminals + hitl-adjacent, flag states with no path to terminal/hitl
 *   - detectStuckLoops: Tarjan's SCC, flag cycles where no member exits to terminal-reachable state
 *   - analyzeReachability: combined unreachable + dead-end + stuck-loop warnings
 */

import { flowName } from "@domains/flows/board-state-schemas.ts";
import { describe, expect, it } from "vitest";
import type { ResolvedFlow } from "../flow-definition-schemas.ts";
import {
  analyzeReachability,
  buildReverseGraph,
  collectReachableStates,
  detectDeadEnds,
  detectStuckLoops,
} from "../flow-parser.ts";

// Helper to build a minimal ResolvedFlow from inline state specs
function makeFlow(
  states: ResolvedFlow["states"],
  entry: string,
  spawnInstructions?: Record<string, string>,
): ResolvedFlow {
  const si: Record<string, string> = spawnInstructions ?? {};
  // Default: add spawn instructions for all non-terminal states
  for (const [id, s] of Object.entries(states)) {
    if (s.type !== "terminal" && !si[id]) {
      si[id] = `Do ${id}`;
    }
  }
  return {
    description: "test",
    entry,
    name: flowName("test-flow"),
    spawn_instructions: si,
    states,
  };
}

// buildReverseGraph

describe("buildReverseGraph", () => {
  it("correctly inverts a simple graph", () => {
    const graph: Record<string, string[]> = {
      a: ["b", "c"],
      b: ["c"],
      c: [],
    };
    const reversed = buildReverseGraph(graph);

    // a has no incoming edges, so reversed["a"] should be []
    expect(reversed.a).toEqual([]);
    // b is reachable from a only
    expect(reversed.b).toEqual(["a"]);
    // c is reachable from a and b
    expect(reversed.c.sort()).toEqual(["a", "b"]);
  });

  it("includes all state IDs as keys even if they have no incoming edges", () => {
    const graph: Record<string, string[]> = {
      entry: ["middle"],
      middle: ["terminal"],
      terminal: [],
    };
    const reversed = buildReverseGraph(graph);
    expect(Object.keys(reversed).sort()).toEqual(["entry", "middle", "terminal"]);
    expect(reversed.entry).toEqual([]);
  });

  it("handles self-loops", () => {
    const graph: Record<string, string[]> = {
      a: ["a", "b"],
      b: [],
    };
    const reversed = buildReverseGraph(graph);
    expect(reversed.a).toContain("a");
    expect(reversed.b).toContain("a");
  });
});

// detectDeadEnds

describe("detectDeadEnds", () => {
  it("returns empty for a flow where all states reach a terminal", () => {
    const flow = makeFlow(
      {
        done: { type: "terminal" },
        start: { agent: "a", transitions: { done: "done" }, type: "single" },
      },
      "start",
    );
    const warnings = detectDeadEnds(flow);
    expect(warnings).toEqual([]);
  });

  it("flags a state reachable from entry but with no path to terminal", () => {
    // start -> dead (dead has no transitions out)
    const flow = makeFlow(
      {
        dead: { agent: "d", transitions: {}, type: "single" },
        done: { type: "terminal" },
        start: { agent: "a", transitions: { dead: "dead", done: "done" }, type: "single" },
      },
      "start",
    );
    const warnings = detectDeadEnds(flow);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/dead/);
    expect(warnings[0]).toMatch(/Warning:/);
    expect(warnings[0]).toMatch(/dead-end/);
  });

  it("does NOT flag a state that only exits via hitl", () => {
    // hitl-exit: its only transition target is hitl (a VIRTUAL_SINK)
    const flow = makeFlow(
      {
        done: { type: "terminal" },
        hitl_exit: { agent: "h", transitions: { stuck: "hitl" }, type: "single" },
        start: { agent: "a", transitions: { done: "done", stuck: "hitl_exit" }, type: "single" },
      },
      "start",
    );
    const warnings = detectDeadEnds(flow);
    expect(warnings).toEqual([]);
  });

  it("does NOT flag a state that only exits via no_items", () => {
    // no_items_exit: its only transition target is no_items (a VIRTUAL_SINK)
    const flow = makeFlow(
      {
        done: { type: "terminal" },
        no_items_exit: { agent: "n", transitions: { empty: "no_items" }, type: "single" },
        start: {
          agent: "a",
          transitions: { done: "done", process: "no_items_exit" },
          type: "single",
        },
      },
      "start",
    );
    const warnings = detectDeadEnds(flow);
    expect(warnings).toEqual([]);
  });

  it("does not flag terminal states themselves as dead-ends", () => {
    const flow = makeFlow(
      {
        done: { type: "terminal" },
        start: { agent: "a", transitions: { done: "done" }, type: "single" },
      },
      "start",
    );
    const warnings = detectDeadEnds(flow);
    for (const w of warnings) {
      expect(w).not.toMatch(/"done"/);
    }
  });

  it("self-loop-only state has no path to terminal — flagged as dead-end", () => {
    // self_loop transitions only to itself, never to done
    const flow = makeFlow(
      {
        done: { type: "terminal" },
        self_loop: { agent: "s", transitions: { retry: "self_loop" }, type: "single" },
        start: { agent: "a", transitions: { done: "done", loop: "self_loop" }, type: "single" },
      },
      "start",
    );
    const warnings = detectDeadEnds(flow);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/self_loop/);
  });

  it("flags all intermediate states when every path goes through dead-end states", () => {
    // start -> a -> b (b is dead-end, a only leads to b)
    const flow = makeFlow(
      {
        a: { agent: "a", transitions: { next: "b" }, type: "single" },
        b: { agent: "b", transitions: {}, type: "single" },
        done: { type: "terminal" },
        start: { agent: "s", transitions: { go: "a" }, type: "single" },
      },
      "start",
    );
    const warnings = detectDeadEnds(flow);
    // Both a and b should be flagged
    const flaggedIds = warnings.map((w) => {
      const m = w.match(/"([^"]+)" is a dead-end/);
      return m ? m[1] : "";
    });
    expect(flaggedIds).toContain("a");
    expect(flaggedIds).toContain("b");
  });
});

// detectStuckLoops

describe("detectStuckLoops", () => {
  it("returns empty for a flow with no cycles", () => {
    const flow = makeFlow(
      {
        done: { type: "terminal" },
        middle: { agent: "m", transitions: { done: "done" }, type: "single" },
        start: { agent: "a", transitions: { next: "middle" }, type: "single" },
      },
      "start",
    );
    const warnings = detectStuckLoops(flow);
    expect(warnings).toEqual([]);
  });

  it("flags a cycle where no member can reach a terminal", () => {
    // a -> b -> a (stuck cycle, neither reaches done)
    const flow = makeFlow(
      {
        a: { agent: "a", transitions: { next: "b" }, type: "single" },
        b: { agent: "b", transitions: { back: "a" }, type: "single" },
        done: { type: "terminal" },
        start: { agent: "s", transitions: { go: "a" }, type: "single" },
      },
      "start",
    );
    const warnings = detectStuckLoops(flow);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/Warning:/);
    expect(warnings[0]).toMatch(/stuck loop/);
    expect(warnings[0]).toMatch(/a/);
    expect(warnings[0]).toMatch(/b/);
  });

  it("does NOT flag a cycle where at least one member exits to terminal-reachable state", () => {
    // a -> b -> a, but a also -> done
    const flow = makeFlow(
      {
        a: { agent: "a", transitions: { done: "done", retry: "b" }, type: "single" },
        b: { agent: "b", transitions: { back: "a" }, type: "single" },
        done: { type: "terminal" },
        start: { agent: "s", transitions: { go: "a" }, type: "single" },
      },
      "start",
    );
    const warnings = detectStuckLoops(flow);
    expect(warnings).toEqual([]);
  });

  it("does NOT flag a cycle where a member exits via hitl", () => {
    // a -> b -> a, but a also -> hitl (virtual sink)
    const flow = makeFlow(
      {
        a: { agent: "a", transitions: { retry: "b", stuck: "hitl" }, type: "single" },
        b: { agent: "b", transitions: { back: "a" }, type: "single" },
        done: { type: "terminal" },
        start: { agent: "s", transitions: { done: "done", go: "a" }, type: "single" },
      },
      "start",
    );
    const warnings = detectStuckLoops(flow);
    expect(warnings).toEqual([]);
  });

  it("self-loop-only state is NOT flagged as stuck-loop (single-node SCC)", () => {
    // self_loop transitions only to itself
    const flow = makeFlow(
      {
        done: { type: "terminal" },
        self_loop: { agent: "s", transitions: { retry: "self_loop" }, type: "single" },
        start: { agent: "a", transitions: { loop: "self_loop" }, type: "single" },
      },
      "start",
    );
    const warnings = detectStuckLoops(flow);
    // Self-loop is a single-node SCC — not reported as stuck-loop
    expect(warnings).toEqual([]);
  });

  it("real test-fix-loop pattern: cycle with terminal exit is NOT stuck", () => {
    // Resembles real Canon flow fragments: test -> fix -> test, but test -> done
    const flow = makeFlow(
      {
        done: { type: "terminal" },
        fix: { agent: "fixer", transitions: { done: "test" }, type: "single" },
        start: { agent: "s", transitions: { go: "test" }, type: "single" },
        test: {
          agent: "tester",
          transitions: { fail: "fix", pass: "done" },
          type: "single",
        },
      },
      "start",
    );
    const warnings = detectStuckLoops(flow);
    expect(warnings).toEqual([]);
  });
});

// analyzeReachability — combined warnings

describe("analyzeReachability", () => {
  it("returns empty for a valid linear flow", () => {
    const flow = makeFlow(
      {
        done: { type: "terminal" },
        start: { agent: "a", transitions: { done: "done" }, type: "single" },
      },
      "start",
    );
    const warnings = analyzeReachability(flow);
    expect(warnings).toEqual([]);
  });

  it("includes unreachable-state warnings alongside dead-end and stuck-loop warnings", () => {
    const flow = makeFlow(
      {
        a: { agent: "a", transitions: { loop: "b" }, type: "single" },
        b: { agent: "b", transitions: { loop: "a" }, type: "single" },
        done: { type: "terminal" },
        orphan: { agent: "o", transitions: { done: "done" }, type: "single" },
        start: { agent: "s", transitions: { go: "a" }, type: "single" },
      },
      "start",
    );
    const warnings = analyzeReachability(flow);

    // 'orphan' is unreachable from entry
    const unreachableWarnings = warnings.filter((w) => w.includes("unreachable"));
    expect(unreachableWarnings.length).toBeGreaterThanOrEqual(1);
    expect(unreachableWarnings.some((w) => w.includes("orphan"))).toBe(true);

    // a and b form a stuck loop
    const stuckWarnings = warnings.filter((w) => w.includes("stuck loop"));
    expect(stuckWarnings.length).toBeGreaterThanOrEqual(1);

    // a and b are dead-ends
    const deadEndWarnings = warnings.filter((w) => w.includes("dead-end"));
    expect(deadEndWarnings.length).toBeGreaterThanOrEqual(2);
  });

  it("all warnings are prefixed with 'Warning:'", () => {
    const flow = makeFlow(
      {
        a: { agent: "a", transitions: { back: "a" }, type: "single" },
        done: { type: "terminal" },
        start: { agent: "s", transitions: { go: "a" }, type: "single" },
      },
      "start",
    );
    const warnings = analyzeReachability(flow);
    for (const w of warnings) {
      expect(w).toMatch(/^Warning:/);
    }
  });
});

// collectReachableStates export

describe("collectReachableStates", () => {
  it("is exported and returns all forward-reachable states", () => {
    const flow = makeFlow(
      {
        done: { type: "terminal" },
        orphan: { agent: "o", transitions: { done: "done" }, type: "single" },
        start: { agent: "a", transitions: { done: "done" }, type: "single" },
      },
      "start",
    );
    const reachable = collectReachableStates(flow);
    expect(reachable.has("start")).toBe(true);
    expect(reachable.has("done")).toBe(true);
    expect(reachable.has("orphan")).toBe(false);
  });
});
