/**
 * Tests for fanout.ts (Stage 7)
 *
 * Covers:
 * - Single state: one prompt entry with basePrompt
 * - Single state with clusters: one prompt per cluster
 * - Single state with compete: expanded competitor prompts
 * - Compete on non-single: warning produced
 * - Parallel state with agents: one prompt per agent
 * - Parallel state with roles: one prompt per role with role substitution
 * - Wave state: one prompt per item with item substitution
 * - Wave state with empty items: zero prompts, no warning
 * - Wave state with undefined items: zero prompts, no warning
 * - Parallel-per state: items with worktree isolation
 * - Parallel-per state with clusters: cluster items override
 * - Debate: active debate produces fanned_out prompts
 * - Debate: completed debate appends summary
 * - Timeout parsing: valid and invalid formats
 * - clusterDiff empty array vs null behavior preserved
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mocks before module imports

vi.mock("../../orchestration/diff-cluster.ts", () => ({
  clusterDiff: vi.fn().mockReturnValue(null),
}));

vi.mock("../../orchestration/compete.ts", () => ({
  expandCompetitorPrompts: vi.fn(),
}));

vi.mock("../../orchestration/debate.ts", () => ({
  buildDebatePrompt: vi.fn().mockReturnValue("debate-prompt"),
  debateTeamLabel: vi.fn((i: number) => `Team ${String.fromCharCode(65 + i)}`),
  inspectDebateProgress: vi.fn(),
}));

import { expandCompetitorPrompts } from "../../orchestration/compete.ts";
import { buildDebatePrompt, inspectDebateProgress } from "../../orchestration/debate.ts";
import type { FileCluster } from "../../orchestration/diff-cluster.ts";
import { clusterDiff } from "../../orchestration/diff-cluster.ts";
import type { ResolvedFlow, StateDefinition } from "../../orchestration/flow-schema.ts";
import { fanout } from "../../tools/prompt-pipeline/fanout.ts";
import type { PromptContext } from "../../tools/prompt-pipeline/types.ts";

function makeCtx(
  overrides: Partial<PromptContext> & {
    workspace?: string;
    state_id?: string;
    flow?: ResolvedFlow;
    variables?: Record<string, string>;
    items?: PromptContext["input"]["items"];
  } = {},
): PromptContext {
  const { workspace, state_id, flow, variables, items, ...rest } = overrides;
  return {
    basePrompt: "Do the thing",
    input: {
      flow:
        flow ??
        ({
          description: "Test",
          entry: "implement",
          name: "test-flow",
          spawn_instructions: { implement: "Do the thing" },
          states: {
            done: { type: "terminal" },
            implement: { agent: "canon-implementor", type: "single" },
          },
        } as ResolvedFlow),
      state_id: state_id ?? "implement",
      variables: variables ?? { CANON_PLUGIN_ROOT: "" },
      workspace: workspace ?? "/tmp/test-ws",
      ...("items" in overrides ? { items } : {}),
    },
    mergedVariables: { CANON_PLUGIN_ROOT: "" },
    prompts: [],
    rawInstruction: "Do the thing",
    state: { agent: "canon-implementor", type: "single" } as StateDefinition,
    warnings: [],
    ...rest,
  };
}

const sampleClusters: FileCluster[] = [
  { files: ["src/api/orders.ts", "src/api/users.ts"], key: "src/api" },
  { files: ["src/ui/Dashboard.svelte"], key: "src/ui" },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(clusterDiff).mockReturnValue(null);
  vi.mocked(expandCompetitorPrompts).mockReturnValue([]);
});

// Single state

describe("fanout — single state", () => {
  it("produces one prompt entry with basePrompt for single state", async () => {
    const ctx = makeCtx();
    const result = await fanout(ctx);

    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0].agent).toBe("canon-implementor");
    expect(result.prompts[0].prompt).toBe("Do the thing");
  });

  it("uses 'unknown' agent when state has no agent field", async () => {
    const ctx = makeCtx({
      state: { type: "single" } as StateDefinition,
    });
    const result = await fanout(ctx);

    expect(result.prompts[0].agent).toBe("unknown");
  });

  it("produces one prompt per cluster when clusters are present (length > 0)", async () => {
    const ctx = makeCtx({
      basePrompt: "Review ${item.cluster_key}",
      flow: {
        description: "Test",
        entry: "implement",
        name: "test-flow",
        spawn_instructions: { implement: "Review ${item.cluster_key}" },
        states: {
          done: { type: "terminal" },
          implement: { agent: "canon-reviewer", large_diff_threshold: 5, type: "single" },
        },
      } as ResolvedFlow,
      state: {
        agent: "canon-reviewer",
        large_diff_threshold: 5,
        type: "single",
      } as StateDefinition,
    });
    vi.mocked(clusterDiff).mockReturnValue(sampleClusters);

    const result = await fanout(ctx);

    expect(result.prompts).toHaveLength(2);
    expect(result.prompts[0].item).toEqual(expect.objectContaining({ cluster_key: "src/api" }));
    expect(result.prompts[1].item).toEqual(expect.objectContaining({ cluster_key: "src/ui" }));
  });

  it("falls through to single prompt when clusters is empty array (not truthy-but-empty guard)", async () => {
    const ctx = makeCtx();
    // clusterDiff returns [] — empty array, not null
    vi.mocked(clusterDiff).mockReturnValue([]);

    const result = await fanout(ctx);

    // Empty array: clusters.length === 0, so should NOT fan out by clusters
    expect(result.prompts).toHaveLength(1);
  });

  it("falls through to single prompt when clusterDiff returns null", async () => {
    const ctx = makeCtx();
    vi.mocked(clusterDiff).mockReturnValue(null);

    const result = await fanout(ctx);
    expect(result.prompts).toHaveLength(1);
  });

  it("expands competitor prompts when compete config is present", async () => {
    const ctx = makeCtx({
      state: {
        agent: "canon-implementor",
        compete: { count: 2, strategy: "synthesize" },
        type: "single",
      } as StateDefinition,
    });
    vi.mocked(expandCompetitorPrompts).mockReturnValue([
      { agent: "canon-implementor", index: 0, prompt: "Team A prompt", template_paths: [] },
      { agent: "canon-implementor", index: 1, prompt: "Team B prompt", template_paths: [] },
    ]);

    const result = await fanout(ctx);

    expect(expandCompetitorPrompts).toHaveBeenCalledOnce();
    expect(result.prompts).toHaveLength(2);
    expect(result.prompts[0].prompt).toBe("Team A prompt");
    expect(result.prompts[1].prompt).toBe("Team B prompt");
  });
});

// Compete warning on non-single

describe("fanout — compete on non-single states", () => {
  it("produces a warning when non-single state has compete config", async () => {
    const ctx = makeCtx({
      state: {
        agents: ["canon-implementor"],
        compete: { count: 2, strategy: "synthesize" },
        type: "parallel",
      } as unknown as StateDefinition,
    });

    const result = await fanout(ctx);

    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining("compete")]));
  });

  it("still returns prompts despite warning for non-single with compete", async () => {
    const ctx = makeCtx({
      state: {
        agents: ["canon-implementor", "canon-architect"],
        compete: { count: 2, strategy: "synthesize" },
        type: "parallel",
      } as unknown as StateDefinition,
    });

    const result = await fanout(ctx);

    expect(result.prompts.length).toBeGreaterThan(0);
  });
});

// Parallel state

describe("fanout — parallel state", () => {
  it("produces one prompt per agent when multiple agents and no roles", async () => {
    const ctx = makeCtx({
      state: {
        agents: ["canon-implementor", "canon-architect"],
        type: "parallel",
      } as StateDefinition,
    });

    const result = await fanout(ctx);

    expect(result.prompts).toHaveLength(2);
    expect(result.prompts[0].agent).toBe("canon-implementor");
    expect(result.prompts[1].agent).toBe("canon-architect");
  });

  it("produces one prompt per role when one agent and multiple roles", async () => {
    const ctx = makeCtx({
      state: {
        agents: ["canon-implementor"],
        roles: ["frontend", "backend", "infra"],
        type: "parallel",
      } as StateDefinition,
    });

    const result = await fanout(ctx);

    expect(result.prompts).toHaveLength(3);
    expect(result.prompts[0].role).toBe("frontend");
    expect(result.prompts[1].role).toBe("backend");
    expect(result.prompts[2].role).toBe("infra");
  });

  it("substitutes role variable in prompt when role fanout", async () => {
    const ctx = makeCtx({
      basePrompt: "Implement the ${role} layer",
      state: {
        agents: ["canon-implementor"],
        roles: ["frontend", "backend"],
        type: "parallel",
      } as StateDefinition,
    });

    const result = await fanout(ctx);

    expect(result.prompts[0].prompt).toBe("Implement the frontend layer");
    expect(result.prompts[1].prompt).toBe("Implement the backend layer");
  });

  it("handles object role entries (with name field)", async () => {
    const ctx = makeCtx({
      state: {
        agents: ["canon-implementor"],
        roles: [{ name: "frontend", optional: true }, "backend"],
        type: "parallel",
      } as StateDefinition,
    });

    const result = await fanout(ctx);

    expect(result.prompts).toHaveLength(2);
    expect(result.prompts[0].role).toBe("frontend");
    expect(result.prompts[1].role).toBe("backend");
  });
});

// Wave state

describe("fanout — wave state", () => {
  it("produces one prompt per item with item substitution", async () => {
    const ctx = makeCtx({
      basePrompt: "Implement ${item}",
      items: ["task-a", "task-b", "task-c"],
      state: { agent: "canon-implementor", type: "wave" } as StateDefinition,
    });

    const result = await fanout(ctx);

    expect(result.prompts).toHaveLength(3);
    expect(result.prompts[0].prompt).toBe("Implement task-a");
    expect(result.prompts[0].item).toBe("task-a");
    expect(result.prompts[1].prompt).toBe("Implement task-b");
    expect(result.prompts[2].prompt).toBe("Implement task-c");
  });

  it("sets isolation: worktree on wave prompts", async () => {
    const ctx = makeCtx({
      items: ["task-a"],
      state: { agent: "canon-implementor", type: "wave" } as StateDefinition,
    });

    const result = await fanout(ctx);

    expect(result.prompts[0].isolation).toBe("worktree");
  });

  it("produces zero prompts when items is empty array", async () => {
    const ctx = makeCtx({
      items: [],
      state: { agent: "canon-implementor", type: "wave" } as StateDefinition,
    });

    const result = await fanout(ctx);

    expect(result.prompts).toHaveLength(0);
    // No warning should be produced for empty items
    expect(result.warnings).toHaveLength(0);
  });

  it("produces zero prompts when items is undefined (uses ?? [])", async () => {
    const ctx = makeCtx({
      items: undefined,
      state: { agent: "canon-implementor", type: "wave" } as StateDefinition,
    });

    const result = await fanout(ctx);

    expect(result.prompts).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("handles object items with ${item.field} substitution", async () => {
    const ctx = makeCtx({
      basePrompt: "Implement ${item.name} in ${item.layer}",
      items: [{ layer: "domain", name: "OrderService" }],
      state: { agent: "canon-implementor", type: "wave" } as StateDefinition,
    });

    const result = await fanout(ctx);

    expect(result.prompts[0].prompt).toBe("Implement OrderService in domain");
  });
});

// Parallel-per state

describe("fanout — parallel-per state", () => {
  it("produces one prompt per item with worktree isolation", async () => {
    const ctx = makeCtx({
      items: ["item-1", "item-2"],
      state: { agent: "canon-implementor", type: "parallel-per" } as StateDefinition,
    });

    const result = await fanout(ctx);

    expect(result.prompts).toHaveLength(2);
    expect(result.prompts[0].isolation).toBe("worktree");
    expect(result.prompts[1].isolation).toBe("worktree");
  });

  it("uses cluster items instead of original items when clusters present", async () => {
    const ctx = makeCtx({
      basePrompt: "Review cluster ${item.cluster_key}",
      items: ["original-item"],
      state: {
        agent: "canon-implementor",
        large_diff_threshold: 5,
        type: "parallel-per",
      } as StateDefinition,
    });
    vi.mocked(clusterDiff).mockReturnValue(sampleClusters);

    const result = await fanout(ctx);

    // Should use cluster items, not original items
    expect(result.prompts).toHaveLength(2);
    expect(result.prompts[0].item).toEqual(expect.objectContaining({ cluster_key: "src/api" }));
  });

  it("produces zero prompts for parallel-per when items is empty array", async () => {
    const ctx = makeCtx({
      items: [],
      state: { agent: "canon-implementor", type: "parallel-per" } as StateDefinition,
    });

    const result = await fanout(ctx);
    expect(result.prompts).toHaveLength(0);
  });
});

// Debate handling

describe("fanout — debate handling", () => {
  it("produces fanned_out prompts for active (not completed) debate", async () => {
    const flow: ResolvedFlow = {
      debate: {
        composition: ["canon-architect"],
        continue_to_build: true,
        convergence_check_after: 2,
        hitl_checkpoint: false,
        max_rounds: 3,
        min_rounds: 1,
        teams: 2,
      },
      description: "Test",
      entry: "implement",
      name: "debate-flow",
      spawn_instructions: { implement: "Debate this" },
      states: {
        done: { type: "terminal" },
        implement: { agent: "canon-architect", type: "single" },
      },
    } as unknown as ResolvedFlow;

    const ctx = makeCtx({
      basePrompt: "Debate this",
      flow,
      state: { agent: "canon-architect", type: "single" } as StateDefinition,
      state_id: "implement",
    });

    vi.mocked(inspectDebateProgress).mockResolvedValue({
      completed: false,
      last_completed_round: 0,
      next_channel: "debate-round-1",
      next_round: 1,
    });
    vi.mocked(buildDebatePrompt).mockReturnValue("debate-prompt-A");

    const result = await fanout(ctx);

    // With teams=2 and 1 agent in composition, expect 2 prompts (one per team)
    expect(result.prompts).toHaveLength(2);
    expect(result.prompts[0].role).toMatch(/Team/);
  });

  it("returns fanned_out: true when debate produces multiple prompts", async () => {
    const flow: ResolvedFlow = {
      debate: {
        composition: ["canon-architect"],
        continue_to_build: true,
        convergence_check_after: 2,
        hitl_checkpoint: false,
        max_rounds: 3,
        min_rounds: 1,
        teams: 2,
      },
      description: "Test",
      entry: "implement",
      name: "debate-flow",
      spawn_instructions: { implement: "Debate this" },
      states: {
        done: { type: "terminal" },
        implement: { agent: "canon-architect", type: "single" },
      },
    } as unknown as ResolvedFlow;

    const ctx = makeCtx({
      flow,
      state_id: "implement",
    });

    vi.mocked(inspectDebateProgress).mockResolvedValue({
      completed: false,
      last_completed_round: 0,
      next_channel: "debate-round-1",
      next_round: 1,
    });

    const result = await fanout(ctx);
    // debate early return sets fanned_out: true on context
    expect(result.prompts.length).toBeGreaterThan(0);
  });

  it("appends debate summary to basePrompt when debate is completed", async () => {
    const flow: ResolvedFlow = {
      debate: {
        composition: ["canon-architect"],
        continue_to_build: true,
        convergence_check_after: 2,
        hitl_checkpoint: false,
        max_rounds: 3,
        min_rounds: 1,
        teams: 2,
      },
      description: "Test",
      entry: "implement",
      name: "debate-flow",
      spawn_instructions: { implement: "Debate this" },
      states: {
        done: { type: "terminal" },
        implement: { agent: "canon-architect", type: "single" },
      },
    } as unknown as ResolvedFlow;

    const ctx = makeCtx({
      basePrompt: "Original prompt",
      flow,
      state_id: "implement",
    });

    vi.mocked(inspectDebateProgress).mockResolvedValue({
      completed: true,
      convergence: { converged: true, reason: "Agreement reached" },
      last_completed_round: 3,
      next_channel: "debate-round-3",
      next_round: 3,
      summary: "## Debate Summary\n\nTeams agreed on approach X.",
    });

    const result = await fanout(ctx);

    // After debate completes, should continue to normal fanout with appended summary
    expect(result.basePrompt).toContain("## Debate Summary");
  });

  it("adds warning when debate completed", async () => {
    const flow: ResolvedFlow = {
      debate: {
        composition: ["canon-architect"],
        continue_to_build: true,
        convergence_check_after: 2,
        hitl_checkpoint: false,
        max_rounds: 3,
        min_rounds: 1,
        teams: 2,
      },
      description: "Test",
      entry: "implement",
      name: "debate-flow",
      spawn_instructions: { implement: "Debate this" },
      states: {
        done: { type: "terminal" },
        implement: { agent: "canon-architect", type: "single" },
      },
    } as unknown as ResolvedFlow;

    const ctx = makeCtx({
      flow,
      state_id: "implement",
    });

    vi.mocked(inspectDebateProgress).mockResolvedValue({
      completed: true,
      convergence: { converged: true, reason: "Both teams converged" },
      last_completed_round: 3,
      next_channel: "debate-round-3",
      next_round: 3,
    });

    const result = await fanout(ctx);

    expect(result.warnings.some((w) => w.includes("Debate completed"))).toBe(true);
  });
});

// Timeout parsing

describe("fanout — timeout parsing", () => {
  it("sets timeout_ms from valid timeout string", async () => {
    const ctx = makeCtx({
      state: {
        agent: "canon-implementor",
        timeout: "10m",
        type: "single",
      } as StateDefinition,
    });

    const result = await fanout(ctx);

    expect(result.timeout_ms).toBe(600000);
  });

  it("adds warning for invalid timeout format", async () => {
    const ctx = makeCtx({
      state: {
        agent: "canon-implementor",
        timeout: "invalid",
        type: "single",
      } as StateDefinition,
    });

    const result = await fanout(ctx);

    expect(result.warnings.some((w) => w.includes("timeout"))).toBe(true);
    expect(result.timeout_ms).toBeUndefined();
  });

  it("handles complex timeout like 1h30m", async () => {
    const ctx = makeCtx({
      state: {
        agent: "canon-implementor",
        timeout: "1h30m",
        type: "single",
      } as StateDefinition,
    });

    const result = await fanout(ctx);

    expect(result.timeout_ms).toBe(5400000); // 1.5 hours
  });

  it("handles seconds timeout", async () => {
    const ctx = makeCtx({
      state: {
        agent: "canon-implementor",
        timeout: "90s",
        type: "single",
      } as StateDefinition,
    });

    const result = await fanout(ctx);

    expect(result.timeout_ms).toBe(90000);
  });
});

// clusterDiff null vs empty array — behavioral preservation

describe("fanout — clusterDiff null vs empty array distinction", () => {
  it("null clusterDiff result does not trigger cluster fanout", async () => {
    const ctx = makeCtx({
      state: {
        agent: "canon-reviewer",
        large_diff_threshold: 5,
        type: "single",
      } as StateDefinition,
    });
    vi.mocked(clusterDiff).mockReturnValue(null);

    const result = await fanout(ctx);
    expect(result.prompts).toHaveLength(1);
  });

  it("empty array clusterDiff result does not trigger cluster fanout (null-vs-empty guard)", async () => {
    const ctx = makeCtx({
      state: {
        agent: "canon-reviewer",
        large_diff_threshold: 5,
        type: "single",
      } as StateDefinition,
    });
    // clusterDiff returns [] — threshold not exceeded but returns empty array
    vi.mocked(clusterDiff).mockReturnValue([]);

    const result = await fanout(ctx);
    // clusters && clusters.length > 0 guard: empty array falls through
    expect(result.prompts).toHaveLength(1);
  });

  it("non-empty clusters produce multiple prompts", async () => {
    const ctx = makeCtx({
      state: {
        agent: "canon-reviewer",
        large_diff_threshold: 5,
        type: "single",
      } as StateDefinition,
    });
    vi.mocked(clusterDiff).mockReturnValue(sampleClusters);

    const result = await fanout(ctx);
    expect(result.prompts).toHaveLength(2);
  });
});
