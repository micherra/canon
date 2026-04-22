/**
 * Integration tests for ADR-008 Context Assembly — ctx-08 and ctx-09
 * Part 1 of 2: ctx-08 (enrichment tier fix) and ctx-09 (pipeline integration).
 *
 * Covers cross-task integration boundaries and declared Known Gaps from the
 * ctx-08 through ctx-09 implementation summaries:
 *
 * 1. ctx-08 end-to-end: assembleEnrichment reads tier from execution store session,
 *    not flow.tier — the fix is observable at the boundary (large tier caps at 30,
 *    not 15) and does not regress when execution store is unavailable.
 *
 * 2. ctx-09 pipeline integration: the feature/fast-path/refactor/epic/migrate flows
 *    declare inject_context: [{from: file_context}] on their implement states.
 *    pipeline stage 1 (resolveContext) invokes resolveContextInjections and merges
 *    the resolved variable into ctx.mergedVariables.
 *
 * Known Gaps addressed:
 * - ctx-09: No test for pipeline stage 1 actually invoking the file_context handler
 * - ctx-08: No end-to-end test showing session tier overrides flow.tier
 */

import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Shared mock declarations (vi.hoisted) ───────────────────────────────────

const {
  mockExecutionStore,
  mockGetFileMetrics,
  mockGetKgFreshnessMs,
  mockGetFile,
  mockGetSummaryByFile,
  mockDb,
} = vi.hoisted(() => {
  const mockExecutionStore = { getSession: vi.fn().mockReturnValue({ tier: "medium" }) };
  const mockGetFileMetrics = vi.fn().mockReturnValue(null);
  const mockGetKgFreshnessMs = vi.fn().mockReturnValue(500);
  const mockGetFile = vi.fn().mockReturnValue(undefined);
  const mockGetSummaryByFile = vi.fn().mockReturnValue(undefined);
  const mockDb = { close: vi.fn() };
  return {
    mockDb,
    mockExecutionStore,
    mockGetFile,
    mockGetFileMetrics,
    mockGetKgFreshnessMs,
    mockGetSummaryByFile,
  };
});

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("@domains/workspaces/execution-store-cache.ts", () => ({
  getExecutionStore: vi.fn(() => mockExecutionStore),
}));

vi.mock("@platform/adapters/git-adapter.ts", () => ({
  gitLog: vi.fn().mockReturnValue({
    duration_ms: 10,
    exitCode: 0,
    ok: true,
    stderr: "",
    stdout: "abc1234 Add feature",
    timedOut: false,
  }),
}));

vi.mock("@platform/storage/drift/store.ts", () => ({
  DriftStore: vi.fn(function () {
    return { getReviewsForFiles: vi.fn().mockResolvedValue([]) };
  }),
}));

vi.mock("@features/orchestration/services/scope-resolver.ts", () => ({
  resolveTaskScope: vi.fn().mockReturnValue([]),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

vi.mock("@graph/kg-schema.ts", () => ({
  initDatabase: vi.fn(() => mockDb),
}));

vi.mock("@graph/kg-query-insights.ts", () => ({
  computeFileInsightMaps: vi.fn().mockReturnValue({
    cycleMemberPaths: new Map<string, string[]>(),
    hubPaths: new Set<string>(),
    layerViolationsByPath: new Map(),
  }),
}));

vi.mock("@graph/kg-query.ts", () => ({
  KgQuery: class MockKgQuery {
    getFileMetrics = mockGetFileMetrics;
    getKgFreshnessMs = mockGetKgFreshnessMs;
  },
}));

vi.mock("@graph/kg-store.ts", () => ({
  KgStore: class MockKgStore {
    getFile = mockGetFile;
    getSummaryByFile = mockGetSummaryByFile;
  },
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────────

import { existsSync } from "node:fs";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { resolveTaskScope } from "@features/orchestration/services/scope-resolver.ts";
import { computeFileInsightMaps } from "@graph/kg-query-insights.ts";
import { initDatabase } from "@graph/kg-schema.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

// pluginDir = one level above mcp-server (the canon repo root where flows/ lives)
// Matches the pattern used in context-assembly-integration.test.ts
const pluginDir = resolve(process.cwd(), "..");

function makeBoard(
  metadata?: Record<string, string | number | boolean>,
): import("@domains/flows/board-state-schemas.ts").Board {
  return {
    base_commit: "abc123",
    blocked: null,
    concerns: [],
    current_state: "implement",
    entry: "implement",
    flow: "feature",
    iterations: {},
    last_updated: new Date().toISOString(),
    ...(metadata !== undefined ? { metadata } : {}),
    skipped: [],
    started: new Date().toISOString(),
    states: {},
    task: "test task",
  };
}

// ─── Section 1: ctx-08 end-to-end tier fix ────────────────────────────────────
// The fix: assembleEnrichment now reads tier from execution store, not flow.tier.
// These integration tests verify the observable behavior change at the boundary.

describe("ctx-08 integration — enrichment tier reads from execution store, not flow object", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("large session tier processes 30 files — more than medium cap of 15", async () => {
    // Given: session tier = "large" (cap = 30)
    vi.mocked(getExecutionStore).mockReturnValue({
      getSession: vi.fn().mockReturnValue({ tier: "large" }),
    } as unknown as ReturnType<typeof getExecutionStore>);

    // Given: 35 files in scope
    const thirtyFiveFiles = Array.from({ length: 35 }, (_, i) => `src/file-${i}.ts`);
    vi.mocked(resolveTaskScope).mockReturnValue(thirtyFiveFiles);

    const { assembleEnrichment } = await import("../services/context-enrichment.ts");
    const result = await assembleEnrichment({
      board: makeBoard(),
      cwd: "/tmp/project",
      flow: {
        description: "test",
        entry: "implement",
        name: "feature",
        params: {},
        states: { implement: { type: "terminal" } },
        // Deliberately omit tier from flow object to confirm the fix:
        // the old code would read flow.tier (undefined → "medium" cap of 15)
        // the new code reads from execution store session (tier "large" → cap of 30)
      } as unknown as import("@domains/flows/flow-definition-schemas.ts").ResolvedFlow,
      projectDir: undefined,
      stateId: "implement",
      workspace: "/tmp/workspace",
    });

    // With large tier, up to 30 files processed. With medium (old behavior), only 15.
    // Count unique file references in the output.
    const fileMatches = result.content.match(/`src\/file-\d+\.ts`/g) ?? [];
    const uniqueCount = new Set(fileMatches).size;

    // Large tier: should process MORE than medium cap (15)
    expect(uniqueCount).toBeGreaterThan(15);
    // But never more than 30 (the large cap)
    expect(uniqueCount).toBeLessThanOrEqual(30);
  });

  it("small session tier processes max 5 files even with many in scope", async () => {
    vi.mocked(getExecutionStore).mockReturnValue({
      getSession: vi.fn().mockReturnValue({ tier: "small" }),
    } as unknown as ReturnType<typeof getExecutionStore>);

    const twentyFiles = Array.from({ length: 20 }, (_, i) => `src/file-${i}.ts`);
    vi.mocked(resolveTaskScope).mockReturnValue(twentyFiles);

    const { assembleEnrichment } = await import("../services/context-enrichment.ts");
    const result = await assembleEnrichment({
      board: makeBoard(),
      cwd: "/tmp/project",
      flow: {
        description: "test",
        entry: "implement",
        name: "fast-path",
        params: {},
        states: { implement: { type: "terminal" } },
        // No tier on flow object — old code would default to "medium" (15 files)
        // New code reads "small" from session (5 files)
      } as unknown as import("@domains/flows/flow-definition-schemas.ts").ResolvedFlow,
      projectDir: undefined,
      stateId: "implement",
      workspace: "/tmp/workspace",
    });

    const fileMatches = result.content.match(/`src\/file-\d+\.ts`/g) ?? [];
    const uniqueCount = new Set(fileMatches).size;

    // Small tier cap = 5; old code would have processed up to 15 (medium default)
    expect(uniqueCount).toBeLessThanOrEqual(5);
  });

  it("execution store unavailable → graceful fallback to medium tier (15 files)", async () => {
    // When execution store throws, enrichment falls back to medium cap
    vi.mocked(getExecutionStore).mockImplementation(() => {
      throw new Error("execution store not available");
    });

    const twentyFiles = Array.from({ length: 20 }, (_, i) => `src/file-${i}.ts`);
    vi.mocked(resolveTaskScope).mockReturnValue(twentyFiles);

    const { assembleEnrichment } = await import("../services/context-enrichment.ts");
    const result = await assembleEnrichment({
      board: makeBoard(),
      cwd: "/tmp/project",
      flow: {
        description: "test",
        entry: "implement",
        name: "feature",
        params: {},
        states: { implement: { type: "terminal" } },
      } as unknown as import("@domains/flows/flow-definition-schemas.ts").ResolvedFlow,
      projectDir: undefined,
      stateId: "implement",
      workspace: "/tmp/workspace",
    });

    // Medium fallback cap = 15; so at most 15 files processed
    const fileMatches = result.content.match(/`src\/file-\d+\.ts`/g) ?? [];
    const uniqueCount = new Set(fileMatches).size;
    expect(uniqueCount).toBeLessThanOrEqual(15);
  });
});

// ─── Section 2: ctx-09 pipeline integration ───────────────────────────────────
// The fix: feature/fast-path/refactor/epic/migrate flows declare inject_context.
// These tests verify that:
// a) The flows actually contain the inject_context: [{from: file_context}] declaration
// b) The pipeline stage 1 (resolveContext) invokes resolveContextInjections when
//    the state has inject_context declarations

describe("ctx-09 integration — flow YAML inject_context declarations", () => {
  it("feature flow implement state has inject_context: [{from: file_context}]", async () => {
    const { loadAndResolveFlow } = await import("@domains/flows/flow-parser.ts");
    const flow = await loadAndResolveFlow(pluginDir, "feature");

    const implementState = flow.states.implement;
    expect(implementState).toBeDefined();
    // The state must have inject_context declared
    expect(implementState.inject_context).toBeDefined();
    expect(Array.isArray(implementState.inject_context)).toBe(true);
    // Must contain a file_context entry
    const fileContextEntry = implementState.inject_context?.find(
      (entry) => entry.from === "file_context",
    );
    expect(fileContextEntry).toBeDefined();
    expect(fileContextEntry?.as).toBe("file_context");
  });

  it("fast-path flow execute/implement state has inject_context: [{from: file_context}]", async () => {
    const { loadAndResolveFlow } = await import("@domains/flows/flow-parser.ts");
    const flow = await loadAndResolveFlow(pluginDir, "fast-path");

    // fast-path has a single-agent execute or implement state
    // Find a state with the implementor agent
    const implementorState = Object.values(flow.states).find(
      (state) => state.type !== "terminal" && "agent" in state && state.agent === "implementor",
    );

    expect(implementorState).toBeDefined();
    const fileContextEntry = implementorState?.inject_context?.find(
      (entry) => entry.from === "file_context",
    );
    expect(fileContextEntry).toBeDefined();
    expect(fileContextEntry?.as).toBe("file_context");
  });

  it("refactor flow implement state has inject_context: [{from: file_context}]", async () => {
    const { loadAndResolveFlow } = await import("@domains/flows/flow-parser.ts");
    const flow = await loadAndResolveFlow(pluginDir, "refactor");

    const implementState = flow.states.implement;
    expect(implementState).toBeDefined();
    const fileContextEntry = implementState?.inject_context?.find(
      (entry) => entry.from === "file_context",
    );
    expect(fileContextEntry).toBeDefined();
    expect(fileContextEntry?.as).toBe("file_context");
  });

  it("epic flow implement state has inject_context: [{from: file_context}]", async () => {
    const { loadAndResolveFlow } = await import("@domains/flows/flow-parser.ts");
    const flow = await loadAndResolveFlow(pluginDir, "epic");

    const implementState = flow.states.implement;
    expect(implementState).toBeDefined();
    const fileContextEntry = implementState?.inject_context?.find(
      (entry) => entry.from === "file_context",
    );
    expect(fileContextEntry).toBeDefined();
    expect(fileContextEntry?.as).toBe("file_context");
  });

  it("migrate flow implement state has inject_context: [{from: file_context}]", async () => {
    const { loadAndResolveFlow } = await import("@domains/flows/flow-parser.ts");
    const flow = await loadAndResolveFlow(pluginDir, "migrate");

    const implementState = flow.states.implement;
    expect(implementState).toBeDefined();
    const fileContextEntry = implementState?.inject_context?.find(
      (entry) => entry.from === "file_context",
    );
    expect(fileContextEntry).toBeDefined();
    expect(fileContextEntry?.as).toBe("file_context");
  });

  it("epic flow design state inject_context is not disturbed (still has risk_findings)", async () => {
    const { loadAndResolveFlow } = await import("@domains/flows/flow-parser.ts");
    const flow = await loadAndResolveFlow(pluginDir, "epic");

    const designState = flow.states.design;
    expect(designState).toBeDefined();
    // Design state should still have its risk_findings injection
    const riskFindingsEntry = designState?.inject_context?.find(
      (entry) => entry.from === "research",
    );
    expect(riskFindingsEntry).toBeDefined();
  });
});

// ─── Section 3: ctx-09 pipeline stage 1 invocation ───────────────────────────
// Verify that when a state has inject_context: [{from: file_context}], the
// pipeline stage 1 (resolveContext) actually calls resolveContextInjections
// and the KG handler is triggered.

describe("ctx-09 integration — pipeline stage 1 invokes file_context handler", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ctx09-pipeline-"));
    // KG DB appears to exist
    vi.mocked(existsSync).mockImplementation((p) => {
      return String(p).endsWith("knowledge-graph.db");
    });
    mockExecutionStore.getSession.mockReturnValue({ tier: "medium" });
    vi.clearAllMocks();
    vi.mocked(existsSync).mockImplementation((p) => {
      return String(p).endsWith("knowledge-graph.db");
    });
    mockExecutionStore.getSession.mockReturnValue({ tier: "medium" });
    vi.mocked(getExecutionStore).mockReturnValue(
      mockExecutionStore as unknown as ReturnType<typeof getExecutionStore>,
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
  });

  it("resolveContext with file_context inject_context triggers resolveContextInjections and queries KG", async () => {
    // Board has affected_files metadata — what file_context handler reads
    const board = makeBoard({
      affected_files: JSON.stringify(["src/api/handler.ts", "src/domain/service.ts"]),
    });

    const { resolveContext } = await import(
      "@features/prompt-pipeline/services/resolve-context.ts"
    );

    // Build a minimal PromptContext with inject_context: [{from: file_context, as: file_context}]
    const ctx: import("@features/prompt-pipeline/model/types.ts").PromptContext = {
      basePrompt: "Execute plan ${file_context}",
      board,
      input: {
        flow: {
          description: "test",
          entry: "implement",
          name: "feature",
          params: {},
          spawn_instructions: { implement: "Execute ${file_context}" },
          states: { implement: { type: "terminal" } },
        } as unknown as import("@domains/flows/flow-definition-schemas.ts").ResolvedFlow,
        state_id: "implement",
        variables: {},
        workspace: tmpDir,
      },
      mergedVariables: {},
      prompts: [],
      rawInstruction: "",
      state: {
        agent: "implementor",
        inject_context: [{ as: "file_context", from: "file_context" }],
        transitions: {},
        type: "single",
      } as unknown as import("@domains/flows/flow-definition-schemas.ts").StateDefinition,
      warnings: [],
    };

    const result = await resolveContext(ctx);

    // Stage 1 should have populated mergedVariables.file_context
    // (initDatabase was called because KG DB exists)
    expect(vi.mocked(initDatabase)).toHaveBeenCalledTimes(1);
    // computeFileInsightMaps called (for the 2 affected_files)
    expect(vi.mocked(computeFileInsightMaps)).toHaveBeenCalledTimes(1);
    // mergedVariables now has file_context key
    expect(result.mergedVariables).toHaveProperty("file_context");
    // The value should contain the file paths
    const fileContextVal = result.mergedVariables.file_context;
    expect(fileContextVal).toContain("src/api/handler.ts");
    expect(fileContextVal).toContain("src/domain/service.ts");
  });

  it("resolveContext with no inject_context returns ctx unchanged (no KG invocation)", async () => {
    const { resolveContext } = await import(
      "@features/prompt-pipeline/services/resolve-context.ts"
    );

    const board = makeBoard({
      affected_files: JSON.stringify(["src/foo.ts"]),
    });

    const ctx: import("@features/prompt-pipeline/model/types.ts").PromptContext = {
      basePrompt: "Execute plan",
      board,
      input: {
        flow: {
          description: "test",
          entry: "implement",
          name: "feature",
          params: {},
          spawn_instructions: {},
          states: {},
        } as unknown as import("@domains/flows/flow-definition-schemas.ts").ResolvedFlow,
        state_id: "implement",
        variables: {},
        workspace: tmpDir,
      },
      mergedVariables: {},
      prompts: [],
      rawInstruction: "",
      state: {
        agent: "implementor",
        // No inject_context
        transitions: {},
        type: "single",
      } as unknown as import("@domains/flows/flow-definition-schemas.ts").StateDefinition,
      warnings: [],
    };

    const result = await resolveContext(ctx);

    // No inject_context means ctx returned unchanged, initDatabase never called
    expect(vi.mocked(initDatabase)).not.toHaveBeenCalled();
    expect(result.mergedVariables).not.toHaveProperty("file_context");
    // Same object reference (ctx unchanged optimization)
    expect(result).toBe(ctx);
  });

  it("resolveContext file_context injection degrades gracefully when affected_files missing", async () => {
    const { resolveContext } = await import(
      "@features/prompt-pipeline/services/resolve-context.ts"
    );

    // Board with no metadata (no affected_files)
    const board = makeBoard(undefined);

    const ctx: import("@features/prompt-pipeline/model/types.ts").PromptContext = {
      basePrompt: "Execute plan",
      board,
      input: {
        flow: {
          description: "test",
          entry: "implement",
          name: "feature",
          params: {},
          spawn_instructions: {},
          states: {},
        } as unknown as import("@domains/flows/flow-definition-schemas.ts").ResolvedFlow,
        state_id: "implement",
        variables: {},
        workspace: tmpDir,
      },
      mergedVariables: {},
      prompts: [],
      rawInstruction: "",
      state: {
        agent: "implementor",
        inject_context: [{ as: "file_context", from: "file_context" }],
        transitions: {},
        type: "single",
      } as unknown as import("@domains/flows/flow-definition-schemas.ts").StateDefinition,
      warnings: [],
    };

    const result = await resolveContext(ctx);

    // No crash — warnings emitted, variable not populated
    expect(result.warnings.some((w) => w.includes("affected_files"))).toBe(true);
    expect(result.mergedVariables).not.toHaveProperty("file_context");
    // no skip_reason set — it's a warning, not a blocking error
    expect(result.skip_reason).toBeUndefined();
  });
});
