#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getPrinciples } from "./tools/get-principles.js";
import { listPrinciples } from "./tools/list-principles.js";
import { reviewCode } from "./tools/review-code.js";
import { getCompliance } from "./tools/get-compliance.js";
import { report } from "./tools/report.js";
import { logRalph } from "./tools/log-ralph.js";
import { getPrReviewData } from "./tools/pr-review-data.js";
import { codebaseGraph } from "./tools/codebase-graph.js";
import { deployDashboard } from "./tools/deploy-dashboard.js";
import { getFileContext } from "./tools/get-file-context.js";
import { storeSummaries } from "./tools/store-summaries.js";
import { askCodebase } from "./tools/ask-codebase.js";
import { reportInputSchema } from "./schema.js";

import { resolve } from "path";

// Resolve project dir: CANON_PROJECT_DIR may be "." (relative) — always make absolute.
// Falls back to cwd which is typically set by Claude Code to the user's project root.
const projectDir = resolve(process.env.CANON_PROJECT_DIR || process.cwd());
const pluginDir = resolve(process.env.CANON_PLUGIN_DIR || new URL("../..", import.meta.url).pathname);

const server = new McpServer({
  name: "canon",
  version: "0.1.0",
});

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
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
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
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
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
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
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
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
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
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// Tool: log_ralph
server.tool(
  "log_ralph",
  "Log the completion of a Ralph loop — records iteration results, convergence status, and team composition for drift tracking.",
  {
    task_slug: z.string().describe("Slug of the task that was built"),
    iterations: z
      .array(
        z.object({
          iteration: z.number(),
          verdict: z.enum(["BLOCKING", "WARNING", "CLEAN"]),
          violations_count: z.number(),
          violations_fixed: z.number(),
          cannot_fix: z.number(),
        })
      )
      .describe("Results for each iteration of the loop"),
    final_verdict: z.enum(["BLOCKING", "WARNING", "CLEAN"]).describe("Final verdict after all iterations"),
    converged: z.boolean().describe("Whether the loop achieved CLEAN verdict"),
    team: z.array(z.string()).describe("Agent names used in the loop"),
  },
  async (input) => {
    const result = await logRalph(input, projectDir);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// Tool: get_pr_review_data
server.tool(
  "get_pr_review_data",
  "Get PR review data — file list, layer grouping, and diff command for a pull request or branch review.",
  {
    pr_number: z.number().optional().describe("GitHub PR number"),
    branch: z.string().optional().describe("Branch name to review"),
    diff_base: z.string().optional().describe("Base ref for the diff (default: main)"),
    incremental: z.boolean().optional().describe("Only review new commits since last Canon review"),
  },
  async (input) => {
    const result = await getPrReviewData(input, projectDir, pluginDir);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// Tool: codebase_graph
server.tool(
  "codebase_graph",
  "Generate a dependency graph of the codebase with Canon compliance overlay. Returns nodes (files), edges (imports), layers, and hotspots.",
  {
    root_dir: z.string().optional().describe("Root directory to scan directly (bypasses source_dirs). Use '.' to scan everything from project root."),
    source_dirs: z.array(z.string()).optional().describe("Directories to scan (e.g. ['src', 'lib']). Overrides .canon/config.json source_dirs."),
    include_extensions: z.array(z.string()).optional().describe("File extensions to include (default: ts, js, py, go, rs)"),
    exclude_dirs: z.array(z.string()).optional().describe("Directories to exclude (default: node_modules, .git, dist, etc.)"),
    diff_base: z.string().optional().describe("Git ref to diff against — marks changed files in the graph"),
    changed_files: z.array(z.string()).optional().describe("Explicit list of changed files to highlight"),
  },
  async (input) => {
    const result = await codebaseGraph(input, projectDir, pluginDir);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// Tool: deploy_dashboard
server.tool(
  "deploy_dashboard",
  "Deploy the Canon dashboard UI to the project's .canon/dashboard/ directory. Copies HTML, JS, and CSS files so the dashboard can load data from .canon/ via relative paths.",
  {},
  async () => {
    const result = await deployDashboard(projectDir, pluginDir);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
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
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
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
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// Tool: ask_codebase
server.tool(
  "ask_codebase",
  "Query the codebase graph for architectural insights. Returns structured data about dependencies, layers, cycles, hotspots, and file summaries. Claude reasons over the data to answer user questions conversationally.",
  {
    question: z.string().describe("Natural language question about the codebase architecture"),
    file_path: z.string().optional().describe("Focus analysis on a specific file"),
    layer: z.string().optional().describe("Focus analysis on a specific layer"),
  },
  async (input) => {
    const result = await askCodebase(input, projectDir);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
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
