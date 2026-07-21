import { getDecisions, logDecision } from "@features/orchestration/tools/decisions-ledger.ts";
import { getDecisionsCorpus } from "@features/orchestration/tools/get-decisions-corpus.ts";
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

/**
 * Post-implement/fix evaluator-gate result (CLAUDE.md Post-Step Effects,
 * ADR-0058). Two shapes are written by the orchestrator today:
 *   - verdict form: { verdict, advisory? } — verdict is PASS / FAIL /
 *     PASS_parse_fallback (and future PASS_* fallback variants)
 *   - skip form: { skipped } — tool_unavailable / tool_error
 * verdict/skipped are typed as z.string() rather than z.enum(...) so a
 * future legitimate value is never silently stripped by validation — the
 * exact class of bug this schema previously had (a future new value would
 * fail an enum and vanish at this boundary the same way the whole key did).
 * Plain z.object (no .strict()/.passthrough()) quietly drops unrecognized
 * nested keys instead of hard-failing or admitting arbitrary passthrough.
 */
const evaluatorGateOutcomeSchema = z
  .object({
    advisory: z.number().optional(),
    skipped: z.string().optional(),
    verdict: z.string().optional(),
  })
  .optional()
  .describe("Evaluator-gate verdict or skip reason (ADR-0058)");

const stepOutcomeSchema = z
  .object({
    evaluator_gate: evaluatorGateOutcomeSchema,
    fix_iterations: z.number().optional(),
    review_verdict: z.string().optional(),
    t2_recorded: z
      .boolean()
      .optional()
      .describe(
        "Whether the T2 live-forward-checker recorder fired for this review step (ADR-0065)",
      ),
    test_pass_rate: z.number().optional(),
  })
  .optional()
  .describe("Quality signals recorded on completion");

const stepStatusSchema = z
  .enum(["planned", "started", "completed", "skipped"])
  .describe("Step execution status");

/**
 * Exported for boundary testing — validates the registered input schema
 * directly, the same way the MCP SDK parses a real log_step/batch_log_steps
 * call. Tests that use this schema exercise the actual rejection/stripping
 * point, not just the impl (same convention as reconcileWorkspaceInputSchema
 * above). Shared by both log_step's inputSchema (outcome: stepOutcomeSchema)
 * and batch_log_steps's inputSchema (steps: z.array(stepEntrySchema)) — one
 * schema change here covers both tools.
 */
export const stepEntrySchema = z
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
        "Finalize a completed workflow: verify all steps are done, all artifacts are present, release file claims, release the workspace mutex, record analytics, and archive the workspace. Returns steps logged, missing steps, missing artifacts, aggregated quality signals, and post-completion cleanup results.",
      inputSchema: {
        session_id: z
          .string()
          .optional()
          .describe(
            "Calling session's identity for workspace mutex release — pass the same value " +
              "given to init_workspace. Omitting releases the lock unconditionally (single-session " +
              "backward compat). The shared HTTP daemon cannot derive per-session identity from " +
              "process.env; pass explicitly when running in a multi-session context.",
          ),
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

function registerGetDecisionsCorpus(server: McpServer): void {
  server.registerTool(
    "get_decisions_corpus",
    {
      description:
        "Read the offline, cross-workspace decisions corpus — unions every live-on-disk " +
        "workspace's decisions (.canon/workspaces/**/orchestration.db) with durably-persisted " +
        "decisions from workspaces already reaped (drift.db orchestrator_decisions table). " +
        "Returns the unioned, source-tagged (live|durable), deterministically-sorted records " +
        "plus an aggregation (by_category keyed on gate ?? decision_type, by_decision_type, " +
        "by_outcome, fill_rates) and a rendered markdown summary. Unreadable live stores are " +
        "surfaced in skipped[], never silently dropped.",
      inputSchema: {
        project_dir: z
          .string()
          .optional()
          .describe("Project root directory path (overridden by session scope server-side)"),
      },
    },
    gatedWrapHandler(async (input, extra) =>
      getDecisionsCorpus({ ...input, project_dir: resolveScope(extra) }),
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
  registerGetDecisionsCorpus(server);
  registerWriteOrchestratorCheckpoint(server);
}
