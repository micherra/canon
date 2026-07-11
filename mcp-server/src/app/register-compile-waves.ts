import { compileWavesTool } from "@features/orchestration/tools/compile-waves.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { gatedWrapHandler, resolveScope } from "./server-state.ts";

export function registerCompileWavesTool(server: McpServer): void {
  server.registerTool(
    "compile_waves",
    {
      description:
        "Compile a validated task-dag.yaml + its task plans into a WavesArgs envelope for the workflows/canon-waves.js generic runner (canon-waves increment 1, single-wave only). Read-only — reads task-dag.yaml + {task_id}-PLAN.md files, fills a self-contained worker prompt per task, and returns { envelope, worktrees_to_create }. The orchestrator pre-creates each worktree from worktrees_to_create before invoking the runner. Fails closed with INVALID_INPUT on any DAG validation error (including multi-wave DAGs, out of increment-1 scope) — never a partial envelope.",
      inputSchema: {
        base_commit: z.string().describe("Git commit SHA the build worktree was created from"),
        build_worktree: z.string().describe("Absolute path to the Canon build worktree"),
        project_dir: z
          .string()
          .optional()
          .describe("Project root; defaults to the resolved session scope when omitted"),
        slug: z.string().describe("Build slug — matches ${WORKSPACE}/plans/${slug}"),
        workspace: z.string().describe("Absolute path to the Canon workspace"),
      },
    },
    gatedWrapHandler(async (input, extra) =>
      compileWavesTool(input, resolveScope(extra)),
    ),
  );
}
