/**
 * Integration tests for 008 Context Assembly
 *
 * These tests cover cross-task integration boundaries and declared known gaps
 * from the ctx-01 through ctx-07 implementation summaries:
 *
 * 1. Cross-task: getItemCountCap drives both inject-context (ctx-03) and
 *    inject-wave-briefing (ctx-04) — same caps from same utility.
 * 2. Cross-task: PIPELINE_ALLOWED_VARIABLES in validate.ts extends RUNTIME_VARIABLES
 *    from flow-parser.ts — the "enrichment" addition in ctx-05 is visible to stage 9.
 * 3. Config-validation: real flow files (epic, feature, refactor, migrate) load without
 *    ${enrichment} triggering unresolved-ref errors — ctx-05 RUNTIME_VARIABLES fix.
 * 4. Coverage gap: session === null fallback in file_context defaults to "medium" tier.
 * 5. Coverage gap: file in affected_files that has a KG row but file_id === undefined
 *    is formatted as "(not indexed)".
 * 6. Coverage gap: initDatabase failure (throws) is caught and returns a warning.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rmdir } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// 1. Cross-task: shared tier caps from context-budget.ts
// ---------------------------------------------------------------------------

describe("context-budget: shared cap values match expected tier bounds", () => {
  it("getItemCountCap values match the documented caps (5/15/30)", async () => {
    const { getItemCountCap } = await import("../orchestration/context-budget.ts");
    // These values are the contract both inject-context and inject-wave-briefing depend on
    expect(getItemCountCap("small")).toBe(5);
    expect(getItemCountCap("medium")).toBe(15);
    expect(getItemCountCap("large")).toBe(30);
  });

  it("unknown tier returns the medium cap (15) — same fallback for both consumers", async () => {
    const { getItemCountCap } = await import("../orchestration/context-budget.ts");
    // Both inject-context and inject-wave-briefing fall back to "medium" when session is null
    expect(getItemCountCap("unknown" as "small" | "medium" | "large")).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// 2. Cross-task: PIPELINE_ALLOWED_VARIABLES extends RUNTIME_VARIABLES
//    The "enrichment" entry added to RUNTIME_VARIABLES by ctx-05 must be
//    visible in the stage 9 allowlist (imported via spread in validate.ts).
// ---------------------------------------------------------------------------

describe("PIPELINE_ALLOWED_VARIABLES superset relationship", () => {
  it("contains all RUNTIME_VARIABLES entries (superset contract)", async () => {
    const { RUNTIME_VARIABLES } = await import("../orchestration/flow-parser.ts");
    const { PIPELINE_ALLOWED_VARIABLES } = await import("../tools/prompt-pipeline/validate.ts");

    for (const variable of RUNTIME_VARIABLES) {
      expect(PIPELINE_ALLOWED_VARIABLES.has(variable)).toBe(true);
    }
  });

  it("enrichment is in RUNTIME_VARIABLES (ctx-05 ancillary fix)", async () => {
    const { RUNTIME_VARIABLES } = await import("../orchestration/flow-parser.ts");
    expect(RUNTIME_VARIABLES.has("enrichment")).toBe(true);
  });

  it("enrichment is in PIPELINE_ALLOWED_VARIABLES (visible to stage 9 via spread)", async () => {
    const { PIPELINE_ALLOWED_VARIABLES } = await import("../tools/prompt-pipeline/validate.ts");
    expect(PIPELINE_ALLOWED_VARIABLES.has("enrichment")).toBe(true);
  });

  it("project_structure is NOT in PIPELINE_ALLOWED_VARIABLES (injected via cache prefix, not substitution)", async () => {
    const { PIPELINE_ALLOWED_VARIABLES } = await import("../tools/prompt-pipeline/validate.ts");
    expect(PIPELINE_ALLOWED_VARIABLES.has("project_structure")).toBe(false);
  });

  it("conventions is NOT in PIPELINE_ALLOWED_VARIABLES (injected via cache prefix, not substitution)", async () => {
    const { PIPELINE_ALLOWED_VARIABLES } = await import("../tools/prompt-pipeline/validate.ts");
    expect(PIPELINE_ALLOWED_VARIABLES.has("conventions")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Config-validation: real flow files load without ${enrichment} unresolved-ref errors
//    This is the integration test for ctx-05's RUNTIME_VARIABLES addition.
//    Without it, loadAndResolveFlow would throw for epic, feature, refactor, migrate.
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pluginDir = resolve(__dirname, "../../.."); // mcp-server root (where flows/ lives)

describe("flow files load successfully with ${enrichment} in spawn instructions", () => {
  it("epic flow loads without throwing (enrichment in implement spawn)", async () => {
    const { loadAndResolveFlow } = await import("../orchestration/flow-parser.ts");
    await expect(loadAndResolveFlow(pluginDir, "epic")).resolves.not.toThrow();
  });

  it("feature flow loads without throwing (enrichment in implement spawn)", async () => {
    const { loadAndResolveFlow } = await import("../orchestration/flow-parser.ts");
    await expect(loadAndResolveFlow(pluginDir, "feature")).resolves.not.toThrow();
  });

  it("refactor flow loads without throwing (enrichment in implement spawn)", async () => {
    const { loadAndResolveFlow } = await import("../orchestration/flow-parser.ts");
    await expect(loadAndResolveFlow(pluginDir, "refactor")).resolves.not.toThrow();
  });

  it("migrate flow loads without throwing (enrichment in implement spawn)", async () => {
    const { loadAndResolveFlow } = await import("../orchestration/flow-parser.ts");
    await expect(loadAndResolveFlow(pluginDir, "migrate")).resolves.not.toThrow();
  });

  it("review-only flow loads without throwing (enrichment in review spawn)", async () => {
    const { loadAndResolveFlow } = await import("../orchestration/flow-parser.ts");
    await expect(loadAndResolveFlow(pluginDir, "review-only")).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. Coverage gap: session === null fallback → "medium" tier in file_context
//    ctx-03 declared: "No test for the exact behavior when session is null"
// ---------------------------------------------------------------------------

const {
  mockGetFileMetrics2,
  mockGetKgFreshnessMs2,
  mockGetFile2,
  mockGetSummaryByFile2,
  mockStore2,
  mockDb2,
} = vi.hoisted(() => {
  const mockGetFileMetrics2 = vi.fn().mockReturnValue(null);
  const mockGetKgFreshnessMs2 = vi.fn().mockReturnValue(500);
  const mockGetFile2 = vi.fn().mockReturnValue(undefined);
  const mockGetSummaryByFile2 = vi.fn().mockReturnValue(undefined);
  const mockStore2 = { getSession: vi.fn() };
  const mockDb2 = { close: vi.fn() };
  return {
    mockGetFileMetrics2,
    mockGetKgFreshnessMs2,
    mockGetFile2,
    mockGetSummaryByFile2,
    mockStore2,
    mockDb2,
  };
});

vi.mock("../orchestration/execution-store.ts", () => ({
  getExecutionStore: vi.fn(() => mockStore2),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
  };
});

vi.mock("../graph/kg-schema.ts", () => ({
  initDatabase: vi.fn(() => mockDb2),
}));

vi.mock("../graph/kg-query.ts", () => ({
  KgQuery: class MockKgQuery2 {
    getFileMetrics = mockGetFileMetrics2;
    getKgFreshnessMs = mockGetKgFreshnessMs2;
  },
  computeFileInsightMaps: vi.fn().mockReturnValue({
    hubPaths: new Set<string>(),
    cycleMemberPaths: new Map<string, string[]>(),
    layerViolationsByPath: new Map<string, unknown[]>(),
  }),
}));

vi.mock("../graph/kg-store.ts", () => ({
  KgStore: class MockKgStore2 {
    getFile = mockGetFile2;
    getSummaryByFile = mockGetSummaryByFile2;
  },
}));

import { existsSync } from "node:fs";
import { computeFileInsightMaps } from "../graph/kg-query.ts";

function makeBoardWithFiles(files: string[]): import("../orchestration/flow-schema.ts").Board {
  return {
    flow: "test",
    task: "test task",
    entry: "start",
    current_state: "start",
    base_commit: "abc123",
    started: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    states: {},
    iterations: {},
    blocked: null,
    concerns: [],
    skipped: [],
    metadata: {
      affected_files: JSON.stringify(files),
    },
  };
}

describe("file_context injection — session null fallback", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ctx-integration-null-session-"));
    // KG DB appears to exist
    vi.mocked(existsSync).mockImplementation((p) => {
      return String(p).endsWith("knowledge-graph.db");
    });
    vi.clearAllMocks();
    // Mock restores after clearAllMocks — re-set existsSync
    vi.mocked(existsSync).mockImplementation((p) => {
      return String(p).endsWith("knowledge-graph.db");
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uses medium tier cap (15) when session is null", async () => {
    // session === null means no active session — falls back to "medium"
    mockStore2.getSession.mockReturnValue(null);
    // Give 20 files
    const twentyFiles = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`);
    const board = makeBoardWithFiles(twentyFiles);

    const { resolveContextInjections } = await import("../orchestration/inject-context.ts");
    const result = await resolveContextInjections(
      [{ from: "file_context", as: "FILE_CONTEXT" }],
      board,
      tmpDir,
    );

    // Medium cap is 15, so computeFileInsightMaps called once and getFileMetrics called 15 times
    expect(computeFileInsightMaps).toHaveBeenCalledTimes(1);
    expect(mockGetFileMetrics2).toHaveBeenCalledTimes(15);
    const value = result.variables["FILE_CONTEXT"];
    expect(value).toContain("src/file0.ts");
    expect(value).not.toContain("src/file15.ts");
  });
});

// ---------------------------------------------------------------------------
// 5. Coverage gap: file in affected_files that is NOT in KG → "(not indexed)" label
//    This path is exercised but not explicitly asserted in ctx-03 tests.
// ---------------------------------------------------------------------------

describe("file_context injection — not-indexed file formatting", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ctx-integration-not-indexed-"));
    vi.mocked(existsSync).mockImplementation((p) => {
      return String(p).endsWith("knowledge-graph.db");
    });
    mockStore2.getSession.mockReturnValue({ tier: "medium" });
    mockGetFileMetrics2.mockReturnValue(null); // file not in KG
    mockGetFile2.mockReturnValue(undefined);   // no file row in store
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("formats file as '(not indexed)' when KG has no entry for the file", async () => {
    const board = makeBoardWithFiles(["src/new-file.ts"]);

    const { resolveContextInjections } = await import("../orchestration/inject-context.ts");
    const result = await resolveContextInjections(
      [{ from: "file_context", as: "FILE_CONTEXT" }],
      board,
      tmpDir,
    );

    expect(result.warnings).toHaveLength(0);
    const value = result.variables["FILE_CONTEXT"];
    expect(value).toContain("src/new-file.ts");
    expect(value).toContain("(not indexed)");
  });
});

// ---------------------------------------------------------------------------
// 6. Coverage gap: initDatabase throws → caught, warning returned, no crash
//    ctx-02 declared: "No test for KG DB that exists but throws on open"
// ---------------------------------------------------------------------------

describe("file_context injection — initDatabase failure graceful degradation", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ctx-integration-db-fail-"));
    // KG DB appears to exist (existsSync returns true) but initDatabase throws
    vi.mocked(existsSync).mockImplementation((p) => {
      return String(p).endsWith("knowledge-graph.db");
    });
    mockStore2.getSession.mockReturnValue({ tier: "medium" });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits warning and returns no value when initDatabase throws (corrupt DB)", async () => {
    const { initDatabase } = await import("../graph/kg-schema.ts");
    vi.mocked(initDatabase).mockImplementation(() => {
      throw new Error("database is malformed");
    });

    const board = makeBoardWithFiles(["src/api/handler.ts"]);

    const { resolveContextInjections } = await import("../orchestration/inject-context.ts");
    const result = await resolveContextInjections(
      [{ from: "file_context", as: "FILE_CONTEXT" }],
      board,
      tmpDir,
    );

    expect(result.warnings.some((w) => w.includes("KG") || w.includes("database") || w.includes("failed"))).toBe(true);
    expect(result.variables).not.toHaveProperty("FILE_CONTEXT");
  });
});
