/**
 * Evolution MCP tool registration.
 *
 * Registers:
 *   - evaluate_candidate       — Phase-1 candidate fitness gate tool.
 *   - attribute_failure        — Phase-1 attribution consumer: joins provenance + failures.
 *   - select_mutation_targets  — Phase-1 mutator: selects mutation targets from attributions.
 *
 * Lives in features/evolution/ (decisions evaluate-candidate-01, attribute-01, mutator-02).
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
import {
  GetEvolutionOutcomesInputSchema,
  getEvolutionOutcomes,
} from "@features/evolution/tools/get-evolution-outcomes.ts";
import {
  RecordAppliedEvolutionInputSchema,
  recordAppliedEvolution,
} from "@features/evolution/tools/record-applied-evolution.ts";
import {
  SelectMutationTargetsInputSchema,
  selectMutationTargetsHandler,
} from "@features/evolution/tools/select-mutation-targets.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { gatedWrapHandler, pluginDir } from "./server-state.ts";

const RECORD_APPLIED_EVOLUTION_DESC =
  "Record durable apply-provenance for an applied evolution-candidate " +
  "(drift.db applied_evolutions, ADR-0034). Writes one row tying proposal_id ↔ " +
  "target_path ↔ before/after content hash ↔ holdout scores ↔ applied_at ↔ " +
  "apply_base_commit. AUTHORITATIVE / FAIL-CLOSED: a storage failure returns a " +
  "ToolResult error, never fail-open — a lost provenance record is the exact gap " +
  "this closes. Idempotent on proposal_id (re-apply upserts). Only " +
  "evolution-candidate proposals (carrying holdout scores) are recorded.";

const GET_EVOLUTION_OUTCOMES_DESC =
  "Read a target-scoped, apply-anchored regression HYPOTHESIS for a recorded " +
  "evolution-candidate. Splits the target-scoped signal (reviews⋈violations per " +
  "principle_id, or cliff_events per agent_type) into a pre/post cohort anchored on " +
  "applied_at, reports a delta and a reused confidence tier (insufficient when either " +
  "side < 5 events), and flags concurrent-change confounds as ambiguous. " +
  "HYPOTHESIS VOCABULARY ONLY — presence/correlation phrasing, never proven causation. " +
  "FAIL-OPEN: absent signal rows → insufficient verdict, not an error. " +
  "PROPOSAL_NOT_RECORDED when no applied_evolutions row exists.";

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
    gatedWrapHandler(async (input) => attributeFailure(input, pluginDir)),
  );

  server.registerTool(
    "select_mutation_targets",
    {
      description:
        "Select mutation targets from Canon build attributions for trace-driven evolution. " +
        "Runs the full attribution pipeline (provenance → failure sources → join) then " +
        "applies the mutator selection gate: filters to hash-verified, high-confidence " +
        "attributions; partitions by gate-eligibility (guardrail paths and eval surface, " +
        "not .ts or register-* entrypoints); ranks by violation count then weighted counts; " +
        "caps at max_targets_per_pass (default 3). " +
        "DETERMINISTIC — no model calls, no subprocess. Pure join + rank + read. " +
        "Fail-open: absent provenance or reviews → empty targets, not error. " +
        "INVALID_INPUT when both or neither of workspace/archive_id are provided.",
      inputSchema: SelectMutationTargetsInputSchema.shape,
    },
    gatedWrapHandler(async (input) => selectMutationTargetsHandler(input, pluginDir)),
  );

  server.registerTool(
    "record_applied_evolution",
    {
      description: RECORD_APPLIED_EVOLUTION_DESC,
      inputSchema: RecordAppliedEvolutionInputSchema.shape,
    },
    gatedWrapHandler(async (input) => recordAppliedEvolution(input)),
  );

  server.registerTool(
    "get_evolution_outcomes",
    {
      description: GET_EVOLUTION_OUTCOMES_DESC,
      inputSchema: GetEvolutionOutcomesInputSchema.shape,
    },
    gatedWrapHandler(async (input) => getEvolutionOutcomes(input)),
  );
}
