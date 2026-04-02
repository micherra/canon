import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadAndResolveFlow,
  parseFlowContent,
  resolveFragments,
  validateFlow,
  validateStateIdParams,
} from "../orchestration/flow-parser.ts";
import type {
  FlowDefinition,
  FragmentDefinition,
  FragmentInclude,
  ResolvedFlow,
} from "../orchestration/flow-schema.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(testDir, "../../.."); // mcp-server/src/__tests__ → project root

// ---------------------------------------------------------------------------
// parseFlowContent
// ---------------------------------------------------------------------------

describe("parseFlowContent", () => {
  it("extracts frontmatter and spawn instructions from a flow string", () => {
    const content = `---
name: test-flow
description: A test flow

states:
  build:
    type: single
    agent: builder
    transitions:
      done: review

  review:
    type: single
    agent: reviewer
    transitions:
      clean: done

  done:
    type: terminal
---

## Spawn Instructions

### build
Build the project. Save output to workspace.

### review
Review the code changes.
`;

    const { frontmatter, spawnInstructions } = parseFlowContent(content);

    expect(frontmatter.name).toBe("test-flow");
    expect(frontmatter.description).toBe("A test flow");
    expect(frontmatter.states).toBeDefined();

    expect(Object.keys(spawnInstructions)).toEqual(["build", "review"]);
    expect(spawnInstructions["build"]).toBe("Build the project. Save output to workspace.");
    expect(spawnInstructions["review"]).toBe("Review the code changes.");
  });

  it("returns empty objects for content without frontmatter", () => {
    const { frontmatter, spawnInstructions } = parseFlowContent("no frontmatter here");
    expect(frontmatter).toEqual({});
    expect(spawnInstructions).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// resolveFragments
// ---------------------------------------------------------------------------

describe("resolveFragments", () => {
  const baseFlow: FlowDefinition = {
    name: "test",
    description: "test flow",
    states: {
      start: {
        type: "single",
        agent: "starter",
        transitions: { done: "frag-state" },
      },
    },
  };

  it("merges fragment states into the result", () => {
    const fragment: FragmentDefinition = {
      fragment: "my-frag",
      states: {
        "frag-state": {
          type: "single",
          agent: "frag-agent",
          transitions: { done: "end" },
        },
      },
    };

    const result = resolveFragments(
      baseFlow,
      [{ definition: fragment, spawnInstructions: { "frag-state": "Do frag work" } }],
      [{ fragment: "my-frag" }],
    );

    expect(result.states["frag-state"]).toBeDefined();
    expect(result.states["frag-state"].agent).toBe("frag-agent");
    expect(result.spawnInstructions["frag-state"]).toBe("Do frag work");
  });

  it("handles consultation fragments separately", () => {
    const consultation: FragmentDefinition = {
      fragment: "my-consult",
      type: "consultation",
      agent: "advisor",
      role: "advisor-role",
      section: "Advisory",
      timeout: "5m",
    };

    const result = resolveFragments(
      baseFlow,
      [{ definition: consultation, spawnInstructions: { "my-consult": "Advise on stuff" } }],
      [{ fragment: "my-consult" }],
    );

    expect(result.consultations["my-consult"]).toBeDefined();
    expect(result.consultations["my-consult"].agent).toBe("advisor");
    expect(result.consultations["my-consult"].role).toBe("advisor-role");
    // Consultations should NOT appear in states
    expect(result.states["my-consult"]).toBeUndefined();
  });

  it("substitutes params in fragment state definitions", () => {
    const fragment: FragmentDefinition = {
      fragment: "loop-frag",
      params: { target: null },
      states: {
        "loop-state": {
          type: "single",
          agent: "looper",
          transitions: { done: "${target}" },
        },
      },
    };

    const result = resolveFragments(
      baseFlow,
      [{ definition: fragment, spawnInstructions: { "loop-state": "Go to ${target}" } }],
      [{ fragment: "loop-frag", with: { target: "end" } }],
    );

    expect(result.states["loop-state"].transitions!["done"]).toBe("end");
    expect(result.spawnInstructions["loop-state"]).toBe("Go to end");
  });

  it("detects state ID collisions", () => {
    const frag1: FragmentDefinition = {
      fragment: "frag-a",
      states: {
        "shared-id": { type: "single", agent: "a" },
      },
    };
    const frag2: FragmentDefinition = {
      fragment: "frag-b",
      states: {
        "shared-id": { type: "single", agent: "b" },
      },
    };

    expect(() =>
      resolveFragments(
        baseFlow,
        [
          { definition: frag1, spawnInstructions: {} },
          { definition: frag2, spawnInstructions: {} },
        ],
        [{ fragment: "frag-a" }, { fragment: "frag-b" }],
      ),
    ).toThrow(/collision.*shared-id/i);
  });

  it("throws when required param is missing", () => {
    const fragment: FragmentDefinition = {
      fragment: "needs-param",
      params: { required_val: null },
      states: {
        s: { type: "single", agent: "a", transitions: { done: "${required_val}" } },
      },
    };

    expect(() =>
      resolveFragments(
        baseFlow,
        [{ definition: fragment, spawnInstructions: {} }],
        [{ fragment: "needs-param" }], // no `with`
      ),
    ).toThrow(/requires param.*required_val/i);
  });

  it("applies overrides to fragment states", () => {
    const fragment: FragmentDefinition = {
      fragment: "overridable",
      states: {
        review: {
          type: "single",
          agent: "reviewer",
          large_diff_threshold: 300,
          transitions: { done: "end" },
        },
      },
    };

    const result = resolveFragments(
      baseFlow,
      [{ definition: fragment, spawnInstructions: {} }],
      [
        {
          fragment: "overridable",
          overrides: { review: { large_diff_threshold: 500 } },
        },
      ],
    );

    expect(result.states["review"].large_diff_threshold).toBe(500);
    // Original fields preserved
    expect(result.states["review"].agent).toBe("reviewer");
  });
});

// ---------------------------------------------------------------------------
// validateFlow
// ---------------------------------------------------------------------------

describe("validateFlow", () => {
  it("returns empty array for a valid flow", () => {
    const flow: ResolvedFlow = {
      name: "valid",
      description: "valid flow",
      entry: "start",
      spawn_instructions: { start: "Do work." },
      states: {
        start: {
          type: "single",
          agent: "a",
          transitions: { done: "end" },
        },
        end: { type: "terminal" },
      },
    };

    expect(validateFlow(flow)).toEqual([]);
  });

  it("catches missing entry state", () => {
    const flow: ResolvedFlow = {
      name: "bad",
      description: "bad flow",
      entry: "nonexistent",
      spawn_instructions: {},
      states: {
        start: { type: "terminal" },
      },
    };

    const errors = validateFlow(flow);
    expect(errors.some((e) => e.includes("nonexistent"))).toBe(true);
  });

  it("catches broken transition targets", () => {
    const flow: ResolvedFlow = {
      name: "bad-trans",
      description: "bad transitions",
      entry: "start",
      spawn_instructions: { start: "Do work." },
      states: {
        start: {
          type: "single",
          agent: "a",
          transitions: { done: "nowhere" },
        },
      },
    };

    const errors = validateFlow(flow);
    expect(errors.some((e) => e.includes("nowhere"))).toBe(true);
  });

  it("allows hitl as a transition target", () => {
    const flow: ResolvedFlow = {
      name: "hitl-ok",
      description: "hitl transitions",
      entry: "start",
      spawn_instructions: { start: "Do work." },
      states: {
        start: {
          type: "single",
          agent: "a",
          transitions: { blocked: "hitl", done: "end" },
        },
        end: { type: "terminal" },
      },
    };

    expect(validateFlow(flow)).toEqual([]);
  });

  it("warns when max_iterations lacks stuck_when", () => {
    const flow: ResolvedFlow = {
      name: "no-stuck",
      description: "missing stuck_when",
      entry: "loop",
      spawn_instructions: { loop: "Do loopy work." },
      states: {
        loop: {
          type: "single",
          agent: "a",
          max_iterations: 3,
          transitions: { done: "end" },
        },
        end: { type: "terminal" },
      },
    };

    const errors = validateFlow(flow);
    expect(errors.some((e) => e.includes("stuck_when"))).toBe(true);
  });

  it("warns when parallel-per lacks iterate_on", () => {
    const flow: ResolvedFlow = {
      name: "no-iterate",
      description: "missing iterate_on",
      entry: "par",
      spawn_instructions: { par: "Run in parallel." },
      states: {
        par: {
          type: "parallel-per",
          agent: "a",
          transitions: { done: "end" },
        },
        end: { type: "terminal" },
      },
    };

    const errors = validateFlow(flow);
    expect(errors.some((e) => e.includes("iterate_on"))).toBe(true);
  });

  it("warns when terminal state has transitions", () => {
    const flow: ResolvedFlow = {
      name: "bad-terminal",
      description: "terminal with transitions",
      entry: "start",
      spawn_instructions: { start: "Do work." },
      states: {
        start: {
          type: "single",
          agent: "a",
          transitions: { done: "end" },
        },
        end: {
          type: "terminal",
          transitions: { done: "start" },
        },
      },
    };

    const errors = validateFlow(flow);
    expect(errors.some((e) => e.includes("terminal"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateStateIdParams
// ---------------------------------------------------------------------------

describe("validateStateIdParams", () => {
  const resolvedStateIds = new Set(["build", "review", "done"]);

  it("returns no errors when state_id param value exists in resolved states", () => {
    const fragments: Array<{ definition: FragmentDefinition; spawnInstructions: Record<string, string> }> = [
      {
        definition: {
          fragment: "my-frag",
          params: { next_state: { type: "state_id" } },
          states: {
            "frag-state": { type: "single", agent: "a", transitions: { done: "${next_state}" } },
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
    const fragments: Array<{ definition: FragmentDefinition; spawnInstructions: Record<string, string> }> = [
      {
        definition: {
          fragment: "my-frag",
          params: { next_state: { type: "state_id" } },
          states: {
            "frag-state": { type: "single", agent: "a", transitions: { done: "${next_state}" } },
          },
        },
        spawnInstructions: {},
      },
    ];
    const includes: FragmentInclude[] = [{ fragment: "my-frag", with: { next_state: "nonexistent-state" } }];
    const errors = validateStateIdParams(fragments, includes, resolvedStateIds);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/my-frag/);
    expect(errors[0]).toMatch(/next_state/);
    expect(errors[0]).toMatch(/nonexistent-state/);
  });

  it("returns no errors when state_id param value is 'hitl'", () => {
    const fragments: Array<{ definition: FragmentDefinition; spawnInstructions: Record<string, string> }> = [
      {
        definition: {
          fragment: "my-frag",
          params: { fallback_state: { type: "state_id" } },
          states: {
            "frag-state": { type: "single", agent: "a", transitions: { blocked: "${fallback_state}" } },
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
    const fragments: Array<{ definition: FragmentDefinition; spawnInstructions: Record<string, string> }> = [
      {
        definition: {
          fragment: "my-frag",
          params: { label: { type: "string", default: "foo" } },
          states: {
            "frag-state": { type: "single", agent: "a" },
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
    const fragments: Array<{ definition: FragmentDefinition; spawnInstructions: Record<string, string> }> = [
      {
        definition: {
          fragment: "my-frag",
          params: { next_state: { type: "state_id", default: "build" } },
          states: {
            "frag-state": { type: "single", agent: "a", transitions: { done: "${next_state}" } },
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
    const fragments: Array<{ definition: FragmentDefinition; spawnInstructions: Record<string, string> }> = [
      {
        definition: {
          fragment: "my-frag",
          params: { next_state: { type: "state_id", default: "bad-state" } },
          states: {
            "frag-state": { type: "single", agent: "a", transitions: { done: "${next_state}" } },
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

// ---------------------------------------------------------------------------
// resolveFragments — typed param support
// ---------------------------------------------------------------------------

describe("resolveFragments — typed params", () => {
  const baseFlow: FlowDefinition = {
    name: "test",
    description: "test flow",
  };

  it("accepts old null-marker format (backward compat)", () => {
    const fragment: FragmentDefinition = {
      fragment: "old-frag",
      params: { required_val: null },
      states: {
        s: { type: "single", agent: "a", transitions: { done: "${required_val}" } },
      },
    };

    const result = resolveFragments(
      baseFlow,
      [{ definition: fragment, spawnInstructions: {} }],
      [{ fragment: "old-frag", with: { required_val: "end" } }],
    );

    expect(result.states["s"].transitions!["done"]).toBe("end");
  });

  it("uses default from typed param { type: 'string', default: 'foo' } when not in with", () => {
    const fragment: FragmentDefinition = {
      fragment: "typed-frag",
      params: { label: { type: "string", default: "foo" } },
      states: {
        s: { type: "single", agent: "a", template: "${label}" },
      },
    };

    const result = resolveFragments(
      baseFlow,
      [{ definition: fragment, spawnInstructions: {} }],
      [{ fragment: "typed-frag" }], // no with, uses default
    );

    expect(result.states["s"].template).toBe("foo");
  });

  it("allows typed param with default to be overridden via with", () => {
    const fragment: FragmentDefinition = {
      fragment: "typed-frag",
      params: { label: { type: "string", default: "foo" } },
      states: {
        s: { type: "single", agent: "a", template: "${label}" },
      },
    };

    const result = resolveFragments(
      baseFlow,
      [{ definition: fragment, spawnInstructions: {} }],
      [{ fragment: "typed-frag", with: { label: "bar" } }],
    );

    expect(result.states["s"].template).toBe("bar");
  });

  it("throws when typed param { type: 'number' } with no default is missing from with", () => {
    const fragment: FragmentDefinition = {
      fragment: "typed-frag",
      params: { count: { type: "number" } },
      states: {
        s: { type: "single", agent: "a" },
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
        s: { type: "single", agent: "a", transitions: { done: "${next_state}" } },
      },
    };

    const result = resolveFragments(
      baseFlow,
      [{ definition: fragment, spawnInstructions: {} }],
      [{ fragment: "typed-frag", with: { next_state: "my-state" } }],
    );

    expect(result.states["s"].transitions!["done"]).toBe("my-state");
  });
});

// ---------------------------------------------------------------------------
// loadAndResolveFlow (real files)
// ---------------------------------------------------------------------------

describe("loadAndResolveFlow", () => {
  it("loads the review-only flow from real files", async () => {
    const flow = await loadAndResolveFlow(pluginDir, "review-only");

    expect(flow.name).toBe("review-only");
    expect(flow.entry).toBe("review");
    expect(flow.states["review"]).toBeDefined();
    expect(flow.states["done"]).toBeDefined();
    expect(flow.states["review"].type).toBe("single");
    expect(flow.states["review"].agent).toBe("canon-reviewer");
    expect(flow.states["done"].type).toBe("terminal");

    // Should have spawn instruction for review
    expect(flow.spawn_instructions["review"]).toBeDefined();
    expect(flow.spawn_instructions["review"]).toContain("git diff");
  });
});

// ---------------------------------------------------------------------------
// Integration: all 11 production flows load with no unresolved ${...} refs
// ---------------------------------------------------------------------------

const ALL_FLOWS = [
  "feature",
  "epic",
  "refactor",
  "migrate",
  "quick-fix",
  "hotfix",
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
