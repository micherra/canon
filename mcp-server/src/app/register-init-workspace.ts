import { initWorkspaceFlow } from "@features/orchestration/tools/init-workspace.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { gatedWrapHandler, pluginDir, resolveScope } from "./server-state.ts";

export function registerInitWorkspaceTool(server: McpServer): void {
  server.registerTool(
    "init_workspace",
    {
      description:
        "Initialize a Canon workspace for flow execution. Creates workspace directory and initializes SQLite store. Resumes from existing store if present.",
      inputSchema: {
        base_commit: z.string(),
        branch: z.string(),
        brief_content: z
          .string()
          .optional()
          .describe(
            "Raw planning brief markdown to persist to ${WORKSPACE}/plans/${slug}/planning-brief.md at creation time",
          ),
        flow_name: z.string(),
        job_id: z
          .string()
          .optional()
          .describe(
            "Job identifier for the workspace mutex — first 8 chars of basename(CLAUDE_JOB_DIR). " +
              "The shared HTTP daemon cannot derive per-session identity from process.env; " +
              'pass from the orchestrator\'s env. Omitting stores "unknown" in the lock.',
          ),
        original_input: z.string().optional(),
        preflight: z
          .boolean()
          .optional()
          .describe(
            "Run pre-flight checks (git status, lock, stale sessions) before creating workspace",
          ),
        runbook_content: z
          .string()
          .optional()
          .describe(
            "Raw runbook markdown to persist to ${WORKSPACE}/plans/${slug}/runbook.md at creation time",
          ),
        session_id: z
          .string()
          .optional()
          .describe(
            "Calling session's identity for the workspace mutex — value of CLAUDE_CODE_SESSION_ID " +
              "in the orchestrator's env. The shared HTTP daemon cannot derive per-session identity " +
              'from process.env; pass explicitly. Omitting stores "unknown" in the lock.',
          ),
        skip_flags: z.array(z.string()).optional(),
        task: z.string(),
        tier: z.enum(["small", "medium", "large"]),
      },
    },
    gatedWrapHandler(async (input, extra) =>
      initWorkspaceFlow(input, resolveScope(extra), pluginDir),
    ),
  );
}
