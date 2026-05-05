import { getDriftReport } from "@features/diagnostics/tools/get-drift-report.ts";
import { getHistory } from "@features/diagnostics/tools/get-history.ts";
import { storeSummaries } from "@features/diagnostics/tools/store-summaries.ts";
import { getFileContext } from "@features/file-context/tools/get-file-context.ts";
import { codebaseGraph, compactGraph } from "@features/knowledge-graph/tools/codebase-graph.ts";
import { codebaseGraphMaterialize } from "@features/knowledge-graph/tools/codebase-graph-materialize.ts";
import { codebaseGraphPoll } from "@features/knowledge-graph/tools/codebase-graph-poll.ts";
import { codebaseGraphSubmit } from "@features/knowledge-graph/tools/codebase-graph-submit.ts";
import { graphQuery } from "@features/knowledge-graph/tools/graph-query.ts";
import { semanticSearch } from "@features/knowledge-graph/tools/semantic-search.ts";
import { z } from "zod";
import {
  gatedWrapHandler,
  pluginDir,
  projectDir,
  registerToolWithUi,
  server,
} from "./server-state.ts";

const codebaseGraphInputSchema = {
  changed_files: z
    .array(z.string())
    .optional()
    .describe("Explicit list of changed files to highlight"),
  diff_base: z
    .string()
    .optional()
    .describe("Git ref to diff against — marks changed files in the graph"),
  exclude_dirs: z
    .array(z.string())
    .optional()
    .describe("Directories to exclude (default: node_modules, .git, dist, etc.)"),
  include_extensions: z
    .array(z.string())
    .optional()
    .describe("File extensions to include (default: ts, js, py, go, rs)"),
  root_dir: z
    .string()
    .optional()
    .describe(
      "Fallback root directory to scan when no source directories are configured. Ignored if source_dirs are provided in input or derived from layers in .canon/config.json.",
    ),
  source_dirs: z
    .array(z.string())
    .optional()
    .describe(
      "Directories to scan (e.g. ['src', 'lib']). Overrides directories derived from layers in .canon/config.json.",
    ),
};

function registerGraphUiTools(): void {
  registerToolWithUi("codebase_graph", {
    description:
      "Generate a dependency graph of the codebase with Canon compliance overlay. Returns a compact summary (layers, violations, insights).",
    handler: gatedWrapHandler(async (input) => {
      const result = await codebaseGraph(input, projectDir, pluginDir);
      return compactGraph(result);
    }),
    htmlFile: "codebase-graph.html",
    inputSchema: codebaseGraphInputSchema,
    resourceUri: "ui://canon/codebase-graph",
    title: "Codebase Graph",
  });

  registerToolWithUi("get_file_context", {
    description:
      "Get rich context for a source file — contents (up to 200 lines), graph relationships (imports/imported_by), exported names, layer, and compliance data.",
    handler: gatedWrapHandler(async (input) => getFileContext(input, projectDir)),
    htmlFile: "file-context.html",
    inputSchema: {
      file_path: z.string().describe("Project-relative file path (e.g. 'src/api/handler.ts')"),
    },
    resourceUri: "ui://canon/file-context",
    title: "File Context",
  });
}

function registerDiagnosticsTools(): void {
  server.registerTool(
    "store_summaries",
    {
      description:
        "Store file summaries to the KG SQLite database. Summaries are written incrementally — calling multiple times is safe.",
      inputSchema: {
        summaries: z
          .array(
            z.object({
              file_path: z.string().describe("Project-relative file path"),
              summary: z.string().describe("Rich contextual summary of the file's role"),
            }),
          )
          .describe("Array of file summaries to store"),
      },
    },
    gatedWrapHandler(async (input) => storeSummaries(input, projectDir)),
  );

  server.registerTool(
    "get_drift_report",
    {
      description:
        "Returns a full drift report — compliance rates, most violated principles, hotspot directories, trend, recommendations, and PR review history.",
      inputSchema: {
        directory: z.string().optional().describe("Filter to files in a specific directory"),
        last_n: z.number().optional().describe("Only analyze the last N reviews"),
        principle_id: z.string().optional().describe("Filter to a specific principle"),
      },
    },
    gatedWrapHandler(async (input) => getDriftReport(input, projectDir, pluginDir)),
  );

  server.registerTool(
    "get_history",
    {
      description:
        "Query flow execution history with associated decisions and commit data. Returns recent flow runs enriched with decision records from the project's drift store.",
      inputSchema: {
        flow: z.string().optional().describe("Filter by flow name (e.g., 'feature', 'fast-path')"),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .default(20)
          .describe("Maximum number of flow runs to return (default: 20)"),
        project_dir: z.string().describe("Project root directory path"),
      },
    },
    gatedWrapHandler(async (input) => getHistory(input)),
  );
}

function registerGraphQueryTool(): void {
  server.registerTool(
    "graph_query",
    {
      description:
        "Query the codebase knowledge graph for callers, callees, blast radius, dead code, search, and more. Requires the knowledge graph to be built first via codebase_graph.",
      inputSchema: {
        options: z
          .object({
            include_tests: z
              .boolean()
              .optional()
              .describe("Include test files in dead_code results"),
            limit: z
              .number()
              .int()
              .min(1)
              .max(500)
              .optional()
              .describe("Max results for search (default 50)"),
            max_depth: z
              .number()
              .int()
              .min(1)
              .max(10)
              .optional()
              .describe("Max depth for blast_radius (default 3)"),
            min_confidence: z
              .number()
              .min(0)
              .max(1)
              .optional()
              .describe(
                "Minimum confidence threshold for file-edge queries (0–1). Applies to future file-edge query types.",
              ),
          })
          .optional(),
        query_type: z
          .enum(["callers", "callees", "blast_radius", "dead_code", "search", "ancestors"])
          .describe("Type of query to perform"),
        target: z
          .string()
          .optional()
          .describe("Target entity name or file path (not needed for dead_code)"),
      },
    },
    gatedWrapHandler(async (input) => graphQuery(input, projectDir)),
  );
}

function registerSemanticSearchTool(): void {
  server.registerTool(
    "semantic_search",
    {
      description:
        "Search the codebase with natural language. Finds code entities and summaries by meaning, not just name matching. Requires the knowledge graph to be built first via codebase_graph.",
      inputSchema: {
        kind_filter: z
          .array(z.string())
          .optional()
          .describe("Filter results by entity kind (e.g., ['function', 'class'])"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max results to return (default: 20)"),
        query: z
          .string()
          .describe("Natural language search query (e.g., 'error handling middleware')"),
        scope: z
          .enum(["entities", "summaries", "both"])
          .optional()
          .describe("Search scope: entity signatures, AI summaries, or both (default: both)"),
        threshold: z
          .number()
          .optional()
          .describe(
            "Maximum distance threshold — lower means more similar (default: no threshold)",
          ),
      },
    },
    gatedWrapHandler(async (input) => semanticSearch(input, projectDir)),
  );
}

function registerGraphJobTools(): void {
  server.registerTool(
    "codebase_graph_submit",
    {
      description:
        "Submit a background codebase graph generation job. Returns immediately with a job_id for polling. In CI mode (process.env.CI or CANON_SYNC_JOBS=1), runs synchronously and returns a complete result.",
      inputSchema: {
        ...codebaseGraphInputSchema,
        force: z.boolean().optional().describe("Skip cache, force new run"),
      },
    },
    gatedWrapHandler(async (input) => codebaseGraphSubmit(input, projectDir, pluginDir)),
  );

  server.registerTool(
    "codebase_graph_poll",
    {
      description:
        "Poll the status of a background codebase graph job. Returns job_id, status (pending/running/complete/failed/timed_out/cancelled), progress, and error.",
      inputSchema: { job_id: z.string().describe("Job ID returned by codebase_graph_submit") },
    },
    gatedWrapHandler(async (input) => codebaseGraphPoll(input)),
  );

  registerToolWithUi("codebase_graph_materialize", {
    description:
      "Materialize the results of a completed codebase graph job into a visual graph. Job must have status 'complete' (check with codebase_graph_poll first).",
    handler: gatedWrapHandler(async (input) =>
      codebaseGraphMaterialize(input, projectDir, pluginDir),
    ),
    htmlFile: "codebase-graph.html",
    inputSchema: {
      changed_files: z
        .array(z.string())
        .optional()
        .describe("Explicit list of changed files to highlight"),
      detail_level: z
        .enum(["file", "entity"])
        .optional()
        .describe("Graph resolution: file (default) or entity"),
      diff_base: z
        .string()
        .optional()
        .describe("Git ref to diff against — marks changed files in the graph"),
      job_id: z.string().describe("Job ID of a completed codebase graph job"),
    },
    resourceUri: "ui://canon/codebase-graph",
    title: "Codebase Graph",
  });
}

export function registerKnowledgeTools(): void {
  registerGraphUiTools();
  registerDiagnosticsTools();
  registerGraphQueryTool();
  registerSemanticSearchTool();
  registerGraphJobTools();
}
