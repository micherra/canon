/**
 * Evolution MCP tool registration.
 *
 * Registers:
 *   - evaluate_candidate       — Phase-1 candidate fitness gate tool.
 *   - attribute_failure        — Phase-1 attribution consumer: joins provenance + failures.
 *   - select_mutation_targets  — Phase-1 mutator: selects mutation targets from attributions.
 *   - attribute_outcomes       — Gap 3 Layer 2: signed, trust-weighted, two-sided score map
 *                                over the decisions/RunSummary corpus (DESIGN.md dc-01/dc-03).
 *   - record_applied_evolution — ADR-0034 authoritative apply-provenance write.
 *   - get_evolution_outcomes   — ADR-0034 fail-open regression-hypothesis reader.
 *   - backfill_applying_commit — Inc-3 best-effort back-fill of applying_commit from
 *                                Canon-Evolution: git trailers.
 *
 * Lives in features/evolution/ (decisions evaluate-candidate-01, attribute-01, mutator-02).
 *
 * ADR-002: features/evolution/ NEVER imports node:child_process.
 * All subprocess work routes through @platform/adapters/process-adapter.ts or
 * @platform/adapters/git-adapter.ts.
 *
 * attribute_outcomes composition note: features/evolution/ may not import
 * features/orchestration/services/decisions-corpus.ts directly (no-cross-feature-
 * internal-import) — this composition root resolves buildDecisionsCorpus and injects
 * it, the same precedent app/register-knowledge.ts uses for ensureContextGraphFresh's
 * decisions parameter.
 */

import {
  AttributeFailureInputSchema,
  attributeFailure,
} from "@features/evolution/tools/attribute-failure.ts";
import {
  AttributeOutcomesInputSchema,
  attributeOutcomes,
} from "@features/evolution/tools/attribute-outcomes.ts";
import {
  BackfillApplyingCommitInputSchema,
  backfillApplyingCommit,
} from "@features/evolution/tools/backfill-applying-commit.ts";
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
import { buildDecisionsCorpus } from "@features/orchestration/services/decisions-corpus.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { gatedWrapHandler, pluginDir } from "./server-state.ts";

const ATTRIBUTE_OUTCOMES_DESC =
  "Signed, trust-weighted, two-sided per-principle score map derived on-read from the " +
  "decisions/RunSummary corpus (Gap 3 Layer 2, DESIGN.md). For each build, joins " +
  "positive (honored[]) and negative (violation/cliff) signals to in-context artifacts " +
  "and weights each by source-tier, corroboration, and time-decay — a careful " +
  "adversarial catch outweighs an author's self-exoneration, a corroborated jury " +
  "outweighs a single juror, and stale signal decays. Returns " +
  "{ scores: [{ principle_id, net_score, positive_weight, negative_weight, " +
  "corroboration, tier_breakdown, contributing_builds }], unattributed_positive, " +
  "unattributed_negative, flagged, meta }. DETERMINISTIC — same corpus + same threaded " +
  "`now` produces byte-identical scores; no Date.now(), no model calls. " +
  "PURE QUERY — mutates nothing. Fail-open: absent provenance/reviews/archives → " +
  "partial (empty scores), never throws. INVALID_INPUT when project_dir is missing.";

const RECORD_APPLIED_EVOLUTION_DESC =
  "Record durable apply-provenance for an applied evolution-candidate " +
  "(drift.db applied_evolutions, ADR-0034). Writes one row tying proposal_id ↔ " +
  "target_path ↔ before/after content hash ↔ holdout scores ↔ applied_at ↔ " +
  "apply_base_commit. AUTHORITATIVE / FAIL-CLOSED: a storage failure returns a " +
  "ToolResult error, never fail-open — a lost provenance record is the exact gap " +
  "this closes. Idempotent on proposal_id (re-apply upserts). Only " +
  "evolution-candidate proposals (carrying holdout scores) are recorded.";

const BACKFILL_APPLYING_COMMIT_DESC =
  "Back-fill applied_evolutions.applying_commit from Canon-Evolution: {proposal_id} git " +
  "trailers (Inc-3, ADR-0034). Reads git log for trailer commits, parses id↔sha pairs " +
  "(charset-guarded), and applies a null-only, idempotent UPDATE — never clobbers an " +
  "already-set applying_commit. OBSERVABLE-BEST-EFFORT (not fail-closed): a git or " +
  "storage failure returns a ToolResult error, but the caller surfaces a warning and " +
  "does not block or undo an apply. record_applied_evolution stays the authoritative " +
  "write path; this tool only reconciles a nullable column. Returns { updated, scanned }.";

const GET_EVOLUTION_OUTCOMES_DESC =
  "Read a target-scoped, apply-anchored regression HYPOTHESIS for a recorded " +
  "evolution-candidate. Splits the target-scoped signal (reviews⋈violations per " +
  "principle_id, or cliff_events per agent_type) into a pre/post cohort anchored on " +
  "applied_at, reports a delta and a reused confidence tier (insufficient when either " +
  "side < 5 events), and flags concurrent-change confounds as ambiguous. " +
  "HYPOTHESIS VOCABULARY ONLY — presence/correlation phrasing, never proven causation. " +
  "FAIL-OPEN: absent signal rows → insufficient verdict, not an error. " +
  "PROPOSAL_NOT_RECORDED when no applied_evolutions row exists.";

/** Phase-1 mutator pipeline: evaluate_candidate, attribute_failure, select_mutation_targets. */
function registerMutatorPipelineTools(server: McpServer): void {
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
    "attribute_outcomes",
    {
      description: ATTRIBUTE_OUTCOMES_DESC,
      inputSchema: AttributeOutcomesInputSchema.shape,
    },
    gatedWrapHandler(async (input) => {
      // Skip the corpus read entirely on an empty project_dir — attributeOutcomes
      // itself returns INVALID_INPUT; avoids buildDecisionsCorpus touching a
      // CWD-relative .canon/ path before that guard fires.
      const decisions = input.project_dir ? buildDecisionsCorpus(input.project_dir).decisions : [];
      return attributeOutcomes(input, pluginDir, decisions);
    }),
  );
}

/** ADR-0034 apply-provenance tools + Inc-3's back-fill reconciliation tool. */
function registerApplyProvenanceTools(server: McpServer): void {
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

  server.registerTool(
    "backfill_applying_commit",
    {
      description: BACKFILL_APPLYING_COMMIT_DESC,
      inputSchema: BackfillApplyingCommitInputSchema.shape,
    },
    gatedWrapHandler(async (input) => backfillApplyingCommit(input)),
  );
}

export function registerEvolutionTools(server: McpServer): void {
  registerMutatorPipelineTools(server);
  registerApplyProvenanceTools(server);
}
