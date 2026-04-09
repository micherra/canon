/**
 * flow-parser-gate-states.test.ts — Unit tests for gate-only state exemption in validateSpawnCoverage.
 *
 * Covers:
 * 1. Gate-only states (type: single, gates: [...], no agent) are exempt from spawn coverage
 * 2. States WITH an agent AND gates still require spawn instructions
 * 3. States without gates and without an agent still require spawn instructions
 *
 * Canon principles:
 * - fail-closed gate philosophy: gate-only exemption is narrow and explicit
 */

import { describe, expect, it } from "vitest";
import type { ResolvedFlow } from "../flow-definition-schemas.ts";
import { validateSpawnCoverage } from "../flow-parser.ts";

function makeBaseFlow(overrides: Partial<ResolvedFlow> = {}): ResolvedFlow {
  return {
    description: "test flow",
    entry: "start",
    name: "test-flow",
    spawn_instructions: {},
    states: {},
    ...overrides,
  };
}

// Test 1: Gate-only states are exempt from spawn coverage

describe("validateSpawnCoverage: gate-only state exemption", () => {
  it("skips gate-only states (type: single, gates declared, no agent)", () => {
    const flow = makeBaseFlow({
      spawn_instructions: {
        // No instruction for "check" — gate-only state is exempt
        review: "Do review",
      },
      states: {
        check: {
          gates: ["npm run build"],
          transitions: { done: "review" },
          type: "single",
        },
        review: {
          agent: "canon:canon-reviewer",
          transitions: { done: "terminal" },
          type: "single",
        },
        terminal: {
          type: "terminal",
        },
      },
    });

    const errors = validateSpawnCoverage(flow);
    expect(errors).toHaveLength(0);
  });

  it("skips gate-only states with multiple gates", () => {
    const flow = makeBaseFlow({
      spawn_instructions: {
        review: "Do review",
      },
      states: {
        check: {
          gates: ["npm run build", "npm test"],
          transitions: { done: "review" },
          type: "single",
        },
        review: {
          agent: "canon:canon-reviewer",
          transitions: { done: "terminal" },
          type: "single",
        },
        terminal: {
          type: "terminal",
        },
      },
    });

    const errors = validateSpawnCoverage(flow);
    expect(errors).toHaveLength(0);
  });
});

// Test 2: States with agent AND gates still require spawn instructions

describe("validateSpawnCoverage: agent + gates states still need spawn instructions", () => {
  it("requires spawn instruction for states that have both an agent and gates", () => {
    const flow = makeBaseFlow({
      spawn_instructions: {
        // No instruction for "implement" — should error even though it has gates
      },
      states: {
        implement: {
          agent: "canon:canon-implementor",
          gates: ["npm test"],
          transitions: { done: "terminal" },
          type: "single",
        },
        terminal: {
          type: "terminal",
        },
      },
    });

    const errors = validateSpawnCoverage(flow);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"implement"');
  });

  it("no error when agent + gates state has a spawn instruction", () => {
    const flow = makeBaseFlow({
      spawn_instructions: {
        implement: "Implement the changes",
      },
      states: {
        implement: {
          agent: "canon:canon-implementor",
          gates: ["npm test"],
          transitions: { done: "terminal" },
          type: "single",
        },
        terminal: {
          type: "terminal",
        },
      },
    });

    const errors = validateSpawnCoverage(flow);
    expect(errors).toHaveLength(0);
  });
});

// Test 3: States without gates and without agent require spawn instructions

describe("validateSpawnCoverage: states without gates or agent require spawn instructions", () => {
  it("requires spawn instruction for states that have no gates and no agent", () => {
    const flow = makeBaseFlow({
      spawn_instructions: {},
      states: {
        research: {
          // No agent, no gates — should still require spawn instruction
          transitions: { done: "terminal" },
          type: "single",
        },
        terminal: {
          type: "terminal",
        },
      },
    });

    const errors = validateSpawnCoverage(flow);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"research"');
  });

  it("terminal states are always exempt (baseline regression)", () => {
    const flow = makeBaseFlow({
      spawn_instructions: {},
      states: {
        terminal: {
          type: "terminal",
        },
      },
    });

    const errors = validateSpawnCoverage(flow);
    expect(errors).toHaveLength(0);
  });
});

// Test 4: Mixed flow with gate-only + normal states

describe("validateSpawnCoverage: mixed flow", () => {
  it("reports errors only for non-gate-only states without spawn instructions", () => {
    const flow = makeBaseFlow({
      spawn_instructions: {
        // Missing "implement" instruction — should error
        // "check" is exempt (gate-only)
        review: "Do review",
      },
      states: {
        check: {
          gates: ["npm run build"],
          transitions: { done: "implement" },
          type: "single",
        },
        implement: {
          agent: "canon:canon-implementor",
          transitions: { done: "review" },
          type: "single",
        },
        review: {
          agent: "canon:canon-reviewer",
          transitions: { done: "terminal" },
          type: "single",
        },
        terminal: {
          type: "terminal",
        },
      },
    });

    const errors = validateSpawnCoverage(flow);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"implement"');
    // "check" should not appear in errors
    expect(errors.join("")).not.toContain('"check"');
  });
});
