import { computeAutonomyTier } from "@features/orchestration/tools/compute-autonomy-tier.ts";
import { forecastBaseAdvance } from "@features/orchestration/tools/forecast-base-advance.ts";
import { getNextEscalationStrategy } from "@features/orchestration/tools/get-next-escalation-strategy.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { gatedWrapHandler, resolveScope } from "./server-state.ts";

/**
 * Confidence and escalation tool registrations.
 *
 * compute_autonomy_tier  — assess build risk and return gate-skip tier.
 * forecast_base_advance — plan-time exogenous-collision forecast (advisory-only).
 * get_next_escalation_strategy — advance the auto-escalation cascade for a failing step.
 */
export function registerConfidenceTools(server: McpServer): void {
  server.registerTool(
    "compute_autonomy_tier",
    {
      description:
        "Compute autonomy tier (autonomous/light-touch/supervised) from build history, blast radius, and compliance signals. Returns tier, score, reasoning, and signals_used. A sensitive-path deny-list floor forces supervised and sets require_security/require_adversarial on the result when file_paths intersects Canon's security-critical surfaces — uncircumventable by override_tier; the orchestrator MUST honor those fields (mandatory canon:security review + adversarial re-review). Fail-safe: defaults to supervised on any signal-gathering error, and the deny-list floor is still evaluated in that fail-safe path. Logs an auto_decision event to the execution store.",
      inputSchema: {
        file_paths: z.array(z.string()).describe("Files in the build scope"),
        override_tier: z
          .enum(["autonomous", "light-touch", "supervised"])
          .optional()
          .describe("Force a specific tier regardless of signals"),
        workspace: z.string().describe("Workspace path"),
      },
    },
    gatedWrapHandler(async (input, extra) =>
      computeAutonomyTier({ ...input, projectDir: resolveScope(extra) }),
    ),
  );

  server.registerTool(
    "forecast_base_advance",
    {
      description:
        "Plan-time exogenous-collision forecast: intersect the build's declared files with files changed on origin/main since base_commit and their co-change partners. Returns commits_ahead, overlapping_files, and a one-line advisory (null when main has not advanced or there is no overlap). Advisory-only — never blocks. Read-only: does NOT fetch (caller fetches first). Fail-safe: returns a silent result on any git/KG error.",
      inputSchema: {
        base_commit: z.string().describe("The build's base commit SHA"),
        declared_files: z
          .array(z.string())
          .describe("The architect's declared files: for this build"),
        workspace: z.string().describe("Workspace path"),
      },
    },
    gatedWrapHandler(async (input, extra) =>
      forecastBaseAdvance({ ...input, projectDir: resolveScope(extra) }),
    ),
  );

  server.registerTool(
    "get_next_escalation_strategy",
    {
      description:
        "Get next fallback strategy when an agent failure or stuck condition is detected. Reads and advances escalation state in the execution store. Returns strategy, reasoning, attempts_so_far, time_elapsed_ms, and is_terminal. Cascade sequence: add_primer → increase_budget → escalate_model → narrow_scope → hitl. Enforces a 2-minute cumulative timeout. Logs an auto_decision event.",
      inputSchema: {
        flow_config: z
          .object({
            skip_strategies: z
              .array(
                z.enum(["add_primer", "increase_budget", "escalate_model", "narrow_scope", "hitl"]),
              )
              .optional(),
            timeout_ms: z.number().int().positive().optional(),
          })
          .optional()
          .describe("Per-flow escalation configuration"),
        step_id: z.string().describe("Step ID where the failure occurred"),
        workspace: z.string().describe("Workspace path"),
      },
    },
    gatedWrapHandler(async (input) => getNextEscalationStrategy(input)),
  );
}
