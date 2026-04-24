import { initWorkspaceFlow } from "@features/orchestration/tools/init-workspace.ts";
import { z } from "zod";
import { gatedWrapHandler, pluginDir, projectDir, server } from "./server-state.ts";

export function registerInitWorkspaceTool(): void {
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
        skip_flags: z.array(z.string()).optional(),
        task: z.string(),
        tier: z.enum(["small", "medium", "large"]),
      },
    },
    gatedWrapHandler(async (input) => initWorkspaceFlow(input, projectDir, pluginDir)),
  );
}
