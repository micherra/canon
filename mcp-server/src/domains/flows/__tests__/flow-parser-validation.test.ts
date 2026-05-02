import { describe, expect, it } from "vitest";
import type {
  FlowDefinition,
  FragmentDefinition,
  FragmentInclude,
} from "../flow-definition-schemas.ts";
import { resolveFragments } from "../flow-parser.ts";
import { validateStateIdParams } from "../flow-parser-validation.ts";

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

// Integration tests that loaded real flow YAML files from disk have been removed.
// The flow YAML files in flows/ were deleted as part of agent-teams decoupling (delete-flows-06).
// The flow-parser machinery is fully tested above using inline fixtures.
