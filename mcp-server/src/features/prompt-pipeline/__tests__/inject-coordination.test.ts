/**
 * Tests for inject-coordination.ts (Stage 8) — Part 1
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

import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mocks before module imports

vi.mock("@domains/messages/messages.ts", () => ({
  buildMessageInstructions: vi.fn().mockReturnValue("## Wave Coordination\n\nInstructions here"),
}));

vi.mock("../model/tool-profiles.ts", () => ({
  AGENT_TOOL_PROFILES: {
    implementor: {
      allowed: ["Read", "Edit", "Write"],
      disallowed: [],
    },
    researcher: {
      allowed: ["Read", "Grep", "Glob"],
      disallowed: ["Edit", "Write"],
    },
  },
  EMPTY_PROFILE: {
    allowed: [],
    disallowed: ["Edit", "Write", "Bash", "NotebookEdit"],
  },
  resolveToolProfile: vi.fn().mockReturnValue({
    disallowed_tools: ["Edit", "Write"],
    permission_mode: "prompt",
    tools: ["Read", "Grep"],
  }),
}));

// Mock node:fs to control whether KG DB "exists"
vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false), // default: no KG DB → skip trust computation
}));

// Mock KG and related dependencies (no-ops by default; individual tests override as needed)
vi.mock("@graph/kg-schema.ts", () => ({
  initDatabase: vi.fn(),
}));

vi.mock("@graph/kg-query-insights.ts", () => ({
  computeFileInsightMaps: vi.fn().mockReturnValue({
    cycleMemberPaths: new Map(),
    hubPaths: new Set(),
    layerViolationsByPath: new Map(),
  }),
}));

vi.mock("@graph/kg-query.ts", () => ({
  KgQuery: vi.fn(),
}));

vi.mock("@domains/workspaces/execution-store.ts", () => ({
  getExecutionStore: vi.fn().mockReturnValue({
    getBoard: vi.fn().mockReturnValue(null),
  }),
}));

vi.mock("@features/orchestration/services/scope-resolver.ts", () => ({
  resolveTaskScope: vi.fn().mockReturnValue([]),
}));

vi.mock("../services/trust-resolver.ts", () => ({
  buildScopeMetrics: vi.fn().mockReturnValue({
    hasCycleFile: false,
    hasHighDegreeFile: false,
    hasHubFile: false,
  }),
  computeTrustLevel: vi.fn().mockReturnValue({ level: "HIGH", reason: "All scope files low-risk" }),
  trustLevelToPermissionMode: vi.fn().mockReturnValue("auto"),
}));

vi.mock("@shared/constants.ts", () => ({
  CANON_DIR: ".canon",
  CANON_FILES: { KNOWLEDGE_DB: "knowledge-graph.db" },
}));

import type { ResolvedFlow, StateDefinition } from "@domains/flows/flow-definition-schemas.ts";
import { buildMessageInstructions } from "@domains/messages/messages.ts";
import type { PromptContext, SpawnPromptEntry } from "../model/types.ts";
import { injectCoordination } from "../services/inject-coordination.ts";

function makeEntry(overrides: Partial<SpawnPromptEntry> = {}): SpawnPromptEntry {
  return {
    agent: "implementor",
    prompt: "Do the work",
    template_paths: [],
    ...overrides,
  };
}

function makeCtx(
  overrides: Partial<PromptContext> & {
    workspace?: string;
    state_id?: string;
    flow?: ResolvedFlow;
    variables?: Record<string, string>;
    role?: string;
    wave?: number;
    peer_count?: number;
  } = {},
): PromptContext {
  const { workspace, state_id, flow, variables, role, wave, peer_count, ...rest } = overrides;
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
      variables: variables ?? {},
      workspace: workspace ?? "/tmp/test-workspace",
      ...("role" in overrides ? { role } : {}),
      ...("wave" in overrides ? { wave } : {}),
      ...("peer_count" in overrides ? { peer_count } : {}),
    },
    mergedVariables: {},
    prompts: [makeEntry()],
    rawInstruction: "Do the thing",
    state: { agent: "implementor", type: "single" } as StateDefinition,
    warnings: [],
    ...rest,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(buildMessageInstructions).mockReturnValue("## Wave Coordination\n\nInstructions here");
});

// Role substitution

describe("injectCoordination — role substitution", () => {
  it("substitutes role variable in prompt for single state when ctx.role is set", async () => {
    const ctx = makeCtx({
      prompts: [makeEntry({ prompt: "Implement the ${role} layer" })],
      role: "frontend",
      state: { agent: "implementor", type: "single" } as StateDefinition,
    });

    const result = await injectCoordination(ctx);

    expect(result.prompts[0].prompt).toContain("frontend");
    expect(result.prompts[0].role).toBe("frontend");
  });

  it("applies role substitution to all prompts (for cluster-fanned single state)", async () => {
    const ctx = makeCtx({
      prompts: [
        makeEntry({ prompt: "Review cluster 1 as ${role}" }),
        makeEntry({ prompt: "Review cluster 2 as ${role}" }),
      ],
      role: "tech-lead",
      state: { agent: "reviewer", type: "single" } as StateDefinition,
    });

    const result = await injectCoordination(ctx);

    expect(result.prompts[0].prompt).toContain("tech-lead");
    expect(result.prompts[1].prompt).toContain("tech-lead");
    expect(result.prompts[0].role).toBe("tech-lead");
    expect(result.prompts[1].role).toBe("tech-lead");
  });

  it("does NOT apply role substitution when state type is not single", async () => {
    const ctx = makeCtx({
      prompts: [makeEntry({ prompt: "Implement the ${role} layer" })],
      role: "frontend",
      state: { agent: "implementor", type: "wave" } as StateDefinition,
    });

    const result = await injectCoordination(ctx);

    // role substitution only applies to single states — ${role} should remain unsubstituted
    expect(result.prompts[0].prompt).toContain("Implement the ${role} layer");
    expect(result.prompts[0].role).toBeUndefined();
  });

  it("does NOT apply role substitution when ctx.role is not set", async () => {
    const ctx = makeCtx({
      prompts: [makeEntry({ prompt: "Implement the ${role} layer" })],
      role: undefined,
      state: { agent: "implementor", type: "single" } as StateDefinition,
    });

    const result = await injectCoordination(ctx);

    // No role provided — ${role} pattern should remain unsubstituted
    expect(result.prompts[0].prompt).toContain("Implement the ${role} layer");
  });
});

// Messaging instructions were removed from inject-coordination (Stage 8).
// Wave coordination messaging now handled by debate.ts and get_messages(include_events: true).

// Metrics footer

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
      prompts: [makeEntry()],
      workspace: "/Users/michelle/projects/my-workspace",
    });

    const result = await injectCoordination(ctx);

    expect(result.prompts[0].prompt).toContain("/Users/michelle/projects/my-workspace");
  });

  it("metrics footer contains correct state_id value", async () => {
    const ctx = makeCtx({
      prompts: [makeEntry()],
      state_id: "review-code",
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
