/**
 * Evolution MCP tool registration.
 *
 * Registers:
 *   - evaluate_candidate — Phase-1 candidate fitness gate tool.
 *   - attribute_failure  — Phase-1 attribution consumer: joins provenance + failures.
 *
 * Lives in features/evolution/ (decisions evaluate-candidate-01, attribute-01).
 *
 * ADR-002: features/evolution/ NEVER imports node:child_process.
 * All subprocess work routes through @platform/adapters/process-adapter.ts.
 */

import {
  AttributeFailureInputSchema,
  attributeFailure,
} from "@features/evolution/tools/attribute-failure.ts";
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

  server.registerTool(
    "attribute_failure",
    {
      description:
        "Attribute observed failures (review violations, cliff events) to the specific " +
        "artifacts that were in the failing agent's context during a build. " +
        "Joins recorded context_provenance with review violations and cliff events, " +
        "re-verifies content_hash byte-identity (fail-closed: hash_verified true ONLY on " +
        "exact match), and surfaces typed attribution hypotheses. " +
        "HYPOTHESIS VOCABULARY ONLY — attributions assert presence-in-context, " +
        "never proven causation. " +
        "Produces the mutator-facing contract for trace-driven-evolution Phase 2. " +
        "Fail-open: absent provenance or reviews → partial output, not error.",
      inputSchema: AttributeFailureInputSchema.shape,
    },
    gatedWrapHandler(async (input) => attributeFailure(input)),
  );
}
