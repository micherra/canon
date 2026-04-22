import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  FlowDefinition,
  FragmentDefinition,
  FragmentInclude,
} from "../flow-definition-schemas.ts";
import { loadAndResolveFlow, resolveFragments } from "../flow-parser.ts";
import { validateFlow, validateStateIdParams } from "../flow-parser-validation.ts";

const pluginDir = resolve(process.cwd(), "..");

// validateStateIdParams

describe("validateStateIdParams", () => {
  const resolvedStateIds = new Set(["build", "review", "done"]);

  it("returns no errors when state_id param value exists in resolved states", () => {
    const fragments: Array<{
      definition: FragmentDefinition;
      spawnInstructions: Record<string, string>;
    }> = [
      {
        definition: {
          fragment: "my-frag",
          params: { next_state: { type: "state_id" } },
          states: {
            "frag-state": { agent: "a", transitions: { done: "${next_state}" }, type: "single" },
          },
        },
        spawnInstructions: {},
      },
    ];
    const includes: FragmentInclude[] = [{ fragment: "my-frag", with: { next_state: "build" } }];
    const errors = validateStateIdParams(fragments, includes, resolvedStateIds);
    expect(errors).toEqual([]);
  });

  it("returns error when state_id param value does not exist in resolved states", () => {
    const fragments: Array<{
      definition: FragmentDefinition;
      spawnInstructions: Record<string, string>;
    }> = [
      {
        definition: {
          fragment: "my-frag",
          params: { next_state: { type: "state_id" } },
          states: {
            "frag-state": { agent: "a", transitions: { done: "${next_state}" }, type: "single" },
          },
        },
        spawnInstructions: {},
      },
    ];
    const includes: FragmentInclude[] = [
      { fragment: "my-frag", with: { next_state: "nonexistent-state" } },
    ];
    const errors = validateStateIdParams(fragments, includes, resolvedStateIds);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/my-frag/);
    expect(errors[0]).toMatch(/next_state/);
    expect(errors[0]).toMatch(/nonexistent-state/);
  });

  it("returns no errors when state_id param value is 'hitl'", () => {
    const fragments: Array<{
      definition: FragmentDefinition;
      spawnInstructions: Record<string, string>;
    }> = [
      {
        definition: {
          fragment: "my-frag",
          params: { fallback_state: { type: "state_id" } },
          states: {
            "frag-state": {
              agent: "a",
              transitions: { blocked: "${fallback_state}" },
              type: "single",
            },
          },
        },
        spawnInstructions: {},
      },
    ];
    const includes: FragmentInclude[] = [{ fragment: "my-frag", with: { fallback_state: "hitl" } }];
    const errors = validateStateIdParams(fragments, includes, resolvedStateIds);
    expect(errors).toEqual([]);
  });

  it("skips validation for params that are not type state_id", () => {
    const fragments: Array<{
      definition: FragmentDefinition;
      spawnInstructions: Record<string, string>;
    }> = [
      {
        definition: {
          fragment: "my-frag",
          params: { label: { default: "foo", type: "string" } },
          states: {
            "frag-state": { agent: "a", type: "single" },
          },
        },
        spawnInstructions: {},
      },
    ];
    const includes: FragmentInclude[] = [{ fragment: "my-frag", with: { label: "whatever" } }];
    const errors = validateStateIdParams(fragments, includes, resolvedStateIds);
    expect(errors).toEqual([]);
  });

  it("uses default value for state_id param when not in with", () => {
    const fragments: Array<{
      definition: FragmentDefinition;
      spawnInstructions: Record<string, string>;
    }> = [
      {
        definition: {
          fragment: "my-frag",
          params: { next_state: { default: "build", type: "state_id" } },
          states: {
            "frag-state": { agent: "a", transitions: { done: "${next_state}" }, type: "single" },
          },
        },
        spawnInstructions: {},
      },
    ];
    const includes: FragmentInclude[] = [{ fragment: "my-frag" }]; // no with — default used
    const errors = validateStateIdParams(fragments, includes, resolvedStateIds);
    expect(errors).toEqual([]);
  });

  it("returns error when state_id param default refers to nonexistent state", () => {
    const fragments: Array<{
      definition: FragmentDefinition;
      spawnInstructions: Record<string, string>;
    }> = [
      {
        definition: {
          fragment: "my-frag",
          params: { next_state: { default: "bad-state", type: "state_id" } },
          states: {
            "frag-state": { agent: "a", transitions: { done: "${next_state}" }, type: "single" },
          },
        },
        spawnInstructions: {},
      },
    ];
    const includes: FragmentInclude[] = [{ fragment: "my-frag" }];
    const errors = validateStateIdParams(fragments, includes, resolvedStateIds);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/bad-state/);
  });
});

// resolveFragments — typed param support

describe("resolveFragments — typed params", () => {
  const baseFlow: FlowDefinition = {
    description: "test flow",
    name: "test",
  };

  it("accepts old null-marker format (backward compat)", () => {
    const fragment: FragmentDefinition = {
      fragment: "old-frag",
      params: { required_val: null },
      states: {
        s: { agent: "a", transitions: { done: "${required_val}" }, type: "single" },
      },
    };

    const result = resolveFragments(
      baseFlow,
      [{ definition: fragment, spawnInstructions: {} }],
      [{ fragment: "old-frag", with: { required_val: "end" } }],
    );

    expect(result.states.s.transitions!.done).toBe("end");
  });

  it("uses default from typed param { type: 'string', default: 'foo' } when not in with", () => {
    const fragment: FragmentDefinition = {
      fragment: "typed-frag",
      params: { label: { default: "foo", type: "string" } },
      states: {
        s: { agent: "a", template: "${label}", type: "single" },
      },
    };

    const result = resolveFragments(
      baseFlow,
      [{ definition: fragment, spawnInstructions: {} }],
      [{ fragment: "typed-frag" }], // no with, uses default
    );

    expect(result.states.s.template).toBe("foo");
  });

  it("allows typed param with default to be overridden via with", () => {
    const fragment: FragmentDefinition = {
      fragment: "typed-frag",
      params: { label: { default: "foo", type: "string" } },
      states: {
        s: { agent: "a", template: "${label}", type: "single" },
      },
    };

    const result = resolveFragments(
      baseFlow,
      [{ definition: fragment, spawnInstructions: {} }],
      [{ fragment: "typed-frag", with: { label: "bar" } }],
    );

    expect(result.states.s.template).toBe("bar");
  });

  it("throws when typed param { type: 'number' } with no default is missing from with", () => {
    const fragment: FragmentDefinition = {
      fragment: "typed-frag",
      params: { count: { type: "number" } },
      states: {
        s: { agent: "a", type: "single" },
      },
    };

    expect(() =>
      resolveFragments(
        baseFlow,
        [{ definition: fragment, spawnInstructions: {} }],
        [{ fragment: "typed-frag" }], // missing required count
      ),
    ).toThrow(/requires param.*count/i);
  });

  it("accepts typed param { type: 'state_id' } when value provided in with", () => {
    const fragment: FragmentDefinition = {
      fragment: "typed-frag",
      params: { next_state: { type: "state_id" } },
      states: {
        s: { agent: "a", transitions: { done: "${next_state}" }, type: "single" },
      },
    };

    const result = resolveFragments(
      baseFlow,
      [{ definition: fragment, spawnInstructions: {} }],
      [{ fragment: "typed-frag", with: { next_state: "my-state" } }],
    );

    expect(result.states.s.transitions!.done).toBe("my-state");
  });
});

// loadAndResolveFlow (real files)

describe("loadAndResolveFlow", () => {
  it("loads the review-only flow from real files", async () => {
    const flow = await loadAndResolveFlow(pluginDir, "review-only");

    expect(flow.name).toBe("review-only");
    expect(flow.entry).toBe("review");
    expect(flow.states.review).toBeDefined();
    expect(flow.states.done).toBeDefined();
    expect(flow.states.review.type).toBe("single");
    expect(flow.states.review.agent).toBe("reviewer");
    expect(flow.states.done.type).toBe("terminal");

    // Should have spawn instruction for review
    expect(flow.spawn_instructions.review).toBeDefined();
    expect(flow.spawn_instructions.review).toContain("git diff");
  });

  it("fast-path execute state has agent: implementor", async () => {
    const flow = await loadAndResolveFlow(pluginDir, "fast-path");

    expect(flow.name).toBe("fast-path");
    expect(flow.entry).toBe("execute");
    expect(flow.states.execute).toBeDefined();
    expect(flow.states.execute.agent).toBe("implementor");
  });
});

// Integration: all 11 production flows load with no unresolved ${...} refs

const ALL_FLOWS = [
  "feature",
  "epic",
  "refactor",
  "migrate",
  "fast-path",
  "review-only",
  "test-gap",
  "explore",
  "security-audit",
  "adopt",
] as const;

describe("all production flows: load without errors (integration)", () => {
  for (const flowName of ALL_FLOWS) {
    it(`${flowName} loads without throwing`, async () => {
      const flow = await loadAndResolveFlow(pluginDir, flowName);
      expect(flow).toBeDefined();
      expect(flow.entry).toBeDefined();
    });
  }
});

describe("all production flows: no unresolved ${...} references after fragment substitution", () => {
  for (const flowName of ALL_FLOWS) {
    it(`${flowName} has no unresolved variable refs`, async () => {
      const flow = await loadAndResolveFlow(pluginDir, flowName);
      const errors = validateFlow(flow).filter((e) => e.includes("unresolved reference"));
      expect(errors, `${flowName}: ${errors.join(", ")}`).toEqual([]);
    });
  }
});

describe("all production flows: all non-terminal states have spawn instructions", () => {
  for (const flowName of ALL_FLOWS) {
    it(`${flowName} has full spawn coverage`, async () => {
      const flow = await loadAndResolveFlow(pluginDir, flowName);
      const errors = validateFlow(flow).filter((e) => e.includes("no spawn instruction"));
      expect(errors, `${flowName}: ${errors.join(", ")}`).toEqual([]);
    });
  }
});

describe("all production flows: all transition targets are valid states", () => {
  for (const flowName of ALL_FLOWS) {
    it(`${flowName} has no broken transitions`, async () => {
      const flow = await loadAndResolveFlow(pluginDir, flowName);
      const errors = validateFlow(flow).filter((e) => e.includes("targets non-existent state"));
      expect(errors, `${flowName}: ${errors.join(", ")}`).toEqual([]);
    });
  }
});
