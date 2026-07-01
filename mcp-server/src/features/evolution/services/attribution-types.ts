/**
 * attribution-types.ts — Mutator-facing output contract for the attribute_failure tool.
 *
 * Design:
 * - Pure types only. No I/O, no imports beyond domain types.
 * - Uses `type` (not `interface`) per project style.
 * - `as const` for derived union constants.
 * - `presence_in_context: true` is the ONLY asserted-true causal claim.
 *   ALL hypothesis strings use presence/hypothesis vocabulary — never "caused"/"causes".
 *
 * Failure kinds (discriminated set):
 *   - "review_violation" — TWO independent join edges may fire per violation:
 *       - join_basis "principle_id==artifact_id" — joined via in-context artifact_id (inferred, lossy)
 *       - join_basis "code_author_agent_def" — joined via the code-authoring agent-def present in
 *         provenance (ADR-0031); no per-violation step-key threading (all engineer steps share one
 *         agents/engineer.md, so the mutation target is singular and hash-verifiable regardless).
 *   - "cliff_event"      — joined via cliff.step_id == provenance.step_id (exact, clean)
 *   - test_failure is a DEFERRED variant — no durable test_failure event keyed by step_id
 *     exists in the current trace schema (ADR-0024 Revisit-If). Re-add once a joinable
 *     key is available.
 *
 * Canon principles:
 *   - errors-are-values: all failure paths are typed buckets, never thrown
 *   - validate-at-trust-boundaries: content_hash re-check is the trust boundary
 *   - deep-modules: one small tool interface over a rich join
 */

import type { AssembledArtifact } from "@domains/workspaces/context-provenance.ts";
import type { ReviewViolation } from "@platform/storage/archive/archive-types.ts";

// Re-export for consumers that need these types alongside AttributeFailureResult
export type { ReviewViolation };

// ---------------------------------------------------------------------------
// Failure kind — discriminant on FailureAttribution
// ---------------------------------------------------------------------------

// canon:allow-unwired: part of mutator-facing AttributeFailureResult contract; consumed by deliverable 5 (the mutator), not yet built
export const FAILURE_KINDS = ["review_violation", "cliff_event"] as const;
// NOTE: test_failure deferred — no joinable key in current trace; re-add per ADR-0024 Revisit-If
// canon:allow-unwired: part of mutator-facing AttributeFailureResult contract; consumed by deliverable 5 (the mutator), not yet built
export type FailureKind = (typeof FAILURE_KINDS)[number];

// ---------------------------------------------------------------------------
// Attribution confidence + hash status + application disposition
// ---------------------------------------------------------------------------

export type AttributionConfidence = "high" | "medium" | "low";
export type HashStatus = "verified" | "mismatch" | "artifact_missing";
// canon:allow-unwired: part of mutator-facing AttributeFailureResult contract; consumed by deliverable 5 (the mutator), not yet built
export type ApplicationDisposition = "applied" | "ignored" | "indeterminate";

// ---------------------------------------------------------------------------
// Core attribution sub-types
// ---------------------------------------------------------------------------

/**
 * A single artifact that was in context and is attributed to a failure.
 * → future mutator's evaluate_candidate target_path input.
 */
export type AttributedArtifact = {
  id: string; // == principle_id for rule artifacts
  kind: AssembledArtifact["kind"]; // "rule" | "ref" | "primer" | "template"
  path: string; // → future mutator's evaluate_candidate target_path
  content_hash: string; // recorded in-context hash (PRE-disclosure)
  char_span: [number, number] | null;
  span_available: boolean; // false when char_span is null (blanked/sidecar)
  hash_verified: boolean; // fail-closed: true ONLY on exact byte match
  hash_status: HashStatus;
};

/** Optional transcript excerpt linking a step to an artifact reference. */
export type TranscriptEvidence = {
  step_id: string;
  excerpt: string;
  applied_or_ignored: ApplicationDisposition;
};

/** A step that owned the in-context artifact implicated by the failure. */
export type OwningStep = {
  step_id: string | null;
  agent_id: string | null;
  agent_name: string;
};

// ---------------------------------------------------------------------------
// Primary output shape — FailureAttribution
// ---------------------------------------------------------------------------

/**
 * A single failure→artifact attribution.
 *
 * Vocabulary invariant: `hypothesis` and all field names use presence/hypothesis
 * vocabulary ONLY. "caused"/"causes" are NEVER used — `presence_in_context: true`
 * is the only asserted-true claim about the artifact's role.
 */
export type FailureAttribution = {
  /** Discriminant — which failure kind this attribution is for. */
  failure_kind: FailureKind;
  /** Hypothesis statement. NEVER uses "caused"/"causes". */
  hypothesis: string;
  /** The artifact that was in context and is the attribution target. */
  target_artifact: AttributedArtifact;
  /** For review_violation: the violation(s) that triggered this attribution.
   *  For cliff_event: empty array (no violation, the cliff itself is the failure). */
  attributed_violations: ReviewViolation[];
  /** Steps whose context held the matching artifact. */
  owning_steps: OwningStep[];
  /** true when multiple steps held the same artifact (ambiguous join). */
  ambiguous: boolean;
  /** How the join was performed — informs the mutator's trust level. */
  join_basis: "cliff_step_id" | "principle_id==artifact_id" | "code_author_agent_def";
  /** Optional transcript excerpts corroborating the attribution. */
  transcript_evidence: TranscriptEvidence[];
  /** Confidence in the attribution — deterministically derived per join_basis + hash_verified. */
  confidence: AttributionConfidence;
  /** The ONLY proven claim: this artifact was present in context during the build. */
  presence_in_context: true;
};

// ---------------------------------------------------------------------------
// Lossy output buckets — typed, never silently dropped
// ---------------------------------------------------------------------------

/** A violation that could not be joined to any in-context artifact. */
export type UnattributedViolation = {
  violation: ReviewViolation;
  reason: "no_in_context_artifact" | "no_provenance";
};

/** An artifact where hash verification failed — flagged for human review. */
export type FlaggedAttribution = {
  artifact_id: string;
  path: string;
  reason: "hash_mismatch" | "artifact_missing";
};

// ---------------------------------------------------------------------------
// Top-level result shape (mutator-facing contract)
// ---------------------------------------------------------------------------

/** Full result shape for attribute_failure — the mutator-facing contract. */
export type AttributeFailureResult = {
  /** Successful attributions — artifact was in context and hash check passed (or degraded gracefully). */
  attributions: FailureAttribution[];
  /** Violations that could not be joined to any in-context artifact. */
  unattributed: UnattributedViolation[];
  /** Artifacts where hash verification failed (drifted or missing) — require human review. */
  flagged: FlaggedAttribution[];
  /** Processing metadata for observability. */
  meta: {
    provenance_steps: number;
    violations_seen: number;
    hash_checks: number;
  };
};
