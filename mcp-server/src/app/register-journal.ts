import { getDecisions, logDecision } from "@features/orchestration/tools/decisions-ledger.ts";
import {
  batchLogSteps,
  finalizeWorkspace,
  logStep,
} from "@features/orchestration/tools/orchestration-journal.ts";
import { writeOrchestratorCheckpoint } from "@features/orchestration/tools/orchestrator-checkpoint.ts";
import { reconcileWorkspace } from "@features/orchestration/tools/reconcile-workspace.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { gatedWrapHandler, resolveScope } from "./server-state.ts";

const stepOutcomeSchema = z
  .object({
    fix_iterations: z.number().optional(),
    review_verdict: z.string().optional(),
    test_pass_rate: z.number().optional(),
  })
  .optional()
  .describe("Quality signals recorded on completion");

const stepStatusSchema = z
  .enum(["planned", "started", "completed", "skipped"])
  .describe("Step execution status");

const stepEntrySchema = z
  .object({
    agent_id: z
      .string()
      .optional()
      .describe(
        "Agent ID for transcript capture. When provided on a completed step, triggers best-effort transcript capture.",
      ),
    agent_type: z
      .string()
      .nullable()
      .optional()
      .describe("Agent definition name, null for gate-only steps"),
    artifacts_expected: z
      .array(z.string())
      .optional()
      .describe("Expected artifact paths relative to workspace"),
    domain_skills_loaded: z.array(z.string()).optional(),
    outcome: stepOutcomeSchema,
    skip_reason: z.string().optional().describe("Reason a tail step was skipped"),
    status: stepStatusSchema,
    step_id: z.string().describe("Step ID from the runbook"),
  })
  .refine(
    (data) =>
      data.status !== "skipped" ||
      (typeof data.skip_reason === "string" && data.skip_reason.length > 0),
    { message: "skip_reason is required when status is 'skipped'", path: ["skip_reason"] },
  );

function registerLogStep(server: McpServer): void {
  server.registerTool(
    "log_step",
    {
      description:
        "Log a step in the orchestration journal. Records step execution for audit trail and completion verification.",
      inputSchema: {
        agent_id: z
          .string()
          .optional()
          .describe(
            "Agent ID from the Agent tool result. When provided with status=completed, triggers best-effort transcript capture inside the MCP server process.",
          ),
        agent_type: z
          .string()
          .nullable()
          .optional()
          .describe("Agent definition name, null for gate-only steps"),
        artifacts_expected: z
          .array(z.string())
          .optional()
          .describe("Expected artifact paths relative to workspace"),
        domain_skills_loaded: z.array(z.string()).optional(),
        outcome: stepOutcomeSchema,
        skip_reason: z
          .string()
          .optional()
          .describe(
            "Reason a tail step was skipped. Required (non-empty) when status is 'skipped'.",
          ),
        status: stepStatusSchema,
        step_id: z.string().describe("Step ID from the runbook"),
        workspace: z.string().describe("Workspace directory path"),
      },
    },
    gatedWrapHandler(async (input, extra) =>
      logStep({ ...input, projectDir: resolveScope(extra) }),
    ),
  );
}

function registerBatchLogSteps(server: McpServer): void {
  server.registerTool(
    "batch_log_steps",
    {
      description:
        "Log multiple steps in a single journal read-modify-write cycle. Accepts an array of step entries and writes them all atomically. Fails the entire batch if any entry has an empty step_id.",
      inputSchema: {
        steps: z.array(stepEntrySchema).describe("Array of step entries to log in one batch"),
        workspace: z.string().describe("Workspace directory path"),
      },
    },
    gatedWrapHandler(async (input, extra) =>
      batchLogSteps({ ...input, projectDir: resolveScope(extra) }),
    ),
  );
}

function registerFinalizeWorkspace(server: McpServer): void {
  server.registerTool(
    "finalize_workspace",
    {
      description:
        "Finalize a completed workflow: verify all steps are done, all artifacts are present, release file claims, record analytics, and archive the workspace. Returns steps logged, missing steps, missing artifacts, aggregated quality signals, and post-completion cleanup results.",
      inputSchema: {
        workspace: z.string().describe("Workspace directory path"),
      },
    },
    gatedWrapHandler(async (input, extra) =>
      finalizeWorkspace({ ...input, projectDir: resolveScope(extra) }),
    ),
  );
}

/**
 * Exported for boundary testing — validates the registered input schema directly.
 * Tests that use this schema exercise the actual rejection point, not just the impl.
 */
export const reconcileWorkspaceInputSchema = z.object({
  emit_telemetry: z
    .boolean()
    .optional()
    .describe(
      "When true and a cliff is detected, append a fail-open cliff_detected audit event to the execution store.",
    ),
  source: z
    .enum(["resume", "post_subagent", "loop"])
    .optional()
    .describe("Telemetry source tag — which orchestrator path triggered the check."),
  workspace: z.string().describe("Workspace directory path"),
});

function registerReconcileWorkspace(server: McpServer): void {
  server.registerTool(
    "reconcile_workspace",
    {
      description:
        "Cliff detection, read-only w.r.t. the journal/archive: return started/planned steps whose declared artifacts are missing on disk. Call on resume/turn-start to detect agents that stopped before producing their artifacts. Never mutates or archives the journal. When emit_telemetry is true and a cliff is detected, performs two fail-open writes: (1) appends a cliff_detected audit event to the execution-store event log, and (2) writes a durable row per incomplete step to drift.db via CliffEventsDao (when projectDir is available). Both writes are best-effort — failures are warned but never alter the returned result.",
      inputSchema: {
        emit_telemetry: reconcileWorkspaceInputSchema.shape.emit_telemetry,
        source: reconcileWorkspaceInputSchema.shape.source,
        workspace: reconcileWorkspaceInputSchema.shape.workspace,
      },
    },
    gatedWrapHandler(async (input, extra) =>
      reconcileWorkspace({ ...input, projectDir: resolveScope(extra) }),
    ),
  );
}

/** Decision type enum values for Zod schema. */
const DECISION_TYPES = [
  "hitl_gate",
  "scope_cut",
  "ac_change",
  "tier_override",
  "merge_resolution",
  "manual_verification",
  "other",
] as const;

function registerLogDecision(server: McpServer): void {
  server.registerTool(
    "log_decision",
    {
      description:
        "Append a timestamped orchestrator decision to the durable event log (orchestrator_decision type). " +
        "This is an AUTHORITATIVE write — returns a ToolResult error on store failure (NOT fail-open). " +
        "Call at each consequential decision: HITL gate outcomes, scope cuts, AC changes, tier overrides, merge resolutions, manual-verification confirmations.",
      inputSchema: {
        decision_type: z.enum(DECISION_TYPES).describe("Category of decision (closed enum)"),
        gate: z
          .string()
          .optional()
          .describe("HITL gate name, e.g. 'plan_approval', 'review_verdict'"),
        outcome: z
          .string()
          .optional()
          .describe("Result of the decision, e.g. 'approved', 'overridden', 'descoped'"),
        rationale: z.string().optional().describe("Why this decision was made"),
        refs: z.array(z.string()).optional().describe("References, e.g. ['AC#3', 'REVIEW.md']"),
        summary: z.string().describe("One-line human-readable description of what was decided"),
        workspace: z.string().describe("Workspace directory path"),
      },
    },
    gatedWrapHandler(async (input, extra) =>
      logDecision({ ...input, projectDir: resolveScope(extra) }),
    ),
  );
}

function registerGetDecisions(server: McpServer): void {
  server.registerTool(
    "get_decisions",
    {
      description:
        "Read the orchestrator decisions ledger (getEventsByType('orchestrator_decision')). " +
        "Returns the structured array of DecisionRecord objects and a rendered markdown table (human-readable view). " +
        "Use before HITL gates and on resume to rehydrate decided state.",
      inputSchema: {
        workspace: z.string().describe("Workspace directory path"),
      },
    },
    gatedWrapHandler(async (input, extra) =>
      getDecisions({ ...input, projectDir: resolveScope(extra) }),
    ),
  );
}

function registerWriteOrchestratorCheckpoint(server: McpServer): void {
  server.registerTool(
    "write_orchestrator_checkpoint",
    {
      description:
        "Write a derived compact resume-state snapshot to ${workspace}/checkpoint.md " +
        "(current/completed/pending steps + recent decisions + next action). " +
        "Best-effort-observable: returns a ToolResult error on write failure (never silent). " +
        "Refresh after each completed step (alongside log_step(...completed)) and at each HITL gate.",
      inputSchema: {
        next_action: z
          .string()
          .optional()
          .describe(
            "Explicit next-action hint. If absent, derived from the first non-terminal journal step.",
          ),
        workspace: z.string().describe("Workspace directory path"),
      },
    },
    gatedWrapHandler(async (input, extra) =>
      writeOrchestratorCheckpoint({ ...input, projectDir: resolveScope(extra) }),
    ),
  );
}

export function registerJournalTools(server: McpServer): void {
  registerLogStep(server);
  registerBatchLogSteps(server);
  registerFinalizeWorkspace(server);
  registerReconcileWorkspace(server);
  registerLogDecision(server);
  registerGetDecisions(server);
  registerWriteOrchestratorCheckpoint(server);
}
