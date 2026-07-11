import { reconcileLearnings } from "@features/learning/index.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { gatedWrapHandler } from "./server-state.ts";

/**
 * Register the learning-resolution tools on the given McpServer.
 *
 * Thin registration only — all logic lives in features/learning/. Mirrors
 * registerRoutineTools in register-routines.ts.
 */
export function registerLearningTools(server: McpServer): void {
  server.registerTool(
    "reconcile_learnings",
    {
      description:
        "Reconcile-on-read for the .canon/proposed-learnings/{timestamp}/ review surface (ADR-0050). Auto-moves actionable proposals whose target already shipped to applied/ (evidence-cited: target exists on disk + a commit touching it post-dates the proposal), and auto-archives fully-informational stale sets to stale/. Idempotent, fail-open, append-only, move-never-delete. Never touches the loose top-level proposal files.",
      inputSchema: {
        dry_run: z
          .boolean()
          .optional()
          .describe(
            "When true, compute and return the plan without moving files or appending learning.jsonl.",
          ),
        freshness_days: z
          .number()
          .optional()
          .describe("Staleness threshold in calendar days (default 30). Must be positive."),
        project_dir: z.string().describe("Project root directory path"),
      },
    },
    gatedWrapHandler(async (input) => reconcileLearnings(input)),
  );
}
