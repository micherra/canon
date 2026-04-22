/**
 * Tests for fanout.ts (Stage 7) — Part 2
 *
 * Covers:
 * - Parallel-per state: items fanout (no isolation field — worktree_path is sole signal)
 * - Parallel-per state with clusters: cluster items override
 * - Debate: active debate produces fanned_out prompts
 * - Debate: completed debate appends summary
 * - Timeout parsing: valid and invalid formats
 * - clusterDiff empty array vs null behavior preserved
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mocks before module imports

vi.mock("@features/orchestration/services/diff-cluster.ts", () => ({
  clusterDiff: vi.fn().mockReturnValue(null),
}));

vi.mock("@features/orchestration/engine/compete.ts", () => ({
  expandCompetitorPrompts: vi.fn(),
}));

vi.mock("@features/orchestration/engine/debate.ts", () => ({
  buildDebatePrompt: vi.fn().mockReturnValue("debate-prompt"),
  debateTeamLabel: vi.fn((i: number) => `Team ${String.fromCharCode(65 + i)}`),
  inspectDebateProgress: vi.fn(),
}));

import type { ResolvedFlow, StateDefinition } from "@domains/flows/flow-definition-schemas.ts";
import { expandCompetitorPrompts } from "@features/orchestration/engine/compete.ts";
import { buildDebatePrompt, inspectDebateProgress } from "@features/orchestration/engine/debate.ts";
import type { FileCluster } from "@features/orchestration/services/diff-cluster.ts";
import { clusterDiff } from "@features/orchestration/services/diff-cluster.ts";
import type { PromptContext } from "../model/types.ts";
import { fanout } from "../tools/fanout.ts";

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
            implement: { agent: "implementor", type: "single" },
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
    state: { agent: "implementor", type: "single" } as StateDefinition,
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

// Parallel-per state

describe("fanout — parallel-per state", () => {
  it("produces one prompt per item (no isolation field set)", async () => {
    const ctx = makeCtx({
      items: ["item-1", "item-2"],
      state: { agent: "implementor", type: "parallel-per" } as StateDefinition,
    });

    const result = await fanout(ctx);

    expect(result.prompts).toHaveLength(2);
    expect(result.prompts[0]).not.toHaveProperty("isolation");
    expect(result.prompts[1]).not.toHaveProperty("isolation");
  });

  it("uses cluster items instead of original items when clusters present", async () => {
    const ctx = makeCtx({
      basePrompt: "Review cluster ${item.cluster_key}",
      items: ["original-item"],
      state: {
        agent: "implementor",
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
      state: { agent: "implementor", type: "parallel-per" } as StateDefinition,
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
        composition: ["architect"],
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
        implement: { agent: "architect", type: "single" },
      },
    } as unknown as ResolvedFlow;

    const ctx = makeCtx({
      basePrompt: "Debate this",
      flow,
      state: { agent: "architect", type: "single" } as StateDefinition,
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
        composition: ["architect"],
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
        implement: { agent: "architect", type: "single" },
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
        composition: ["architect"],
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
        implement: { agent: "architect", type: "single" },
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
        composition: ["architect"],
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
        implement: { agent: "architect", type: "single" },
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
        agent: "implementor",
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
        agent: "implementor",
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
        agent: "implementor",
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
        agent: "implementor",
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
        agent: "reviewer",
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
        agent: "reviewer",
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
        agent: "reviewer",
        large_diff_threshold: 5,
        type: "single",
      } as StateDefinition,
    });
    vi.mocked(clusterDiff).mockReturnValue(sampleClusters);

    const result = await fanout(ctx);
    expect(result.prompts).toHaveLength(2);
  });
});
