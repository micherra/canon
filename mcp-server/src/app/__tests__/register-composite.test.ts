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

vi.mock("@features/diagnostics/services/signal-compiler.ts", () => ({
  compileSignals: vi.fn().mockReturnValue([]),
}));

vi.mock("@platform/storage/drift/drift-db.ts", () => ({
  getDriftDb: vi.fn().mockReturnValue({ getSignals: vi.fn().mockReturnValue({}) }),
}));

// Import after mocks are set up
import { getDriftReport } from "@features/diagnostics/tools/get-drift-report.ts";
import { getFileContext } from "@features/file-context/tools/get-file-context.ts";
import { graphQuery } from "@features/knowledge-graph/tools/graph-query.ts";
import { getPrinciplesBatch } from "@features/principles/tools/get-principles.ts";

const mockPrinciplesResult = {
  graph_context_by_file: {},
  principles: [{ body: "b", id: "p1", severity: "rule", title: "P1" }],
  total_in_canon: 10,
  total_matched: 1,
};

const mockFileContextOk = {
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

const mockDriftResult = {
  formatted: "drift formatted",
  pr_reviews: [],
  report: {} as never,
};

const mockGraphResult = {
  count: 2,
  ok: true as const,
  query_type: "blast_radius" as const,
  results: [{ depth: 1, name: "bar" }],
  target: "src/foo.ts",
};

describe("register-knowledge get_context handler", () => {
  let handler: (input: { file_paths: string[]; include?: string[] }) => Promise<unknown>;

  beforeEach(async () => {
    vi.clearAllMocks();

    vi.mocked(getPrinciplesBatch).mockResolvedValue(mockPrinciplesResult);
    vi.mocked(getFileContext).mockResolvedValue(mockFileContextOk);
    vi.mocked(getDriftReport).mockResolvedValue(mockDriftResult);
    vi.mocked(graphQuery).mockReturnValue(mockGraphResult);

    // Dynamically import after mocks are set up so the module captures our mocks.
    const mod = await import("../register-knowledge.ts");

    // Extract the handler by calling registerKnowledgeTools and capturing what
    // server.registerTool was given for get_context.
    const { server } = await import("@app/server-state.ts");
    vi.mocked(server.registerTool).mockClear();
    mod.registerKnowledgeTools();
    const calls = vi.mocked(server.registerTool).mock.calls;
    // Find the get_context registration
    const getContextCall = calls.find((c) => c[0] === "get_context");
    if (!getContextCall) throw new Error("get_context tool not registered");
    handler = getContextCall[2] as typeof handler;
  });

  describe("all sections returned when include is omitted", () => {
    it("calls all underlying tools and returns all sections", async () => {
      const result = (await handler({ file_paths: ["src/foo.ts"] })) as Record<string, unknown>;

      expect(getPrinciplesBatch).toHaveBeenCalledOnce();
      expect(getFileContext).toHaveBeenCalledOnce();
      expect(getDriftReport).toHaveBeenCalledOnce();
      expect(graphQuery).toHaveBeenCalledOnce();

      expect(result.principles).toEqual(mockPrinciplesResult);
      const { ok: _ok, ...expectedFileContext } = mockFileContextOk;
      expect(result.file_context).toEqual([expectedFileContext]);
      expect(result.drift).toEqual(mockDriftResult);
      expect(result.graph).toEqual([mockGraphResult]);
      // signals: compileSignals returns [] so output.signals is not set
      expect(result.signals).toBeUndefined();
    });

    it("includes file_paths and include in response metadata", async () => {
      const result = (await handler({ file_paths: ["src/foo.ts"] })) as Record<string, unknown>;

      expect(result.file_paths).toEqual(["src/foo.ts"]);
      expect(result.include).toEqual(["principles", "file_context", "drift", "graph", "signals"]);
    });
  });

  describe("include filter selects only requested sections", () => {
    it("returns only principles when include=['principles']", async () => {
      const result = (await handler({
        file_paths: ["src/foo.ts"],
        include: ["principles"],
      })) as Record<string, unknown>;

      expect(getPrinciplesBatch).toHaveBeenCalledOnce();
      expect(getFileContext).not.toHaveBeenCalled();
      expect(getDriftReport).not.toHaveBeenCalled();
      expect(graphQuery).not.toHaveBeenCalled();

      expect(result.principles).toEqual(mockPrinciplesResult);
      expect(result.file_context).toBeUndefined();
      expect(result.drift).toBeUndefined();
      expect(result.graph).toBeUndefined();
    });

    it("returns only file_context and drift when include=['file_context','drift']", async () => {
      const result = (await handler({
        file_paths: ["src/foo.ts"],
        include: ["file_context", "drift"],
      })) as Record<string, unknown>;

      expect(getFileContext).toHaveBeenCalledOnce();
      expect(getDriftReport).toHaveBeenCalledOnce();
      expect(getPrinciplesBatch).not.toHaveBeenCalled();
      expect(graphQuery).not.toHaveBeenCalled();

      const { ok: _ok, ...expectedFileContext } = mockFileContextOk;
      expect(result.file_context).toEqual([expectedFileContext]);
      expect(result.drift).toEqual(mockDriftResult);
    });
  });

  describe("fail-closed: file_context errors propagate", () => {
    it("throws when getFileContext returns an error result", async () => {
      vi.mocked(getFileContext).mockResolvedValue({
        error_code: "INVALID_INPUT",
        message: "File not found: src/missing.ts",
        ok: false,
        recoverable: false,
      });

      await expect(
        handler({ file_paths: ["src/missing.ts"], include: ["file_context"] }),
      ).rejects.toThrow("file_context error (INVALID_INPUT): File not found: src/missing.ts");
    });
  });

  describe("graph section: graceful skip when KG is not indexed", () => {
    it("omits graph section when graphQuery returns KG_NOT_INDEXED error", async () => {
      vi.mocked(graphQuery).mockReturnValue({
        error_code: "KG_NOT_INDEXED",
        message: "Knowledge graph database not found",
        ok: false,
        recoverable: true,
      });

      const result = (await handler({
        file_paths: ["src/foo.ts"],
        include: ["graph"],
      })) as Record<string, unknown>;

      expect(graphQuery).toHaveBeenCalledOnce();
      // Graph section should be absent (graceful skip)
      expect(result.graph).toBeUndefined();
    });

    it("omits graph section when file_paths is empty", async () => {
      const result = (await handler({
        file_paths: [],
        include: ["graph"],
      })) as Record<string, unknown>;

      // graphQuery should not be called when there are no file paths
      expect(graphQuery).not.toHaveBeenCalled();
      expect(result.graph).toBeUndefined();
    });
  });

  describe("graph section: queries all file paths, not just the first", () => {
    it("calls graphQuery once per file path and returns all successful results", async () => {
      const mockGraphResult2 = {
        count: 1,
        ok: true as const,
        query_type: "blast_radius" as const,
        results: [{ depth: 2, name: "baz" }],
        target: "src/bar.ts",
      };
      vi.mocked(graphQuery)
        .mockReturnValueOnce(mockGraphResult)
        .mockReturnValueOnce(mockGraphResult2);

      const result = (await handler({
        file_paths: ["src/foo.ts", "src/bar.ts"],
        include: ["graph"],
      })) as Record<string, unknown>;

      expect(graphQuery).toHaveBeenCalledTimes(2);
      expect(graphQuery).toHaveBeenCalledWith(
        { query_type: "blast_radius", target: "src/foo.ts" },
        "/mock/project",
      );
      expect(graphQuery).toHaveBeenCalledWith(
        { query_type: "blast_radius", target: "src/bar.ts" },
        "/mock/project",
      );
      expect(result.graph).toEqual([mockGraphResult, mockGraphResult2]);
    });

    it("skips failed files but includes successful ones in the aggregate", async () => {
      vi.mocked(graphQuery).mockReturnValueOnce(mockGraphResult).mockReturnValueOnce({
        error_code: "KG_NOT_INDEXED",
        message: "KG not indexed",
        ok: false,
        recoverable: true,
      });

      const result = (await handler({
        file_paths: ["src/foo.ts", "src/bar.ts"],
        include: ["graph"],
      })) as Record<string, unknown>;

      expect(graphQuery).toHaveBeenCalledTimes(2);
      // Only the first file succeeded; result is still present but with one entry
      expect(result.graph).toEqual([mockGraphResult]);
    });
  });
});
