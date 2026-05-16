import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---
// Mock server-state first so no MCP server is instantiated during tests.
vi.mock("@app/server-state.ts", () => ({
  gatedWrapHandler: (handler: (input: unknown) => unknown) => handler,
  pluginDir: "/mock/plugin",
  projectDir: "/mock/project",
  registerToolWithUi: vi.fn(),
  server: { registerTool: vi.fn() },
}));

// Mock all dependencies of handleGetContext that are not under test
vi.mock("@features/principles/tools/get-principles.ts", () => ({
  getPrinciplesBatch: vi.fn(),
}));

vi.mock("@features/file-context/tools/get-file-context.ts", () => ({
  getFileContext: vi.fn(),
}));

vi.mock("@features/diagnostics/tools/get-drift-report.ts", () => ({
  getDriftReport: vi.fn(),
}));

vi.mock("@features/knowledge-graph/tools/graph-query.ts", () => ({
  graphQuery: vi.fn(),
}));

vi.mock("@features/diagnostics/services/signal-compiler.ts", () => ({
  compileSignals: vi.fn(),
}));

vi.mock("@features/diagnostics/services/prediction-tracker.ts", () => ({
  recordPrediction: vi.fn(),
}));

vi.mock("@platform/storage/drift/drift-db.ts", () => ({
  getDriftDb: vi.fn(),
}));

// Stub out other register-knowledge.ts dependencies that aren't under test
vi.mock("@features/diagnostics/tools/get-history.ts", () => ({ getHistory: vi.fn() }));
vi.mock("@features/diagnostics/tools/store-summaries.ts", () => ({ storeSummaries: vi.fn() }));
vi.mock("@features/knowledge-graph/tools/codebase-graph.ts", () => ({
  codebaseGraph: vi.fn(),
  compactGraph: vi.fn(),
}));
vi.mock("@features/knowledge-graph/tools/codebase-graph-materialize.ts", () => ({
  codebaseGraphMaterialize: vi.fn(),
}));
vi.mock("@features/knowledge-graph/tools/codebase-graph-poll.ts", () => ({
  codebaseGraphPoll: vi.fn(),
}));
vi.mock("@features/knowledge-graph/tools/codebase-graph-submit.ts", () => ({
  codebaseGraphSubmit: vi.fn(),
}));
vi.mock("@features/knowledge-graph/tools/semantic-search.ts", () => ({
  semanticSearch: vi.fn(),
}));

import { recordPrediction } from "@features/diagnostics/services/prediction-tracker.ts";
// Import after mocks are set up
import type { FileSignals } from "@features/diagnostics/services/signal-compiler.ts";
import { compileSignals } from "@features/diagnostics/services/signal-compiler.ts";
import { getDriftReport } from "@features/diagnostics/tools/get-drift-report.ts";
import { getFileContext } from "@features/file-context/tools/get-file-context.ts";
import { graphQuery } from "@features/knowledge-graph/tools/graph-query.ts";
import { getPrinciplesBatch } from "@features/principles/tools/get-principles.ts";
import { getDriftDb } from "@platform/storage/drift/drift-db.ts";

const mockSignalsForFoo: FileSignals = {
  file_path: "src/foo.ts",
  signals: [
    {
      priority: 8,
      text: 'Principle "simplicity-first" has been violated 5 time(s) in this file. Last seen: 2026-05-01. First seen: 2026-04-01.',
      type: "violation_history",
    },
  ],
};

const mockSignalsForBar: FileSignals = {
  file_path: "src/bar.ts",
  signals: [
    {
      priority: 4,
      text: "Reviewed 3 time(s) with 2 violation(s). Current violation streak: 1.",
      type: "path_effect",
    },
  ],
};

const mockDriftDbSignals = { getFileViolationHistory: vi.fn(), getPathEffects: vi.fn() };
const mockDriftDb = { getSignals: vi.fn(() => mockDriftDbSignals) };

describe("get_context signals section", () => {
  let handleGetContext: (input: {
    file_paths: string[];
    include?: string[];
  }) => Promise<Record<string, unknown>>;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Set default mock return values for all dependencies
    vi.mocked(getDriftDb).mockReturnValue(mockDriftDb as never);
    vi.mocked(compileSignals).mockReturnValue([mockSignalsForFoo]);
    vi.mocked(recordPrediction).mockReturnValue(undefined);
    vi.mocked(getPrinciplesBatch).mockResolvedValue({
      graph_context_by_file: {},
      principles: [],
      total_in_canon: 0,
      total_matched: 0,
    });
    vi.mocked(getFileContext).mockResolvedValue({
      content: "",
      exports: [],
      file_path: "src/foo.ts",
      imported_by: [],
      imported_by_layer: {},
      imports: [],
      imports_by_layer: {},
      last_verdict: null,
      layer: "app",
      layer_stack: [],
      ok: true as const,
      project_max_impact: 0,
      role: "internal",
      shape: { description: "Leaf file.", label: "Leaf" },
      summary: null,
      violation_count: 0,
      violations: [],
    });
    vi.mocked(getDriftReport).mockResolvedValue({
      formatted: "",
      pr_reviews: [],
      report: {} as never,
    });
    vi.mocked(graphQuery).mockReturnValue({
      count: 0,
      ok: true as const,
      query_type: "blast_radius" as const,
      results: [],
      target: "src/foo.ts",
    });

    // Dynamically import after mocks are set up so the module captures our mocks.
    const mod = await import("../register-knowledge.ts");
    handleGetContext = mod.handleGetContext as typeof handleGetContext;
  });

  // Test 1: signals section included when include=['signals']
  it("includes signals in output when include contains 'signals'", async () => {
    vi.mocked(compileSignals).mockReturnValue([mockSignalsForFoo]);

    const result = await handleGetContext({
      file_paths: ["src/foo.ts"],
      include: ["signals"],
    });

    expect(getDriftDb).toHaveBeenCalledWith("/mock/project");
    expect(mockDriftDb.getSignals).toHaveBeenCalledOnce();
    expect(compileSignals).toHaveBeenCalledWith(["src/foo.ts"], mockDriftDbSignals);
    expect(result.signals).toEqual([mockSignalsForFoo]);
  });

  // Test 2: signals section omitted when include does not contain 'signals'
  it("omits signals when include does not contain 'signals'", async () => {
    const result = await handleGetContext({
      file_paths: ["src/foo.ts"],
      include: ["principles"],
    });

    expect(compileSignals).not.toHaveBeenCalled();
    expect(getDriftDb).not.toHaveBeenCalled();
    expect(result.signals).toBeUndefined();
  });

  // Test 3: signals included by default (no include parameter)
  it("includes signals by default when no include parameter is passed", async () => {
    vi.mocked(compileSignals).mockReturnValue([mockSignalsForFoo]);

    const result = await handleGetContext({
      file_paths: ["src/foo.ts"],
    });

    expect(compileSignals).toHaveBeenCalledOnce();
    expect(result.signals).toEqual([mockSignalsForFoo]);
    // Also verify include metadata reflects all sections
    expect(result.include).toEqual(["principles", "file_context", "drift", "graph", "signals"]);
  });

  // Test 4: signals contains FileSignals[] with correct file paths
  it("signals section contains FileSignals[] with correct file paths", async () => {
    vi.mocked(compileSignals).mockReturnValue([mockSignalsForFoo, mockSignalsForBar]);

    const result = await handleGetContext({
      file_paths: ["src/foo.ts", "src/bar.ts"],
      include: ["signals"],
    });

    expect(result.signals).toHaveLength(2);
    const signals = result.signals as FileSignals[];
    expect(signals[0].file_path).toBe("src/foo.ts");
    expect(signals[1].file_path).toBe("src/bar.ts");
    expect(signals[0].signals[0].type).toBe("violation_history");
    expect(signals[1].signals[0].type).toBe("path_effect");
  });

  // Test 5: signals section is undefined when compileSignals returns empty array
  it("omits signals field when compileSignals returns empty array (no data for files)", async () => {
    vi.mocked(compileSignals).mockReturnValue([]);

    const result = await handleGetContext({
      file_paths: ["src/no-data.ts"],
      include: ["signals"],
    });

    expect(compileSignals).toHaveBeenCalledOnce();
    // When signals is empty, output.signals is not set
    expect(result.signals).toBeUndefined();
  });

  // Test 6: signals section fails gracefully when getDriftDb throws
  it("fails gracefully when getDriftDb throws (drift.db not initialized)", async () => {
    vi.mocked(getDriftDb).mockImplementation(() => {
      throw new Error("SQLITE: unable to open database");
    });

    // Should not throw — fail-open behavior
    const result = await handleGetContext({
      file_paths: ["src/foo.ts"],
      include: ["signals"],
    });

    expect(result.signals).toBeUndefined();
  });

  // Test 7: other sections still work when signals is also requested
  it("principles and file_context still work when signals is also requested", async () => {
    const mockPrinciples = {
      graph_context_by_file: {},
      principles: [{ body: "b", id: "p1", severity: "rule", title: "P1" }],
      total_in_canon: 10,
      total_matched: 1,
    };
    const mockFileCtx = {
      content: "const x = 1;",
      exports: [],
      file_path: "src/foo.ts",
      imported_by: [],
      imported_by_layer: {},
      imports: [],
      imports_by_layer: {},
      last_verdict: null,
      layer: "app",
      layer_stack: [],
      ok: true as const,
      project_max_impact: 0,
      role: "internal",
      shape: { description: "Moderate connectivity, typical file.", label: "Internal" },
      summary: null,
      violation_count: 0,
      violations: [],
    };

    vi.mocked(getPrinciplesBatch).mockResolvedValue(mockPrinciples);
    vi.mocked(getFileContext).mockResolvedValue(mockFileCtx);
    vi.mocked(compileSignals).mockReturnValue([mockSignalsForFoo]);

    const result = await handleGetContext({
      file_paths: ["src/foo.ts"],
      include: ["principles", "file_context", "signals"],
    });

    expect(result.principles).toEqual(mockPrinciples);
    const { ok: _ok, ...expectedFileCtx } = mockFileCtx;
    expect(result.file_context).toEqual([expectedFileCtx]);
    expect(result.signals).toEqual([mockSignalsForFoo]);
    expect(result.drift).toBeUndefined();
    expect(result.graph).toBeUndefined();
  });

  // Test 8: resolveSignals() calls recordPrediction after compileSignals returns signals
  it("calls recordPrediction with compiled signals when signals are present", async () => {
    vi.mocked(compileSignals).mockReturnValue([mockSignalsForFoo]);

    await handleGetContext({
      file_paths: ["src/foo.ts"],
      include: ["signals"],
    });

    expect(recordPrediction).toHaveBeenCalledOnce();
    expect(recordPrediction).toHaveBeenCalledWith(
      { compiledSignals: [mockSignalsForFoo], filePaths: ["src/foo.ts"] },
      mockDriftDbSignals,
    );
  });

  // Test 9: resolveSignals() does NOT call recordPrediction when compileSignals returns empty
  it("does not call recordPrediction when compileSignals returns empty array", async () => {
    vi.mocked(compileSignals).mockReturnValue([]);

    await handleGetContext({
      file_paths: ["src/no-data.ts"],
      include: ["signals"],
    });

    expect(recordPrediction).not.toHaveBeenCalled();
  });
});
