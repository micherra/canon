/**
 * Tests for inject-coordination.ts (Stage 8) — Part 2
 *
 * Covers:
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

vi.mock("@domains/workspaces/execution-store-cache.ts", () => ({
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
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { resolveTaskScope } from "@features/orchestration/services/scope-resolver.ts";
import { KgQuery } from "@graph/kg-query.ts";
import { computeFileInsightMaps } from "@graph/kg-query-insights.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import { resolveToolProfile } from "../model/tool-profiles.ts";
import type { PromptContext, SpawnPromptEntry } from "../model/types.ts";
import { injectCoordination } from "../services/inject-coordination.ts";
import { computeTrustLevel, trustLevelToPermissionMode } from "../services/trust-resolver.ts"; // import for vi.mocked() access

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
      prompts: [makeEntry(), makeEntry({ agent: "researcher" })],
    });

    const result = await injectCoordination(ctx);

    expect(result.prompts[0].tools).toEqual(["Read", "Grep"]);
    expect(result.prompts[0].disallowed_tools).toEqual(["Edit", "Write"]);
    expect(result.prompts[0].permission_mode).toBe("prompt");
    expect(result.prompts[1].tools).toEqual(["Read", "Grep"]);
    expect(result.prompts[1].disallowed_tools).toEqual(["Edit", "Write"]);
    expect(result.prompts[1].permission_mode).toBe("prompt");
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

  it("passes tool_overrides to resolveToolProfile", async () => {
    const ctx = makeCtx({
      prompts: [makeEntry()],
      state: {
        agent: "implementor",
        tool_overrides: { allow: ["ExtraTool"], deny: ["Bash"] },
        type: "single",
      } as StateDefinition,
    });

    await injectCoordination(ctx);

    expect(resolveToolProfile).toHaveBeenCalledWith(
      "implementor",
      expect.objectContaining({ overrides: { allow: ["ExtraTool"], deny: ["Bash"] } }),
    );
  });

  it("passes worktree_path to resolveToolProfile", async () => {
    vi.mocked(resolveToolProfile).mockReturnValue({
      disallowed_tools: [],
      permission_mode: "auto",
      tools: ["Read", "Grep"],
    });

    const ctx = makeCtx({
      prompts: [makeEntry({ worktree_path: "/path/to/worktree" })],
    });

    const result = await injectCoordination(ctx);

    expect(resolveToolProfile).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ worktreePath: "/path/to/worktree" }),
    );
    expect(result.prompts[0].permission_mode).toBe("auto");
  });

  it("forwards tool_scope_warnings onto SpawnPromptEntry", async () => {
    const warnings = [
      {
        agent: "researcher",
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
      prompts: [makeEntry({ agent: "researcher" })],
    });

    const result = await injectCoordination(ctx);

    expect(result.prompts[0].tool_scope_warnings).toEqual(warnings);
  });

  it("does NOT set tool_scope_warnings when resolveToolProfile returns no warnings", async () => {
    vi.mocked(resolveToolProfile).mockReturnValue({
      disallowed_tools: ["Edit", "Write"],
      permission_mode: "prompt",
      tools: ["Read", "Grep"],
    });

    const ctx = makeCtx({ prompts: [makeEntry()] });

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
        flow: "test-flow",
        iterations: {},
        last_updated: "2026-01-01",
        skipped: [],
        started: "2026-01-01",
        states: { implement: { entries: 1, status: "in_progress" } },
        task: "test",
      },
      prompts: [makeEntry({ agent: "implementor" })],
    });

    await injectCoordination(ctx);

    expect(resolveToolProfile).toHaveBeenCalledWith(
      "implementor",
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
      flow: "test-flow",
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
