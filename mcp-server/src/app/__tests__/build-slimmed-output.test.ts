/**
 * build-slimmed-output.test.ts — Unit tests for buildSlimmedOutput
 *
 * Verifies the progressive-disclosure slimming logic:
 * - Principle bodies get emptied
 * - file_context entry arrays (imports, exports, imported_by) get cleared
 * - file_context content gets emptied
 * - Metadata fields (file_paths, include, truncated, full_data_path) are preserved
 */

import { describe, expect, it, vi } from "vitest";

// Mock server-state so no MCP server is instantiated during tests.
vi.mock("@app/server-state.ts", () => ({
  gatedWrapHandler: (handler: (input: unknown) => unknown) => handler,
  pluginDir: "/mock/plugin",
  projectDir: "/mock/project",
  registerToolWithUi: vi.fn(),
  resolveScope: () => "/mock/project",
  server: { registerTool: vi.fn() },
}));

// Stub out all other register-knowledge.ts dependencies.
vi.mock("@features/principles/tools/get-principles.ts", () => ({ getPrinciplesBatch: vi.fn() }));
vi.mock("@features/file-context/tools/get-file-context.ts", () => ({ getFileContext: vi.fn() }));
vi.mock("@features/diagnostics/tools/get-drift-report.ts", () => ({ getDriftReport: vi.fn() }));
vi.mock("@features/knowledge-graph/tools/graph-query.ts", () => ({ graphQuery: vi.fn() }));
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
vi.mock("@platform/storage/drift/drift-db-cache.ts", () => ({
  getDriftDb: vi.fn().mockReturnValue({ getSignals: vi.fn().mockReturnValue({}) }),
}));

import { buildSlimmedOutput, type GetContextOutput } from "../register-knowledge.ts";

const FULL_DATA_PATH = "/tmp/get-context-abc123.json";

describe("buildSlimmedOutput", () => {
  it("sets truncated=true and full_data_path on the slimmed result", () => {
    const output: GetContextOutput = {
      file_paths: ["src/foo.ts"],
      include: ["principles"],
    };

    const slimmed = buildSlimmedOutput(output, FULL_DATA_PATH);

    expect(slimmed.truncated).toBe(true);
    expect(slimmed.full_data_path).toBe(FULL_DATA_PATH);
  });

  it("preserves file_paths and include metadata", () => {
    const output: GetContextOutput = {
      file_paths: ["src/foo.ts", "src/bar.ts"],
      include: ["principles", "file_context"],
    };

    const slimmed = buildSlimmedOutput(output, FULL_DATA_PATH);

    expect(slimmed.file_paths).toEqual(["src/foo.ts", "src/bar.ts"]);
    expect(slimmed.include).toEqual(["principles", "file_context"]);
  });

  it("empties principle bodies", () => {
    const output: GetContextOutput = {
      file_paths: ["src/foo.ts"],
      include: ["principles"],
      principles: {
        graph_context_by_file: {},
        principles: [
          { body: "full principle body text", id: "p1", severity: "rule", title: "P1" },
          { body: "another principle body", id: "p2", severity: "convention", title: "P2" },
        ],
        total_in_canon: 10,
        total_matched: 2,
      },
    };

    const slimmed = buildSlimmedOutput(output, FULL_DATA_PATH);

    expect(slimmed.principles).toBeDefined();
    expect(slimmed.principles!.principles[0].body).toBe("");
    expect(slimmed.principles!.principles[1].body).toBe("");
    // Other fields on the principle object preserved
    expect(slimmed.principles!.principles[0].id).toBe("p1");
    expect(slimmed.principles!.principles[1].id).toBe("p2");
    // Top-level principles metadata preserved
    expect(slimmed.principles!.total_matched).toBe(2);
    expect(slimmed.principles!.total_in_canon).toBe(10);
  });

  it("clears file_context content and dependency arrays", () => {
    const output: GetContextOutput = {
      file_context: [
        {
          content: "const x = 1;\nconst y = 2;",
          exports: ["x", "y"],
          file_path: "src/foo.ts",
          imported_by: ["src/bar.ts"],
          imported_by_layer: {},
          imports: ["node:fs"],
          imports_by_layer: {},
          last_verdict: null,
          layer: "app",
          layer_stack: [],
          project_max_impact: 0,
          role: "internal",
          shape: { description: "desc", label: "Internal" },
          summary: null,
          violation_count: 0,
          violations: [],
        },
      ],
      file_paths: ["src/foo.ts"],
      include: ["file_context"],
    };

    const slimmed = buildSlimmedOutput(output, FULL_DATA_PATH);

    expect(slimmed.file_context).toBeDefined();
    const fc = slimmed.file_context![0];
    expect(fc.content).toBe("");
    expect(fc.imports).toEqual([]);
    expect(fc.exports).toEqual([]);
    expect(fc.imported_by).toEqual([]);
    // Non-stripped fields preserved
    expect(fc.file_path).toBe("src/foo.ts");
    expect(fc.layer).toBe("app");
  });

  it("omits principles when not in the original output", () => {
    const output: GetContextOutput = {
      file_paths: ["src/foo.ts"],
      include: ["drift"],
    };

    const slimmed = buildSlimmedOutput(output, FULL_DATA_PATH);

    expect(slimmed.principles).toBeUndefined();
  });

  it("omits file_context when not in the original output", () => {
    const output: GetContextOutput = {
      file_paths: ["src/foo.ts"],
      include: ["principles"],
      principles: {
        graph_context_by_file: {},
        principles: [],
        total_in_canon: 0,
        total_matched: 0,
      },
    };

    const slimmed = buildSlimmedOutput(output, FULL_DATA_PATH);

    expect(slimmed.file_context).toBeUndefined();
  });
});
