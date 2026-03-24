#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { readFile } from "fs/promises";
import { getPrinciples } from "./tools/get-principles.js";
import { listPrinciples } from "./tools/list-principles.js";
import { reviewCode } from "./tools/review-code.js";
import { getCompliance } from "./tools/get-compliance.js";
import { report } from "./tools/report.js";
import { getPrReviewData } from "./tools/pr-review-data.js";
import { codebaseGraph, summarizeGraph } from "./tools/codebase-graph.js";
import { getFileContext } from "./tools/get-file-context.js";
import { storeSummaries } from "./tools/store-summaries.js";

import { getDashboardSelection } from "./tools/get-dashboard-selection.js";
import { getDriftReport } from "./tools/get-drift-report.js";
import { getDecisions } from "./tools/get-decisions.js";
import { getPatterns } from "./tools/get-patterns.js";
import { loadFlow } from "./tools/load-flow.js";
import { validateFlows } from "./tools/validate-flows.js";
import { initWorkspaceFlow } from "./tools/init-workspace.js";
import { getSpawnPrompt } from "./tools/get-spawn-prompt.js";
import { reportResult } from "./tools/report-result.js";
import { checkConvergence } from "./tools/check-convergence.js";
import { updateBoard } from "./tools/update-board.js";
import { listOverlays } from "./tools/list-overlays.js";
import { postWaveBulletin } from "./tools/post-wave-bulletin.js";
import { getWaveBulletin } from "./tools/get-wave-bulletin.js";
import { injectWaveEvent } from "./tools/inject-wave-event.js";
import { storePrReview } from "./tools/store-pr-review.js";
import { graphQuery } from "./tools/graph-query.js";
import { reindexFileTool } from "./tools/reindex-file.js";
import { updateDashboardState } from "./tools/update-dashboard-state.js";
import { getBranch } from "./tools/get-branch.js";
import { getFileContent } from "./tools/get-file-content.js";
import { getSummary } from "./tools/get-summary.js";
import { getComplianceTrend } from "./tools/get-compliance-trend.js";
import { getPrReviews } from "./tools/get-pr-reviews.js";
import { getFlowRuns, computeAnalytics } from "./drift/analytics.js";
import { reportInputSchema } from "./schema.js";
import { ResolvedFlowSchema } from "./orchestration/flow-schema.js";

import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

// Resolve project dir: CANON_PROJECT_DIR may be "." (relative) — always make absolute.
// Falls back to cwd which is typically set by Claude Code to the user's project root.
const projectDir = resolve(process.env.CANON_PROJECT_DIR || process.cwd());

// Plugin dir: the repo root that contains the `principles/` directory.
// __filename → src/index.ts (or dist/index.js), dirname twice → mcp-server/, once more → repo root.
// Using dirname(fileURLToPath(...)) is more explicit than URL("..") traversal.
const thisFile = fileURLToPath(import.meta.url);
const mcpServerRoot = dirname(dirname(thisFile));
const pluginDir = resolve(process.env.CANON_PLUGIN_DIR || dirname(mcpServerRoot));

const server = new McpServer({
  name: "canon",
  version: "0.1.0",
});

/** Standard JSON response wrapper for MCP tool results. */
function jsonResponse(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

// --- MCP App: open_dashboard tool + ui://canon/dashboard resource ---

const dashboardResourceUri = "ui://canon/dashboard";

registerAppTool(
  server,
  "open_dashboard",
  {
    title: "Canon Dashboard",
    description:
      "Opens the Canon dependency graph dashboard with architecture insights, compliance overlay, and impact analysis.",
    inputSchema: {},
    _meta: { ui: { resourceUri: dashboardResourceUri } },
  },
  async () => {
    // Return cached graph summary from disk if available; otherwise a status prompt.
    try {
      const graphJson = await readFile(join(projectDir, ".canon", "graph-data.json"), "utf-8");
      const graph = JSON.parse(graphJson);
      return jsonResponse(summarizeGraph(graph));
    } catch {
      return jsonResponse({ status: "no_graph", message: "Run codebase_graph first to generate the dependency graph." });
    }
  },
);

registerAppResource(
  server,
  "Canon Dashboard",
  dashboardResourceUri,
  { mimeType: RESOURCE_MIME_TYPE },
  async () => {
    const html = await readFile(
      join(mcpServerRoot, "dist", "ui", "mcp-app.html"),
      "utf-8",
    );
    return {
      contents: [{ uri: dashboardResourceUri, mimeType: RESOURCE_MIME_TYPE, text: html }],
    };
  },
);

server.registerTool(
  "get_principles",
  {
    description: "Returns Canon principles relevant to the current coding context. Call before generating code.",
    inputSchema: {
      file_path: z.string().optional().describe("Path of the file being worked on"),
      layers: z.array(z.string()).optional().describe("Architectural layers (e.g., api, domain, data)"),
      task_description: z.string().optional().describe("Brief description of the task"),
      summary_only: z.boolean().optional().describe("Return only the summary paragraph instead of full body — reduces context usage by ~60%"),
    },
  },
  async (input) => {
    const result = await getPrinciples(input, projectDir, pluginDir);
    return jsonResponse(result);
  }
);

server.registerTool(
  "list_principles",
  {
    description: "Browse the full Canon principle index. Returns metadata only (no full body) for efficient browsing.",
    inputSchema: {
      filter_severity: z
        .enum(["rule", "strong-opinion", "convention"])
        .optional()
        .describe("Filter by severity level"),
      filter_tags: z.array(z.string()).optional().describe("Filter by tags"),
      filter_layers: z.array(z.string()).optional().describe("Filter by architectural layers"),
      include_archived: z.boolean().optional().describe("Include archived principles in results (default: false)"),
    },
  },
  async (input) => {
    const result = await listPrinciples(input, projectDir, pluginDir);
    return jsonResponse(result);
  }
);

server.registerTool(
  "review_code",
  {
    description: "Returns Canon principles relevant to a file for review. The calling agent evaluates compliance — this tool provides the matched principles and code.",
    inputSchema: {
      code: z.string().describe("The code to review"),
      file_path: z.string().describe("Path of the file being reviewed"),
      context: z.string().optional().describe("Brief description of what the code does"),
    },
  },
  async (input) => {
    const result = await reviewCode(input, projectDir, pluginDir);
    return jsonResponse(result);
  }
);

server.registerTool(
  "get_compliance",
  {
    description: "Returns compliance stats for a specific Canon principle. Shows violation counts, compliance rate, and trend.",
    inputSchema: {
      principle_id: z.string().describe("ID of the principle to check compliance for"),
    },
  },
  async (input) => {
    const result = await getCompliance(input, projectDir, pluginDir);
    return jsonResponse(result);
  }
);

// Tool: report (unified — decisions, patterns, and reviews)
server.registerTool(
  "report",
  {
    description:
      "Log a Canon observation: an intentional deviation (decision), an observed codebase pattern, or a code review result. All feed into drift tracking and the learning loop.",
    inputSchema: reportInputSchema,
  },
  async (input) => {
    const result = await report(input, projectDir);
    return jsonResponse(result);
  }
);

server.registerTool(
  "get_pr_review_data",
  {
    description: "Get PR review data — file list, layer grouping, diff command, and graph-aware review priority for a pull request or branch review.",
    inputSchema: {
      pr_number: z.number().optional().describe("GitHub PR number"),
      branch: z.string().optional().describe("Branch name to review"),
      diff_base: z.string().optional().describe("Base ref for the diff (default: main)"),
      incremental: z.boolean().optional().describe("Only review new commits since last Canon review"),
    },
  },
  async (input) => {
    const result = await getPrReviewData(input, projectDir);
    return jsonResponse(result);
  }
);

server.registerTool(
  "codebase_graph",
  {
    description: "Generate a dependency graph of the codebase with Canon compliance overlay. Full graph is persisted to .canon/graph-data.json. Returns a compact summary (layers, violations, insights).",
    inputSchema: {
      root_dir: z.string().optional().describe("Fallback root directory to scan when no source_dirs are configured. Ignored if source_dirs exist in input or .canon/config.json."),
      source_dirs: z.array(z.string()).optional().describe("Directories to scan (e.g. ['src', 'lib']). Overrides .canon/config.json source_dirs."),
      include_extensions: z.array(z.string()).optional().describe("File extensions to include (default: ts, js, py, go, rs)"),
      exclude_dirs: z.array(z.string()).optional().describe("Directories to exclude (default: node_modules, .git, dist, etc.)"),
      diff_base: z.string().optional().describe("Git ref to diff against — marks changed files in the graph"),
      changed_files: z.array(z.string()).optional().describe("Explicit list of changed files to highlight"),
    },
  },
  async (input) => {
    const result = await codebaseGraph(input, projectDir, pluginDir);
    return jsonResponse(summarizeGraph(result));
  }
);

server.registerTool(
  "get_file_context",
  {
    description: "Get rich context for a source file — contents (up to 200 lines), graph relationships (imports/imported_by), exported names, layer, and compliance data. Use this to understand a file before generating a summary.",
    inputSchema: {
      file_path: z.string().describe("Project-relative file path (e.g. 'src/api/handler.ts')"),
    },
  },
  async (input) => {
    const result = await getFileContext(input, projectDir);
    return jsonResponse(result);
  }
);

server.registerTool(
  "store_summaries",
  {
    description: "Store file summaries to .canon/summaries.json. Merges with existing summaries so you can generate them incrementally.",
    inputSchema: {
      summaries: z.array(z.object({
        file_path: z.string().describe("Project-relative file path"),
        summary: z.string().describe("Rich contextual summary of the file's role"),
      })).describe("Array of file summaries to store"),
    },
  },
  async (input) => {
    const result = await storeSummaries(input, projectDir);
    return jsonResponse(result);
  }
);

server.registerTool(
  "get_dashboard_selection",
  {
    description: "Returns the user's current focus from the Canon dashboard — the selected graph node AND the active editor file with matched principles. Call this at the start of a conversation to understand what the user is working on. Returns layer, summary, dependencies, dependents, content preview, and top 3 principles for the active file.",
    inputSchema: {},
  },
  async () => {
    const result = await getDashboardSelection(projectDir, pluginDir);
    return jsonResponse(result);
  }
);

server.registerTool(
  "get_drift_report",
  {
    description: "Returns a full drift report — compliance rates, most violated principles, hotspot directories, trend, and recommendations. Covers all principles across all reviews.",
    inputSchema: {
      last_n: z.number().optional().describe("Only analyze the last N reviews"),
      principle_id: z.string().optional().describe("Filter to a specific principle"),
      directory: z.string().optional().describe("Filter to files in a specific directory"),
    },
  },
  async (input) => {
    const result = await getDriftReport(input, projectDir, pluginDir);
    return jsonResponse(result);
  }
);

server.registerTool(
  "get_decisions",
  {
    description: "Returns intentional deviation decisions grouped by principle, with category counts. Use for understanding why principles are overridden.",
    inputSchema: {
      principle_id: z.string().optional().describe("Filter to decisions for a specific principle"),
      limit: z.number().optional().describe("Max number of principle groups to return"),
    },
  },
  async (input) => {
    const result = await getDecisions(input, projectDir);
    return jsonResponse(result);
  }
);

server.registerTool(
  "get_patterns",
  {
    description: "Returns observed codebase patterns logged by agents, grouped and deduplicated. Use to find pre-validated patterns before scanning.",
    inputSchema: {
      limit: z.number().optional().describe("Max number of pattern groups to return"),
    },
  },
  async (input) => {
    const result = await getPatterns(input, projectDir);
    return jsonResponse(result);
  }
);

server.registerTool(
  "load_flow",
  {
    description: "Load and resolve a Canon flow definition. Returns the resolved flow with fragment resolution, spawn instructions, and a state adjacency graph.",
    inputSchema: {
      flow_name: z.string().describe("Name of the flow file (without .md extension)"),
    },
  },
  async (input) => {
    const result = await loadFlow(input, pluginDir);
    return jsonResponse(result);
  }
);

server.registerTool(
  "validate_flows",
  {
    description: "Validate Canon flow definitions. Checks parsing, fragment resolution, transition targets, reachability, and terminal state accessibility.",
    inputSchema: {
      flow_name: z.string().optional().describe("Validate a specific flow (omit to validate all)"),
    },
  },
  async (input) => {
    const result = await validateFlows(input, pluginDir);
    return jsonResponse(result);
  }
);

server.registerTool(
  "init_workspace",
  {
    description: "Initialize a Canon workspace for flow execution. Creates workspace directory, session.json, and board.json. Resumes from existing board if present.",
    inputSchema: {
      flow_name: z.string(),
      task: z.string(),
      branch: z.string(),
      base_commit: z.string(),
      tier: z.enum(["small", "medium", "large"]),
      original_input: z.string().optional(),
      skip_flags: z.array(z.string()).optional(),
    },
  },
  async (input) => {
    const result = await initWorkspaceFlow(input, projectDir, pluginDir);
    return jsonResponse(result);
  }
);

server.registerTool(
  "get_spawn_prompt",
  {
    description: "Resolve spawn prompts for a flow state. Substitutes variables, applies templates, and fans out by state type (single/parallel/wave/parallel-per).",
    inputSchema: {
      workspace: z.string(),
      state_id: z.string(),
      flow: ResolvedFlowSchema.describe("Resolved flow object from load_flow"),
      variables: z.record(z.string(), z.string()),
      items: z.array(z.any()).optional(),
      role: z.string().optional(),
      overlays: z.array(z.string()).optional().describe("Role overlay names to inject"),
      wave: z.number().optional().describe("Current wave number (enables bulletin instructions)"),
      peer_count: z.number().optional().describe("Number of peer agents in the wave"),
    },
  },
  async (input) => {
    const result = await getSpawnPrompt({ ...input, project_dir: projectDir });
    return jsonResponse(result);
  }
);

server.registerTool(
  "report_result",
  {
    description: "Report an agent's result. Normalizes status, evaluates transitions, updates board state, checks stuck detection. Returns next state and whether HITL is required.",
    inputSchema: {
      workspace: z.string(),
      state_id: z.string(),
      status_keyword: z.string(),
      flow: ResolvedFlowSchema.describe("Resolved flow object from load_flow"),
      artifacts: z.array(z.string()).optional(),
      concern_text: z.string().optional(),
      error: z.string().optional(),
      metrics: z.object({ duration_ms: z.number(), spawns: z.number(), model: z.string() }).optional(),
      principle_ids: z.array(z.string()).optional().describe("Violation principle IDs for same_violations stuck detection"),
      file_paths: z.array(z.string()).optional().describe("Violating file paths for same_violations stuck detection"),
      file_test_pairs: z.array(z.object({ file: z.string(), test: z.string() })).optional().describe("File/test pairs for same_file_test stuck detection"),
      commit_sha: z.string().optional().describe("Current commit SHA for no_progress stuck detection"),
      artifact_count: z.number().optional().describe("Current artifact count for no_progress stuck detection"),
      parallel_results: z.array(z.object({
        item: z.string(),
        status: z.string(),
        artifacts: z.array(z.string()).optional(),
      })).optional().describe("Results from parallel-per execution — triggers aggregation"),
    },
  },
  async (input) => {
    const result = await reportResult({ ...input, project_dir: projectDir });
    return jsonResponse(result);
  }
);

server.registerTool(
  "check_convergence",
  {
    description: "Check whether a state can be re-entered based on iteration limits. Returns iteration count, max, cannot-fix items, and history.",
    inputSchema: {
      workspace: z.string(),
      state_id: z.string(),
    },
  },
  async (input) => {
    const result = await checkConvergence(input);
    return jsonResponse(result);
  }
);

server.registerTool(
  "update_board",
  {
    description: "Perform board state mutations. Supports entering, skipping, blocking, unblocking states, completing flow, and setting wave progress.",
    inputSchema: {
      workspace: z.string(),
      action: z.enum(["enter_state", "skip_state", "block", "unblock", "complete_flow", "set_wave_progress", "set_metadata"]),
      state_id: z.string().optional().describe("Required for enter_state, skip_state, block, unblock, set_wave_progress"),
      next_state_id: z.string().optional().describe("Next state to advance to (used with skip_state)"),
      blocked_reason: z.string().optional(),
      wave_data: z.object({ wave: z.number(), wave_total: z.number(), tasks: z.array(z.string()) }).optional(),
      result: z.string().optional(),
      artifacts: z.array(z.string()).optional(),
      metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Key-value metadata to merge into board (used with set_metadata)"),
    },
  },
  async (input) => {
    const result = await updateBoard(input);
    return jsonResponse(result);
  }
);

server.registerTool(
  "list_overlays",
  {
    description: "List available role overlays. Overlays are expertise lenses injected into agent spawn prompts. Optionally filter by target agent.",
    inputSchema: {
      agent: z.string().optional().describe("Filter overlays applicable to a specific agent"),
    },
  },
  async (input) => {
    const result = await listOverlays(input, projectDir);
    return jsonResponse(result);
  }
);

server.registerTool(
  "post_wave_bulletin",
  {
    description: "Post a message to the wave bulletin for inter-agent communication during parallel execution. Agents use this to share created utilities, patterns, and gotchas.",
    inputSchema: {
      workspace: z.string(),
      wave: z.number(),
      from: z.string().describe("Task ID or agent name of the poster"),
      type: z.enum(["created_utility", "established_pattern", "discovered_gotcha", "needs_input", "fyi"]),
      summary: z.string().describe("One-line human-readable description"),
      detail: z.object({
        path: z.string().optional(),
        exports: z.array(z.string()).optional(),
        pattern: z.string().optional(),
        issue: z.string().optional(),
      }).optional(),
    },
  },
  async (input) => {
    const result = await postWaveBulletin(input);
    return jsonResponse(result);
  }
);

server.registerTool(
  "get_wave_bulletin",
  {
    description: "Read messages from the wave bulletin. Returns messages posted by other agents in the same wave, optionally filtered by timestamp or type.",
    inputSchema: {
      workspace: z.string(),
      wave: z.number(),
      since: z.string().optional().describe("ISO timestamp — only return messages after this time"),
      type: z.string().optional().describe("Filter by message type"),
      include_events: z.boolean().optional().describe("Also return pending wave events"),
    },
  },
  async (input) => {
    const result = await getWaveBulletin(input);
    return jsonResponse(result);
  }
);

server.registerTool(
  "inject_wave_event",
  {
    description: "Inject a user event into a running wave execution. Events are applied at wave boundaries (between waves). Use to add tasks, skip tasks, inject context, provide guidance, or pause execution.",
    inputSchema: {
      workspace: z.string(),
      type: z.enum(["add_task", "skip_task", "reprioritize", "inject_context", "guidance", "pause"]),
      payload: z.object({
        task_id: z.string().optional().describe("Task ID to skip or reprioritize"),
        description: z.string().optional().describe("Description for add_task, inject_context, or guidance"),
        context: z.string().optional().describe("Additional context"),
        wave: z.number().optional().describe("Target wave number (defaults to next wave)"),
      }),
    },
  },
  async (input) => {
    const result = await injectWaveEvent(input);
    return jsonResponse(result);
  }
);

server.registerTool(
  "store_pr_review",
  {
    description: "Store a PR review result for drift tracking. Server generates pr_review_id and timestamp.",
    inputSchema: {
      pr_number: z.number().optional().describe("GitHub PR number"),
      branch: z.string().optional().describe("Branch name reviewed"),
      last_reviewed_sha: z.string().optional().describe("Last commit SHA that was reviewed"),
      verdict: z.enum(["BLOCKING", "WARNING", "CLEAN"]).describe("Overall review verdict"),
      files: z.array(z.string()).describe("File paths that were reviewed"),
      violations: z.array(
        z.object({
          principle_id: z.string(),
          severity: z.string(),
          file_path: z.string().optional().describe("Specific file where violation occurred"),
          impact_score: z.number().optional().describe("Graph-derived impact score"),
        })
      ).describe("Principle violations found"),
      honored: z.array(z.string()).describe("IDs of principles honored"),
      score: z.object({
        rules: z.object({ passed: z.number(), total: z.number() }),
        opinions: z.object({ passed: z.number(), total: z.number() }),
        conventions: z.object({ passed: z.number(), total: z.number() }),
      }).describe("Compliance score breakdown"),
      file_priorities: z.array(
        z.object({
          path: z.string(),
          priority_score: z.number(),
        })
      ).optional().describe("Graph-derived file review priorities"),
    },
  },
  async (input) => {
    const result = await storePrReview(input, projectDir);
    return jsonResponse(result);
  }
);

server.registerTool(
  "graph_query",
  {
    description: "Query the codebase knowledge graph for callers, callees, blast radius, dead code, search, and more. Requires the knowledge graph to be built first via codebase_graph.",
    inputSchema: {
      query_type: z
        .enum(['callers', 'callees', 'blast_radius', 'dead_code', 'search', 'ancestors'])
        .describe('Type of query to perform'),
      target: z
        .string()
        .optional()
        .describe('Target entity name or file path (not needed for dead_code)'),
      options: z
        .object({
          max_depth: z.number().int().min(1).max(10).optional().describe('Max depth for blast_radius (default 3)'),
          limit: z.number().int().min(1).max(500).optional().describe('Max results for search (default 50)'),
          include_tests: z.boolean().optional().describe('Include test files in dead_code results'),
        })
        .optional(),
    },
  },
  async (input) => {
    const result = graphQuery(input, projectDir);
    return jsonResponse(result);
  }
);

server.registerTool(
  "reindex_file",
  {
    description: "Incrementally reindex a single file in the knowledge graph. Updates entity and edge data for the given file, then rematerializes graph-data.json. Handles missing files (deletion), path traversal rejection, and DB initialization.",
    inputSchema: {
      file_path: z.string().describe("Project-relative path to the file to reindex (e.g. 'src/tools/my-tool.ts')"),
    },
  },
  async (input) => {
    const result = await reindexFileTool(input, projectDir);
    return jsonResponse(result);
  }
);

server.registerTool(
  "get_flow_analytics",
  {
    description: "Get flow execution analytics — average durations, bottleneck states, skip rates, and spawn counts. Useful for identifying slow states and optimization opportunities.",
    inputSchema: {
      flow: z.string().optional().describe("Filter to a specific flow name"),
    },
  },
  async (input) => {
    const runs = await getFlowRuns(projectDir, input.flow);
    const analytics = computeAnalytics(runs);
    return jsonResponse(analytics);
  }
);

// --- Dashboard support tools (called by MCP App iframe via app.callServerTool()) ---

registerAppTool(
  server,
  "update_dashboard_state",
  {
    description:
      "Write the currently selected graph node to .canon/dashboard-state.json. Called by the Canon dashboard to persist user selection so get_dashboard_selection can read it.",
    inputSchema: {
      selectedNode: z
        .object({
          id: z.string().min(1).describe("Project-relative file path of the selected node"),
          layer: z.string(),
          summary: z.string(),
          violation_count: z.number().int().min(0),
        })
        .nullable()
        .optional()
        .describe("The selected node, or null to clear the selection"),
    },
    _meta: { ui: { resourceUri: dashboardResourceUri, visibility: ["app"] } },
  },
  async (input) => {
    const result = await updateDashboardState(input, projectDir);
    return jsonResponse(result);
  },
);

registerAppTool(
  server,
  "get_branch",
  {
    description: "Returns the current git branch name. Used by the Canon dashboard to display context.",
    inputSchema: {},
    _meta: { ui: { resourceUri: dashboardResourceUri, visibility: ["app"] } },
  },
  async () => {
    const result = await getBranch(projectDir);
    return jsonResponse(result);
  },
);

registerAppTool(
  server,
  "get_file_content",
  {
    description:
      "Read the content of a file within the project directory. Rejects path traversal attempts. Returns null content with an error message when the file is missing or the path is invalid.",
    inputSchema: {
      file_path: z.string().min(1).describe("Project-relative file path (e.g. 'src/tools/my-tool.ts')"),
    },
    _meta: { ui: { resourceUri: dashboardResourceUri, visibility: ["app"] } },
  },
  async (input) => {
    const result = await getFileContent(input, projectDir);
    return jsonResponse(result);
  },
);

registerAppTool(
  server,
  "get_summary",
  {
    description:
      "Return the stored summary for a file from .canon/summaries.json. Falls back to the first 5 lines of the file when no summary is stored.",
    inputSchema: {
      file_id: z
        .string()
        .min(1)
        .describe("Project-relative file path (key used in summaries.json)"),
    },
    _meta: { ui: { resourceUri: dashboardResourceUri, visibility: ["app"] } },
  },
  async (input) => {
    const result = await getSummary(input, projectDir);
    return jsonResponse(result);
  },
);

registerAppTool(
  server,
  "get_compliance_trend",
  {
    description:
      "Compute the weekly compliance pass rate for a principle from .canon/reviews.jsonl. Returns an array of { week, pass_rate } points sorted by week.",
    inputSchema: {
      principle_id: z.string().min(1).describe("ID of the principle to compute trend for"),
    },
    _meta: { ui: { resourceUri: dashboardResourceUri, visibility: ["app"] } },
  },
  async (input) => {
    const result = await getComplianceTrend(input, projectDir);
    return jsonResponse(result);
  },
);

// get_pr_reviews: dual visibility — LLM-visible AND app-callable (user decision)
registerAppTool(
  server,
  "get_pr_reviews",
  {
    description:
      "Return stored PR reviews from .canon/pr-reviews.jsonl. Each entry includes verdict, violations, score, and file list. Use this to review Canon's audit history for pull requests.",
    inputSchema: {},
    _meta: { ui: { resourceUri: dashboardResourceUri, visibility: ["app", "model"] } },
  },
  async () => {
    const result = await getPrReviews(projectDir);
    return jsonResponse(result);
  },
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Canon MCP server error:", error);
  process.exit(1);
});
