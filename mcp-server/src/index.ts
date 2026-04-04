#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { z } from "zod";
import { getJobManager } from "./jobs/job-manager.ts";
import { ResolvedFlowSchema } from "./orchestration/flow-schema.ts";
import { reportInputSchema } from "./schema.ts";
import type { FailureEntry } from "./tools/categorize-failures.ts";
import { categorizeFailures } from "./tools/categorize-failures.ts";
import { codebaseGraph, compactGraph } from "./tools/codebase-graph.ts";
import { codebaseGraphMaterialize } from "./tools/codebase-graph-materialize.ts";
import { codebaseGraphPoll } from "./tools/codebase-graph-poll.ts";
import { codebaseGraphSubmit } from "./tools/codebase-graph-submit.ts";
import { driveFlow } from "./tools/drive-flow.ts";
import { getCompliance } from "./tools/get-compliance.ts";
import { getDriftReport } from "./tools/get-drift-report.ts";
import { getFileContext } from "./tools/get-file-context.ts";
import { getMessages } from "./tools/get-messages.ts";
import { getPrinciples } from "./tools/get-principles.ts";
import { getTranscript } from "./tools/get-transcript.ts";
import { graphQuery } from "./tools/graph-query.ts";
import { initWorkspaceFlow } from "./tools/init-workspace.ts";
import { injectWaveEvent } from "./tools/inject-wave-event.ts";
import { listPrinciples } from "./tools/list-principles.ts";
import { loadFlow } from "./tools/load-flow.ts";
import { postMessage } from "./tools/post-message.ts";
import { recordAgentMetrics } from "./tools/record-agent-metrics.ts";
import { report } from "./tools/report.ts";
import { reportResult } from "./tools/report-result.ts";
import { resolveAfterConsultations } from "./tools/resolve-after-consultations.ts";
import { resolveWaveEvent } from "./tools/resolve-wave-event.ts";
import { reviewCode } from "./tools/review-code.ts";
import { semanticSearch } from "./tools/semantic-search.ts";
import { showPrImpact } from "./tools/show-pr-impact.ts";
import { storePrReview } from "./tools/store-pr-review.ts";
import { storeSummaries } from "./tools/store-summaries.ts";
import { updateBoard } from "./tools/update-board.ts";
import { writeDesignBrief } from "./tools/write-design-brief.ts";
import { writeImplementationSummary } from "./tools/write-implementation-summary.ts";
import { writePlanIndex } from "./tools/write-plan-index.ts";
import { writeResearchSynthesis } from "./tools/write-research-synthesis.ts";
import { writeReview } from "./tools/write-review.ts";
import { writeTestReport } from "./tools/write-test-report.ts";
import { installFuzzyValidation } from "./shared/lib/fuzzy-field-validation.ts";
import { wrapHandler } from "./shared/lib/wrap-handler.ts";

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

// Patch validation to detect unknown fields with fuzzy "did you mean?" suggestions.
installFuzzyValidation(server);

/** Helper to register a tool + resource pair for an MCP App UI. */
const registeredResources = new Set<string>();

/** Options for registering a tool with an MCP App UI. */
type RegisterToolWithUiOptions<Schema extends ZodRawShapeCompat> = {
  resourceUri: string;
  title: string;
  description: string;
  inputSchema: Schema;
  htmlFile: string;
  handler: ToolCallback<Schema>;
};

function registerToolWithUi<Schema extends ZodRawShapeCompat>(
  toolName: string,
  options: RegisterToolWithUiOptions<Schema>,
) {
  const { resourceUri, title, description, inputSchema, htmlFile, handler } = options;
  registerAppTool(
    server,
    toolName,
    {
      _meta: { ui: { resourceUri } },
      description,
      inputSchema,
      title,
    },
    handler,
  );

  if (!registeredResources.has(resourceUri)) {
    registeredResources.add(resourceUri);
    registerAppResource(server, title, resourceUri, { mimeType: RESOURCE_MIME_TYPE }, async () => {
      const html = await readFile(join(mcpServerRoot, "dist", "src", "ui", htmlFile), "utf-8");
      return {
        contents: [{ mimeType: RESOURCE_MIME_TYPE, text: html, uri: resourceUri }],
      };
    });
  }
}

// --- MCP App tool UIs ---

registerToolWithUi("show_pr_impact", {
  description:
    "Opens the PR Review view — change analysis, impact assessment, and review violations for a pull request or branch.",
  handler: wrapHandler(async (input) => {
    return showPrImpact(projectDir, {
      branch: input.branch,
      diff_base: input.diff_base,
      incremental: input.incremental,
      pr_number: input.pr_number,
    });
  }),
  htmlFile: "pr-review.html",
  inputSchema: {
    branch: z.string().optional().describe("Filter to reviews for this branch"),
    diff_base: z.string().optional().describe("Base ref for the diff (default: main)"),
    incremental: z.boolean().optional().describe("Only review new commits since last Canon review"),
    pr_number: z.number().optional().describe("Filter to reviews for this PR number"),
  },
  resourceUri: "ui://canon/pr-review",
  title: "PR Review",
});

server.registerTool(
  "get_principles",
  {
    description:
      "Returns Canon principles relevant to the current coding context. Call before generating code.",
    inputSchema: {
      file_path: z.string().optional().describe("Path of the file being worked on"),
      layers: z
        .array(z.string())
        .optional()
        .describe("Architectural layers (e.g., api, domain, data)"),
      summary_only: z
        .boolean()
        .optional()
        .describe(
          "Return only the summary paragraph instead of full body — reduces context usage by ~60%",
        ),
      task_description: z.string().optional().describe("Brief description of the task"),
    },
  },
  wrapHandler(async (input) => {
    return getPrinciples(input, projectDir, pluginDir);
  }),
);

server.registerTool(
  "list_principles",
  {
    description:
      "Browse the full Canon principle index. Returns metadata only (no full body) for efficient browsing.",
    inputSchema: {
      filter_layers: z.array(z.string()).optional().describe("Filter by architectural layers"),
      filter_severity: z
        .enum(["rule", "strong-opinion", "convention"])
        .optional()
        .describe("Filter by severity level"),
      filter_tags: z.array(z.string()).optional().describe("Filter by tags"),
      include_archived: z
        .boolean()
        .optional()
        .describe("Include archived principles in results (default: false)"),
    },
  },
  wrapHandler(async (input) => {
    return listPrinciples(input, projectDir, pluginDir);
  }),
);

server.registerTool(
  "review_code",
  {
    description:
      "Returns Canon principles relevant to a file for review. The calling agent evaluates compliance — this tool provides the matched principles and code.",
    inputSchema: {
      code: z.string().describe("The code to review"),
      context: z.string().optional().describe("Brief description of what the code does"),
      file_path: z.string().describe("Path of the file being reviewed"),
    },
  },
  wrapHandler(async (input) => {
    return reviewCode(input, projectDir, pluginDir);
  }),
);

server.registerTool(
  "get_compliance",
  {
    description:
      "Returns compliance stats for a specific Canon principle. Shows violation counts, compliance rate, trend, and weekly history.",
    inputSchema: {
      principle_id: z.string().describe("ID of the principle to check compliance for"),
    },
  },
  wrapHandler(async (input) => {
    return getCompliance(input, projectDir, pluginDir);
  }),
);

// Tool: report (unified — decisions, patterns, and reviews)
server.registerTool(
  "report",
  {
    description:
      "Log a Canon observation: an intentional deviation (decision), an observed codebase pattern, or a code review result. All feed into drift tracking and the learning loop.",
    inputSchema: reportInputSchema,
  },
  wrapHandler(async (input) => {
    return report(input, projectDir);
  }),
);

registerToolWithUi("codebase_graph", {
  description:
    "Generate a dependency graph of the codebase with Canon compliance overlay. Returns a compact summary (layers, violations, insights).",
  handler: wrapHandler(async (input) => {
    const result = await codebaseGraph(input, projectDir, pluginDir);
    return compactGraph(result);
  }),
  htmlFile: "codebase-graph.html",
  inputSchema: {
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
  },
  resourceUri: "ui://canon/codebase-graph",
  title: "Codebase Graph",
});

registerToolWithUi("get_file_context", {
  description:
    "Get rich context for a source file — contents (up to 200 lines), graph relationships (imports/imported_by), exported names, layer, and compliance data.",
  handler: wrapHandler(async (input) => {
    return getFileContext(input, projectDir);
  }),
  htmlFile: "file-context.html",
  inputSchema: {
    file_path: z.string().describe("Project-relative file path (e.g. 'src/api/handler.ts')"),
  },
  resourceUri: "ui://canon/file-context",
  title: "File Context",
});

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
  wrapHandler(async (input) => {
    return storeSummaries(input, projectDir);
  }),
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
  wrapHandler(async (input) => {
    return getDriftReport(input, projectDir, pluginDir);
  }),
);

server.registerTool(
  "load_flow",
  {
    description:
      "Load and resolve a Canon flow definition. Returns the resolved flow with fragment resolution, spawn instructions, and a state adjacency graph.",
    inputSchema: {
      flow_name: z.string().describe("Name of the flow file (without .md extension)"),
    },
  },
  wrapHandler(async (input) => {
    return loadFlow(input, pluginDir, projectDir);
  }),
);

server.registerTool(
  "init_workspace",
  {
    description:
      "Initialize a Canon workspace for flow execution. Creates workspace directory and initializes SQLite store. Resumes from existing store if present.",
    inputSchema: {
      base_commit: z.string(),
      branch: z.string(),
      flow_name: z.string(),
      original_input: z.string().optional(),
      preflight: z
        .boolean()
        .optional()
        .describe(
          "Run pre-flight checks (git status, lock, stale sessions) before creating workspace",
        ),
      skip_flags: z.array(z.string()).optional(),
      task: z.string(),
      tier: z.enum(["small", "medium", "large"]),
    },
  },
  wrapHandler(async (input) => {
    return initWorkspaceFlow(input, projectDir, pluginDir);
  }),
);

server.registerTool(
  "report_result",
  {
    description:
      "Report an agent's result. Normalizes status, evaluates transitions, updates board state, checks stuck detection. Returns next state and whether HITL is required.",
    inputSchema: {
      artifact_count: z
        .number()
        .optional()
        .describe("Current artifact count for no_progress stuck detection"),
      artifacts: z.array(z.string()).optional(),
      commit_sha: z
        .string()
        .optional()
        .describe("Current commit SHA for no_progress stuck detection"),
      compete_results: z
        .array(
          z.object({
            artifacts: z.array(z.string()).optional(),
            lens: z.string().optional(),
            status: z.string(),
          }),
        )
        .optional()
        .describe("Results from competitive execution — persisted to board state"),
      concern_text: z.string().optional(),
      discovered_gates: z
        .array(
          z.object({
            command: z.string(),
            source: z.string(),
          }),
        )
        .optional()
        .describe("Gate commands discovered by the agent for future runs"),
      discovered_postconditions: z
        .array(
          z.object({
            command: z.string().optional(),
            pattern: z.string().optional(),
            target: z.string().optional(),
            type: z.enum([
              "file_exists",
              "file_changed",
              "pattern_match",
              "no_pattern",
              "bash_check",
            ]),
          }),
        )
        .optional()
        .describe("Postcondition assertions discovered by the agent for future runs"),
      error: z.string().optional(),
      file_paths: z
        .array(z.string())
        .optional()
        .describe("Violating file paths for same_violations stuck detection"),
      file_test_pairs: z
        .array(z.object({ file: z.string(), test: z.string() }))
        .optional()
        .describe("File/test pairs for same_file_test stuck detection"),
      files_changed: z.number().optional().describe("Number of files changed in this state's work"),
      flow: ResolvedFlowSchema.describe("Resolved flow object from load_flow"),
      gate_results: z
        .array(
          z.object({
            command: z.string().optional(),
            exitCode: z.number().optional(),
            gate: z.string(),
            output: z.string().optional(),
            passed: z.boolean(),
          }),
        )
        .optional()
        .describe("Quality gate results reported by the agent"),
      metrics: z
        .object({
          cache_read_tokens: z.number().optional(),
          cache_write_tokens: z.number().optional(),
          duration_ms: z.number(),
          input_tokens: z.number().optional(),
          model: z.string(),
          orientation_calls: z.number().optional(),
          output_tokens: z.number().optional(),
          spawns: z.number(),
          tool_calls: z.number().optional(),
          turns: z.number().optional(),
        })
        .optional(),
      parallel_results: z
        .array(
          z.object({
            artifacts: z.array(z.string()).optional(),
            item: z.string(),
            status: z.string(),
          }),
        )
        .optional()
        .describe("Results from parallel-per execution — triggers aggregation"),
      postcondition_results: z
        .array(
          z.object({
            name: z.string(),
            output: z.string().optional(),
            passed: z.boolean(),
            type: z.string(),
          }),
        )
        .optional()
        .describe("Postcondition check results reported by the agent"),
      principle_ids: z
        .array(z.string())
        .optional()
        .describe("Violation principle IDs for same_violations stuck detection"),
      progress_line: z
        .string()
        .optional()
        .describe(
          "One-line progress entry to append to progress.md (e.g. '- [state_id] done: summary')",
        ),
      state_id: z.string(),
      status_keyword: z.string(),
      synthesized: z
        .boolean()
        .optional()
        .describe("Whether the compete results have been synthesized into a single output"),
      test_results: z
        .object({
          failed: z.number(),
          passed: z.number(),
          skipped: z.number(),
        })
        .optional()
        .describe("Test suite results"),
      transcript_path: z
        .string()
        .optional()
        .describe("Path to the agent transcript JSONL file (ADR-015)"),
      violation_count: z.number().optional().describe("Total number of principle violations found"),
      violation_severities: z
        .object({
          blocking: z.number(),
          warning: z.number(),
        })
        .optional()
        .describe("Violation counts broken down by severity"),
      workspace: z.string(),
    },
  },
  wrapHandler(async (input) => {
    return reportResult({ ...input, project_dir: projectDir });
  }),
);

server.registerTool(
  "record_agent_metrics",
  {
    description:
      "Record agent performance metrics (tool_calls, orientation_calls, turns) directly to the execution store. Agents call this at the end of their work, before returning status. Merges with existing metrics — does not overwrite orchestrator-tracked fields.",
    inputSchema: {
      orientation_calls: z
        .number()
        .optional()
        .describe("Read/Glob/Grep calls made for orientation before writing"),
      state_id: z.string().describe("Current state ID the agent is working in"),
      tool_calls: z.number().optional().describe("Total tool invocations the agent made"),
      turns: z.number().optional().describe("Number of assistant turns in the agent conversation"),
      workspace: z.string().describe("Workspace path"),
    },
  },
  wrapHandler(async (input) => {
    return recordAgentMetrics(input);
  }),
);

server.registerTool(
  "get_transcript",
  {
    description:
      "Retrieve the transcript of a specialist agent's conversation for a given state execution. Supports full mode (all entries) and summary mode (assistant messages only, ~20% of full).",
    inputSchema: {
      mode: z
        .enum(["full", "summary"])
        .optional()
        .describe(
          "full returns all entries, summary returns only assistant messages (default: full)",
        ),
      state_id: z.string().describe("State ID to retrieve transcript for"),
      workspace: z.string(),
    },
  },
  wrapHandler(async (input) => {
    return getTranscript(input);
  }),
);

server.registerTool(
  "update_board",
  {
    description:
      "Perform board state mutations. Supports entering, skipping, blocking, unblocking states, completing flow, and setting wave progress.",
    inputSchema: {
      action: z.enum([
        "enter_state",
        "skip_state",
        "block",
        "unblock",
        "complete_flow",
        "set_wave_progress",
        "set_metadata",
      ]),
      artifacts: z.array(z.string()).optional(),
      blocked_reason: z.string().optional(),
      metadata: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe("Key-value metadata to merge into board (used with set_metadata)"),
      next_state_id: z
        .string()
        .optional()
        .describe("Next state to advance to (used with skip_state)"),
      result: z.string().optional(),
      state_id: z
        .string()
        .optional()
        .describe("Required for enter_state, skip_state, block, unblock, set_wave_progress"),
      wave_data: z
        .object({
          tasks: z.array(z.string()),
          wave: z.number(),
          wave_total: z.number(),
        })
        .optional(),
      workspace: z.string(),
    },
  },
  wrapHandler(async (input) => {
    return updateBoard(input);
  }),
);

server.registerTool(
  "inject_wave_event",
  {
    description:
      "Inject a user event into a running wave execution. Events are applied at wave boundaries (between waves). Use to add tasks, skip tasks, inject context, provide guidance, or pause execution.",
    inputSchema: {
      payload: z.object({
        context: z.string().optional().describe("Additional context"),
        description: z
          .string()
          .optional()
          .describe("Description for add_task, inject_context, or guidance"),
        task_id: z.string().optional().describe("Task ID to skip or reprioritize"),
        wave: z.number().optional().describe("Target wave number (defaults to next wave)"),
      }),
      type: z.enum([
        "add_task",
        "skip_task",
        "reprioritize",
        "inject_context",
        "guidance",
        "pause",
      ]),
      workspace: z.string(),
    },
  },
  wrapHandler(async (input) => {
    return injectWaveEvent(input);
  }),
);

server.registerTool(
  "resolve_wave_event",
  {
    description:
      "Resolve a pending wave event by applying or rejecting it. Returns agent routing from resolveEventAgents so the orchestrator knows which agents to spawn. Use after processing events from get_messages.",
    inputSchema: {
      action: z.enum(["apply", "reject"]).describe("Whether to apply or reject the event"),
      event_id: z.string().describe("ID of the pending event to resolve"),
      reason: z
        .string()
        .optional()
        .describe("Reason for rejection (required when action is reject)"),
      resolution: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Resolution data to attach (apply only)"),
      workspace: z.string(),
    },
  },
  wrapHandler(async (input) => {
    return resolveWaveEvent(input);
  }),
);

server.registerTool(
  "resolve_after_consultations",
  {
    description:
      "Resolve 'after' consultation prompts for a state. Call after the last wave completes and before report_result. Returns consultation prompt entries for the orchestrator to spawn.",
    inputSchema: {
      flow: ResolvedFlowSchema.describe("Resolved flow object from load_flow"),
      state_id: z.string(),
      variables: z.record(z.string(), z.string()),
      workspace: z.string(),
    },
  },
  wrapHandler(async (input) => {
    return resolveAfterConsultations(input);
  }),
);

server.registerTool(
  "post_message",
  {
    description:
      "Post a message to a workspace channel for inter-agent communication. Messages are markdown files that agents read at spawn time.",
    inputSchema: {
      channel: z
        .string()
        .describe("Channel name (e.g. 'wave-000', 'debate-preflight', 'consultation')"),
      content: z.string().describe("Markdown message content"),
      from: z.string().describe("Sender identity (e.g. task ID, agent name)"),
      workspace: z.string(),
    },
  },
  wrapHandler(async (input) => {
    return postMessage(input);
  }),
);

server.registerTool(
  "get_messages",
  {
    description:
      "Read messages from a workspace channel. Returns messages ordered by sequence number. Optionally includes pending wave events.",
    inputSchema: {
      channel: z.string().describe("Channel name to read from"),
      include_events: z.boolean().optional().describe("Also return pending wave events"),
      since: z.string().optional().describe("ISO timestamp — only return messages after this time"),
      workspace: z.string(),
    },
  },
  wrapHandler(async (input) => {
    return getMessages(input);
  }),
);

server.registerTool(
  "store_pr_review",
  {
    description:
      "Store a PR review result for drift tracking. Server generates review_id and timestamp.",
    inputSchema: {
      branch: z.string().optional().describe("Branch name reviewed"),
      file_priorities: z
        .array(
          z.object({
            path: z.string(),
            priority_score: z.number(),
          }),
        )
        .optional()
        .describe("Graph-derived file review priorities"),
      files: z.array(z.string()).describe("File paths that were reviewed"),
      honored: z.array(z.string()).describe("IDs of principles honored"),
      last_reviewed_sha: z.string().optional().describe("Last commit SHA that was reviewed"),
      pr_number: z.number().optional().describe("GitHub PR number"),
      recommendations: z
        .array(
          z.object({
            file_path: z.string().optional().describe("File the recommendation applies to"),
            message: z.string().describe("Concrete explanation with suggested fix"),
            source: z
              .enum(["principle", "holistic"])
              .describe("Whether derived from a principle violation or holistic observation"),
            title: z.string().describe("Short label for the recommendation (≤ 60 chars)"),
          }),
        )
        .optional()
        .describe(
          "Top-5 prioritized recommendations mixing principle violations and holistic suggestions",
        ),
      score: z
        .object({
          conventions: z.object({
            passed: z.number().int().min(0),
            total: z.number().int().min(0),
          }),
          opinions: z.object({
            passed: z.number().int().min(0),
            total: z.number().int().min(0),
          }),
          rules: z.object({
            passed: z.number().int().min(0),
            total: z.number().int().min(0),
          }),
        })
        .describe("Compliance score breakdown"),
      verdict: z.enum(["BLOCKING", "WARNING", "CLEAN"]).describe("Overall review verdict"),
      violations: z
        .array(
          z.object({
            file_path: z.string().optional().describe("Specific file where violation occurred"),
            impact_score: z.number().optional().describe("Graph-derived impact score"),
            message: z.string().optional().describe("Human-readable violation reason"),
            principle_id: z.string(),
            severity: z.string(),
          }),
        )
        .describe("Principle violations found"),
    },
  },
  wrapHandler(async (input) => {
    return storePrReview(input, projectDir);
  }),
);

server.registerTool(
  "graph_query",
  {
    description:
      "Query the codebase knowledge graph for callers, callees, blast radius, dead code, search, and more. Requires the knowledge graph to be built first via codebase_graph.",
    inputSchema: {
      options: z
        .object({
          include_tests: z.boolean().optional().describe("Include test files in dead_code results"),
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
  wrapHandler(async (input) => {
    return graphQuery(input, projectDir);
  }),
);

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
        .describe("Maximum distance threshold — lower means more similar (default: no threshold)"),
    },
  },
  wrapHandler(async (input) => {
    return semanticSearch(input, projectDir);
  }),
);

server.registerTool(
  "write_plan_index",
  {
    description:
      "Write a structured plan index (INDEX.md) for wave execution. Accepts typed task entries and produces normalized markdown that parseTaskIdsForWave can reliably parse.",
    inputSchema: {
      slug: z.string(),
      tasks: z.array(
        z.object({
          depends_on: z.array(z.string()).optional(),
          files: z.array(z.string()).optional(),
          principles: z.array(z.string()).optional(),
          task_id: z.string().describe("Task identifier — alphanumeric, hyphens, underscores only"),
          wave: z.number().min(1).describe("Wave number (1-based)"),
        }),
      ),
      workspace: z.string(),
    },
  },
  wrapHandler(async (input) => writePlanIndex(input)),
);

server.registerTool(
  "write_test_report",
  {
    description:
      "Write a structured test report. Accepts typed test results and produces normalized TEST-REPORT.md with a companion .meta.json sidecar for machine reading.",
    inputSchema: {
      failed: z.number().int().min(0),
      issues: z
        .array(
          z.object({
            category: z.string().optional().describe("Error category"),
            error: z.string().describe("Error message"),
            file: z.string().optional().describe("Test file path"),
            test: z.string().describe("Test name or identifier"),
          }),
        )
        .optional(),
      passed: z.number().int().min(0),
      skipped: z.number().int().min(0),
      slug: z.string(),
      summary: z.string().describe("Human-readable summary of test results"),
      workspace: z.string(),
    },
  },
  wrapHandler(async (input) => writeTestReport(input)),
);

server.registerTool(
  "write_review",
  {
    description:
      "Write a structured code review. Accepts typed review data with verdict, violations, and scores. Maps ADR-010 verdict vocabulary to DriftStore vocabulary. Produces REVIEW.md + .meta.json sidecar.",
    inputSchema: {
      files: z.array(z.string()),
      honored: z.array(z.string()),
      score: z.object({
        conventions: z.object({
          passed: z.number().int().min(0),
          total: z.number().int().min(0),
        }),
        opinions: z.object({
          passed: z.number().int().min(0),
          total: z.number().int().min(0),
        }),
        rules: z.object({
          passed: z.number().int().min(0),
          total: z.number().int().min(0),
        }),
      }),
      slug: z.string(),
      verdict: z.enum(["approved", "approved_with_concerns", "changes_required", "blocked"]),
      violations: z.array(
        z.object({
          description: z.string().optional(),
          file_path: z.string().optional(),
          fix: z.string().optional(),
          principle_id: z.string(),
          severity: z.string(),
        }),
      ),
      workspace: z.string(),
    },
  },
  wrapHandler(async (input) => writeReview(input)),
);

server.registerTool(
  "write_implementation_summary",
  {
    description:
      "Write a structured implementation summary. Accepts typed file changes, decisions applied, deviations, and tests. Produces IMPLEMENTATION-SUMMARY.md + .meta.json sidecar.",
    inputSchema: {
      decisions_applied: z.array(z.string()).optional(),
      deviations: z
        .array(
          z.object({
            decision_id: z.string(),
            reason: z.string(),
          }),
        )
        .optional(),
      files_changed: z.array(
        z.object({
          action: z.enum(["added", "modified", "deleted"]),
          path: z.string(),
        }),
      ),
      slug: z.string(),
      task_id: z.string(),
      tests_added: z.array(z.string()).optional(),
      workspace: z.string(),
    },
  },
  wrapHandler(async (input) => writeImplementationSummary(input)),
);

server.registerTool(
  "write_research_synthesis",
  {
    description:
      "Write a structured research synthesis for researcher-to-architect handoff. Produces RESEARCH-SYNTHESIS.md + .meta.json sidecar in workspace handoffs/ directory.",
    inputSchema: {
      affected_subsystems: z.array(z.string()),
      key_findings: z.array(
        z.object({
          confidence: z.enum(["high", "medium", "low"]),
          finding: z.string(),
          source: z.string().optional(),
        }),
      ),
      open_questions: z.array(z.string()),
      risk_areas: z.array(
        z.object({
          area: z.string(),
          mitigation: z.string().optional(),
          severity: z.enum(["high", "medium", "low"]),
        }),
      ),
      slug: z.string(),
      sources: z.array(z.string()).optional(),
      workspace: z.string(),
    },
  },
  wrapHandler(async (input) => writeResearchSynthesis(input)),
);

server.registerTool(
  "write_design_brief",
  {
    description:
      "Write a structured design brief for architect-to-implementor handoff. Produces DESIGN-BRIEF.md + .meta.json sidecar in workspace handoffs/ directory.",
    inputSchema: {
      constraints: z.array(z.string()),
      decisions_referenced: z.array(z.string()).optional(),
      dependencies: z.array(z.string()).optional(),
      file_targets: z.array(
        z.object({
          action: z.enum(["create", "modify", "delete"]),
          description: z.string().optional(),
          path: z.string(),
        }),
      ),
      slug: z.string(),
      task_id: z.string(),
      test_expectations: z.array(
        z.object({
          description: z.string(),
          file: z.string().optional(),
        }),
      ),
      workspace: z.string(),
    },
  },
  wrapHandler(async (input) => writeDesignBrief(input)),
);

server.registerTool(
  "drive_flow",
  {
    description:
      "Drive the Canon state machine loop server-side. Turn-by-turn protocol: first call (no result) enters the current state and returns SpawnRequest[]; subsequent calls (with result) report the agent's result, advance the loop, and return the next action. Returns spawn, hitl, or done.",
    inputSchema: {
      flow: ResolvedFlowSchema.describe("Resolved flow object from load_flow"),
      result: z
        .object({
          agent_session_id: z
            .string()
            .optional()
            .describe("Agent session ID for ADR-009a continue_from support"),
          artifacts: z
            .array(z.string())
            .optional()
            .describe("Artifact paths produced by the agent"),
          metrics: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Agent performance metrics"),
          parallel_results: z
            .array(
              z.object({
                artifacts: z.array(z.string()).optional(),
                item: z.string(),
                status: z.string(),
              }),
            )
            .optional()
            .describe("Results from parallel-per execution"),
          state_id: z.string().describe("State ID that just completed"),
          status: z
            .string()
            .describe("Agent status keyword (e.g. DONE, DONE_WITH_CONCERNS, BLOCKED)"),
          task_id: z
            .string()
            .optional()
            .describe("Task ID within a wave state (required for wave task results)"),
        })
        .strip()
        .optional()
        .describe("Result from the most recently completed agent. Omit on the first call."),
      workspace: z.string().describe("Workspace directory path"),
    },
  },
  wrapHandler(async (input) => driveFlow(input)),
);

const FailureEntrySchema = z.object({
  error_message: z.string().describe("Error message from the failure"),
  error_type: z
    .string()
    .optional()
    .describe("Error type or class (e.g. TypeError, AssertionError)"),
  file: z.string().describe("Test file path"),
  test_name: z.string().optional().describe("Test name"),
});

server.registerTool(
  "categorize_failures",
  {
    description:
      "Group test failures by root cause using pattern matching with confidence scoring. Returns categorized failures and a needs_refinement flag indicating whether LLM review is needed for low-confidence groupings.",
    inputSchema: {
      failures: z
        .array(FailureEntrySchema)
        .min(1)
        .describe("Array of test failure entries to categorize"),
      refined_categories: z
        .array(
          z.object({
            category: z.string().describe("Category label"),
            description: z.string().describe("Category description"),
            files: z.array(z.string()).describe("File paths in this category"),
          }),
        )
        .optional()
        .describe(
          "LLM-provided refined categories. When present, skips pattern matching and applies these groupings directly (confidence 1.0).",
        ),
      workspace: z.string().describe("Workspace directory path"),
    },
  },
  wrapHandler(async (input) =>
    categorizeFailures(
      input as {
        workspace: string;
        failures: FailureEntry[];
        refined_categories?: Array<{
          category: string;
          description: string;
          files: string[];
        }>;
      },
    ),
  ),
);

// --- Background job tools ---

server.registerTool(
  "codebase_graph_submit",
  {
    description:
      "Submit a background codebase graph generation job. Returns immediately with a job_id for polling. In CI mode (process.env.CI or CANON_SYNC_JOBS=1), runs synchronously and returns a complete result.",
    inputSchema: {
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
      force: z.boolean().optional().describe("Skip cache, force new run"),
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
    },
  },
  wrapHandler(async (input) => codebaseGraphSubmit(input, projectDir, pluginDir)),
);

server.registerTool(
  "codebase_graph_poll",
  {
    description:
      "Poll the status of a background codebase graph job. Returns job_id, status (pending/running/complete/failed/timed_out/cancelled), progress, and error.",
    inputSchema: {
      job_id: z.string().describe("Job ID returned by codebase_graph_submit"),
    },
  },
  wrapHandler(async (input) => codebaseGraphPoll(input)),
);

registerToolWithUi("codebase_graph_materialize", {
  description:
    "Materialize the results of a completed codebase graph job into a visual graph. Job must have status 'complete' (check with codebase_graph_poll first).",
  handler: wrapHandler(async (input) => codebaseGraphMaterialize(input, projectDir, pluginDir)),
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

// --- Signal handlers for child process cleanup ---

function cleanupAndExit(signal: string): void {
  try {
    const manager = getJobManager();
    if (manager) manager.cleanup();
  } catch {
    // Best-effort cleanup — do not let errors prevent shutdown
  }
  process.exit(signal === "SIGTERM" ? 0 : 1);
}

process.on("SIGTERM", () => cleanupAndExit("SIGTERM"));
process.on("SIGINT", () => cleanupAndExit("SIGINT"));

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Mark any leftover running jobs from a previous crashed session as failed
  try {
    const manager = getJobManager();
    if (manager) manager.cleanup();
  } catch {
    // Best-effort — do not fail startup if cleanup errors
  }
}

main().catch((error) => {
  console.error("Canon MCP server error:", error);
  process.exit(1);
});
