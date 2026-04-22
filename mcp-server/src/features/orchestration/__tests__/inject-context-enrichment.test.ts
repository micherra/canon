import { rmSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Board } from "@domains/flows/board-state-schemas.ts";
import type { ContextInjection } from "@domains/flows/flow-definition-schemas.ts";
import type { LayerViolation } from "@graph/kg-types.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveContextInjections } from "../services/inject-context.ts";

// Mocks for file_context tests
// Use vi.hoisted so mock factory functions can reference these variables
// even after vi.mock() is hoisted to the top of the module by vitest.

const {
  mockGetFileMetrics,
  mockGetKgFreshnessMs,
  mockGetFile,
  mockGetSummaryByFile,
  mockStore,
  mockDb,
} = vi.hoisted(() => {
  const mockGetFileMetrics = vi.fn();
  const mockGetKgFreshnessMs = vi.fn().mockReturnValue(1000);
  const mockGetFile = vi.fn();
  const mockGetSummaryByFile = vi.fn();
  const mockStore = {
    getSession: vi.fn().mockReturnValue({ tier: "medium" }),
  };
  const mockDb = { close: vi.fn() };
  return {
    mockDb,
    mockGetFile,
    mockGetFileMetrics,
    mockGetKgFreshnessMs,
    mockGetSummaryByFile,
    mockStore,
  };
});

vi.mock("@domains/workspaces/execution-store-cache.ts", () => ({
  getExecutionStore: vi.fn(() => mockStore),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
  };
});

vi.mock("@graph/kg-schema.ts", () => ({
  initDatabase: vi.fn(() => mockDb),
}));

vi.mock("@graph/kg-query-insights.ts", () => ({
  computeFileInsightMaps: vi.fn().mockReturnValue({
    cycleMemberPaths: new Map<string, string[]>(),
    hubPaths: new Set<string>(),
    layerViolationsByPath: new Map<string, LayerViolation[]>(),
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

import { existsSync } from "node:fs";
import { computeFileInsightMaps } from "@graph/kg-query-insights.ts";

function makeBoardWithMetadata(metadata?: Record<string, string | number | boolean>): Board {
  return {
    base_commit: "abc123",
    blocked: null,
    concerns: [],
    current_state: "start",
    entry: "start",
    flow: "test",
    iterations: {},
    last_updated: new Date().toISOString(),
    skipped: [],
    started: new Date().toISOString(),
    states: {},
    task: "test task",
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function makeBoard(stateOverrides: Board["states"] = {}): Board {
  return {
    base_commit: "abc123",
    blocked: null,
    concerns: [],
    current_state: "start",
    entry: "start",
    flow: "test",
    iterations: {},
    last_updated: new Date().toISOString(),
    skipped: [],
    started: new Date().toISOString(),
    states: stateOverrides,
    task: "test task",
  };
}

// file_context injection source

describe("resolveContextInjections — file_context source", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "inject-ctx-kg-test-"));
    // Reset mocks to clean state
    vi.mocked(existsSync).mockImplementation((p) => {
      // Default: KG DB exists
      const strPath = String(p);
      if (strPath.endsWith("knowledge-graph.db")) return true;
      return false;
    });
    mockStore.getSession.mockReturnValue({ tier: "medium" });
    mockGetFileMetrics.mockReturnValue(null);
    mockGetSummaryByFile.mockReturnValue(undefined);
    mockGetFile.mockReturnValue(undefined);
    mockGetKgFreshnessMs.mockReturnValue(1000); // fresh by default
    vi.mocked(computeFileInsightMaps).mockReturnValue({
      cycleMemberPaths: new Map<string, string[]>(),
      hubPaths: new Set<string>(),
      layerViolationsByPath: new Map<string, LayerViolation[]>(),
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
    vi.clearAllMocks();
  });

  it("resolves file summaries from KG for valid affected_files in board metadata", async () => {
    const board = makeBoardWithMetadata({
      affected_files: JSON.stringify(["src/api/handler.ts", "src/domain/service.ts"]),
    });
    const injections: ContextInjection[] = [{ as: "FILE_CONTEXT", from: "file_context" }];

    // Set up KG mocks: metrics and summaries for both files
    mockGetFileMetrics
      .mockReturnValueOnce({
        cycle_peers: [],
        impact_score: 16,
        in_cycle: false,
        in_degree: 5,
        is_hub: false,
        layer: "api",
        layer_violation_count: 0,
        layer_violations: [],
        out_degree: 3,
      })
      .mockReturnValueOnce({
        cycle_peers: [],
        impact_score: 8,
        in_cycle: false,
        in_degree: 2,
        is_hub: false,
        layer: "domain",
        layer_violation_count: 0,
        layer_violations: [],
        out_degree: 8,
      });

    mockGetFile
      .mockReturnValueOnce({ file_id: 1, path: "src/api/handler.ts" })
      .mockReturnValueOnce({ file_id: 2, path: "src/domain/service.ts" });

    mockGetSummaryByFile
      .mockReturnValueOnce({ summary: "Handles HTTP API requests" })
      .mockReturnValueOnce({ summary: "Domain service layer" });

    const result = await resolveContextInjections(injections, board, tmpDir);

    expect(result.warnings).toHaveLength(0);
    expect(result.variables.FILE_CONTEXT).toBeDefined();
    const value = result.variables.FILE_CONTEXT!;
    expect(value).toContain("### File Context");
    expect(value).toContain("src/api/handler.ts");
    expect(value).toContain("src/domain/service.ts");
    expect(value).toContain("in_degree: 5");
    expect(value).toContain("in_degree: 2");
    expect(value).toContain("Handles HTTP API requests");
    expect(value).toContain("Domain service layer");
  });

  it("produces warning and no value when affected_files is missing from board metadata", async () => {
    const board = makeBoardWithMetadata(); // no metadata
    const injections: ContextInjection[] = [{ as: "FILE_CONTEXT", from: "file_context" }];

    const result = await resolveContextInjections(injections, board, tmpDir);

    expect(result.warnings.some((w) => w.includes("affected_files"))).toBe(true);
    expect(result.variables).not.toHaveProperty("FILE_CONTEXT");
  });

  it("produces warning and no value when affected_files is empty array", async () => {
    const board = makeBoardWithMetadata({
      affected_files: JSON.stringify([]),
    });
    const injections: ContextInjection[] = [{ as: "FILE_CONTEXT", from: "file_context" }];

    const result = await resolveContextInjections(injections, board, tmpDir);

    expect(result.warnings.some((w) => w.includes("affected_files"))).toBe(true);
    expect(result.variables).not.toHaveProperty("FILE_CONTEXT");
  });

  it("produces warning and no value when affected_files contains malformed JSON", async () => {
    const board = makeBoardWithMetadata({
      affected_files: "not-valid-json[",
    });
    const injections: ContextInjection[] = [{ as: "FILE_CONTEXT", from: "file_context" }];

    const result = await resolveContextInjections(injections, board, tmpDir);

    expect(result.warnings.some((w) => w.includes("affected_files"))).toBe(true);
    expect(result.variables).not.toHaveProperty("FILE_CONTEXT");
  });

  it("respects item count cap: small tier with 10 files only processes 5", async () => {
    mockStore.getSession.mockReturnValue({ tier: "small" }); // cap = 5

    const tenFiles = Array.from({ length: 10 }, (_, i) => `src/file${i}.ts`);
    const board = makeBoardWithMetadata({
      affected_files: JSON.stringify(tenFiles),
    });
    const injections: ContextInjection[] = [{ as: "FILE_CONTEXT", from: "file_context" }];

    // All files return null metrics (no KG entry)
    mockGetFileMetrics.mockReturnValue(null);

    const result = await resolveContextInjections(injections, board, tmpDir);

    // computeFileInsightMaps called once
    expect(computeFileInsightMaps).toHaveBeenCalledTimes(1);
    // KgQuery.getFileMetrics called at most 5 times (capped)
    expect(mockGetFileMetrics).toHaveBeenCalledTimes(5);
    // Result should reference only the first 5 files
    const value = result.variables.FILE_CONTEXT;
    expect(value).toContain("src/file0.ts");
    expect(value).not.toContain("src/file5.ts");
  });

  it("produces warning and no value when KG DB is unavailable", async () => {
    vi.mocked(existsSync).mockReturnValue(false); // KG DB missing

    const board = makeBoardWithMetadata({
      affected_files: JSON.stringify(["src/api/handler.ts"]),
    });
    const injections: ContextInjection[] = [{ as: "FILE_CONTEXT", from: "file_context" }];

    const result = await resolveContextInjections(injections, board, tmpDir);

    expect(
      result.warnings.some(
        (w) =>
          w.includes("KG") ||
          w.includes("knowledge") ||
          w.includes("database") ||
          w.includes("unavailable"),
      ),
    ).toBe(true);
    expect(result.variables).not.toHaveProperty("FILE_CONTEXT");
  });

  it("emits staleness warning but still returns value when KG is stale (>1h)", async () => {
    mockGetKgFreshnessMs.mockReturnValue(4_000_000); // ~1.1 hours — stale

    const board = makeBoardWithMetadata({
      affected_files: JSON.stringify(["src/api/handler.ts"]),
    });
    const injections: ContextInjection[] = [{ as: "FILE_CONTEXT", from: "file_context" }];

    mockGetFileMetrics.mockReturnValue({
      cycle_peers: [],
      impact_score: 4,
      in_cycle: false,
      in_degree: 1,
      is_hub: false,
      layer: "api",
      layer_violation_count: 0,
      layer_violations: [],
      out_degree: 1,
    });
    mockGetFile.mockReturnValue({ file_id: 1, path: "src/api/handler.ts" });
    mockGetSummaryByFile.mockReturnValue(undefined); // no summary

    const result = await resolveContextInjections(injections, board, tmpDir);

    // Should have a staleness warning
    expect(
      result.warnings.some((w) => w.includes("stale") || w.includes("KG") || w.includes("hour")),
    ).toBe(true);
    // But still returns a value
    expect(result.variables.FILE_CONTEXT).toBeDefined();
    expect(result.variables.FILE_CONTEXT).toContain("src/api/handler.ts");
  });
});

// handoff injection source

describe("resolveContextInjections — handoff source", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "inject-handoff-test-"));
    // Restore the real existsSync — the file_context tests override the mock's implementation
    // in their beforeEach, and vi.clearAllMocks() does not restore implementations.
    // We use vi.importActual to get the real function and reset the mock here.
    const { existsSync: realExistsSync } =
      await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(existsSync).mockImplementation(realExistsSync);
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
  });

  it("reads and concatenates .md files from handoffs/ directory", async () => {
    const handoffsDir = join(tmpDir, "handoffs");
    await mkdir(handoffsDir);
    await writeFile(join(handoffsDir, "alpha.md"), "Alpha content.");
    await writeFile(join(handoffsDir, "beta.md"), "Beta content.");

    const board = makeBoard({});
    const injections: ContextInjection[] = [{ as: "HANDOFF", from: "handoff" }];

    const result = await resolveContextInjections(injections, board, tmpDir);

    expect(result.warnings).toHaveLength(0);
    expect(result.variables.HANDOFF).toContain("Alpha content.");
    expect(result.variables.HANDOFF).toContain("Beta content.");
    // Files should be presented with ## headers
    expect(result.variables.HANDOFF).toContain("## alpha");
    expect(result.variables.HANDOFF).toContain("## beta");
  });

  it("filters by section (filename match, case-insensitive) when section is specified", async () => {
    const handoffsDir = join(tmpDir, "handoffs");
    await mkdir(handoffsDir);
    await writeFile(join(handoffsDir, "research.md"), "Research content.");
    await writeFile(join(handoffsDir, "plan.md"), "Plan content.");

    const board = makeBoard({});
    const injections: ContextInjection[] = [
      { as: "HANDOFF", from: "handoff", section: "Research" },
    ];

    const result = await resolveContextInjections(injections, board, tmpDir);

    expect(result.warnings).toHaveLength(0);
    expect(result.variables.HANDOFF).toContain("Research content.");
    expect(result.variables.HANDOFF).not.toContain("Plan content.");
  });

  it("returns warning when handoffs/ directory is empty (no .md files)", async () => {
    const handoffsDir = join(tmpDir, "handoffs");
    await mkdir(handoffsDir);
    // No files in dir

    const board = makeBoard({});
    const injections: ContextInjection[] = [{ as: "HANDOFF", from: "handoff" }];

    const result = await resolveContextInjections(injections, board, tmpDir);

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes("handoff"))).toBe(true);
    expect(result.variables).not.toHaveProperty("HANDOFF");
  });

  it("returns warning when handoffs/ directory does not exist", async () => {
    // No handoffs/ dir created
    const board = makeBoard({});
    const injections: ContextInjection[] = [{ as: "HANDOFF", from: "handoff" }];

    const result = await resolveContextInjections(injections, board, tmpDir);

    expect(result.warnings.some((w) => w.includes("handoff"))).toBe(true);
    expect(result.variables).not.toHaveProperty("HANDOFF");
  });

  it("ignores non-.md files in handoffs/ directory", async () => {
    const handoffsDir = join(tmpDir, "handoffs");
    await mkdir(handoffsDir);
    await writeFile(join(handoffsDir, "notes.txt"), "Text file content.");
    await writeFile(join(handoffsDir, "data.json"), '{"key": "value"}');
    await writeFile(join(handoffsDir, "summary.md"), "Markdown content.");

    const board = makeBoard({});
    const injections: ContextInjection[] = [{ as: "HANDOFF", from: "handoff" }];

    const result = await resolveContextInjections(injections, board, tmpDir);

    expect(result.warnings).toHaveLength(0);
    expect(result.variables.HANDOFF).toContain("Markdown content.");
    expect(result.variables.HANDOFF).not.toContain("Text file content.");
    expect(result.variables.HANDOFF).not.toContain('"key"');
  });

  it("skips whole files that would push total over 50KB and adds a warning", async () => {
    const handoffsDir = join(tmpDir, "handoffs");
    await mkdir(handoffsDir);
    // Write a file that fills ~49KB
    const bigContent = "x".repeat(49 * 1024);
    await writeFile(join(handoffsDir, "big.md"), bigContent);
    // Write a second file that would push it over 50KB
    const smallContent = "y".repeat(2 * 1024);
    await writeFile(join(handoffsDir, "overflow.md"), smallContent);

    const board = makeBoard({});
    const injections: ContextInjection[] = [{ as: "HANDOFF", from: "handoff" }];

    const result = await resolveContextInjections(injections, board, tmpDir);

    // Should include the big file (fits under 50KB)
    expect(result.variables.HANDOFF).toContain(bigContent.slice(0, 10));
    // The overflow file should be skipped
    expect(result.variables.HANDOFF).not.toContain("y".repeat(10));
    // A warning should be emitted for the skipped file
    expect(result.warnings.some((w) => w.includes("overflow") && w.includes("50KB"))).toBe(true);
  });
});
