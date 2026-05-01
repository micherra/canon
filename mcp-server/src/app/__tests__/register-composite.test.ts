import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---
// Mock server-state first so no MCP server is instantiated during tests.
vi.mock("@app/server-state.ts", () => ({
  gatedWrapHandler: (handler: (input: unknown) => unknown) => handler,
  pluginDir: "/mock/plugin",
  projectDir: "/mock/project",
  server: { registerTool: vi.fn() },
}));

vi.mock("@features/principles/tools/get-principles.ts", () => ({
  getPrinciplesBatch: vi.fn(),
}));

vi.mock("@features/file-context/tools/get-file-context-batch.ts", () => ({
  getFileContextBatch: vi.fn(),
}));

vi.mock("@features/diagnostics/tools/get-drift-report.ts", () => ({
  getDriftReport: vi.fn(),
}));

vi.mock("@features/knowledge-graph/tools/graph-query.ts", () => ({
  graphQuery: vi.fn(),
}));

// Import after mocks are set up
import { getDriftReport } from "@features/diagnostics/tools/get-drift-report.ts";
import { getFileContextBatch } from "@features/file-context/tools/get-file-context-batch.ts";
import { graphQuery } from "@features/knowledge-graph/tools/graph-query.ts";
import { getPrinciplesBatch } from "@features/principles/tools/get-principles.ts";

// Import the module under test — this executes registerCompositeTools() is NOT called automatically;
// we import the handler factory directly.
// The handler is extracted by capturing what gatedWrapHandler receives.

const mockPrinciplesResult = {
  graph_context_by_file: {},
  principles: [{ body: "b", id: "p1", severity: "rule", title: "P1" }],
  total_in_canon: 10,
  total_matched: 1,
};

const mockFileContextResult = {
  ok: true as const,
  results: [
    {
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
      project_max_impact: 0,
      role: "internal",
      shape: { description: "Moderate connectivity, typical file.", label: "Internal" },
      summary: null,
      violation_count: 0,
      violations: [],
    },
  ],
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

describe("register-composite handler", () => {
  let handler: (input: { file_paths: string[]; include?: string[] }) => Promise<unknown>;

  beforeEach(async () => {
    vi.clearAllMocks();

    vi.mocked(getPrinciplesBatch).mockResolvedValue(mockPrinciplesResult);
    vi.mocked(getFileContextBatch).mockResolvedValue(mockFileContextResult);
    vi.mocked(getDriftReport).mockResolvedValue(mockDriftResult);
    vi.mocked(graphQuery).mockReturnValue(mockGraphResult);

    // Dynamically import after mocks are set up so the module captures our mocks.
    // Use a cache-busting trick: vitest auto-resets modules when vi.mock is declared,
    // but we need to re-import on each test run.
    const mod = await import("../register-composite.ts");

    // Extract the handler by calling registerCompositeTools and capturing what
    // server.registerTool was given.
    const { server } = await import("@app/server-state.ts");
    mod.registerCompositeTools();
    const calls = vi.mocked(server.registerTool).mock.calls;
    // The last call is our get_context registration
    const lastCall = calls[calls.length - 1];
    handler = lastCall[2] as typeof handler;
  });

  describe("all sections returned when include is omitted", () => {
    it("calls all four underlying tools and returns all sections", async () => {
      const result = (await handler({ file_paths: ["src/foo.ts"] })) as Record<string, unknown>;

      expect(getPrinciplesBatch).toHaveBeenCalledOnce();
      expect(getFileContextBatch).toHaveBeenCalledOnce();
      expect(getDriftReport).toHaveBeenCalledOnce();
      expect(graphQuery).toHaveBeenCalledOnce();

      expect(result.principles).toEqual(mockPrinciplesResult);
      expect(result.file_context).toEqual(mockFileContextResult.results);
      expect(result.drift).toEqual(mockDriftResult);
      expect(result.graph).toEqual(mockGraphResult);
    });

    it("includes file_paths and include in response metadata", async () => {
      const result = (await handler({ file_paths: ["src/foo.ts"] })) as Record<string, unknown>;

      expect(result.file_paths).toEqual(["src/foo.ts"]);
      expect(result.include).toEqual(["principles", "file_context", "drift", "graph"]);
    });
  });

  describe("include filter selects only requested sections", () => {
    it("returns only principles when include=['principles']", async () => {
      const result = (await handler({
        file_paths: ["src/foo.ts"],
        include: ["principles"],
      })) as Record<string, unknown>;

      expect(getPrinciplesBatch).toHaveBeenCalledOnce();
      expect(getFileContextBatch).not.toHaveBeenCalled();
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

      expect(getFileContextBatch).toHaveBeenCalledOnce();
      expect(getDriftReport).toHaveBeenCalledOnce();
      expect(getPrinciplesBatch).not.toHaveBeenCalled();
      expect(graphQuery).not.toHaveBeenCalled();

      expect(result.file_context).toEqual(mockFileContextResult.results);
      expect(result.drift).toEqual(mockDriftResult);
    });
  });

  describe("fail-closed: file_context errors propagate", () => {
    it("throws when getFileContextBatch returns an error result", async () => {
      vi.mocked(getFileContextBatch).mockResolvedValue({
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
});
