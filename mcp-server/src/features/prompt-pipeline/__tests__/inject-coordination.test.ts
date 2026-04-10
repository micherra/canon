/**
 * Tests for inject-coordination.ts (Stage 8)
 *
 * Covers:
 * - Role substitution for single states with ctx.role set
 * - Role substitution NOT applied for non-single states
 * - Messaging instructions NOT appended for wave states (removed — debate flows use buildDebatePrompt)
 * - Messaging instructions NOT appended for parallel-per states
 * - Messaging instructions NOT appended when wave is null/undefined
 * - Metrics footer appended to every prompt entry
 * - Metrics footer contains correct workspace and state_id values
 * - Metrics footer appended even when prompts have different content
 * - Tool scope set on all prompt entries (ADR-014)
 * - Trust-derived permission_mode from KG when available
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mocks before module imports

vi.mock("@domains/messages/messages.ts", () => ({
  buildMessageInstructions: vi.fn().mockReturnValue("## Wave Coordination\n\nInstructions here"),
}));

vi.mock("../model/tool-profiles.ts", () => ({
  AGENT_TOOL_PROFILES: {
    "canon-implementor": {
      allowed: ["Read", "Edit", "Write"],
      disallowed: [],
    },
    "canon-researcher": {
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

vi.mock("@graph/kg-query.ts", () => ({
  computeFileInsightMaps: vi.fn().mockReturnValue({
    cycleMemberPaths: new Map(),
    hubPaths: new Set(),
    layerViolationsByPath: new Map(),
  }),
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

import { existsSync } from "node:fs";
import type { ResolvedFlow, StateDefinition } from "@domains/flows/flow-definition-schemas.ts";
import { buildMessageInstructions } from "@domains/messages/messages.ts";
import { getExecutionStore } from "@domains/workspaces/execution-store.ts";
import { resolveTaskScope } from "@features/orchestration/services/scope-resolver.ts";
import { computeFileInsightMaps, KgQuery } from "@graph/kg-query.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import { resolveToolProfile } from "../model/tool-profiles.ts";
import type { PromptContext, SpawnPromptEntry } from "../model/types.ts";
import { injectCoordination } from "../services/inject-coordination.ts";
import { computeTrustLevel, trustLevelToPermissionMode } from "../services/trust-resolver.ts"; // import for vi.mocked() access
import { flowName } from "@domains/flows/board-state-schemas.ts";

function makeEntry(overrides: Partial<SpawnPromptEntry> = {}): SpawnPromptEntry {
  return {
    agent: "canon-implementor",
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
          name: flowName("test-flow"),
          spawn_instructions: { implement: "Do the thing" },
          states: {
            done: { type: "terminal" },
            implement: { agent: "canon-implementor", type: "single" },
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
    state: { agent: "canon-implementor", type: "single" } as StateDefinition,
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
      state: { agent: "canon-implementor", type: "single" } as StateDefinition,
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
      state: { agent: "canon-reviewer", type: "single" } as StateDefinition,
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
      state: { agent: "canon-implementor", type: "wave" } as StateDefinition,
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
      state: { agent: "canon-implementor", type: "single" } as StateDefinition,
    });

    const result = await injectCoordination(ctx);

    // No role provided — ${role} pattern should remain unsubstituted
    expect(result.prompts[0].prompt).toContain("Implement the ${role} layer");
  });
});

// Messaging instructions
// Stage 8 no longer injects wave coordination messaging — debate flows use buildDebatePrompt directly.

describe("injectCoordination — messaging instructions", () => {
  it("does NOT append messaging instructions for wave state with wave set", async () => {
    const ctx = makeCtx({
      prompts: [
        makeEntry({ prompt: "Implement task A" }),
        makeEntry({ prompt: "Implement task B" }),
      ],
      state: { agent: "canon-implementor", type: "wave" } as StateDefinition,
      wave: 2,
    });

    const result = await injectCoordination(ctx);

    expect(buildMessageInstructions).not.toHaveBeenCalled();
    expect(result.prompts[0].prompt).not.toContain("## Wave Coordination");
    expect(result.prompts[1].prompt).not.toContain("## Wave Coordination");
  });

  it("does NOT append messaging instructions for parallel-per state with wave set", async () => {
    const ctx = makeCtx({
      prompts: [makeEntry()],
      state: { agent: "canon-implementor", type: "parallel-per" } as StateDefinition,
      wave: 1,
    });

    const result = await injectCoordination(ctx);

    expect(buildMessageInstructions).not.toHaveBeenCalled();
    expect(result.prompts[0].prompt).not.toContain("## Wave Coordination");
  });

  it("does NOT append messaging instructions when wave is null/undefined", async () => {
    const ctx = makeCtx({
      prompts: [makeEntry()],
      state: { agent: "canon-implementor", type: "wave" } as StateDefinition,
      wave: undefined,
    });

    const result = await injectCoordination(ctx);

    expect(buildMessageInstructions).not.toHaveBeenCalled();
    expect(result.prompts[0].prompt).not.toContain("## Wave Coordination");
  });

  it("does NOT append messaging instructions for single state", async () => {
    const ctx = makeCtx({
      prompts: [makeEntry()],
      state: { agent: "canon-implementor", type: "single" } as StateDefinition,
      wave: 1,
    });

    const _result = await injectCoordination(ctx);

    expect(buildMessageInstructions).not.toHaveBeenCalled();
  });
});

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

// Tool scope injection (ADR-014)

describe("injectCoordination — tool scope injection", () => {
  beforeEach(() => {
    vi.mocked(resolveToolProfile).mockReturnValue({
      disallowed_tools: ["Edit", "Write"],
      permission_mode: "prompt",
      tools: ["Read", "Grep"],
    });
  });

  it("sets tools, disallowed_tools, and permission_mode on all prompt entries", async () => {
    const ctx = makeCtx({
      prompts: [makeEntry(), makeEntry({ agent: "canon-researcher" })],
    });

    const result = await injectCoordination(ctx);

    expect(result.prompts[0].tools).toEqual(["Read", "Grep"]);
    expect(result.prompts[0].disallowed_tools).toEqual(["Edit", "Write"]);
    expect(result.prompts[0].permission_mode).toBe("prompt");
    expect(result.prompts[1].tools).toEqual(["Read", "Grep"]);
    expect(result.prompts[1].disallowed_tools).toEqual(["Edit", "Write"]);
    expect(result.prompts[1].permission_mode).toBe("prompt");
  });

  it("calls resolveToolProfile for known agent type (canon-researcher)", async () => {
    vi.mocked(resolveToolProfile).mockReturnValue({
      disallowed_tools: ["Edit", "Write", "NotebookEdit"],
      permission_mode: "prompt",
      tools: ["Read", "Grep", "Glob", "Bash", "WebFetch"],
    });

    const ctx = makeCtx({
      prompts: [makeEntry({ agent: "canon-researcher" })],
    });

    await injectCoordination(ctx);

    expect(resolveToolProfile).toHaveBeenCalledWith(
      "canon-researcher",
      expect.objectContaining({ overrides: undefined }),
    );
    const result = await injectCoordination(ctx);
    expect(result.prompts[0].tools).toEqual(["Read", "Grep", "Glob", "Bash", "WebFetch"]);
  });

  it("unknown agent type gets empty profile (fail-closed)", async () => {
    vi.mocked(resolveToolProfile).mockReturnValue({
      disallowed_tools: [],
      permission_mode: "prompt",
      tools: [],
    });

    const ctx = makeCtx({
      prompts: [makeEntry({ agent: "unknown-agent-type" })],
    });

    const result = await injectCoordination(ctx);

    expect(result.prompts[0].tools).toEqual([]);
    expect(result.prompts[0].disallowed_tools).toEqual([]);
  });

  it("passes tool_overrides.allow to resolveToolProfile when state has tool_overrides", async () => {
    const ctx = makeCtx({
      prompts: [makeEntry()],
      state: {
        agent: "canon-implementor",
        tool_overrides: { allow: ["ExtraTool"] },
        type: "single",
      } as StateDefinition,
    });

    await injectCoordination(ctx);

    expect(resolveToolProfile).toHaveBeenCalledWith(
      "canon-implementor",
      expect.objectContaining({ overrides: { allow: ["ExtraTool"] } }),
    );
  });

  it("passes tool_overrides.deny to resolveToolProfile when state has deny override", async () => {
    const ctx = makeCtx({
      prompts: [makeEntry()],
      state: {
        agent: "canon-implementor",
        tool_overrides: { deny: ["Bash"] },
        type: "single",
      } as StateDefinition,
    });

    await injectCoordination(ctx);

    expect(resolveToolProfile).toHaveBeenCalledWith(
      "canon-implementor",
      expect.objectContaining({ overrides: { deny: ["Bash"] } }),
    );
  });

  it("passes tool_overrides.replace to resolveToolProfile when state has replace override", async () => {
    const ctx = makeCtx({
      prompts: [makeEntry()],
      state: {
        agent: "canon-implementor",
        tool_overrides: { replace: ["OnlyThisTool"] },
        type: "single",
      } as StateDefinition,
    });

    await injectCoordination(ctx);

    expect(resolveToolProfile).toHaveBeenCalledWith(
      "canon-implementor",
      expect.objectContaining({ overrides: { replace: ["OnlyThisTool"] } }),
    );
  });

  it("passes tool_overrides.permission_mode to resolveToolProfile", async () => {
    vi.mocked(resolveToolProfile).mockReturnValue({
      disallowed_tools: [],
      permission_mode: "deny_unknown",
      tools: ["Read"],
    });

    const ctx = makeCtx({
      prompts: [makeEntry()],
      state: {
        agent: "canon-implementor",
        tool_overrides: { permission_mode: "deny_unknown" },
        type: "single",
      } as StateDefinition,
    });

    const result = await injectCoordination(ctx);

    expect(resolveToolProfile).toHaveBeenCalledWith(
      "canon-implementor",
      expect.objectContaining({ overrides: { permission_mode: "deny_unknown" } }),
    );
    expect(result.prompts[0].permission_mode).toBe("deny_unknown");
  });

  it("passes worktree_path to resolveToolProfile — auto for entries with worktree_path", async () => {
    vi.mocked(resolveToolProfile).mockReturnValue({
      disallowed_tools: [],
      permission_mode: "auto",
      tools: ["Read", "Grep"],
    });

    const ctx = makeCtx({
      prompts: [makeEntry({ worktree_path: "/path/to/worktree" })],
    });

    await injectCoordination(ctx);

    expect(resolveToolProfile).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ worktreePath: "/path/to/worktree" }),
    );
    const result = await injectCoordination(ctx);
    expect(result.prompts[0].permission_mode).toBe("auto");
  });

  it("passes undefined worktree_path for entries without worktree — prompt mode", async () => {
    const ctx = makeCtx({
      prompts: [makeEntry({ worktree_path: undefined })],
    });

    await injectCoordination(ctx);

    expect(resolveToolProfile).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ worktreePath: undefined }),
    );
  });

  it("existing behavior preserved: role substitution still works after tool scope injection", async () => {
    const ctx = makeCtx({
      prompts: [makeEntry({ prompt: "Do ${role} work" })],
      role: "frontend",
      state: { agent: "canon-implementor", type: "single" } as StateDefinition,
    });

    const result = await injectCoordination(ctx);

    expect(result.prompts[0].prompt).toContain("frontend");
    expect(result.prompts[0].tools).toEqual(["Read", "Grep"]);
  });

  it("existing behavior preserved: messaging instructions NOT injected (removed from Stage 8), tool scope still applied", async () => {
    const ctx = makeCtx({
      prompts: [makeEntry()],
      state: { agent: "canon-implementor", type: "wave" } as StateDefinition,
      wave: 1,
    });

    const result = await injectCoordination(ctx);

    expect(result.prompts[0].prompt).not.toContain("## Wave Coordination");
    expect(result.prompts[0].tools).toEqual(["Read", "Grep"]);
  });

  it("existing behavior preserved: metrics footer still appended with tool scope", async () => {
    const ctx = makeCtx({
      prompts: [makeEntry()],
    });

    const result = await injectCoordination(ctx);

    expect(result.prompts[0].prompt).toContain("## Performance Metrics");
    expect(result.prompts[0].tools).toEqual(["Read", "Grep"]);
  });

  it("forwards tool_scope_warnings onto SpawnPromptEntry when resolveToolProfile returns warnings", async () => {
    const warnings = [
      {
        agent: "canon-researcher",
        event: "adr014_replace_override_grants_disallowed" as const,
        granted_disallowed: ["Edit"],
      },
    ];
    vi.mocked(resolveToolProfile).mockReturnValue({
      disallowed_tools: [],
      permission_mode: "prompt",
      tools: ["Read", "Edit"],
      warnings,
    });

    const ctx = makeCtx({
      prompts: [makeEntry({ agent: "canon-researcher" })],
    });

    const result = await injectCoordination(ctx);

    expect(result.prompts[0].tool_scope_warnings).toEqual(warnings);
  });

  it("does NOT set tool_scope_warnings when resolveToolProfile returns no warnings", async () => {
    // default mock returns no warnings
    vi.mocked(resolveToolProfile).mockReturnValue({
      disallowed_tools: ["Edit", "Write"],
      permission_mode: "prompt",
      tools: ["Read", "Grep"],
    });

    const ctx = makeCtx({
      prompts: [makeEntry()],
    });

    const result = await injectCoordination(ctx);

    expect(result.prompts[0].tool_scope_warnings).toBeUndefined();
  });
});

// Trust integration tests

describe("injectCoordination — trust integration", () => {
  beforeEach(() => {
    // Reset all mocks to safe defaults for trust tests
    vi.mocked(existsSync).mockReturnValue(false); // default: no KG DB
    vi.mocked(resolveToolProfile).mockReturnValue({
      disallowed_tools: ["Edit", "Write"],
      permission_mode: "prompt",
      tools: ["Read", "Grep"],
    });
    vi.mocked(initDatabase).mockReset();
    vi.mocked(KgQuery).mockReset();
    vi.mocked(computeFileInsightMaps).mockReturnValue({
      cycleMemberPaths: new Map(),
      hubPaths: new Set(),
      layerViolationsByPath: new Map(),
    });
    vi.mocked(computeTrustLevel).mockReturnValue({
      level: "HIGH",
      reason: "All scope files low-risk",
    });
    vi.mocked(trustLevelToPermissionMode).mockReturnValue("auto");
    vi.mocked(resolveTaskScope).mockReturnValue([]);
    vi.mocked(getExecutionStore).mockReturnValue({
      getBoard: vi.fn().mockReturnValue(null),
    } as unknown as ReturnType<typeof getExecutionStore>);
  });

  it("trust-derived permission_mode is passed to resolveToolProfile when KG is available", async () => {
    // Simulate KG DB exists
    vi.mocked(existsSync).mockReturnValue(true);

    // Set up KG mocks for a successful trust computation
    const mockDb = { close: vi.fn() };
    vi.mocked(initDatabase).mockReturnValue(mockDb as unknown as ReturnType<typeof initDatabase>);
    const mockKgQuery = {
      getFileMetrics: vi.fn().mockReturnValue(null),
      getKgFreshnessMs: vi.fn().mockReturnValue(60_000), // 1 min — fresh
    };
    vi.mocked(KgQuery).mockImplementation(function () {
      return mockKgQuery as unknown as KgQuery;
    });
    vi.mocked(computeFileInsightMaps).mockReturnValue({
      cycleMemberPaths: new Map(),
      hubPaths: new Set(),
      layerViolationsByPath: new Map(),
    });
    vi.mocked(computeTrustLevel).mockReturnValue({
      level: "HIGH",
      reason: "All scope files low-risk",
    });
    vi.mocked(trustLevelToPermissionMode).mockReturnValue("auto");

    const ctx = makeCtx({
      board: {
        base_commit: "abc",
        blocked: null,
        concerns: [],
        current_state: "implement",
        entry: "implement",
        flow: flowName("test-flow"),
        iterations: {},
        last_updated: "2026-01-01",
        skipped: [],
        started: "2026-01-01",
        states: { implement: { entries: 1, status: "in_progress" } },
        task: "test",
      },
      prompts: [makeEntry({ agent: "canon-implementor" })],
    });

    await injectCoordination(ctx);

    expect(resolveToolProfile).toHaveBeenCalledWith(
      "canon-implementor",
      expect.objectContaining({ trustPermissionMode: "auto" }),
    );
  });

  it("graceful degradation: KG DB does not exist → worktreePath fallback", async () => {
    vi.mocked(existsSync).mockReturnValue(false); // No KG DB

    const ctx = makeCtx({
      prompts: [makeEntry()],
    });

    await injectCoordination(ctx);

    // initDatabase should NOT be called
    expect(initDatabase).not.toHaveBeenCalled();
    // resolveToolProfile called without trustPermissionMode (empty map → undefined)
    expect(resolveToolProfile).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ trustPermissionMode: undefined }),
    );
  });

  it("graceful degradation: KG query throws → falls back to static behavior", async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    // Mock initDatabase to return a DB that causes KgQuery construction to throw
    const mockDb = { close: vi.fn() };
    vi.mocked(initDatabase).mockReturnValue(mockDb as unknown as ReturnType<typeof initDatabase>);
    vi.mocked(KgQuery).mockImplementation(function () {
      throw new Error("KG query failed");
    });

    const ctx = makeCtx({
      prompts: [makeEntry()],
    });

    // Should not throw
    await expect(injectCoordination(ctx)).resolves.toBeDefined();

    // resolveToolProfile should be called with undefined trustPermissionMode (empty map after error)
    expect(resolveToolProfile).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ trustPermissionMode: undefined }),
    );
  });

  it("board undefined: lazily loads board from execution store", async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const mockDb = { close: vi.fn() };
    vi.mocked(initDatabase).mockReturnValue(mockDb as unknown as ReturnType<typeof initDatabase>);
    const mockKgQuery = {
      getFileMetrics: vi.fn().mockReturnValue(null),
      getKgFreshnessMs: vi.fn().mockReturnValue(60_000),
    };
    vi.mocked(KgQuery).mockImplementation(() => mockKgQuery as unknown as KgQuery);
    vi.mocked(computeFileInsightMaps).mockReturnValue({
      cycleMemberPaths: new Map(),
      hubPaths: new Set(),
      layerViolationsByPath: new Map(),
    });

    const mockBoard = {
      base_commit: "abc",
      blocked: null,
      concerns: [],
      current_state: "implement",
      entry: "implement",
      flow: flowName("test-flow"),
      iterations: {},
      last_updated: "2026-01-01",
      skipped: [],
      started: "2026-01-01",
      states: {},
      task: "test",
    };
    vi.mocked(getExecutionStore).mockReturnValue({
      getBoard: vi.fn().mockReturnValue(mockBoard),
    } as unknown as ReturnType<typeof getExecutionStore>);

    // ctx.board is undefined — should trigger lazy load
    const ctx = makeCtx({ prompts: [makeEntry()] });
    // board is not set in ctx (makeCtx doesn't set it)
    expect(ctx.board).toBeUndefined();

    await injectCoordination(ctx);

    // getExecutionStore should have been called for lazy load
    expect(getExecutionStore).toHaveBeenCalledWith("/tmp/test-workspace");
  });

  it("board undefined AND lazy load fails → empty scope → LOW → prompt (fail-closed)", async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const mockDb = { close: vi.fn() };
    vi.mocked(initDatabase).mockReturnValue(mockDb as unknown as ReturnType<typeof initDatabase>);
    const mockKgQuery = {
      getFileMetrics: vi.fn().mockReturnValue(null),
      getKgFreshnessMs: vi.fn().mockReturnValue(60_000),
    };
    vi.mocked(KgQuery).mockImplementation(() => mockKgQuery as unknown as KgQuery);
    vi.mocked(computeFileInsightMaps).mockReturnValue({
      cycleMemberPaths: new Map(),
      hubPaths: new Set(),
      layerViolationsByPath: new Map(),
    });

    // getExecutionStore throws → lazy load fails
    vi.mocked(getExecutionStore).mockImplementation(() => {
      throw new Error("store unavailable");
    });

    vi.mocked(computeTrustLevel).mockReturnValue({ level: "LOW", reason: "Empty task scope" });
    vi.mocked(trustLevelToPermissionMode).mockReturnValue("prompt");

    const ctx = makeCtx({ prompts: [makeEntry()] });

    // Should not throw — fail-closed
    await expect(injectCoordination(ctx)).resolves.toBeDefined();

    // resolveToolProfile is still called — with undefined trust (exception path clears map)
    expect(resolveToolProfile).toHaveBeenCalled();
  });

  it("backward compat: no KG means resolveToolProfile receives undefined trustPermissionMode", async () => {
    vi.mocked(existsSync).mockReturnValue(false); // No KG

    const ctx = makeCtx({
      prompts: [makeEntry()],
    });

    await injectCoordination(ctx);

    expect(resolveToolProfile).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ trustPermissionMode: undefined }),
    );
  });
});
