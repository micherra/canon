import {
  batchLogSteps,
  finalizeWorkspace,
  logStep,
} from "@features/orchestration/tools/orchestration-journal.ts";
import { wrapHandler } from "@shared/lib/wrap-handler.ts";
import { z } from "zod";
import { server } from "./server-state.ts";

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

const stepEntrySchema = z.object({
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
  skip_reason: z
    .string()
    .optional()
    .describe("Reason a tail step was skipped — required when status is skipped for tail steps"),
  status: stepStatusSchema,
  step_id: z.string().describe("Step ID from the runbook"),
});

function registerLogStep(): void {
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
            "Reason a tail step was skipped — required when status is skipped for tail steps",
          ),
        status: stepStatusSchema,
        step_id: z.string().describe("Step ID from the runbook"),
        workspace: z.string().describe("Workspace directory path"),
      },
    },
    wrapHandler(async (input) => logStep(input)),
  );
}

function registerBatchLogSteps(): void {
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
    wrapHandler(async (input) => batchLogSteps(input)),
  );
}

function registerFinalizeWorkspace(): void {
  server.registerTool(
    "finalize_workspace",
    {
      description:
        "Finalize a completed workflow: verify all steps are done, all artifacts are present, release file claims, record analytics, and archive the workspace. Returns steps logged, missing steps, missing artifacts, aggregated quality signals, and post-completion cleanup results.",
      inputSchema: {
        workspace: z.string().describe("Workspace directory path"),
      },
    },
    wrapHandler(async (input) => finalizeWorkspace(input)),
  );
}

export function registerJournalTools(): void {
  registerLogStep();
  registerBatchLogSteps();
  registerFinalizeWorkspace();
}
