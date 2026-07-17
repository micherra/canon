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

import type { ArtifactTrustTier } from "@domains/workspaces/context-provenance.ts";
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
// canon:allow-unwired: budget constant consumed by the evolve-candidate SKILL.md procedure (markdown, not TS code); pins single-shot candidates_per_target=1 per AC#6
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
// Proposal kind + score provenance — Gap 3 Layer 3 (learner retire/reinforce wiring)
// ---------------------------------------------------------------------------

/**
 * Discriminant for what a mutation candidate proposes to do:
 *   - "rewrite"   — unchanged Phase 1 behavior: a full-file/span candidate replacing
 *                   the artifact, gated by violation-based attribution.
 *   - "retire"    — the artifact's trust-weighted net_score (attribute_outcomes) is
 *                   strongly negative; candidate_text is the WEAKENED/invalidated
 *                   artifact (invalidate-don't-delete — never a deletion request).
 *   - "reinforce" — the artifact's trust-weighted net_score is strongly positive;
 *                   informational only, no content change proposed.
 * Defaults to "rewrite" wherever existing code constructs a target/proposal without
 * setting it explicitly, keeping current behavior byte-compatible.
 */
export type MutationProposalKind = "rewrite" | "retire" | "reinforce";

/** One signed, weighted contribution from a single build — the auditable trace unit. */
export type ScoreProvenanceContribution = {
  archive_id: string;
  sign: 1 | -1;
  weight: number;
};

/**
 * The auditable trace set backing a retire/reinforce candidate — carries WHY a
 * principle is being retired or reinforced (invalidate-don't-delete posture: a
 * retirement is never a silent drop). Mirrors outcome-attribution.ts's
 * TrustWeightedScore net_score + contributing_builds shape (Gap 3 Layer 2).
 */
export type ScoreProvenance = {
  net_score: number;
  contributing_builds: ScoreProvenanceContribution[];
};

// ---------------------------------------------------------------------------
// Core target shape — construction-ready for the learner's inline rewrite
// ---------------------------------------------------------------------------

/**
 * A single mutation target ready for the learner to generate a candidate.
 * `baseline_body` is the current on-disk file content (empty string when missing).
 * `gate_eligible` is always true here — ineligible paths land in GateIneligibleTarget.
 *
 * `attribution` and `failure_kind` are nullable: a retire/reinforce target (Gap 3
 * Layer 3) is derived from a corpus-wide trust-weighted score, not a single
 * violation-based join — it has no FailureAttribution and no FailureKind to report.
 * `proposal_kind`/`score_provenance` are optional and absent for the unchanged
 * "rewrite" path.
 *
 * `trust_tier`/`holdout_exempt` (principle-wording mutation class): stamped by
 * `buildMutationTarget` from the target path — `"untrusted-project-local"` +
 * `true` for an overlay `.canon/principles/**` target (never holdout-gated,
 * ADR-0027 — the eval sandbox never sees overlay content), `"trusted"` + `false`
 * for every other target (unchanged, holdout-gated as before). Optional/omitted
 * at every OTHER existing construction site (retire/reinforce scores mode) —
 * default/omitted is equivalent to `false`/`"trusted"`.
 */
export type MutationTarget = {
  target_path: string;
  artifact_class: ArtifactClass;
  baseline_body: string;
  char_span: [number, number] | null;
  gate_eligible: boolean;
  confidence: AttributionConfidence;
  failure_kind: FailureKind | null;
  principle_id: string | null;
  attributed_violation_count: number;
  attribution: FailureAttribution | null;
  /** Defaults to "rewrite" when absent (existing construction sites, unchanged behavior). */
  proposal_kind?: MutationProposalKind;
  /** Present only for retire/reinforce targets — the trust-weighted audit trace. */
  score_provenance?: ScoreProvenance;
  /** Reuses the ArtifactTrustTier vocabulary (context-provenance.ts). Defaults to "trusted" when omitted. */
  trust_tier?: ArtifactTrustTier;
  /** True ONLY for an overlay principle target — it can never be holdout-gated. Defaults to false when omitted. */
  holdout_exempt?: boolean;
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

/**
 * An attribution skipped before gate-eligibility check, or (Gap 3 L3) a
 * retire/reinforce score candidate skipped before target construction.
 * `target_path` carries the principle_id for the two score-mode reasons (no
 * target_path is known until the artifact resolves).
 */
export type SkippedAttribution = {
  target_path: string;
  reason:
    | "hash_unverified"
    | "confidence_below_high"
    | "budget_exhausted"
    | "artifact_unresolved"
    | "not_gate_eligible";
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
 *   proposal_kind "retire" | "reinforce" → always "writer" (Gap 3 L3)
 *   proposal_kind "rewrite":
 *     principle | rule → "writer" (existing HITL author, review-learnings:79)
 *     all others       → "engineer-build-flow" (DEFERRED enrichment)
 *
 * `failure_kind` is nullable — a retire/reinforce proposal has no single violation
 * to report (corpus-wide trust-weighted score instead). `proposal_kind` is always
 * present (defaults to "rewrite" at construction); `score_provenance` is present
 * only for retire/reinforce.
 *
 * `gated`/`holdout_baseline`/`holdout_candidate`: a "reinforce" candidate is
 * byte-identical to its own baseline (an unchanged artifact cannot be distinguished
 * from itself by a holdout eval — see mutation-proposal.ts header) and is therefore
 * NEVER run through `evaluate_candidate`. `gated: false` marks that case explicitly
 * and `holdout_baseline`/`holdout_candidate` are `null` (no eval ran, not a zero
 * score). "rewrite"/"retire" are always holdout-gated: `gated: true` with real
 * numeric holdout counts.
 */
export type MutationProposal = {
  id: string;
  type: "evolution-candidate";
  confidence: number;
  /** principle_id when available; falls back to target_path. */
  target: string;
  target_path: string;
  artifact_class: ArtifactClass;
  /** null only when `gated === false` (an ungated reinforce signal). */
  holdout_baseline: number | null;
  /** null only when `gated === false` (an ungated reinforce signal). */
  holdout_candidate: number | null;
  accepted: true;
  failure_kind: FailureKind | null;
  principle_id: string | null;
  join_basis: string;
  hash_verified: boolean;
  apply_channel: "writer" | "engineer-build-flow";
  /** Defaults to "rewrite" — always present in the emitted frontmatter (Gap 3 L3). */
  proposal_kind: MutationProposalKind;
  /**
   * True iff this proposal passed the real `evaluate_candidate` §7 holdout gate
   * ("rewrite"/"retire"). False for an ungated "reinforce" confidence signal — see
   * type-level doc above. Always present (Gap 3 L3 fix).
   */
  gated: boolean;
  /** Present only for retire/reinforce — the trust-weighted audit trace (Gap 3 L3). */
  score_provenance?: ScoreProvenance;
};
