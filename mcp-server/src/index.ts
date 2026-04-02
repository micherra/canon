#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { z } from "zod";
import { ResolvedFlowSchema } from "./orchestration/flow-schema.ts";
import { reportInputSchema } from "./schema.ts";
import { checkConvergence } from "./tools/check-convergence.ts";
import { codebaseGraph, compactGraph } from "./tools/codebase-graph.ts";
import { enterAndPrepareState } from "./tools/enter-and-prepare-state.ts";
import { getCompliance } from "./tools/get-compliance.ts";

import { getDriftReport } from "./tools/get-drift-report.ts";
import { getFileContext } from "./tools/get-file-context.ts";
import { getMessages } from "./tools/get-messages.ts";
import { getTranscript } from "./tools/get-transcript.ts";
import { getPrinciples } from "./tools/get-principles.ts";
import { getSpawnPrompt } from "./tools/get-spawn-prompt.ts";
import { graphQuery } from "./tools/graph-query.ts";
import { initWorkspaceFlow } from "./tools/init-workspace.ts";
import { injectWaveEvent } from "./tools/inject-wave-event.ts";
import { listPrinciples } from "./tools/list-principles.ts";
import { loadFlow } from "./tools/load-flow.ts";
import { postMessage } from "./tools/post-message.ts";
import { report } from "./tools/report.ts";
import { reportAndEnterNextState } from "./tools/report-and-enter-next-state.ts";
import { reportResult } from "./tools/report-result.ts";
import { resolveAfterConsultations } from "./tools/resolve-after-consultations.ts";
import { resolveWaveEvent } from "./tools/resolve-wave-event.ts";
import { reviewCode } from "./tools/review-code.ts";
import { showPrImpact } from "./tools/show-pr-impact.ts";
import { storePrReview } from "./tools/store-pr-review.ts";
import { semanticSearch } from "./tools/semantic-search.ts";
import { storeSummaries } from "./tools/store-summaries.ts";
import { updateBoard } from "./tools/update-board.ts";
import { writePlanIndex } from "./tools/write-plan-index.ts";
import { recordAgentMetrics } from "./tools/record-agent-metrics.ts";
import { installFuzzyValidation } from "./utils/fuzzy-field-validation.ts";
import { wrapHandler } from "./utils/wrap-handler.ts";

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
function registerToolWithUi<Schema extends ZodRawShapeCompat>(
  toolName: string,
  resourceUri: string,
  title: string,
  description: string,
  inputSchema: Schema,
  htmlFile: string,
  handler: ToolCallback<Schema>,
) {
  registerAppTool(
    server,
    toolName,
    {
      title,
      description,
      inputSchema,
      _meta: { ui: { resourceUri } },
    },
    handler,
  );

  registerAppResource(server, title, resourceUri, { mimeType: RESOURCE_MIME_TYPE }, async () => {
    const html = await readFile(join(mcpServerRoot, "dist", "ui", htmlFile), "utf-8");
    return { contents: [{ uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: html }] };
  });
}

// --- MCP App tool UIs ---

registerToolWithUi(
  "show_pr_impact",
  "ui://canon/pr-review",
  "PR Review",
  "Opens the PR Review view — change analysis, impact assessment, and review violations for a pull request or branch.",
  {
    branch: z.string().optional().describe("Filter to reviews for this branch"),
    pr_number: z.number().optional().describe("Filter to reviews for this PR number"),
    diff_base: z.string().optional().describe("Base ref for the diff (default: main)"),
    incremental: z.boolean().optional().describe("Only review new commits since last Canon review"),
  },
  "pr-review.html",
  wrapHandler(async (input) => {
    return showPrImpact(projectDir, {
      branch: input.branch,
      pr_number: input.pr_number,
      diff_base: input.diff_base,
      incremental: input.incremental,
    });
  }),
);

server.registerTool(
  "get_principles",
  {
    description: "Returns Canon principles relevant to the current coding context. Call before generating code.",
    inputSchema: {
      file_path: z.string().optional().describe("Path of the file being worked on"),
      layers: z.array(z.string()).optional().describe("Architectural layers (e.g., api, domain, data)"),
      task_description: z.string().optional().describe("Brief description of the task"),
      summary_only: z
        .boolean()
        .optional()
        .describe("Return only the summary paragraph instead of full body — reduces context usage by ~60%"),
    },
  },
  wrapHandler(async (input) => {
    return getPrinciples(input, projectDir, pluginDir);
  })
);

server.registerTool(
  "list_principles",
  {
    description: "Browse the full Canon principle index. Returns metadata only (no full body) for efficient browsing.",
    inputSchema: {
      filter_severity: z.enum(["rule", "strong-opinion", "convention"]).optional().describe("Filter by severity level"),
      filter_tags: z.array(z.string()).optional().describe("Filter by tags"),
      filter_layers: z.array(z.string()).optional().describe("Filter by architectural layers"),
      include_archived: z.boolean().optional().describe("Include archived principles in results (default: false)"),
    },
  },
  wrapHandler(async (input) => {
    return listPrinciples(input, projectDir, pluginDir);
  })
);

server.registerTool(
  "review_code",
  {
    description:
      "Returns Canon principles relevant to a file for review. The calling agent evaluates compliance — this tool provides the matched principles and code.",
    inputSchema: {
      code: z.string().describe("The code to review"),
      file_path: z.string().describe("Path of the file being reviewed"),
      context: z.string().optional().describe("Brief description of what the code does"),
    },
  },
  wrapHandler(async (input) => {
    return reviewCode(input, projectDir, pluginDir);
  })
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
  })
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
  })
);

registerToolWithUi(
  "codebase_graph",
  "ui://canon/codebase-graph",
  "Codebase Graph",
  "Generate a dependency graph of the codebase with Canon compliance overlay. Returns a compact summary (layers, violations, insights).",
  {
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
    include_extensions: z
      .array(z.string())
      .optional()
      .describe("File extensions to include (default: ts, js, py, go, rs)"),
    exclude_dirs: z
      .array(z.string())
      .optional()
      .describe("Directories to exclude (default: node_modules, .git, dist, etc.)"),
    diff_base: z.string().optional().describe("Git ref to diff against — marks changed files in the graph"),
    changed_files: z.array(z.string()).optional().describe("Explicit list of changed files to highlight"),
  },
  "codebase-graph.html",
  wrapHandler(async (input) => {
    const result = await codebaseGraph(input, projectDir, pluginDir);
    return compactGraph(result);
  }),
);

registerToolWithUi(
  "get_file_context",
  "ui://canon/file-context",
  "File Context",
  "Get rich context for a source file — contents (up to 200 lines), graph relationships (imports/imported_by), exported names, layer, and compliance data.",
  {
    file_path: z.string().describe("Project-relative file path (e.g. 'src/api/handler.ts')"),
  },
  "file-context.html",
  wrapHandler(async (input) => {
    return getFileContext(input, projectDir);
  }),
);

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
  })
);

server.registerTool(
  "get_drift_report",
  {
    description:
      "Returns a full drift report — compliance rates, most violated principles, hotspot directories, trend, recommendations, and PR review history.",
    inputSchema: {
      last_n: z.number().optional().describe("Only analyze the last N reviews"),
      principle_id: z.string().optional().describe("Filter to a specific principle"),
      directory: z.string().optional().describe("Filter to files in a specific directory"),
    },
  },
  wrapHandler(async (input) => {
    return getDriftReport(input, projectDir, pluginDir);
  })
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
  })
);

server.registerTool(
  "init_workspace",
  {
    description: "Initialize a Canon workspace for flow execution. Creates workspace directory and initializes SQLite store. Resumes from existing store if present.",
    inputSchema: {
      flow_name: z.string(),
      task: z.string(),
      branch: z.string(),
      base_commit: z.string(),
      tier: z.enum(["small", "medium", "large"]),
      original_input: z.string().optional(),
      skip_flags: z.array(z.string()).optional(),
      preflight: z
        .boolean()
        .optional()
        .describe("Run pre-flight checks (git status, lock, stale sessions) before creating workspace"),
    },
  },
  wrapHandler(async (input) => {
    return initWorkspaceFlow(input, projectDir, pluginDir);
  })
);

server.registerTool(
  "get_spawn_prompt",
  {
    description:
      "Resolve spawn prompts for a flow state. Substitutes variables, applies templates, and fans out by state type (single/parallel/wave/parallel-per).",
    inputSchema: {
      workspace: z.string(),
      state_id: z.string(),
      flow: ResolvedFlowSchema.describe("Resolved flow object from load_flow"),
      variables: z.record(z.string(), z.string()),
      items: z.array(z.any()).optional(),
      role: z.string().optional(),
      wave: z.number().optional().describe("Current wave number (enables message instructions)"),
      peer_count: z.number().optional().describe("Number of peer agents in the wave"),
    },
  },
  wrapHandler(async (input) => {
    return getSpawnPrompt({ ...input, project_dir: projectDir });
  })
);

server.registerTool(
  "report_result",
  {
    description:
      "Report an agent's result. Normalizes status, evaluates transitions, updates board state, checks stuck detection. Returns next state and whether HITL is required.",
    inputSchema: {
      workspace: z.string(),
      state_id: z.string(),
      status_keyword: z.string(),
      flow: ResolvedFlowSchema.describe("Resolved flow object from load_flow"),
      artifacts: z.array(z.string()).optional(),
      concern_text: z.string().optional(),
      error: z.string().optional(),
      metrics: z.object({
        duration_ms: z.number(),
        spawns: z.number(),
        model: z.string(),
        tool_calls: z.number().optional(),
        orientation_calls: z.number().optional(),
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
        cache_read_tokens: z.number().optional(),
        cache_write_tokens: z.number().optional(),
        turns: z.number().optional(),
      }).optional(),
      principle_ids: z
        .array(z.string())
        .optional()
        .describe("Violation principle IDs for same_violations stuck detection"),
      file_paths: z.array(z.string()).optional().describe("Violating file paths for same_violations stuck detection"),
      file_test_pairs: z
        .array(z.object({ file: z.string(), test: z.string() }))
        .optional()
        .describe("File/test pairs for same_file_test stuck detection"),
      commit_sha: z.string().optional().describe("Current commit SHA for no_progress stuck detection"),
      artifact_count: z.number().optional().describe("Current artifact count for no_progress stuck detection"),
      parallel_results: z
        .array(
          z.object({
            item: z.string(),
            status: z.string(),
            artifacts: z.array(z.string()).optional(),
          }),
        )
        .optional()
        .describe("Results from parallel-per execution — triggers aggregation"),
      gate_results: z
        .array(
          z.object({
            passed: z.boolean(),
            gate: z.string(),
            command: z.string().optional(),
            output: z.string().optional(),
            exitCode: z.number().optional(),
          }),
        )
        .optional()
        .describe("Quality gate results reported by the agent"),
      postcondition_results: z
        .array(
          z.object({
            passed: z.boolean(),
            name: z.string(),
            type: z.string(),
            output: z.string().optional(),
          }),
        )
        .optional()
        .describe("Postcondition check results reported by the agent"),
      violation_count: z.number().optional().describe("Total number of principle violations found"),
      violation_severities: z
        .object({
          blocking: z.number(),
          warning: z.number(),
        })
        .optional()
        .describe("Violation counts broken down by severity"),
      test_results: z
        .object({
          passed: z.number(),
          failed: z.number(),
          skipped: z.number(),
        })
        .optional()
        .describe("Test suite results"),
      files_changed: z.number().optional().describe("Number of files changed in this state's work"),
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
            type: z.enum(["file_exists", "file_changed", "pattern_match", "no_pattern", "bash_check"]),
            target: z.string().optional(),
            pattern: z.string().optional(),
            command: z.string().optional(),
          }),
        )
        .optional()
        .describe("Postcondition assertions discovered by the agent for future runs"),
      compete_results: z
        .array(
          z.object({
            lens: z.string().optional(),
            status: z.string(),
            artifacts: z.array(z.string()).optional(),
          }),
        )
        .optional()
        .describe("Results from competitive execution — persisted to board state"),
      synthesized: z
        .boolean()
        .optional()
        .describe("Whether the compete results have been synthesized into a single output"),
      progress_line: z
        .string()
        .optional()
        .describe("One-line progress entry to append to progress.md (e.g. '- [state_id] done: summary')"),
      transcript_path: z
        .string()
        .optional()
        .describe("Path to the agent transcript JSONL file (ADR-015)"),
    },
  },
  wrapHandler(async (input) => {
    return reportResult({ ...input, project_dir: projectDir });
  })
);

server.registerTool(
  "report_and_enter_next_state",
  {
    description:
      "Combined tool: report_result + enter_and_prepare_state in a single round-trip. Reports the current state's result and, for non-terminal non-HITL transitions, immediately enters and prepares the next state. Reduces per-state MCP calls from 2 to 1 after the initial state entry.",
    inputSchema: {
      // Report-result fields
      workspace: z.string(),
      state_id: z.string(),
      status_keyword: z.string(),
      flow: ResolvedFlowSchema.describe("Resolved flow object from load_flow"),
      artifacts: z.array(z.string()).optional(),
      concern_text: z.string().optional(),
      error: z.string().optional(),
      metrics: z.object({
        duration_ms: z.number(),
        spawns: z.number(),
        model: z.string(),
        tool_calls: z.number().optional(),
        orientation_calls: z.number().optional(),
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
        cache_read_tokens: z.number().optional(),
        cache_write_tokens: z.number().optional(),
        turns: z.number().optional(),
      }).optional(),
      principle_ids: z
        .array(z.string())
        .optional()
        .describe("Violation principle IDs for same_violations stuck detection"),
      file_paths: z.array(z.string()).optional().describe("Violating file paths for same_violations stuck detection"),
      file_test_pairs: z
        .array(z.object({ file: z.string(), test: z.string() }))
        .optional()
        .describe("File/test pairs for same_file_test stuck detection"),
      commit_sha: z.string().optional().describe("Current commit SHA for no_progress stuck detection"),
      artifact_count: z.number().optional().describe("Current artifact count for no_progress stuck detection"),
      parallel_results: z
        .array(
          z.object({
            item: z.string(),
            status: z.string(),
            artifacts: z.array(z.string()).optional(),
          }),
        )
        .optional()
        .describe("Results from parallel-per execution — triggers aggregation"),
      gate_results: z
        .array(
          z.object({
            passed: z.boolean(),
            gate: z.string(),
            command: z.string().optional(),
            output: z.string().optional(),
            exitCode: z.number().optional(),
          }),
        )
        .optional()
        .describe("Quality gate results reported by the agent"),
      postcondition_results: z
        .array(
          z.object({
            passed: z.boolean(),
            name: z.string(),
            type: z.string(),
            output: z.string().optional(),
          }),
        )
        .optional()
        .describe("Postcondition check results reported by the agent"),
      violation_count: z.number().optional().describe("Total number of principle violations found"),
      violation_severities: z
        .object({
          blocking: z.number(),
          warning: z.number(),
        })
        .optional()
        .describe("Violation counts broken down by severity"),
      test_results: z
        .object({
          passed: z.number(),
          failed: z.number(),
          skipped: z.number(),
        })
        .optional()
        .describe("Test suite results"),
      files_changed: z.number().optional().describe("Number of files changed in this state's work"),
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
            type: z.enum(["file_exists", "file_changed", "pattern_match", "no_pattern", "bash_check"]),
            target: z.string().optional(),
            pattern: z.string().optional(),
            command: z.string().optional(),
          }),
        )
        .optional()
        .describe("Postcondition assertions discovered by the agent for future runs"),
      compete_results: z
        .array(
          z.object({
            lens: z.string().optional(),
            status: z.string(),
            artifacts: z.array(z.string()).optional(),
          }),
        )
        .optional()
        .describe("Results from competitive execution — persisted to board state"),
      synthesized: z
        .boolean()
        .optional()
        .describe("Whether the compete results have been synthesized into a single output"),
      progress_line: z
        .string()
        .optional()
        .describe("One-line progress entry to append to progress.md (e.g. '- [{state_id}] {status}: {one-sentence summary}')"),
      transcript_path: z
        .string()
        .optional()
        .describe("Path to the agent transcript JSONL file (ADR-015)"),
      // Enter-next-state fields
      variables: z.record(z.string(), z.string()),
      items: z.array(z.any()).optional(),
      role: z.string().optional(),
      wave: z.number().optional().describe("Current wave number (enables message instructions)"),
      peer_count: z.number().optional().describe("Number of peer agents in the wave"),
    },
  },
  wrapHandler(async (input) => {
    return reportAndEnterNextState({ ...input, project_dir: projectDir });
  })
);

server.registerTool(
  "check_convergence",
  {
    description:
      "Check whether a state can be re-entered based on iteration limits. Returns iteration count, max, cannot-fix items, and history.",
    inputSchema: {
      workspace: z.string(),
      state_id: z.string(),
    },
  },
  wrapHandler(async (input) => {
    return checkConvergence(input);
  })
);

server.registerTool(
  "record_agent_metrics",
  {
    description:
      "Record agent performance metrics (tool_calls, orientation_calls, turns) directly to the execution store. Agents call this at the end of their work, before returning status. Merges with existing metrics — does not overwrite orchestrator-tracked fields.",
    inputSchema: {
      workspace: z.string().describe("Workspace path"),
      state_id: z.string().describe("Current state ID the agent is working in"),
      tool_calls: z.number().optional().describe("Total tool invocations the agent made"),
      orientation_calls: z.number().optional().describe("Read/Glob/Grep calls made for orientation before writing"),
      turns: z.number().optional().describe("Number of assistant turns in the agent conversation"),
    },
  },
  wrapHandler(async (input) => {
    return recordAgentMetrics(input);
  })
);

server.registerTool(
  "get_transcript",
  {
    description:
      "Retrieve the transcript of a specialist agent's conversation for a given state execution. Supports full mode (all entries) and summary mode (assistant messages only, ~20% of full).",
    inputSchema: {
      workspace: z.string(),
      state_id: z.string().describe("State ID to retrieve transcript for"),
      mode: z
        .enum(["full", "summary"])
        .optional()
        .describe("full returns all entries, summary returns only assistant messages (default: full)"),
    },
  },
  wrapHandler(async (input) => {
    return getTranscript(input);
  })
);

server.registerTool(
  "update_board",
  {
    description:
      "Perform board state mutations. Supports entering, skipping, blocking, unblocking states, completing flow, and setting wave progress.",
    inputSchema: {
      workspace: z.string(),
      action: z.enum([
        "enter_state",
        "skip_state",
        "block",
        "unblock",
        "complete_flow",
        "set_wave_progress",
        "set_metadata",
      ]),
      state_id: z
        .string()
        .optional()
        .describe("Required for enter_state, skip_state, block, unblock, set_wave_progress"),
      next_state_id: z.string().optional().describe("Next state to advance to (used with skip_state)"),
      blocked_reason: z.string().optional(),
      wave_data: z.object({ wave: z.number(), wave_total: z.number(), tasks: z.array(z.string()) }).optional(),
      result: z.string().optional(),
      artifacts: z.array(z.string()).optional(),
      metadata: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe("Key-value metadata to merge into board (used with set_metadata)"),
    },
  },
  wrapHandler(async (input) => {
    return updateBoard(input);
  })
);

server.registerTool(
  "inject_wave_event",
  {
    description:
      "Inject a user event into a running wave execution. Events are applied at wave boundaries (between waves). Use to add tasks, skip tasks, inject context, provide guidance, or pause execution.",
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
  wrapHandler(async (input) => {
    return injectWaveEvent(input);
  })
);

server.registerTool(
  "resolve_wave_event",
  {
    description:
      "Resolve a pending wave event by applying or rejecting it. Returns agent routing from resolveEventAgents so the orchestrator knows which agents to spawn. Use after processing events from get_messages.",
    inputSchema: {
      workspace: z.string(),
      event_id: z.string().describe("ID of the pending event to resolve"),
      action: z.enum(["apply", "reject"]).describe("Whether to apply or reject the event"),
      resolution: z.record(z.string(), z.unknown()).optional().describe("Resolution data to attach (apply only)"),
      reason: z.string().optional().describe("Reason for rejection (required when action is reject)"),
    },
  },
  wrapHandler(async (input) => {
    return resolveWaveEvent(input);
  })
);

server.registerTool(
  "enter_and_prepare_state",
  {
    description:
      "Combined tool: checks convergence, evaluates skip conditions, enters state, and resolves spawn prompts in a single call. Use this instead of separate check_convergence + update_board(enter_state) + get_spawn_prompt calls.",
    inputSchema: {
      workspace: z.string(),
      state_id: z.string(),
      flow: ResolvedFlowSchema.describe("Resolved flow object from load_flow"),
      variables: z.record(z.string(), z.string()),
      items: z.array(z.any()).optional(),
      role: z.string().optional(),
      wave: z.number().optional().describe("Current wave number (enables message instructions)"),
      peer_count: z.number().optional().describe("Number of peer agents in the wave"),
    },
  },
  wrapHandler(async (input) => {
    return enterAndPrepareState({ ...input, project_dir: projectDir });
  })
);

server.registerTool(
  "resolve_after_consultations",
  {
    description:
      "Resolve 'after' consultation prompts for a state. Call after the last wave completes and before report_result. Returns consultation prompt entries for the orchestrator to spawn.",
    inputSchema: {
      workspace: z.string(),
      state_id: z.string(),
      flow: ResolvedFlowSchema.describe("Resolved flow object from load_flow"),
      variables: z.record(z.string(), z.string()),
    },
  },
  wrapHandler(async (input) => {
    return resolveAfterConsultations(input);
  })
);

server.registerTool(
  "post_message",
  {
    description:
      "Post a message to a workspace channel for inter-agent communication. Messages are markdown files that agents read at spawn time.",
    inputSchema: {
      workspace: z.string(),
      channel: z.string().describe("Channel name (e.g. 'wave-000', 'debate-preflight', 'consultation')"),
      from: z.string().describe("Sender identity (e.g. task ID, agent name)"),
      content: z.string().describe("Markdown message content"),
    },
  },
  wrapHandler(async (input) => {
    return postMessage(input);
  })
);

server.registerTool(
  "get_messages",
  {
    description:
      "Read messages from a workspace channel. Returns messages ordered by sequence number. Optionally includes pending wave events.",
    inputSchema: {
      workspace: z.string(),
      channel: z.string().describe("Channel name to read from"),
      since: z.string().optional().describe("ISO timestamp — only return messages after this time"),
      include_events: z.boolean().optional().describe("Also return pending wave events"),
    },
  },
  wrapHandler(async (input) => {
    return getMessages(input);
  })
);

server.registerTool(
  "store_pr_review",
  {
    description: "Store a PR review result for drift tracking. Server generates review_id and timestamp.",
    inputSchema: {
      pr_number: z.number().optional().describe("GitHub PR number"),
      branch: z.string().optional().describe("Branch name reviewed"),
      last_reviewed_sha: z.string().optional().describe("Last commit SHA that was reviewed"),
      verdict: z.enum(["BLOCKING", "WARNING", "CLEAN"]).describe("Overall review verdict"),
      files: z.array(z.string()).describe("File paths that were reviewed"),
      violations: z
        .array(
          z.object({
            principle_id: z.string(),
            severity: z.string(),
            file_path: z.string().optional().describe("Specific file where violation occurred"),
            impact_score: z.number().optional().describe("Graph-derived impact score"),
            message: z.string().optional().describe("Human-readable violation reason"),
          }),
        )
        .describe("Principle violations found"),
      honored: z.array(z.string()).describe("IDs of principles honored"),
      score: z
        .object({
          rules: z.object({ passed: z.number(), total: z.number() }),
          opinions: z.object({ passed: z.number(), total: z.number() }),
          conventions: z.object({ passed: z.number(), total: z.number() }),
        })
        .describe("Compliance score breakdown"),
      file_priorities: z
        .array(
          z.object({
            path: z.string(),
            priority_score: z.number(),
          }),
        )
        .optional()
        .describe("Graph-derived file review priorities"),
      recommendations: z
        .array(
          z.object({
            file_path: z.string().optional().describe("File the recommendation applies to"),
            title: z.string().describe("Short label for the recommendation (≤ 60 chars)"),
            message: z.string().describe("Concrete explanation with suggested fix"),
            source: z
              .enum(["principle", "holistic"])
              .describe("Whether derived from a principle violation or holistic observation"),
          }),
        )
        .optional()
        .describe("Top-5 prioritized recommendations mixing principle violations and holistic suggestions"),
    },
  },
  wrapHandler(async (input) => {
    return storePrReview(input, projectDir);
  })
);

server.registerTool(
  "graph_query",
  {
    description:
      "Query the codebase knowledge graph for callers, callees, blast radius, dead code, search, and more. Requires the knowledge graph to be built first via codebase_graph.",
    inputSchema: {
      query_type: z
        .enum(["callers", "callees", "blast_radius", "dead_code", "search", "ancestors"])
        .describe("Type of query to perform"),
      target: z.string().optional().describe("Target entity name or file path (not needed for dead_code)"),
      options: z
        .object({
          max_depth: z.number().int().min(1).max(10).optional().describe("Max depth for blast_radius (default 3)"),
          limit: z.number().int().min(1).max(500).optional().describe("Max results for search (default 50)"),
          include_tests: z.boolean().optional().describe("Include test files in dead_code results"),
        })
        .optional(),
    },
  },
  wrapHandler(async (input) => {
    return graphQuery(input, projectDir);
  })
);

server.registerTool(
  "semantic_search",
  {
    description:
      "Search the codebase with natural language. Finds code entities and summaries by meaning, not just name matching. Requires the knowledge graph to be built first via codebase_graph.",
    inputSchema: {
      query: z.string().describe("Natural language search query (e.g., 'error handling middleware')"),
      kind_filter: z
        .array(z.string())
        .optional()
        .describe("Filter results by entity kind (e.g., ['function', 'class'])"),
      scope: z
        .enum(["entities", "summaries", "both"])
        .optional()
        .describe("Search scope: entity signatures, AI summaries, or both (default: both)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Max results to return (default: 20)"),
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
      workspace: z.string(),
      slug: z.string(),
      tasks: z.array(
        z.object({
          task_id: z
            .string()
            .describe("Task identifier — alphanumeric, hyphens, underscores only"),
          wave: z.number().min(1).describe("Wave number (1-based)"),
          depends_on: z.array(z.string()).optional(),
          files: z.array(z.string()).optional(),
          principles: z.array(z.string()).optional(),
        }),
      ),
    },
  },
  wrapHandler(async (input) => writePlanIndex(input)),
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
