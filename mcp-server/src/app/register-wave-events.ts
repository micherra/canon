import { ResolvedFlowSchema } from "@domains/flows/flow-definition-schemas.ts";
import { injectWaveEvent } from "@features/orchestration/tools/inject-wave-event.ts";
import { resolveAfterConsultations } from "@features/orchestration/tools/resolve-after-consultations.ts";
import { resolveWaveEvent } from "@features/orchestration/tools/resolve-wave-event.ts";
import { z } from "zod";
import { gatedWrapHandler, server } from "./server-state.ts";

export function registerWaveEventTools(): void {
  server.registerTool(
    "inject_wave_event",
    {
      description: "Inject a user event into a running wave execution.",
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
        "Resolve a pending wave event by applying or rejecting it. Returns agent routing for orchestrator spawn dispatch.",
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
      description: "Resolve after-consultation prompts for a state.",
      inputSchema: {
        flow: ResolvedFlowSchema.describe("Resolved flow object"),
        state_id: z.string(),
        variables: z.record(z.string(), z.string()),
        workspace: z.string(),
      },
    },
    gatedWrapHandler(async (input) => resolveAfterConsultations(input)),
  );
}
