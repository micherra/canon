import { postEvent } from "@features/orchestration/tools/post-event.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { wrapHandler } from "@shared/lib/wrap-handler.ts";
import { z } from "zod";

export function registerMessagingTools(server: McpServer): void {
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
}
