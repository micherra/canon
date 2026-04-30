import { logStep, verifyCompletion } from "@features/orchestration/tools/orchestration-journal.ts";
import { wrapHandler } from "@shared/lib/wrap-handler.ts";
import { z } from "zod";
import { server } from "./server-state.ts";

export function registerJournalTools(): void {
  if (process.env.CANON_AGENT_TEAMS_MODE !== "on") return;

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
        outcome: z
          .object({
            fix_iterations: z.number().optional(),
            review_verdict: z.string().optional(),
            test_pass_rate: z.number().optional(),
          })
          .optional()
          .describe("Quality signals recorded on completion"),
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
        "Verify flow completion by checking the orchestration journal. Returns steps logged, missing steps, missing artifacts, and aggregated quality signals.",
      inputSchema: {
        workspace: z.string().describe("Workspace directory path"),
      },
    },
    wrapHandler(async (input) => verifyCompletion(input)),
  );
}
