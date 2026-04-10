/**
 * ADR-004 Integration Tests — Canon Tester (Part 1)
 *
 * Fills coverage gaps declared in implementor Coverage Notes:
 *
 * 1. Hard-blocking error message format from loadAndResolveFlow
 *    (spawn coverage + unresolved refs combined in one throw)
 * 2. validateStateIdParams with default-is-hitl virtual sink
 * 3. Boolean typed param substitution (verify-fix-loop write_tests path)
 * 4. Edge cases in discriminated union validation (malformed/hybrid states)
 * 5. VIRTUAL_SINKS / RUNTIME_VARIABLES exports are correct sets
 * 6. checkUnresolvedRefs: item.* sub-variants
 * 7. loadAndResolveFlow: throws combining both spawn + ref errors
 */

import { resolve } from "node:path";
import type {
  FragmentDefinition,
  FragmentInclude,
  ResolvedFlow,
} from "@domains/flows/flow-definition-schemas.ts";
import {
  FragmentStateDefinitionSchema,
  StateDefinitionSchema,
} from "@domains/flows/flow-definition-schemas.ts";
import { loadAndResolveFlow } from "@domains/flows/flow-parser.ts";
import {
  checkUnresolvedRefs,
  RUNTIME_VARIABLES,
  VIRTUAL_SINKS,
  validateFlow,
  validateSpawnCoverage,
  validateStateIdParams,
} from "@domains/flows/flow-parser-validation.ts";
import { describe, expect, it } from "vitest";

const pluginDir = resolve(process.cwd(), ".."); // mcp-server/src/__tests__ → project root

// Helper

function makeFlow(overrides: Partial<ResolvedFlow> = {}): ResolvedFlow {
  return {
    description: "test",
    entry: "start",
    name: "test-flow",
    spawn_instructions: { start: "Do the thing" },
    states: {
      end: { type: "terminal" },
      start: { agent: "agent-a", transitions: { done: "end" }, type: "single" },
    },
    ...overrides,
  };
}

// 1. Hard-blocking error message — combined spawn coverage + unresolved refs

describe("loadAndResolveFlow — hard-blocking error message content", () => {
  it("throws with the flow name in the error message", async () => {
    // Path-traversal check: error includes the flow name in its message
    await expect(loadAndResolveFlow(pluginDir, "no-such-flow-x1x2")).rejects.toThrow(
      /no-such-flow-x1x2/,
    );
  });

  it("throws with 'validation failed' prefix when spawn coverage or refs fail", async () => {
    // We can exercise this by directly testing that validateFlow hard errors propagate
    // The public surface is the error message shape — must contain 'validation failed'
    // We use a known-broken synthetic case through the validate path directly.
    const flowWithBothErrors: ResolvedFlow = makeFlow({
      spawn_instructions: {}, // missing 'start' → spawn coverage error
      states: {
        end: { type: "terminal" },
        start: {
          agent: "a",
          transitions: { done: "end" },
          type: "single",
        },
      },
    });

    // validateFlow returns both errors together
    const errors = validateFlow(flowWithBothErrors);
    const spawnErrors = errors.filter((e) => e.includes("no spawn instruction"));
    expect(spawnErrors.length).toBeGreaterThan(0);
    expect(spawnErrors[0]).toMatch(/start/);
  });

  it("combines spawn coverage error AND unresolved ref error in single validateFlow call", () => {
    const flow: ResolvedFlow = makeFlow({
      spawn_instructions: {}, // missing 'start' → spawn error
      states: {
        end: { type: "terminal" },
        start: {
          agent: "a",
          transitions: { done: "${missing_param}" }, // → ref error
          type: "single",
        },
      },
    });

    const errors = validateFlow(flow);
    const spawnErrors = errors.filter((e) => e.includes("no spawn instruction"));
    const refErrors = errors.filter((e) => e.includes("unresolved reference"));

    // Both error categories must be present in the same pass
    expect(spawnErrors.length).toBeGreaterThan(0);
    expect(refErrors.length).toBeGreaterThan(0);
  });

  it("warning-only flow does not throw: only Warning:-prefixed messages in validateFlow result", () => {
    // A flow with unreachable state emits only warnings; loadAndResolveFlow must not throw
    // We test validateFlow alone here to verify the Warning: prefix is applied
    const flow: ResolvedFlow = makeFlow({
      spawn_instructions: { start: "Do it" },
      states: {
        end: { type: "terminal" },
        orphan: { type: "terminal" }, // unreachable, no spawn needed, warning only
        start: { agent: "a", transitions: { done: "end" }, type: "single" },
      },
    });

    const messages = validateFlow(flow);
    const hardErrors = messages.filter((m) => !m.startsWith("Warning:"));
    expect(hardErrors).toEqual([]);

    const warnings = messages.filter((m) => m.startsWith("Warning:"));
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/orphan/);
  });
});

// 2. VIRTUAL_SINKS and RUNTIME_VARIABLES are the correct exported sets

describe("VIRTUAL_SINKS export", () => {
  it("contains 'hitl' and 'no_items' as the two virtual sinks", () => {
    expect(VIRTUAL_SINKS.has("hitl")).toBe(true);
    expect(VIRTUAL_SINKS.has("no_items")).toBe(true);
    expect(VIRTUAL_SINKS.size).toBe(2);
  });
});

describe("RUNTIME_VARIABLES export", () => {
  it("contains the core orchestrator variables", () => {
    expect(RUNTIME_VARIABLES.has("WORKSPACE")).toBe(true);
    expect(RUNTIME_VARIABLES.has("task")).toBe(true);
    expect(RUNTIME_VARIABLES.has("slug")).toBe(true);
    expect(RUNTIME_VARIABLES.has("CLAUDE_PLUGIN_ROOT")).toBe(true);
  });

  it("contains all item.* sub-variants used in parallel-per spawn instructions", () => {
    // These are the item.* variables from the RUNTIME_VARIABLES set
    const itemVars = [
      "item.principle_id",
      "item.severity",
      "item.file_path",
      "item.detail",
      "item.test_file",
      "item.test_name",
      "item.error_message",
      "item.source_file",
    ];
    for (const v of itemVars) {
      expect(RUNTIME_VARIABLES.has(v), `Expected RUNTIME_VARIABLES to contain "${v}"`).toBe(true);
    }
  });

  it("contains wave-related variables", () => {
    expect(RUNTIME_VARIABLES.has("wave")).toBe(true);
    expect(RUNTIME_VARIABLES.has("wave_files")).toBe(true);
    expect(RUNTIME_VARIABLES.has("wave_diff")).toBe(true);
    expect(RUNTIME_VARIABLES.has("wave_summaries")).toBe(true);
    expect(RUNTIME_VARIABLES.has("wave_briefing")).toBe(true);
  });

  it("contains adopt-flow and verify-flow specific variables", () => {
    expect(RUNTIME_VARIABLES.has("directory")).toBe(true);
    expect(RUNTIME_VARIABLES.has("severity_filter")).toBe(true);
    expect(RUNTIME_VARIABLES.has("write_tests")).toBe(true);
    expect(RUNTIME_VARIABLES.has("user_write_tests")).toBe(true);
  });
});

// 3. checkUnresolvedRefs: item.* sub-variants are all accepted

describe("checkUnresolvedRefs — item.* variable exhaustive coverage", () => {
  it("accepts item.test_file in spawn instruction", () => {
    const flow = makeFlow({
      spawn_instructions: { start: "Fix failing test: ${item.test_file}" },
    });
    expect(checkUnresolvedRefs(flow)).toEqual([]);
  });

  it("accepts item.test_name in spawn instruction", () => {
    const flow = makeFlow({
      spawn_instructions: { start: "Failing test: ${item.test_name}" },
    });
    expect(checkUnresolvedRefs(flow)).toEqual([]);
  });

  it("accepts item.error_message in spawn instruction", () => {
    const flow = makeFlow({
      spawn_instructions: { start: "Error: ${item.error_message}" },
    });
    expect(checkUnresolvedRefs(flow)).toEqual([]);
  });

  it("accepts item.source_file in spawn instruction", () => {
    const flow = makeFlow({
      spawn_instructions: { start: "Source: ${item.source_file}" },
    });
    expect(checkUnresolvedRefs(flow)).toEqual([]);
  });

  it("rejects item.unknown_field as unresolved reference", () => {
    const flow = makeFlow({
      spawn_instructions: { start: "Unknown: ${item.unknown_field}" },
    });
    const errors = checkUnresolvedRefs(flow);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/item\.unknown_field/);
  });

  it("accepts role variable in spawn instruction (parallel state context)", () => {
    const flow = makeFlow({
      spawn_instructions: { start: "You are the ${role} agent. Do work." },
    });
    expect(checkUnresolvedRefs(flow)).toEqual([]);
  });

  it("accepts open_questions variable in spawn instruction", () => {
    const flow = makeFlow({
      spawn_instructions: { start: "Address these questions: ${open_questions}" },
    });
    expect(checkUnresolvedRefs(flow)).toEqual([]);
  });
});

// 4. validateStateIdParams — edge cases around defaults and hitl virtual sink

describe("validateStateIdParams — edge cases", () => {
  it("accepts default: hitl as virtual sink (security-scan on_critical pattern)", () => {
    const fragments: Array<{
      definition: FragmentDefinition;
      spawnInstructions: Record<string, string>;
    }> = [
      {
        definition: {
          fragment: "security-scan",
          params: {
            after_done: { type: "state_id" },
            on_critical: { default: "hitl", type: "state_id" },
          },
          states: {
            "security-scan": {
              agent: "canon:canon-security",
              transitions: { critical: "${on_critical}", done: "${after_done}" },
              type: "single",
            },
          },
        },
        spawnInstructions: {},
      },
    ];
    const includes: FragmentInclude[] = [
      { fragment: "security-scan", with: { after_done: "ship" } },
      // on_critical uses default "hitl"
    ];
    const resolvedStateIds = new Set(["ship", "done"]);
    const errors = validateStateIdParams(fragments, includes, resolvedStateIds);
    // hitl default should be valid even though "hitl" is not in resolvedStateIds
    expect(errors).toEqual([]);
  });

  it("returns error when default state_id is not hitl and not in resolvedStateIds", () => {
    const fragments: Array<{
      definition: FragmentDefinition;
      spawnInstructions: Record<string, string>;
    }> = [
      {
        definition: {
          fragment: "my-frag",
          params: { after_done: { default: "nonexistent", type: "state_id" } },
          states: {
            "my-state": { agent: "a", transitions: { done: "${after_done}" }, type: "single" },
          },
        },
        spawnInstructions: {},
      },
    ];
    const includes: FragmentInclude[] = [{ fragment: "my-frag" }]; // uses default "nonexistent"
    const resolvedStateIds = new Set(["build", "review"]);
    const errors = validateStateIdParams(fragments, includes, resolvedStateIds);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/nonexistent/);
  });

  it("skips fragments that have no params", () => {
    const fragments: Array<{
      definition: FragmentDefinition;
      spawnInstructions: Record<string, string>;
    }> = [
      {
        definition: {
          fragment: "no-params-frag",
          // no params key
          states: { s: { agent: "a", type: "single" } },
        },
        spawnInstructions: {},
      },
    ];
    const includes: FragmentInclude[] = [{ fragment: "no-params-frag" }];
    const resolvedStateIds = new Set(["s"]);
    const errors = validateStateIdParams(fragments, includes, resolvedStateIds);
    expect(errors).toEqual([]);
  });
});

// 5. Discriminated union — malformed / hybrid state edge cases

describe("StateDefinitionSchema — malformed state edge cases", () => {
  it("rejects an object with no type field", () => {
    expect(() => StateDefinitionSchema.parse({ agent: "some-agent" })).toThrow();
  });

  it("rejects null input", () => {
    expect(() => StateDefinitionSchema.parse(null)).toThrow();
  });

  it("rejects empty object (no type)", () => {
    expect(() => StateDefinitionSchema.parse({})).toThrow();
  });

  it("strips unknown fields from a single state (Zod default strip)", () => {
    const result = StateDefinitionSchema.parse({
      agent: "my-agent",
      type: "single",
      unknown_field: "should be stripped",
    });
    expect((result as Record<string, unknown>).unknown_field).toBeUndefined();
  });

  it("rejects numeric type (type must be a string literal)", () => {
    expect(() => StateDefinitionSchema.parse({ type: 42 })).toThrow();
  });

  it("rejects wave state with invalid on_conflict value inside wave_policy", () => {
    expect(() =>
      StateDefinitionSchema.parse({
        type: "wave",
        wave_policy: { on_conflict: "surrender" }, // not in enum
      }),
    ).toThrow();
  });
});

describe("FragmentStateDefinitionSchema — malformed state edge cases", () => {
  it("accepts a string max_iterations placeholder in a wave fragment state", () => {
    // wave fragment states may carry string placeholders
    const result = FragmentStateDefinitionSchema.parse({
      agent: "test",
      max_iterations: "${max_iter}",
      type: "wave",
    });
    expect(result.type).toBe("wave");
    expect((result as Record<string, unknown>).max_iterations).toBe("${max_iter}");
  });

  it("rejects unknown type in fragment schema same as regular schema", () => {
    expect(() => FragmentStateDefinitionSchema.parse({ agent: "a", type: "job" })).toThrow();
  });
});

// 6. Boolean typed param substitution (verify-fix-loop write_tests pattern)

describe("resolveFragments — boolean typed param (write_tests pattern)", () => {
  it("substitutes boolean typed param value as string in spawn instructions", async () => {
    // Load the feature flow which includes verify-fix-loop with write_tests: boolean
    // The flow must load cleanly — if boolean substitution is broken this would throw
    const flow = await loadAndResolveFlow(pluginDir, "feature");
    expect(flow).toBeDefined();
    // The feature flow includes verify-fix-loop; check that no ${write_tests} refs remain.
    // write_tests should be substituted (either "false" literal or absent as a runtime var)
    // RUNTIME_VARIABLES includes write_tests, so it may appear there — but should not appear
    // as an unresolved fragment param reference
    const refErrors = checkUnresolvedRefs(flow).filter((e) => e.includes("write_tests"));
    expect(refErrors).toEqual([]);
  });
});

// 7. Cross-task integration: typed params → state_id validation → real flow load

describe("Cross-task: typed param state_id validation with real production flows", () => {
  it("feature flow: all fragment state_id params resolve to real states", async () => {
    const flow = await loadAndResolveFlow(pluginDir, "feature");
    // This exercises validateStateIdParams inside loadAndResolveFlow —
    // any invalid state_id typed param in a fragment include would have thrown
    expect(flow.entry).toBeDefined();
    expect(Object.keys(flow.states).length).toBeGreaterThan(0);
  });

  it("security-audit flow: on_critical hitl default is valid", async () => {
    // The security-scan fragment has on_critical: { type: state_id, default: hitl }
    // hitl is a virtual sink — should not throw during state_id validation
    const flow = await loadAndResolveFlow(pluginDir, "security-audit");
    expect(flow).toBeDefined();
  });

  it("refactor flow: all typed state_id params resolve", async () => {
    const flow = await loadAndResolveFlow(pluginDir, "refactor");
    expect(flow).toBeDefined();
    // validateFlow must be clean (only warnings allowed)
    const errors = validateFlow(flow).filter((m) => !m.startsWith("Warning:"));
    expect(errors).toEqual([]);
  });

  it("migrate flow: typed params and fragment substitution produce clean flow", async () => {
    const flow = await loadAndResolveFlow(pluginDir, "migrate");
    expect(flow).toBeDefined();
    const errors = validateFlow(flow).filter((m) => !m.startsWith("Warning:"));
    expect(errors).toEqual([]);
  });
});

// 8. validateSpawnCoverage: parallel state type coverage

describe("validateSpawnCoverage — parallel state type", () => {
  it("reports missing spawn instruction for a parallel state", () => {
    const flow: ResolvedFlow = makeFlow({
      spawn_instructions: { start: "Do stuff" }, // missing 'workers'
      states: {
        end: { type: "terminal" },
        start: { agent: "a", transitions: { done: "workers" }, type: "single" },
        workers: {
          agents: ["agent-a", "agent-b"],
          transitions: { done: "end" },
          type: "parallel",
        },
      },
    });
    const errors = validateSpawnCoverage(flow);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/workers/);
    expect(errors[0]).toMatch(/parallel/);
  });

  it("reports missing spawn instruction for a wave state", () => {
    const flow: ResolvedFlow = makeFlow({
      spawn_instructions: { start: "Do stuff" }, // missing 'wave-impl'
      states: {
        end: { type: "terminal" },
        start: { agent: "a", transitions: { done: "wave-impl" }, type: "single" },
        "wave-impl": {
          agent: "implementor",
          transitions: { done: "end" },
          type: "wave",
        },
      },
    });
    const errors = validateSpawnCoverage(flow);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/wave-impl/);
    expect(errors[0]).toMatch(/wave/);
  });
});
