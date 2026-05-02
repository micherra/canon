import { ResolvedFlowSchema } from "@domains/flows/flow-definition-schemas.ts";
import { driveFlow } from "@features/orchestration/tools/drive-flow.ts";
import { toolError } from "@shared/lib/tool-result.ts";
import { z } from "zod";
import { gatedWrapHandler, projectDir, server } from "./server-state.ts";

const TEAMS_MODE_ERROR = toolError(
  "INVALID_INPUT",
  "Legacy flow tools are not available when CANON_AGENT_TEAMS_MODE=on. Use agent-teams orchestration instead.",
  false,
);

export function registerDriveFlowTool(): void {
  const teamsMode = process.env.CANON_AGENT_TEAMS_MODE === "on";

  server.registerTool(
    "drive_flow",
    {
      description:
        "Drive the Canon state machine. First call (no result) enters current state and returns SpawnRequest[]; subsequent calls (with result) report agent result and return next action (spawn, hitl, or done).",
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
                "Agent status keyword (e.g. DONE, DONE_WITH_CONCERNS, BLOCKED). Defaults to 'done'.",
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
    gatedWrapHandler(async (input) => {
      if (teamsMode) return TEAMS_MODE_ERROR;
      return driveFlow(input, projectDir);
    }),
  );
}
