import { invokeJanitor } from "@features/orchestration/tools/invoke-janitor.ts";
import { z } from "zod";
import { gatedWrapHandler, server } from "./server-state.ts";

export function registerJanitorTool(): void {
  server.registerTool(
    "invoke_janitor",
    {
      description:
        "Run the Canon background janitor. Checkpoints SQLite WAL files and detects stale worktrees. Non-blocking — all outcomes are reported in the result, never thrown.",
      inputSchema: {
        project_dir: z
          .string()
          .optional()
          .describe("Project root directory (defaults to CANON_PROJECT_DIR env or cwd)"),
      },
    },
    gatedWrapHandler(async (input) => invokeJanitor(input)),
  );
}
