/**
 * mutation-types.ts — Pure types for the mutator pipeline (trace-driven evolution Phase 1).
 *
 * Design:
 * - Pure types only. No I/O, no imports beyond attribution-types.
 * - `type` (not `interface`) per project style.
 * - `as const` for union constants.
 * - NEVER uses `unknown` — all fields are precisely typed.
 *
 * Canon principles:
 *   - errors-are-values: GateIneligibleTarget/SkippedAttribution are typed buckets, never thrown
 *   - no-llm-calls-in-mcp-tools: selection is pure deterministic join+rank, no model calls
 */

import type {
  AttributionConfidence,
  FailureAttribution,
  FailureKind,
} from "./attribution-types.ts";

// ---------------------------------------------------------------------------
// Budget constants — code-enforced, unit-tested (AC#6)
// ---------------------------------------------------------------------------

/** Maximum number of mutation targets selected per pass. */
export const DEFAULT_MAX_TARGETS_PER_PASS = 3;

/** Candidates generated per target (single-shot; no re-rolls in Phase 1). */
export const CANDIDATES_PER_TARGET = 1;

// ---------------------------------------------------------------------------
// Artifact class — discriminant for selection + proposal routing
// ---------------------------------------------------------------------------

export type ArtifactClass =
  | "rule"
  | "primer"
  | "agent"
  | "template"
  | "principle"
  | "skill"
  | "reference"
  | "tool-description"
  | "eval-surface";

// ---------------------------------------------------------------------------
// Core target shape — construction-ready for the learner's inline rewrite
// ---------------------------------------------------------------------------

/**
 * A single mutation target ready for the learner to generate a candidate.
 * `baseline_body` is the current on-disk file content (empty string when missing).
 * `gate_eligible` is always true here — ineligible paths land in GateIneligibleTarget.
 */
export type MutationTarget = {
  target_path: string;
  artifact_class: ArtifactClass;
  baseline_body: string;
  char_span: [number, number] | null;
  gate_eligible: boolean;
  confidence: AttributionConfidence;
  failure_kind: FailureKind;
  principle_id: string | null;
  attributed_violation_count: number;
  attribution: FailureAttribution;
};

// ---------------------------------------------------------------------------
// Selection options
// ---------------------------------------------------------------------------

export type MutationSelectionOptions = {
  /** Override DEFAULT_MAX_TARGETS_PER_PASS. */
  maxTargetsPerPass?: number;
  /**
   * Optional cross-run weighted instance count per principle_id.
   * Used as a tertiary ranking signal (ties within violation count).
   * Map from principle_id → weighted count (from learner's `>= 3` threshold data).
   */
  weightedCounts?: Record<string, number>;
};

// ---------------------------------------------------------------------------
// Lossy output buckets — typed, never silently dropped
// ---------------------------------------------------------------------------

/** An attribution excluded from selection because the target is not gate-eligible. */
export type GateIneligibleTarget = {
  target_path: string;
  artifact_class: ArtifactClass;
  reason:
    | "tool_description_not_loadable"
    | "file_missing"
    | "path_traversal"
    | "harness_entrypoint";
};

/** An attribution skipped before gate-eligibility check. */
export type SkippedAttribution = {
  target_path: string;
  reason: "hash_unverified" | "confidence_below_high" | "budget_exhausted";
};

// ---------------------------------------------------------------------------
// Selection result
// ---------------------------------------------------------------------------

/** Full result of selectMutationTargets — consumed directly by select_mutation_targets handler. */
export type SelectMutationTargetsResult = {
  /** Gate-eligible selected targets, ranked and budget-capped. */
  targets: MutationTarget[];
  /** Attributions excluded because their path is not gate-eligible. */
  gate_ineligible: GateIneligibleTarget[];
  /** Attributions skipped before gate-eligibility check (hash, confidence, budget). */
  skipped: SkippedAttribution[];
  /** Processing metadata for observability. */
  meta: {
    attributions_seen: number;
    selected: number;
    budget: number;
  };
};

// ---------------------------------------------------------------------------
// Proposal shape — emitted to .canon/proposed-learnings/ for accepted candidates
// ---------------------------------------------------------------------------

/**
 * MutationProposal — frontmatter type for a surviving evolution proposal.
 *
 * Invariant: `accepted: true` is always the literal (precondition: caller must
 * gate-check evalResult.accepted before calling shapeMutationProposal).
 *
 * apply_channel routing:
 *   principle | rule → "writer" (existing HITL author, review-learnings:79)
 *   all others       → "engineer-build-flow" (DEFERRED enrichment)
 */
export type MutationProposal = {
  id: string;
  type: "evolution-candidate";
  confidence: number;
  /** principle_id when available; falls back to target_path. */
  target: string;
  target_path: string;
  artifact_class: ArtifactClass;
  holdout_baseline: number;
  holdout_candidate: number;
  accepted: true;
  failure_kind: FailureKind;
  principle_id: string | null;
  join_basis: string;
  hash_verified: boolean;
  apply_channel: "writer" | "engineer-build-flow";
};
