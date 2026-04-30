import { ResolvedFlowSchema } from "@domains/flows/flow-definition-schemas.ts";
import { recordAgentMetrics } from "@features/diagnostics/tools/record-agent-metrics.ts";
import { captureTranscript } from "@features/orchestration/tools/capture-transcript.ts";
import { getTranscript } from "@features/orchestration/tools/get-transcript.ts";
import { reportResult } from "@features/orchestration/tools/report-result.ts";
import { z } from "zod";
import { gatedWrapHandler, projectDir, server } from "./server-state.ts";

const reportResultInputSchema = {
  artifact_count: z
    .number()
    .optional()
    .describe("Current artifact count for no_progress stuck detection"),
  artifacts: z.array(z.string()).optional(),
  commit_sha: z.string().optional().describe("Current commit SHA for no_progress stuck detection"),
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
    .array(z.object({ command: z.string(), source: z.string() }))
    .optional()
    .describe("Gate commands discovered by the agent for future runs"),
  discovered_postconditions: z
    .array(
      z.object({
        command: z.string().optional(),
        pattern: z.string().optional(),
        target: z.string().optional(),
        type: z.enum(["file_exists", "file_changed", "pattern_match", "no_pattern", "bash_check"]),
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
      z.object({ artifacts: z.array(z.string()).optional(), item: z.string(), status: z.string() }),
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
    .object({ failed: z.number(), passed: z.number(), skipped: z.number() })
    .optional()
    .describe("Test suite results"),
  transcript_path: z
    .string()
    .optional()
    .describe("Path to the agent transcript JSONL file (ADR-015)"),
  violation_count: z.number().optional().describe("Total number of principle violations found"),
  violation_severities: z
    .object({ blocking: z.number(), warning: z.number() })
    .optional()
    .describe("Violation counts broken down by severity"),
  workspace: z.string(),
};

function registerCaptureTranscriptTool(): void {
  server.registerTool(
    "capture_transcript",
    {
      description:
        "Capture a Claude Code agent transcript and write it to the workspace transcripts directory in Canon format. Best-effort: returns a warning (never an error) when the source transcript cannot be found.",
      inputSchema: {
        agent_id: z
          .string()
          .describe(
            "Agent ID from the Agent tool result (e.g. 'a10bf0a3a2543f7b5'). Used to locate the source JSONL file.",
          ),
        agent_type: z
          .string()
          .describe("Agent type label (e.g. 'engineer'). Used in the output filename."),
        step_id: z.string().describe("Workflow step ID. Used in the output filename."),
        workspace: z.string().describe("Workspace path for this flow execution."),
      },
    },
    gatedWrapHandler(async (input) => captureTranscript(input)),
  );
}

export function registerReportTools(): void {
  server.registerTool(
    "report_result",
    {
      description:
        "Report an agent's result. Evaluates transitions, updates board state, checks stuck detection. Returns next state and HITL status.",
      inputSchema: reportResultInputSchema,
    },
    gatedWrapHandler(async (input) => reportResult({ ...input, project_dir: projectDir })),
  );

  server.registerTool(
    "record_agent_metrics",
    {
      description:
        "Record agent performance metrics (tool_calls, orientation_calls, turns) to the execution store. Merges with existing metrics without overwriting orchestrator-tracked fields.",
      inputSchema: {
        orientation_calls: z
          .number()
          .optional()
          .describe("Read/Glob/Grep calls made for orientation before writing"),
        state_id: z.string().describe("Current state ID the agent is working in"),
        tool_calls: z.number().optional().describe("Total tool invocations the agent made"),
        turns: z
          .number()
          .optional()
          .describe("Number of assistant turns in the agent conversation"),
        workspace: z.string().describe("Workspace path"),
      },
    },
    gatedWrapHandler(async (input) => recordAgentMetrics(input)),
  );

  server.registerTool(
    "get_transcript",
    {
      description: "Retrieve a specialist agent's conversation transcript for a state execution.",
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
    gatedWrapHandler(async (input) => getTranscript(input)),
  );

  registerCaptureTranscriptTool();
}
