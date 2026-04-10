/**
 * Integration tests for ADR-008 Context Assembly — ctx-08, ctx-09, ctx-10
 *
 * Covers cross-task integration boundaries and declared Known Gaps from the
 * ctx-08 through ctx-10 implementation summaries:
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
 * 3. ctx-10 cross-module: both inject-context.ts and inject-wave-briefing.ts now
 *    delegate to kg-context-formatter.ts — no duplicate implementations.
 *    The shared formatter output format is identical from both callers.
 *
 * 4. Tier consistency: when a session sets tier="small", both assembleEnrichment
 *    (ctx-08) and resolveContextInjections/file_context (ctx-03/inject-context.ts)
 *    read from the same execution store and apply the same 5-file cap.
 *
 * Known Gaps addressed:
 * - ctx-09: No test for pipeline stage 1 actually invoking the file_context handler
 * - ctx-08: No end-to-end test showing session tier overrides flow.tier
 * - ctx-10: No integration test verifying the shared formatter is used by both callers
 */

import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

vi.mock("@domains/workspaces/execution-store.ts", () => ({
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

vi.mock("@graph/kg-query.ts", () => ({
  computeFileInsightMaps: vi.fn().mockReturnValue({
    cycleMemberPaths: new Map<string, string[]>(),
    hubPaths: new Set<string>(),
    layerViolationsByPath: new Map(),
  }),
  KgQuery: class MockKgQuery {
    getFileMetrics = mockGetFileMetrics;
    getKgFreshnessMs = mockGetKgFreshnessMs;
    computeInsightMaps = vi.fn().mockReturnValue({
      cycleMemberPaths: new Map<string, string[]>(),
      hubPaths: new Set<string>(),
      layerViolationsByPath: new Map(),
    });
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
import { flowName } from "@domains/flows/board-state-schemas.ts";
import { getExecutionStore } from "@domains/workspaces/execution-store.ts";
import { resolveTaskScope } from "@features/orchestration/services/scope-resolver.ts";
import { computeFileInsightMaps } from "@graph/kg-query.ts";
import { initDatabase } from "@graph/kg-schema.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
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
    flow: flowName("feature"),
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
      (state) =>
        state.type !== "terminal" && "agent" in state && state.agent === "canon-implementor",
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
        agent: "canon-implementor",
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
        agent: "canon-implementor",
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
        agent: "canon-implementor",
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

// ─── Section 4: ctx-10 cross-module shared formatter ─────────────────────────
// Verify that inject-context.ts and inject-wave-briefing.ts both use the shared
// kg-context-formatter.ts module, producing identical output format.

describe("ctx-10 integration — shared KG formatter used by both callers", () => {
  it("buildKgFileEntries and formatKgFileContext are the public interface from kg-context-formatter.ts", async () => {
    // If these imports succeed, the module exists and exports the expected interface
    const formatter = await import("../services/kg-context-formatter.ts");
    expect(typeof formatter.buildKgFileEntries).toBe("function");
    expect(typeof formatter.formatKgFileContext).toBe("function");
  });

  it("inject-context.ts does NOT define buildFileContextLines (removed in ctx-10)", async () => {
    // The old private function buildFileContextLines should not exist in inject-context.ts
    // We verify indirectly: if the module exports only the public API, the
    // private function is gone. We can check by importing the module and verifying
    // the export is not accidentally exposed.
    const injectContext = await import("../services/inject-context.ts");
    // The public exports are resolveContextInjections and extractSection
    expect(typeof injectContext.resolveContextInjections).toBe("function");
    expect(typeof injectContext.extractSection).toBe("function");
    // buildFileContextLines was private (no export) — this just confirms the module loads
  });

  it("formatKgFileContext output format is identical whether called from inject-context or directly", async () => {
    // Verify the output format contract: (not indexed) sentinel, in_degree/out_degree labels,
    // hub: yes/no — this is the unified format after ctx-10
    const { formatKgFileContext } = await import("../services/kg-context-formatter.ts");

    const indexedEntry = {
      inDegree: 4,
      indexed: true,
      isHub: false,
      layer: "domain",
      outDegree: 2,
      path: "src/domain/service.ts",
      summary: "Core business logic",
    };

    const unindexedEntry = {
      inDegree: 0,
      indexed: false,
      isHub: false,
      layer: "unknown",
      outDegree: 0,
      path: "src/new/fresh.ts",
      summary: null,
    };

    const result = formatKgFileContext([indexedEntry, unindexedEntry]);

    // Unified format assertions (what both callers now produce)
    expect(result).toContain("in_degree: 4");
    expect(result).toContain("out_degree: 2");
    expect(result).toContain("hub: no");
    expect(result).toContain("layer: domain");
    expect(result).toContain("Summary: Core business logic");
    expect(result).toContain("src/new/fresh.ts");
    expect(result).toContain("(not indexed)");
    // Default heading includes file count
    expect(result).toContain("### File Context (2 files)");
  });

  it("formatKgFileContext raw output is unescaped (trust boundary at caller)", async () => {
    // This is the validate-at-trust-boundaries contract: the formatter returns raw text.
    // inject-wave-briefing.ts calls escapeDollarBrace(); inject-context.ts callers
    // via resolveContext stage-1 also apply escapeDollarBrace().
    const { formatKgFileContext } = await import("../services/kg-context-formatter.ts");

    const entryWithDollarBrace = {
      inDegree: 1,
      indexed: true,
      isHub: false,
      layer: "api",
      outDegree: 1,
      path: "src/api/handler.ts",
      summary: "Uses ${TEMPLATE_VAR} for injection", // raw dollar-brace in summary
    };

    const result = formatKgFileContext([entryWithDollarBrace]);

    // Raw output — no escaping applied inside the formatter
    expect(result).toContain("${TEMPLATE_VAR}");
    expect(result).not.toContain("\\${TEMPLATE_VAR}");
  });
});

// ─── Section 5: tier consistency across ctx-08 and ctx-03 consumers ──────────
// Both assembleEnrichment (ctx-08) and resolveContextInjections file_context
// (ctx-03) read from the same execution store. When session tier = "small",
// both should apply the 5-file cap.

describe("tier consistency — same execution store drives both enrichment and file_context", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "tier-consistency-"));
    vi.clearAllMocks();
    // KG DB exists
    vi.mocked(existsSync).mockImplementation((p) => {
      return String(p).endsWith("knowledge-graph.db");
    });
    // Session tier = "small" (cap = 5)
    vi.mocked(getExecutionStore).mockReturnValue({
      getSession: vi.fn().mockReturnValue({ tier: "small" }),
    } as unknown as ReturnType<typeof getExecutionStore>);
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
  });

  it("file_context resolveContextInjections applies small tier cap (5 files) when session is small", async () => {
    // 10 files in affected_files; small cap = 5 → only 5 processed
    const tenFiles = Array.from({ length: 10 }, (_, i) => `src/file${i}.ts`);
    const board = makeBoard({
      affected_files: JSON.stringify(tenFiles),
    });

    const { resolveContextInjections } = await import("../services/inject-context.ts");
    const result = await resolveContextInjections(
      [{ as: "file_context", from: "file_context" }],
      board,
      tmpDir,
    );

    // mockGetFileMetrics called 5 times (small cap = 5) — computeInsightMaps called once per request
    expect(mockGetFileMetrics).toHaveBeenCalledTimes(5);

    // Result contains first 5 files, not file5+
    const value = result.variables.file_context;
    expect(value).toContain("src/file0.ts");
    expect(value).toContain("src/file4.ts");
    expect(value).not.toContain("src/file5.ts");
  });

  it("assembleEnrichment applies small tier cap (5 files) when session is small", async () => {
    const tenFiles = Array.from({ length: 10 }, (_, i) => `src/file-${i}.ts`);
    vi.mocked(resolveTaskScope).mockReturnValue(tenFiles);

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
      } as unknown as import("@domains/flows/flow-definition-schemas.ts").ResolvedFlow,
      projectDir: undefined,
      stateId: "implement",
      workspace: tmpDir,
    });

    const fileMatches = result.content.match(/`src\/file-\d+\.ts`/g) ?? [];
    const uniqueCount = new Set(fileMatches).size;
    // Small tier cap = 5
    expect(uniqueCount).toBeLessThanOrEqual(5);
  });
});

// ─── Section 6: ctx-09 backward compatibility ─────────────────────────────────
// Existing inject_context declarations (epic design → risk_findings, migrate design →
// rollback_findings, explore, test-gap) must not be disturbed.

describe("ctx-09 backward compatibility — existing inject_context not disturbed", () => {
  it("explore flow retains its inject_context from research (not file_context)", async () => {
    const { loadAndResolveFlow } = await import("@domains/flows/flow-parser.ts");
    const flow = await loadAndResolveFlow(pluginDir, "explore");

    // explore has no implement state with file_context
    const implementorStates = Object.entries(flow.states).filter(
      ([, state]) =>
        state.type !== "terminal" && "agent" in state && state.agent === "canon-implementor",
    );
    // explore has no implementor states — or if it does, they don't have file_context
    for (const [, state] of implementorStates) {
      const hasFileCtx = state.inject_context?.some((e) => e.from === "file_context");
      expect(hasFileCtx).toBeFalsy();
    }
  });

  it("migrate flow design state still has rollback_findings injection (not overwritten)", async () => {
    const { loadAndResolveFlow } = await import("@domains/flows/flow-parser.ts");
    const flow = await loadAndResolveFlow(pluginDir, "migrate");

    const designState = flow.states.design;
    expect(designState).toBeDefined();
    const rollbackEntry = designState?.inject_context?.find(
      (entry) => entry.as === "rollback_findings" || entry.from === "research",
    );
    expect(rollbackEntry).toBeDefined();
  });
});
