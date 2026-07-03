import {
  type CheckContextStalenessInput,
  checkContextStaleness,
} from "@features/diagnostics/tools/check-context-staleness.ts";
import { getDriftReport } from "@features/diagnostics/tools/get-drift-report.ts";
import { getHistory } from "@features/diagnostics/tools/get-history.ts";
import { storeSummaries } from "@features/diagnostics/tools/store-summaries.ts";
import {
  ALL_CLASSES,
  type SyncIndexesInput,
  syncIndexes,
} from "@features/diagnostics/tools/sync-indexes.ts";
import { wikiLint } from "@features/diagnostics/tools/wiki-lint.ts";
import { getFileContext } from "@features/file-context/tools/get-file-context.ts";
import { ensureGraphFresh } from "@features/knowledge-graph/ensure-graph-fresh.ts";
import { codebaseGraph, compactGraph } from "@features/knowledge-graph/tools/codebase-graph.ts";
import { codebaseGraphMaterialize } from "@features/knowledge-graph/tools/codebase-graph-materialize.ts";
import { codebaseGraphPoll } from "@features/knowledge-graph/tools/codebase-graph-poll.ts";
import { codebaseGraphSubmit } from "@features/knowledge-graph/tools/codebase-graph-submit.ts";
import { graphQuery } from "@features/knowledge-graph/tools/graph-query.ts";
import { searchKnowledge } from "@features/knowledge-graph/tools/search-knowledge.ts";
import { semanticSearch } from "@features/knowledge-graph/tools/semantic-search.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  buildSlimmedOutput,
  type GetContextOutput,
  getContextInputSchema,
  handleGetContext,
  type SlimmedDriftOutput,
} from "./get-context-handler.ts";
import { gatedWrapHandler, pluginDir, registerToolWithUi, resolveScope } from "./server-state.ts";

// Re-export for test compatibility — existing tests import these from register-knowledge.ts
export type { GetContextOutput, SlimmedDriftOutput };
export { buildSlimmedOutput, handleGetContext };

/**
 * Canonical list of all valid wiki_lint check names.
 * Exported so tests can validate the zod schema's enum membership against the
 * CheckName union in wiki-lint.ts — the two must stay in sync.
 */
export const WIKI_LINT_CHECK_NAMES = [
  "cited_paths",
  "contradictions",
  "duplicate_titles",
  "frontmatter_schema",
  "glossary_consistency",
  "link_integrity",
  "missing_examples",
  "misrouted_principles",
  "orphan_principles",
  "scope_layers",
  "scope_tags",
  "index_drift",
  "stale_refs",
] as const;

export type WikiLintCheckName = (typeof WIKI_LINT_CHECK_NAMES)[number];

function registerCompositeContextTool(server: McpServer): void {
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

function registerGraphUiTools(server: McpServer): void {
  registerToolWithUi(server, "codebase_graph", {
    description:
      "Generate a dependency graph of the codebase with Canon compliance overlay. Returns a compact summary (layers, violations, insights).",
    handler: gatedWrapHandler(async (input, extra) => {
      const result = await codebaseGraph(input, resolveScope(extra), pluginDir);
      return compactGraph(result);
    }),
    htmlFile: "codebase-graph.html",
    inputSchema: codebaseGraphInputSchema,
    resourceUri: "ui://canon/codebase-graph",
    title: "Codebase Graph",
  });

  registerToolWithUi(server, "get_file_context", {
    description:
      "Get rich context for a source file — contents (up to 200 lines), graph relationships (imports/imported_by), exported names, layer, and compliance data.",
    handler: gatedWrapHandler(async (input, extra) => getFileContext(input, resolveScope(extra))),
    htmlFile: "file-context.html",
    inputSchema: {
      file_path: z.string().describe("Project-relative file path (e.g. 'src/api/handler.ts')"),
    },
    resourceUri: "ui://canon/file-context",
    title: "File Context",
  });
}

function registerDiagnosticsTools(server: McpServer): void {
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
    gatedWrapHandler(async (input, extra) => storeSummaries(input, resolveScope(extra))),
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
    gatedWrapHandler(async (input, extra) => getDriftReport(input, resolveScope(extra), pluginDir)),
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

function registerContextStalenessTool(server: McpServer): void {
  server.registerTool(
    "check_context_staleness",
    {
      description:
        "Check whether the installed Canon context artifacts (principles, rules, references, primers, agents, templates) match the committed context-manifest.json. Returns a StalenessReport listing drifted, missing, and extra files.",
      inputSchema: {
        manifest_path: z
          .string()
          .optional()
          .describe(
            "Explicit path to the committed manifest JSON file (default: <project_dir>/context-manifest.json)",
          ),
        project_dir: z.string().describe("Project root directory path"),
      },
    },
    gatedWrapHandler(async (input: CheckContextStalenessInput) => checkContextStaleness(input)),
  );
}

function registerSyncIndexesTool(server: McpServer): void {
  server.registerTool(
    "sync_indexes",
    {
      description:
        "Regenerate the sentinel-delimited inventory block of one or all sibling artifact-class indexes (rules, principles, agents, templates, references, primers), preserving prose outside the markers.",
      inputSchema: {
        class: z
          .enum(ALL_CLASSES)
          .optional()
          .describe(
            "Artifact class to sync (default: all 6). Options: rules, principles, agents, templates, references, primers",
          ),
        project_dir: z
          .string()
          .optional()
          .describe(
            "Target project root to write indexes under (default: the session-bound project root). Supply the build worktree path to sync indexes inside a worktree instead of the main repo.",
          ),
      },
    },
    gatedWrapHandler(async (input: SyncIndexesInput, extra) =>
      syncIndexes(input, resolveScope(extra)),
    ),
  );
}

function registerWikiLintTool(server: McpServer): void {
  server.registerTool(
    "wiki_lint",
    {
      description:
        "Lint Canon's own meta-layer artifacts — detects contradictions between CLAUDE.md files, orphan principles, stale file references, principles missing examples, cited paths in references/ that do not resolve, invalid scope.layers values, invalid scope.tags values outside the KG computed-tag vocabulary, glossary self-consistency (duplicate or ambiguous CONTEXT.md terms), index_drift (inventory block mismatch or missing sentinel markers in sibling artifact-class indexes), duplicate_titles (two principles sharing the same title), misrouted_principles (portable:false principles living in the shipped principles/ tree), frontmatter_schema (per-class Zod validation of principle/agent/template/ADR frontmatter), and link_integrity (broken [[wiki-link]]/relative-md/ADR references and true orphan principles via the inbound-link graph).",
      inputSchema: {
        checks: z
          .array(z.enum(WIKI_LINT_CHECK_NAMES))
          .optional()
          .describe(
            "Checks to run (default: all except index_drift — pass ['index_drift'] explicitly to run it). Options: cited_paths, contradictions, duplicate_titles, frontmatter_schema, glossary_consistency, index_drift, link_integrity, missing_examples, misrouted_principles, orphan_principles, scope_layers, scope_tags, stale_refs",
          ),
      },
    },
    gatedWrapHandler(async (input, extra) => wikiLint(input, resolveScope(extra), pluginDir)),
  );
}

function registerGraphQueryTool(server: McpServer): void {
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
    gatedWrapHandler(async (input, extra) => {
      const dir = resolveScope(extra);
      // Lazily refresh the structural KG when HEAD moved before reading.
      // graphQuery stays synchronous — gate at this async handler boundary.
      await ensureGraphFresh(dir);
      return graphQuery(input, dir);
    }),
  );
}

function registerSemanticSearchTool(server: McpServer): void {
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
    gatedWrapHandler(async (input, extra) => {
      const dir = resolveScope(extra);
      // Lazily refresh the structural KG when HEAD moved before reading.
      await ensureGraphFresh(dir);
      return semanticSearch(input, dir);
    }),
  );
}

function registerSearchKnowledgeTool(server: McpServer): void {
  server.registerTool(
    "search_knowledge",
    {
      description:
        "Search the Canon knowledge corpus (principles, references, agents, primers, memory digest) with natural language. Returns verbatim chunk content and heading path. Requires the knowledge graph to be built first via codebase_graph.",
      inputSchema: {
        corpora: z
          .array(z.string())
          .optional()
          .describe("Restrict search to specific corpus names (e.g., ['principles', 'agents'])"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max results to return (default: 10)"),
        query: z
          .string()
          .describe("Natural language search query (e.g., 'how should I handle errors')"),
        trust: z
          .enum(["internal", "any"])
          .optional()
          .describe(
            "Trust-tier filter: 'internal' (default) excludes external-tier chunks; 'any' includes all",
          ),
      },
    },
    gatedWrapHandler(async (input, extra) => {
      const dir = resolveScope(extra);
      return searchKnowledge(input, dir);
    }),
  );
}

function registerGraphJobTools(server: McpServer): void {
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
    gatedWrapHandler(async (input, extra) =>
      codebaseGraphSubmit(input, resolveScope(extra), pluginDir),
    ),
  );

  server.registerTool(
    "codebase_graph_poll",
    {
      description:
        "Poll the status of a background codebase graph job. Returns job_id, status (pending/running/complete/failed/timed_out/cancelled), progress, and error.",
      inputSchema: { job_id: z.string().describe("Job ID returned by codebase_graph_submit") },
    },
    gatedWrapHandler(async (input, extra) => codebaseGraphPoll(input, resolveScope(extra))),
  );

  registerToolWithUi(server, "codebase_graph_materialize", {
    description:
      "Materialize the results of a completed codebase graph job into a visual graph. Job must have status 'complete' (check with codebase_graph_poll first).",
    handler: gatedWrapHandler(async (input, extra) =>
      codebaseGraphMaterialize(input, resolveScope(extra), pluginDir),
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

export function registerKnowledgeTools(server: McpServer): void {
  registerGraphUiTools(server);
  registerDiagnosticsTools(server);
  registerWikiLintTool(server);
  registerSyncIndexesTool(server);
  registerContextStalenessTool(server);
  registerGraphQueryTool(server);
  registerSemanticSearchTool(server);
  registerSearchKnowledgeTool(server);
  registerGraphJobTools(server);
  registerCompositeContextTool(server);
}
