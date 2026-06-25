/**
 * Evolution MCP tool registration.
 *
 * Registers evaluate_candidate — the Phase-1 candidate fitness gate tool.
 * Lives in features/evolution/ (decision evaluate-candidate-01).
 *
 * ADR-002: features/evolution/ NEVER imports node:child_process.
 * All subprocess work routes through @platform/adapters/process-adapter.ts.
 */

import {
  EvaluateCandidateInputSchema,
  evaluateCandidate,
} from "@features/evolution/tools/evaluate-candidate.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { gatedWrapHandler } from "./server-state.ts";

export function registerEvolutionTools(server: McpServer): void {
  server.registerTool(
    "evaluate_candidate",
    {
      description:
        "Evaluate a candidate artifact against the Canon eval suite. " +
        "Injects the candidate into an isolated temp-dir copy of the eval surface (ADR-0019), " +
        "runs the eval harness per split (train/val/holdout), and applies the §7 strict-holdout " +
        "improvement gate. Returns accepted=true ONLY when holdout pass count strictly increases. " +
        "Fail-closed: any subprocess error or timeout is NOT an accept.",
      inputSchema: EvaluateCandidateInputSchema.shape,
    },
    gatedWrapHandler(async (input) => evaluateCandidate(input)),
  );
}
