import { listActiveWorkspaces } from "@features/orchestration/tools/list-active-workspaces.ts";
import { postEvent } from "@features/orchestration/tools/post-event.ts";
import { postMessage } from "@features/orchestration/tools/post-message.ts";
import { tailMessages } from "@features/orchestration/tools/tail-messages.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { wrapHandler } from "@shared/lib/wrap-handler.ts";
import { z } from "zod";
import { gatedWrapHandler, resolveScope } from "./server-state.ts";

/**
 * Best-effort-poll bound stated verbatim in both chatter tool descriptions (dc-07)
 * so consumers never assume reliable push.
 */
const BEST_EFFORT_POLL_DISCLAIMER =
  "Best-effort ordered poll. No delivery guarantee, no push/subscribe: messages are visible on " +
  "the next tail_messages poll, ordered by id. SQLite is a store, not a bus.";

const ACTIVE_WORKSPACE_STATUS_FILTER = z
  .enum(["live", "finalized_on_disk", "reaped"])
  .optional()
  .describe("Narrow to workspaces in this registry status. Omit to return all statuses.");

function registerPostEvent(server: McpServer): void {
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

function registerPostMessage(server: McpServer): void {
  server.registerTool(
    "post_message",
    {
      description:
        "Post a cross-session chat message to a build's workspace, so another Claude Code " +
        "session working the same or a related build can see it. The workspace path IS the " +
        "channel — one implicit channel per workspace, no channel abstraction. Only workspaces " +
        "registered as 'live' or 'finalized_on_disk' in the active-workspaces registry accept " +
        `posts; unknown or reaped workspaces are rejected. ${BEST_EFFORT_POLL_DISCLAIMER}`,
      inputSchema: {
        content: z.string().describe("Message body"),
        sender: z.string().describe("Who is posting (e.g. 'engineer', 'orchestrator')"),
        workspace: z
          .string()
          .describe("Absolute workspace path. This IS the channel — messages are scoped to it."),
      },
    },
    gatedWrapHandler(async (input, extra) => postMessage(input, resolveScope(extra))),
  );
}

function registerTailMessages(server: McpServer): void {
  server.registerTool(
    "tail_messages",
    {
      description:
        "Poll a build's workspace for cross-session chat messages posted via post_message, " +
        "plus a peer_lock liveness field showing who currently holds the workspace mutex. Only " +
        "workspaces registered as 'live' or 'finalized_on_disk' in the active-workspaces " +
        `registry are readable; unknown or reaped workspaces are rejected. ${BEST_EFFORT_POLL_DISCLAIMER}`,
      inputSchema: {
        since_id: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Only return messages with id greater than this. Defaults to 0 (all)."),
        workspace: z.string().describe("Absolute workspace path. This IS the channel."),
      },
    },
    gatedWrapHandler(async (input, extra) => tailMessages(input, resolveScope(extra))),
  );
}

function registerListActiveWorkspaces(server: McpServer): void {
  server.registerTool(
    "list_active_workspaces",
    {
      description:
        "Discovery index of active builds (live, finalized-on-disk, or reaped) resolved from " +
        "the project-level active-workspaces registry. Lets a session find another session's " +
        "build without a pasted path — pair with tail_messages/post_message on the returned " +
        "workspace_path.",
      inputSchema: {
        status_filter: ACTIVE_WORKSPACE_STATUS_FILTER,
      },
    },
    gatedWrapHandler(async (input, extra) => listActiveWorkspaces(input, resolveScope(extra))),
  );
}

export function registerMessagingTools(server: McpServer): void {
  registerPostEvent(server);
  registerPostMessage(server);
  registerTailMessages(server);
  registerListActiveWorkspaces(server);
}
