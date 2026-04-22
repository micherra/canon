import { ResolvedFlowSchema } from "@domains/flows/flow-definition-schemas.ts";
import type { FailureEntry } from "@features/diagnostics/tools/categorize-failures.ts";
import { categorizeFailures } from "@features/diagnostics/tools/categorize-failures.ts";
import { recordAgentMetrics } from "@features/diagnostics/tools/record-agent-metrics.ts";
import { driveFlow } from "@features/orchestration/tools/drive-flow.ts";
import { getMessages } from "@features/orchestration/tools/get-messages.ts";
import { getTranscript } from "@features/orchestration/tools/get-transcript.ts";
import { initWorkspaceFlow } from "@features/orchestration/tools/init-workspace.ts";
import { injectWaveEvent } from "@features/orchestration/tools/inject-wave-event.ts";
import { loadFlow } from "@features/orchestration/tools/load-flow.ts";
import { logStep, verifyCompletion } from "@features/orchestration/tools/orchestration-journal.ts";
import { postEvent } from "@features/orchestration/tools/post-event.ts";
import { postMessage } from "@features/orchestration/tools/post-message.ts";
import { reportResult } from "@features/orchestration/tools/report-result.ts";
import { resolveAfterConsultations } from "@features/orchestration/tools/resolve-after-consultations.ts";
import { resolveWaveEvent } from "@features/orchestration/tools/resolve-wave-event.ts";
import { simulateFlowTool } from "@features/orchestration/tools/simulate-flow.ts";
import { updateBoard } from "@features/orchestration/tools/update-board.ts";
import { wrapHandler } from "@shared/lib/wrap-handler.ts";
import { z } from "zod";
import { gatedWrapHandler, pluginDir, projectDir, server } from "./server-state.ts";

const FailureEntrySchema = z.object({
  error_message: z.string().describe("Error message from the failure"),
  error_type: z
    .string()
    .optional()
    .describe("Error type or class (e.g. TypeError, AssertionError)"),
  file: z.string().describe("Test file path"),
  test_name: z.string().optional().describe("Test name"),
});

function registerFlowCoreTools(): void {
  server.registerTool(
    "load_flow",
    {
      description:
        "Load and resolve a Canon flow definition. Returns the resolved flow with fragment resolution, spawn instructions, and a state adjacency graph.",
      inputSchema: {
        flow_name: z.string().describe("Name of the flow file (without .md extension)"),
      },
    },
    gatedWrapHandler(async (input) => loadFlow(input, pluginDir, projectDir)),
  );

  server.registerTool(
    "simulate_flow",
    {
      description:
        "Simulate a Canon flow execution with mocked agent results. Walks the state machine deterministically using a provided scenario of (state_id, status) pairs. Returns the full execution path, terminal/stuck/dead-end detection, and iteration tracking. No agents spawned, no workspace needed.",
      inputSchema: {
        flow: z.string().describe("Name of the flow file (without .md extension)"),
        max_steps: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Maximum simulation steps (default 50, max 1000)"),
        scenario: z
          .array(
            z.object({
              state_id: z.string().describe("State ID to provide a result for"),
              status: z.string().describe("Status keyword (e.g. done, blocked, has_failures)"),
            }),
          )
          .max(1000)
          .describe("Sequence of mocked agent results (max 1000 entries)"),
      },
    },
    gatedWrapHandler(async (input) => simulateFlowTool(input, pluginDir, projectDir)),
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
    gatedWrapHandler(async (input) => initWorkspaceFlow(input, projectDir, pluginDir)),
  );
}

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

function registerReportTools(): void {
  server.registerTool(
    "report_result",
    {
      description:
        "Report an agent's result. Normalizes status, evaluates transitions, updates board state, checks stuck detection. Returns next state and whether HITL is required.",
      inputSchema: reportResultInputSchema,
    },
    gatedWrapHandler(async (input) => reportResult({ ...input, project_dir: projectDir })),
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
    gatedWrapHandler(async (input) => getTranscript(input)),
  );
}

function registerUpdateBoardTool(): void {
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
          .object({ tasks: z.array(z.string()), wave: z.number(), wave_total: z.number() })
          .optional(),
        workspace: z.string(),
      },
    },
    gatedWrapHandler(async (input) => updateBoard(input)),
  );
}

function registerWaveEventTools(): void {
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
    gatedWrapHandler(async (input) => injectWaveEvent(input)),
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
    gatedWrapHandler(async (input) => resolveWaveEvent(input)),
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
    gatedWrapHandler(async (input) => resolveAfterConsultations(input)),
  );
}

function registerMessagingTools(): void {
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
    gatedWrapHandler(async (input) => postMessage(input)),
  );

  server.registerTool(
    "post_event",
    {
      description:
        "Log a structured agent activity event (start or complete) to the workspace event store. Agents call this instead of writing to log.jsonl. Events are stored in SQLite for cross-build analysis.",
      inputSchema: {
        action: z
          .enum(["start", "complete"])
          .describe("Whether the agent is starting or completing work"),
        agent: z.string().describe("Agent name (e.g. 'researcher', 'implementor')"),
        artifacts: z
          .array(z.string())
          .optional()
          .describe("Relative artifact paths produced (e.g. 'plans/add-auth/DESIGN.md')"),
        detail: z.string().describe("What the agent is beginning or completed"),
        workspace: z.string().describe("Workspace path"),
      },
    },
    wrapHandler(async (input) => postEvent(input)),
  );

  server.registerTool(
    "get_messages",
    {
      description:
        "Read messages from a workspace channel. Returns messages ordered by sequence number. Optionally includes pending wave events.",
      inputSchema: {
        channel: z.string().describe("Channel name to read from"),
        include_events: z.boolean().optional().describe("Also return pending wave events"),
        since: z
          .string()
          .optional()
          .describe("ISO timestamp — only return messages after this time"),
        workspace: z.string(),
      },
    },
    gatedWrapHandler(async (input) => getMessages(input)),
  );
}

function registerDriveFlowTool(): void {
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
              .optional()
              .default("done")
              .describe(
                "Agent status keyword (e.g. DONE, DONE_WITH_CONCERNS, BLOCKED). Defaults to 'done' when absent — omit when resuming after HITL with no other status to report.",
              ),
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
    gatedWrapHandler(async (input) => driveFlow(input, projectDir)),
  );
}

function registerCategorizeTool(): void {
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
    gatedWrapHandler(async (input) =>
      categorizeFailures(
        input as {
          workspace: string;
          failures: FailureEntry[];
          refined_categories?: Array<{ category: string; description: string; files: string[] }>;
        },
      ),
    ),
  );
}

function registerJournalTools(): void {
  // Feature flag gate: only register when agent-teams mode is active.
  // Keeps legacy CANON_AGENT_TEAMS_MODE=off path byte-identical.
  if (process.env.CANON_AGENT_TEAMS_MODE !== "on") return;

  server.registerTool(
    "log_step",
    {
      description:
        "Log a step in the orchestration journal. Records step execution for audit trail and completion verification. Accepts domain_skills_loaded and outcome fields for self-improving skills analysis (§4b P4).",
      inputSchema: {
        agent_type: z
          .string()
          .nullable()
          .optional()
          .describe("Agent definition name, null for gate-only steps"),
        artifacts_expected: z
          .array(z.string())
          .optional()
          .describe("Expected artifact paths relative to workspace"),
        domain_skills_loaded: z
          .array(z.string())
          .optional()
          .describe("Domain skills named in spawn prompt for this step"),
        outcome: z
          .object({
            fix_iterations: z.number().optional(),
            review_verdict: z.string().optional(),
            test_pass_rate: z.number().optional(),
          })
          .optional()
          .describe("Quality signals recorded on completion (§4b P4)"),
        status: z
          .enum(["planned", "started", "completed", "skipped"])
          .describe("Step execution status"),
        step_id: z.string().describe("Step ID from the runbook"),
        workspace: z.string().describe("Workspace directory path"),
      },
    },
    wrapHandler(async (input) => logStep(input)),
  );

  server.registerTool(
    "verify_completion",
    {
      description:
        "Verify flow completion by checking the orchestration journal. Returns steps logged, steps missing (started but not completed), artifacts missing, and a flow_outcome block with aggregated quality signals (domain skills used, review verdict, fix iterations, total duration).",
      inputSchema: {
        workspace: z.string().describe("Workspace directory path"),
      },
    },
    wrapHandler(async (input) => verifyCompletion(input)),
  );
}

export function registerOrchestrationTools(): void {
  registerFlowCoreTools();
  registerReportTools();
  registerUpdateBoardTool();
  registerWaveEventTools();
  registerMessagingTools();
  registerDriveFlowTool();
  registerCategorizeTool();
  registerJournalTools();
}
