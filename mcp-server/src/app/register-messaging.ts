import { getMessages } from "@features/orchestration/tools/get-messages.ts";
import { postEvent } from "@features/orchestration/tools/post-event.ts";
import { postMessage } from "@features/orchestration/tools/post-message.ts";
import { wrapHandler } from "@shared/lib/wrap-handler.ts";
import { z } from "zod";
import { gatedWrapHandler, server } from "./server-state.ts";

export function registerMessagingTools(): void {
  server.registerTool(
    "post_message",
    {
      description: "Post a message to a workspace channel for inter-agent communication.",
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
      description: "Log a structured agent activity event to the workspace.",
      inputSchema: {
        action: z
          .enum(["start", "complete"])
          .describe("Whether the agent is starting or completing work"),
        agent: z.string().describe("Agent name (e.g. 'engineer', 'architect')"),
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
      description: "Read messages from a workspace channel, ordered by sequence number.",
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
