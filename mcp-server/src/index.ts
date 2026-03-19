#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
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
import { reportInputSchema } from "./schema.js";

import { dirname, resolve } from "path";
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

// Tool: get_principles
server.tool(
  "get_principles",
  "Returns Canon principles relevant to the current coding context. Call before generating code.",
  {
    file_path: z.string().optional().describe("Path of the file being worked on"),
    layers: z.array(z.string()).optional().describe("Architectural layers (e.g., api, domain, data)"),
    task_description: z.string().optional().describe("Brief description of the task"),
    summary_only: z.boolean().optional().describe("Return only the summary paragraph instead of full body — reduces context usage by ~60%"),
  },
  async (input) => {
    const result = await getPrinciples(input, projectDir, pluginDir);
    return jsonResponse(result);
  }
);

// Tool: list_principles
server.tool(
  "list_principles",
  "Browse the full Canon principle index. Returns metadata only (no full body) for efficient browsing.",
  {
    filter_severity: z
      .enum(["rule", "strong-opinion", "convention"])
      .optional()
      .describe("Filter by severity level"),
    filter_tags: z.array(z.string()).optional().describe("Filter by tags"),
    filter_layers: z.array(z.string()).optional().describe("Filter by architectural layers"),
    include_archived: z.boolean().optional().describe("Include archived principles in results (default: false)"),
  },
  async (input) => {
    const result = await listPrinciples(input, projectDir, pluginDir);
    return jsonResponse(result);
  }
);

// Tool: review_code
server.tool(
  "review_code",
  "Returns Canon principles relevant to a file for review. The calling agent evaluates compliance — this tool provides the matched principles and code.",
  {
    code: z.string().describe("The code to review"),
    file_path: z.string().describe("Path of the file being reviewed"),
    context: z.string().optional().describe("Brief description of what the code does"),
  },
  async (input) => {
    const result = await reviewCode(input, projectDir, pluginDir);
    return jsonResponse(result);
  }
);

// Tool: get_compliance
server.tool(
  "get_compliance",
  "Returns compliance stats for a specific Canon principle. Shows violation counts, compliance rate, and trend.",
  {
    principle_id: z.string().describe("ID of the principle to check compliance for"),
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

// Tool: get_pr_review_data
server.tool(
  "get_pr_review_data",
  "Get PR review data — file list, layer grouping, diff command, and graph-aware review priority for a pull request or branch review.",
  {
    pr_number: z.number().optional().describe("GitHub PR number"),
    branch: z.string().optional().describe("Branch name to review"),
    diff_base: z.string().optional().describe("Base ref for the diff (default: main)"),
    incremental: z.boolean().optional().describe("Only review new commits since last Canon review"),
  },
  async (input) => {
    const result = await getPrReviewData(input, projectDir, pluginDir);
    return jsonResponse(result);
  }
);

// Tool: codebase_graph
server.tool(
  "codebase_graph",
  "Generate a dependency graph of the codebase with Canon compliance overlay. Full graph is persisted to .canon/graph-data.json. Returns a compact summary (layers, violations, insights).",
  {
    root_dir: z.string().optional().describe("Fallback root directory to scan when no source_dirs are configured. Ignored if source_dirs exist in input or .canon/config.json."),
    source_dirs: z.array(z.string()).optional().describe("Directories to scan (e.g. ['src', 'lib']). Overrides .canon/config.json source_dirs."),
    include_extensions: z.array(z.string()).optional().describe("File extensions to include (default: ts, js, py, go, rs)"),
    exclude_dirs: z.array(z.string()).optional().describe("Directories to exclude (default: node_modules, .git, dist, etc.)"),
    diff_base: z.string().optional().describe("Git ref to diff against — marks changed files in the graph"),
    changed_files: z.array(z.string()).optional().describe("Explicit list of changed files to highlight"),
  },
  async (input) => {
    const result = await codebaseGraph(input, projectDir, pluginDir);
    return jsonResponse(summarizeGraph(result));
  }
);

// Tool: get_file_context
server.tool(
  "get_file_context",
  "Get rich context for a source file — contents (up to 200 lines), graph relationships (imports/imported_by), exported names, layer, and compliance data. Use this to understand a file before generating a summary.",
  {
    file_path: z.string().describe("Project-relative file path (e.g. 'src/api/handler.ts')"),
  },
  async (input) => {
    const result = await getFileContext(input, projectDir);
    return jsonResponse(result);
  }
);

// Tool: store_summaries
server.tool(
  "store_summaries",
  "Store file summaries to .canon/summaries.json. Merges with existing summaries so you can generate them incrementally.",
  {
    summaries: z.array(z.object({
      file_path: z.string().describe("Project-relative file path"),
      summary: z.string().describe("Rich contextual summary of the file's role"),
    })).describe("Array of file summaries to store"),
  },
  async (input) => {
    const result = await storeSummaries(input, projectDir);
    return jsonResponse(result);
  }
);

// Tool: get_dashboard_selection
server.tool(
  "get_dashboard_selection",
  "Returns the user's current focus from the Canon dashboard — the selected graph node AND the active editor file with matched principles. Call this at the start of a conversation to understand what the user is working on. Returns layer, summary, dependencies, dependents, content preview, and top 3 principles for the active file.",
  {},
  async () => {
    const result = await getDashboardSelection(projectDir, pluginDir);
    return jsonResponse(result);
  }
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
