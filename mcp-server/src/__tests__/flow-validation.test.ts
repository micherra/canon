/**
 * Flow validation tests — ADR-004
 *
 * Tests for three new validation passes added to validateFlow:
 *   1. Spawn instruction coverage (every non-terminal state must have a spawn instruction)
 *   2. Reachability analysis (BFS from entry — unreachable states produce warnings, not errors)
 *   3. Unresolved reference check (${...} patterns not in RUNTIME_VARIABLES block loading)
 *
 * Also tests that loadAndResolveFlow throws (hard-blocking) on validation errors.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  analyzeReachability,
  checkUnresolvedRefs,
  loadAndResolveFlow,
  validateFlow,
  validateSpawnCoverage,
} from "../orchestration/flow-parser.ts";
import type { ResolvedFlow } from "../orchestration/flow-schema.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pluginDir = resolve(__dirname, "../../.."); // mcp-server/src/__tests__ → project root

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

// validateSpawnCoverage

describe("validateSpawnCoverage", () => {
  it("returns no errors when all non-terminal states have spawn instructions", () => {
    const flow = makeFlow();
    const errors = validateSpawnCoverage(flow);
    expect(errors).toEqual([]);
  });

  it("returns error when a non-terminal state has no spawn instruction", () => {
    const flow = makeFlow({
      spawn_instructions: {}, // missing 'start'
    });
    const errors = validateSpawnCoverage(flow);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/start/);
    expect(errors[0]).toMatch(/no spawn instruction/i);
  });

  it("does not require terminal states to have spawn instructions", () => {
    const flow = makeFlow({
      spawn_instructions: { start: "Do the thing" }, // 'end' terminal has no entry — fine
    });
    const errors = validateSpawnCoverage(flow);
    expect(errors).toEqual([]);
  });

  it("reports multiple missing spawn instructions", () => {
    const flow = makeFlow({
      spawn_instructions: {}, // both 'start' is missing
      states: {
        end: { type: "terminal" },
        middle: { agent: "b", transitions: { done: "end" }, type: "single" },
        start: { agent: "a", transitions: { done: "middle" }, type: "single" },
      },
    });
    const errors = validateSpawnCoverage(flow);
    expect(errors.length).toBe(2);
  });

  it("handles parallel-per and wave state types", () => {
    const flow = makeFlow({
      spawn_instructions: { start: "Do stuff" }, // 'fanout' missing
      states: {
        end: { type: "terminal" },
        fanout: {
          agent: "worker",
          iterate_on: "items",
          transitions: { done: "end" },
          type: "parallel-per",
        },
        start: { agent: "a", transitions: { done: "fanout" }, type: "single" },
      },
    });
    const errors = validateSpawnCoverage(flow);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/fanout/);
  });
});

// analyzeReachability

describe("analyzeReachability", () => {
  it("returns no warnings when all states are reachable", () => {
    const flow = makeFlow();
    const warnings = analyzeReachability(flow);
    expect(warnings).toEqual([]);
  });

  it("returns warning for unreachable state", () => {
    const flow = makeFlow({
      states: {
        end: { type: "terminal" },
        orphan: { agent: "b", type: "single" }, // never transitioned to
        start: { agent: "a", transitions: { done: "end" }, type: "single" },
      },
    });
    const warnings = analyzeReachability(flow);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/orphan/);
    expect(warnings[0]).toMatch(/unreachable/i);
  });

  it("does not mark hitl-target source as unreachable", () => {
    const flow = makeFlow({
      states: {
        end: { type: "terminal" },
        start: {
          agent: "a",
          transitions: { blocked: "hitl", done: "end" },
          type: "single",
        },
      },
    });
    // 'start' can reach 'hitl' (virtual sink) and 'end'
    // 'start' itself is reachable from entry
    const warnings = analyzeReachability(flow);
    expect(warnings).toEqual([]);
  });

  it("does not add 'hitl' to reachability as a real state", () => {
    // hitl is a virtual sink — it should not be visited as if it were a real state
    const flow = makeFlow({
      states: {
        end: { type: "terminal" },
        start: {
          agent: "a",
          transitions: { blocked: "hitl", done: "end" },
          type: "single",
        },
      },
    });
    const warnings = analyzeReachability(flow);
    // Should be zero warnings — all real states are reachable
    expect(warnings).toEqual([]);
  });

  it("does not add 'no_items' to reachability as a real state", () => {
    const flow = makeFlow({
      states: {
        end: { type: "terminal" },
        start: {
          agent: "a",
          transitions: { done: "end", empty: "no_items" },
          type: "single",
        },
      },
    });
    const warnings = analyzeReachability(flow);
    expect(warnings).toEqual([]);
  });

  it("reachability warnings are warnings only — included in validateFlow result", () => {
    // unreachable states show up in validateFlow as warnings/errors but do NOT block
    // (the plan says warn only — they're logged but don't cause throws in loadAndResolveFlow)
    const flow = makeFlow({
      spawn_instructions: { start: "do it" },
      states: {
        end: { type: "terminal" },
        start: { agent: "a", transitions: { done: "end" }, type: "single" },
        unreachable: { type: "terminal" }, // terminal, no spawn needed, but unreachable
      },
    });
    const warnings = analyzeReachability(flow);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/unreachable/i);
  });
});

// checkUnresolvedRefs

describe("checkUnresolvedRefs", () => {
  it("returns no errors when spawn instructions have no unresolved refs", () => {
    const flow = makeFlow({
      spawn_instructions: { start: "Do the work. Save to file." },
    });
    const errors = checkUnresolvedRefs(flow);
    expect(errors).toEqual([]);
  });

  it("returns error when spawn instruction has an unknown variable", () => {
    const flow = makeFlow({
      spawn_instructions: { start: "Process ${typo_var}." },
    });
    const errors = checkUnresolvedRefs(flow);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/typo_var/);
    expect(errors[0]).toMatch(/unresolved reference/i);
  });

  it("accepts ${WORKSPACE} as a known runtime variable", () => {
    const flow = makeFlow({
      spawn_instructions: { start: "Save to ${WORKSPACE}/output.md." },
    });
    const errors = checkUnresolvedRefs(flow);
    expect(errors).toEqual([]);
  });

  it("accepts ${task} as a known runtime variable", () => {
    const flow = makeFlow({
      spawn_instructions: { start: "Implement: ${task}." },
    });
    const errors = checkUnresolvedRefs(flow);
    expect(errors).toEqual([]);
  });

  it("accepts ${slug} as a known runtime variable", () => {
    const flow = makeFlow({
      spawn_instructions: { start: "Save to ${WORKSPACE}/plans/${slug}/OUT.md." },
    });
    const errors = checkUnresolvedRefs(flow);
    expect(errors).toEqual([]);
  });

  it("accepts ${CLAUDE_PLUGIN_ROOT} as a known runtime variable", () => {
    const flow = makeFlow({
      spawn_instructions: { start: "Template: ${CLAUDE_PLUGIN_ROOT}/templates/foo.md." },
    });
    const errors = checkUnresolvedRefs(flow);
    expect(errors).toEqual([]);
  });

  it("accepts item.* runtime variables", () => {
    const flow = makeFlow({
      spawn_instructions: {
        start:
          "Fix ${item.principle_id} (${item.severity}) in ${item.file_path}. Detail: ${item.detail}.",
      },
    });
    const errors = checkUnresolvedRefs(flow);
    expect(errors).toEqual([]);
  });

  it("returns error when a transition target still has an unresolved ${param}", () => {
    const flow = makeFlow({
      states: {
        end: { type: "terminal" },
        start: {
          agent: "a",
          transitions: { done: "${unresolved_param}" }, // leftover after substitution
          type: "single",
        },
      },
    });
    const errors = checkUnresolvedRefs(flow);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/unresolved reference/i);
    expect(errors[0]).toMatch(/unresolved_param/);
  });

  it("accepts states with no transitions (no errors)", () => {
    const flow = makeFlow({
      spawn_instructions: {},
      states: {
        start: { type: "terminal" }, // no transitions
      },
    });
    const errors = checkUnresolvedRefs(flow);
    expect(errors).toEqual([]);
  });

  it("accepts wave_briefing, review_scope, progress as known runtime variables", () => {
    const flow = makeFlow({
      spawn_instructions: {
        start: "${wave_briefing}\n${review_scope}\n${progress}",
      },
    });
    const errors = checkUnresolvedRefs(flow);
    expect(errors).toEqual([]);
  });

  it("accepts wave-related runtime variables used in consultation spawn instructions", () => {
    const flow = makeFlow({
      spawn_instructions: {
        start:
          "Review wave ${wave} changes. Files: ${wave_files}. Diff: ${wave_diff}. Summaries: ${wave_summaries}.",
      },
    });
    const errors = checkUnresolvedRefs(flow);
    expect(errors).toEqual([]);
  });
});

// validateFlow integration — new passes included

describe("validateFlow — new passes", () => {
  it("returns errors for spawn coverage violations", () => {
    const flow = makeFlow({
      spawn_instructions: {}, // missing 'start'
    });
    const errors = validateFlow(flow);
    expect(errors.some((e) => e.includes("start"))).toBe(true);
  });

  it("includes reachability warnings in output", () => {
    const flow = makeFlow({
      states: {
        end: { type: "terminal" },
        ghost: { type: "terminal" }, // unreachable terminal, no spawn needed
        start: { agent: "a", transitions: { done: "end" }, type: "single" },
      },
    });
    // analyzeReachability returns warnings — they appear in validateFlow output
    const result = validateFlow(flow);
    const hasReachabilityWarning = result.some(
      (msg) => msg.includes("ghost") && msg.toLowerCase().includes("unreachable"),
    );
    expect(hasReachabilityWarning).toBe(true);
  });

  it("returns errors for unresolved refs", () => {
    const flow = makeFlow({
      spawn_instructions: { start: "Process ${unknown_var}." },
    });
    const errors = validateFlow(flow);
    expect(errors.some((e) => e.includes("unknown_var"))).toBe(true);
  });
});

// Hard-blocking: loadAndResolveFlow throws on validation errors

describe("loadAndResolveFlow — hard-blocking validation", () => {
  it("loads the review-only flow without errors (regression — no LoadFlowResult.errors field)", async () => {
    // After removing the errors field, loadAndResolveFlow returns just ResolvedFlow
    const flow = await loadAndResolveFlow(pluginDir, "review-only");
    expect(flow.name).toBe("review-only");
    expect(flow.states.review).toBeDefined();
    expect(flow.states.done).toBeDefined();
  });

  it("throws an Error for invalid flow name characters (path traversal)", async () => {
    await expect(loadAndResolveFlow("/some/dir", "../../etc/passwd")).rejects.toThrow();
  });

  it("throws when flow is not found", async () => {
    await expect(loadAndResolveFlow("/nonexistent/dir", "no-such-flow")).rejects.toThrow(
      /not found/i,
    );
  });

  it("all 10 production flows load successfully with hard-blocking validation", async () => {
    const flows = [
      "review-only",
      "epic",
      "feature",
      "fast-path",
      "refactor",
      "migrate",
      "explore",
      "test-gap",
      "security-audit",
      "adopt",
    ];

    await Promise.all(
      flows.map((flowName) =>
        expect(
          loadAndResolveFlow(pluginDir, flowName),
          `Flow "${flowName}" should load without throwing`,
        ).resolves.toBeDefined(),
      ),
    );
  });
});
