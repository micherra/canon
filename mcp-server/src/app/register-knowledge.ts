import { join } from "node:path";
import type { AccuracyMap } from "@features/diagnostics/services/prediction-accuracy.ts";
import {
  buildAccuracySummary,
  computeAccuracy,
} from "@features/diagnostics/services/prediction-accuracy.ts";
import { recordPrediction } from "@features/diagnostics/services/prediction-tracker.ts";
import type { FileSignals } from "@features/diagnostics/services/signal-compiler.ts";
import { compileSignals } from "@features/diagnostics/services/signal-compiler.ts";
import { getDriftReport } from "@features/diagnostics/tools/get-drift-report.ts";
import { getHistory } from "@features/diagnostics/tools/get-history.ts";
import { storeSummaries } from "@features/diagnostics/tools/store-summaries.ts";
import type { FileContextOutput } from "@features/file-context/tools/get-file-context.ts";
import { getFileContext } from "@features/file-context/tools/get-file-context.ts";
import { codebaseGraph, compactGraph } from "@features/knowledge-graph/tools/codebase-graph.ts";
import { codebaseGraphMaterialize } from "@features/knowledge-graph/tools/codebase-graph-materialize.ts";
import { codebaseGraphPoll } from "@features/knowledge-graph/tools/codebase-graph-poll.ts";
import { codebaseGraphSubmit } from "@features/knowledge-graph/tools/codebase-graph-submit.ts";
import { graphQuery } from "@features/knowledge-graph/tools/graph-query.ts";
import { semanticSearch } from "@features/knowledge-graph/tools/semantic-search.ts";
import type { GetPrinciplesBatchOutput } from "@features/principles/tools/get-principles.ts";
import { getPrinciplesBatch } from "@features/principles/tools/get-principles.ts";
import { getDriftDb } from "@platform/storage/drift/drift-db.ts";
import { CANON_DIR } from "@shared/constants.ts";
import { applyDisclosure } from "@shared/lib/progressive-disclosure.ts";
import { z } from "zod";
import {
  gatedWrapHandler,
  pluginDir,
  projectDir,
  registerToolWithUi,
  server,
} from "./server-state.ts";

// --- get_context composite tool ---

type IncludeSection = "principles" | "file_context" | "drift" | "graph" | "signals";

export type GetContextOutput = {
  file_paths: string[];
  include: IncludeSection[];
  principles?: GetPrinciplesBatchOutput;
  file_context?: FileContextOutput[];
  drift?: Awaited<ReturnType<typeof getDriftReport>>;
  graph?: unknown;
  signals?: FileSignals[];
  /** Wave 3: Per-principle accuracy summary for learner agent consumption. */
  accuracy_summary?: string;
  /** When true, response was truncated due to size. Full data at full_data_path. */
  truncated?: boolean;
  /** Absolute path to full response JSON when truncated is true. */
  full_data_path?: string;
};

const getContextInputSchema = {
  file_paths: z.array(z.string()).describe("File paths to get context for"),
  include: z
    .array(z.enum(["principles", "file_context", "drift", "graph", "signals"]))
    .optional()
    .describe("Sections to include (default: all)"),
};

const ALL_SECTIONS: IncludeSection[] = ["principles", "file_context", "drift", "graph", "signals"];

/**
 * Query blast_radius for each file path and return the aggregate results.
 * Skips files where KG is not indexed or returns a recoverable error.
 * Returns undefined when no results could be collected.
 */
function queryGraphForFiles(filePaths: string[]): unknown[] | undefined {
  if (filePaths.length === 0) return undefined;
  const aggregated: unknown[] = [];
  for (const target of filePaths) {
    const result = graphQuery({ query_type: "blast_radius", target }, projectDir);
    if (result.ok) aggregated.push(result);
  }
  return aggregated.length > 0 ? aggregated : undefined;
}

/**
 * Populate output.signals and output.accuracy_summary for the signals section.
 * Fail-open: any error (missing drift.db, missing tables) is silently ignored.
 * Signals are optional enrichment — their absence must not prevent get_context from returning.
 *
 * Wave 3: Computes per-principle accuracy data (fail-open) and passes it to
 * compileSignals for weight tuning. Also populates accuracy_summary when data exists.
 */
function resolveSignals(filePaths: string[], output: GetContextOutput): void {
  try {
    const driftDb = getDriftDb(projectDir);
    const driftDbSignals = driftDb.getSignals();

    // Wave 3: Compute accuracy data (fail-open — errors silently ignored)
    let accuracyData: AccuracyMap | undefined;
    try {
      accuracyData = computeAccuracy(driftDbSignals);
    } catch {
      // Fail-open: accuracy computation failure = no tuning
    }

    const signals = compileSignals(filePaths, driftDbSignals, { accuracyData });
    if (signals.length > 0) {
      output.signals = signals;

      // Record prediction — fail-open, separate from signal compilation.
      // If recordPrediction fails, signals are still returned.
      recordPrediction({ compiledSignals: signals, filePaths }, driftDbSignals);
    }

    // Wave 3: Include accuracy summary for learner context
    if (accuracyData && accuracyData.size > 0) {
      try {
        const summary = buildAccuracySummary(accuracyData);
        if (summary) {
          output.accuracy_summary = summary;
        }
      } catch {
        // Fail-open: summary generation failure is non-critical
      }
    }
  } catch {
    // Fail-open: signals section is optional enrichment.
  }
}

/**
 * Produce a compact summary string for a GetContextOutput for disclosure logging.
 * Reports section presence and counts without including full payloads.
 */
function summarizeContextOutput(data: GetContextOutput): string {
  const parts: string[] = [
    `Files: ${data.file_paths.join(", ")}`,
    `Sections: ${data.include.join(", ")}`,
  ];
  if (data.principles) {
    const count = Array.isArray(data.principles.principles)
      ? data.principles.principles.length
      : "batch";
    parts.push(`Principles: ${count} matched`);
  }
  if (data.file_context) parts.push(`File contexts: ${data.file_context.length} files`);
  if (data.drift) parts.push("Drift: included");
  if (data.graph) parts.push("Graph: included");
  if (data.signals) parts.push(`Signals: ${data.signals.length} files`);
  return parts.join("\n");
}

/**
 * Build a slimmed GetContextOutput for truncated responses.
 * Preserves routing metadata but strips large payloads (bodies, content, dependency lists).
 */
export function buildSlimmedOutput(
  output: GetContextOutput,
  fullDataPath: string,
): GetContextOutput {
  const slimmed: GetContextOutput = {
    file_paths: output.file_paths,
    full_data_path: fullDataPath,
    include: output.include,
    truncated: true,
  };
  if (output.principles) {
    slimmed.principles = {
      ...output.principles,
      principles: output.principles.principles.map((p) => ({ ...p, body: "" })),
    };
  }
  if (output.file_context) {
    slimmed.file_context = output.file_context.map((fc) => ({
      ...fc,
      content: "",
      exports: [],
      imported_by: [],
      imports: [],
    }));
  }
  if (output.drift !== undefined) slimmed.drift = output.drift;
  if (output.graph !== undefined) slimmed.graph = output.graph;
  if (output.signals !== undefined) slimmed.signals = output.signals;
  if (output.accuracy_summary !== undefined) slimmed.accuracy_summary = output.accuracy_summary;
  return slimmed;
}

/**
 * Apply progressive disclosure to the assembled GetContextOutput.
 * Returns the output unchanged when under threshold; returns a slimmed version
 * with a file pointer when over threshold.
 */
function applyContextDisclosure(output: GetContextOutput): GetContextOutput {
  const disclosure = applyDisclosure(output, {
    filePrefix: "get-context",
    outputDir: join(projectDir, CANON_DIR, "artifacts"),
    summarize: summarizeContextOutput,
  });
  if (disclosure.truncated) {
    return buildSlimmedOutput(output, disclosure.full_data_path);
  }
  return output;
}

async function handleGetContext(input: {
  file_paths: string[];
  include?: IncludeSection[];
}): Promise<GetContextOutput> {
  const sections: IncludeSection[] = input.include ?? ALL_SECTIONS;
  const output: GetContextOutput = {
    file_paths: input.file_paths,
    include: sections,
  };

  // Collect promises for sections that can run in parallel
  const tasks: Promise<void>[] = [];

  if (sections.includes("principles")) {
    tasks.push(
      getPrinciplesBatch(
        { file_paths: input.file_paths, summary_only: true },
        projectDir,
        pluginDir,
      ).then((result) => {
        output.principles = result;
      }),
    );
  }

  if (sections.includes("file_context")) {
    tasks.push(
      Promise.all(input.file_paths.map((fp) => getFileContext({ file_path: fp }, projectDir))).then(
        (settled) => {
          const results: FileContextOutput[] = [];
          for (let i = 0; i < settled.length; i++) {
            const result = settled[i];
            if (!result.ok) {
              throw new Error(`file_context error (${result.error_code}): ${result.message}`);
            }
            const { ok, ...data } = result;
            results.push(data as FileContextOutput);
          }
          output.file_context = results;
        },
      ),
    );
  }

  if (sections.includes("drift")) {
    tasks.push(
      getDriftReport({}, projectDir, pluginDir).then((result) => {
        output.drift = result;
      }),
    );
  }

  if (sections.includes("graph")) {
    // graph section: skip gracefully when KG is not indexed.
    // Query blast_radius for each file and aggregate the results.
    tasks.push(
      Promise.resolve().then(() => {
        const results = queryGraphForFiles(input.file_paths);
        if (results !== undefined) output.graph = results;
      }),
    );
  }

  if (sections.includes("signals")) {
    tasks.push(Promise.resolve().then(() => resolveSignals(input.file_paths, output)));
  }

  await Promise.all(tasks);
  return applyContextDisclosure(output);
}

export { handleGetContext };

function registerCompositeContextTool(): void {
  server.registerTool(
    "get_context",
    {
      description:
        "Composite context tool — fetches principles, file context, drift report, and graph data in one call. Reduces round-trips when agents need full context for a set of files.",
      inputSchema: getContextInputSchema,
    },
    gatedWrapHandler(handleGetContext),
  );
}

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
              .describe("Minimum confidence threshold for computed_tags (0-1)"),
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
  registerCompositeContextTool();
}
