/**
 * Tests for inject-coordination.ts (Stage 8)
 *
 * Covers:
 * - Role substitution for single states with ctx.role set
 * - Role substitution NOT applied for non-single states
 * - Messaging instructions appended for wave states with wave set
 * - Messaging instructions appended for parallel-per states with wave set
 * - Messaging instructions NOT appended when wave is null/undefined
 * - Metrics footer appended to every prompt entry
 * - Metrics footer contains correct workspace and state_id values
 * - Metrics footer appended even when prompts have different content
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoist mocks before module imports
// ---------------------------------------------------------------------------

vi.mock("../../orchestration/messages.ts", () => ({
  buildMessageInstructions: vi.fn().mockReturnValue("## Wave Coordination\n\nInstructions here"),
}));

import { buildMessageInstructions } from "../../orchestration/messages.ts";
import { injectCoordination } from "../../tools/prompt-pipeline/inject-coordination.ts";
import type { PromptContext, SpawnPromptEntry } from "../../tools/prompt-pipeline/types.ts";
import type { ResolvedFlow, StateDefinition } from "../../orchestration/flow-schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<SpawnPromptEntry> = {}): SpawnPromptEntry {
  return {
    agent: "canon-implementor",
    prompt: "Do the work",
    template_paths: [],
    ...overrides,
  };
}

function makeCtx(overrides: Partial<PromptContext> & { workspace?: string; state_id?: string; flow?: ResolvedFlow; variables?: Record<string, string>; role?: string; wave?: number; peer_count?: number } = {}): PromptContext {
  const { workspace, state_id, flow, variables, role, wave, peer_count, ...rest } = overrides;
  return {
    input: {
      workspace: workspace ?? "/tmp/test-workspace",
      state_id: state_id ?? "implement",
      flow: flow ?? {
        name: "test-flow",
        description: "Test",
        entry: "implement",
        states: {
          implement: { type: "single", agent: "canon-implementor" },
          done: { type: "terminal" },
        },
        spawn_instructions: { implement: "Do the thing" },
      } as ResolvedFlow,
      variables: variables ?? {},
      ...("role" in overrides ? { role } : {}),
      ...("wave" in overrides ? { wave } : {}),
      ...("peer_count" in overrides ? { peer_count } : {}),
    },
    state: { type: "single", agent: "canon-implementor" } as StateDefinition,
    rawInstruction: "Do the thing",
    basePrompt: "Do the thing",
    prompts: [makeEntry()],
    warnings: [],
    mergedVariables: {},
    ...rest,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(buildMessageInstructions).mockReturnValue("## Wave Coordination\n\nInstructions here");
});

// ---------------------------------------------------------------------------
// Role substitution
// ---------------------------------------------------------------------------

describe("injectCoordination — role substitution", () => {
  it("substitutes role variable in prompt for single state when ctx.role is set", async () => {
    const ctx = makeCtx({
      state: { type: "single", agent: "canon-implementor" } as StateDefinition,
      role: "frontend",
      prompts: [makeEntry({ prompt: "Implement the ${role} layer" })],
    });

    const result = await injectCoordination(ctx);

    expect(result.prompts[0].prompt).toContain("frontend");
    expect(result.prompts[0].role).toBe("frontend");
  });

  it("applies role substitution to all prompts (for cluster-fanned single state)", async () => {
    const ctx = makeCtx({
      state: { type: "single", agent: "canon-reviewer" } as StateDefinition,
      role: "tech-lead",
      prompts: [
        makeEntry({ prompt: "Review cluster 1 as ${role}" }),
        makeEntry({ prompt: "Review cluster 2 as ${role}" }),
      ],
    });

    const result = await injectCoordination(ctx);

    expect(result.prompts[0].prompt).toContain("tech-lead");
    expect(result.prompts[1].prompt).toContain("tech-lead");
    expect(result.prompts[0].role).toBe("tech-lead");
    expect(result.prompts[1].role).toBe("tech-lead");
  });

  it("does NOT apply role substitution when state type is not single", async () => {
    const ctx = makeCtx({
      state: { type: "wave", agent: "canon-implementor" } as StateDefinition,
      role: "frontend",
      prompts: [makeEntry({ prompt: "Implement the ${role} layer" })],
    });

    const result = await injectCoordination(ctx);

    // role substitution only applies to single states — ${role} should remain unsubstituted
    expect(result.prompts[0].prompt).toContain("Implement the ${role} layer");
    expect(result.prompts[0].role).toBeUndefined();
  });

  it("does NOT apply role substitution when ctx.role is not set", async () => {
    const ctx = makeCtx({
      state: { type: "single", agent: "canon-implementor" } as StateDefinition,
      role: undefined,
      prompts: [makeEntry({ prompt: "Implement the ${role} layer" })],
    });

    const result = await injectCoordination(ctx);

    // No role provided — ${role} pattern should remain unsubstituted
    expect(result.prompts[0].prompt).toContain("Implement the ${role} layer");
  });
});

// ---------------------------------------------------------------------------
// Messaging instructions
// ---------------------------------------------------------------------------

describe("injectCoordination — messaging instructions", () => {
  it("appends messaging instructions to each prompt for wave state with wave set", async () => {
    const ctx = makeCtx({
      state: { type: "wave", agent: "canon-implementor" } as StateDefinition,
      wave: 2,
      prompts: [makeEntry({ prompt: "Implement task A" }), makeEntry({ prompt: "Implement task B" })],
    });

    const result = await injectCoordination(ctx);

    expect(buildMessageInstructions).toHaveBeenCalledOnce();
    expect(result.prompts[0].prompt).toContain("## Wave Coordination");
    expect(result.prompts[1].prompt).toContain("## Wave Coordination");
  });

  it("appends messaging instructions for parallel-per state with wave set", async () => {
    const ctx = makeCtx({
      state: { type: "parallel-per", agent: "canon-implementor" } as StateDefinition,
      wave: 1,
      prompts: [makeEntry()],
    });

    const result = await injectCoordination(ctx);

    expect(buildMessageInstructions).toHaveBeenCalledOnce();
    expect(result.prompts[0].prompt).toContain("## Wave Coordination");
  });

  it("does NOT append messaging instructions when wave is null/undefined", async () => {
    const ctx = makeCtx({
      state: { type: "wave", agent: "canon-implementor" } as StateDefinition,
      wave: undefined,
      prompts: [makeEntry()],
    });

    const result = await injectCoordination(ctx);

    expect(buildMessageInstructions).not.toHaveBeenCalled();
    expect(result.prompts[0].prompt).not.toContain("## Wave Coordination");
  });

  it("does NOT append messaging instructions for single state", async () => {
    const ctx = makeCtx({
      state: { type: "single", agent: "canon-implementor" } as StateDefinition,
      wave: 1,
      prompts: [makeEntry()],
    });

    const result = await injectCoordination(ctx);

    expect(buildMessageInstructions).not.toHaveBeenCalled();
  });

  it("uses peer_count from ctx when provided", async () => {
    const ctx = makeCtx({
      state: { type: "wave", agent: "canon-implementor" } as StateDefinition,
      wave: 1,
      peer_count: 5,
      prompts: [makeEntry(), makeEntry()],
    });

    await injectCoordination(ctx);

    expect(buildMessageInstructions).toHaveBeenCalledWith(
      "wave-001",
      5, // peer_count from ctx
      "/tmp/test-workspace",
    );
  });

  it("defaults peer_count to prompts.length - 1 when not provided", async () => {
    const ctx = makeCtx({
      state: { type: "wave", agent: "canon-implementor" } as StateDefinition,
      wave: 1,
      peer_count: undefined,
      prompts: [makeEntry(), makeEntry(), makeEntry()],
    });

    await injectCoordination(ctx);

    expect(buildMessageInstructions).toHaveBeenCalledWith(
      "wave-001",
      2, // prompts.length - 1 = 3 - 1 = 2
      "/tmp/test-workspace",
    );
  });

  it("formats wave channel with zero-padding (wave-001, wave-002)", async () => {
    const ctx = makeCtx({
      state: { type: "wave", agent: "canon-implementor" } as StateDefinition,
      wave: 12,
      prompts: [makeEntry()],
    });

    await injectCoordination(ctx);

    expect(buildMessageInstructions).toHaveBeenCalledWith(
      "wave-012",
      expect.any(Number),
      expect.any(String),
    );
  });
});

// ---------------------------------------------------------------------------
// Metrics footer
// ---------------------------------------------------------------------------

describe("injectCoordination — metrics footer", () => {
  it("appends metrics footer to every prompt entry", async () => {
    const ctx = makeCtx({
      prompts: [makeEntry({ prompt: "Do task A" }), makeEntry({ prompt: "Do task B" })],
    });

    const result = await injectCoordination(ctx);

    expect(result.prompts[0].prompt).toContain("## Performance Metrics");
    expect(result.prompts[1].prompt).toContain("## Performance Metrics");
  });

  it("metrics footer contains correct workspace value", async () => {
    const ctx = makeCtx({
      workspace: "/Users/michelle/projects/my-workspace",
      prompts: [makeEntry()],
    });

    const result = await injectCoordination(ctx);

    expect(result.prompts[0].prompt).toContain("/Users/michelle/projects/my-workspace");
  });

  it("metrics footer contains correct state_id value", async () => {
    const ctx = makeCtx({
      state_id: "review-code",
      prompts: [makeEntry()],
    });

    const result = await injectCoordination(ctx);

    expect(result.prompts[0].prompt).toContain("review-code");
  });

  it("appends metrics footer even when prompts list has mixed content", async () => {
    const ctx = makeCtx({
      prompts: [
        makeEntry({ prompt: "Simple task" }),
        makeEntry({ prompt: "Complex task with\nmultiple lines\nof content" }),
      ],
    });

    const result = await injectCoordination(ctx);

    for (const entry of result.prompts) {
      expect(entry.prompt).toContain("## Performance Metrics");
      expect(entry.prompt).toContain("record_agent_metrics");
    }
  });

  it("appends metrics footer to empty prompts list gracefully (zero iterations)", async () => {
    const ctx = makeCtx({
      prompts: [],
    });

    const result = await injectCoordination(ctx);

    expect(result.prompts).toHaveLength(0);
  });

  it("metrics footer contains tool_calls, orientation_calls, and turns fields", async () => {
    const ctx = makeCtx({
      prompts: [makeEntry()],
    });

    const result = await injectCoordination(ctx);

    expect(result.prompts[0].prompt).toContain("tool_calls");
    expect(result.prompts[0].prompt).toContain("orientation_calls");
    expect(result.prompts[0].prompt).toContain("turns");
  });
});
