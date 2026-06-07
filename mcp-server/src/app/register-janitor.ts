import { invokeJanitor } from "@features/orchestration/tools/invoke-janitor.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { gatedWrapHandler, resolveScope } from "./server-state.ts";

export function registerJanitorTool(server: McpServer): void {
  server.registerTool(
    "invoke_janitor",
    {
      description:
        "Run the Canon background janitor. Checkpoints SQLite WAL files and detects stale worktrees. Non-blocking — all outcomes are reported in the result, never thrown.",
      inputSchema: {
        project_dir: z
          .string()
          .optional()
          .describe(
            "Project root directory override (defaults to the per-connection resolved scope)",
          ),
      },
    },
    gatedWrapHandler(async (input, extra) => invokeJanitor(input, resolveScope(extra))),
  );
}
