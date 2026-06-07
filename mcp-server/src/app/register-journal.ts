import {
  batchLogSteps,
  finalizeWorkspace,
  logStep,
} from "@features/orchestration/tools/orchestration-journal.ts";
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

function registerReconcileWorkspace(server: McpServer): void {
  server.registerTool(
    "reconcile_workspace",
    {
      description:
        "Cliff detection, read-only w.r.t. the journal/archive: return started/planned steps whose declared artifacts are missing on disk. Call on resume/turn-start to detect agents that stopped before producing their artifacts. Never mutates or archives the journal. When emit_telemetry is true and a cliff is detected, appends a fail-open cliff_detected audit event to the execution-store event log (the only write it performs).",
      inputSchema: {
        emit_telemetry: z
          .boolean()
          .optional()
          .describe(
            "When true and a cliff is detected, append a fail-open cliff_detected audit event to the execution store.",
          ),
        source: z
          .enum(["resume", "post_subagent"])
          .optional()
          .describe("Telemetry source tag — which orchestrator path triggered the check."),
        workspace: z.string().describe("Workspace directory path"),
      },
    },
    gatedWrapHandler(async (input) => reconcileWorkspace(input)),
  );
}

export function registerJournalTools(server: McpServer): void {
  registerLogStep(server);
  registerBatchLogSteps(server);
  registerFinalizeWorkspace(server);
  registerReconcileWorkspace(server);
}
