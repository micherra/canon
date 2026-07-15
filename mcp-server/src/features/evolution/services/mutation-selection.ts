/**
 * mutation-selection.ts — Pure deterministic selection core for the mutator pipeline.
 *
 * Three exported functions, all PURE (no I/O — bodies + existence injected by the handler):
 *   - isGateEligible: fail-closed eligibility predicate
 *   - classifyArtifact: path → ArtifactClass
 *   - selectMutationTargets: filter → partition → rank → budget-cap → MutationTargets
 *
 * Design:
 * - Pure functions only. No I/O, no model calls, no imports of non-pure code.
 * - `isGuardrailTarget` from candidate-injection.ts is the guardrail source-of-truth.
 * - Ranking is stable and deterministic: violation count desc, then weightedCounts desc.
 *
 * Canon principles:
 *   - no-llm-calls-in-mcp-tools: zero model calls here or in the handler that wraps this
 *   - errors-are-values: skipped/ineligible cases are typed buckets, never thrown
 *   - simplicity-first: exported functions, no classes
 */

import { basename, extname, normalize, sep } from "node:path";
import type { AssembledArtifact } from "@domains/workspaces/context-provenance.ts";
import type { AttributionConfidence, FailureAttribution } from "./attribution-types.ts";
import { isGuardrailTarget } from "./candidate-injection.ts";
import type {
  ArtifactClass,
  GateIneligibleTarget,
  MutationProposalKind,
  MutationSelectionOptions,
  MutationTarget,
  SelectMutationTargetsResult,
  SkippedAttribution,
} from "./mutation-types.ts";
import { DEFAULT_MAX_TARGETS_PER_PASS } from "./mutation-types.ts";
import type { TrustWeightedScore } from "./outcome-attribution.ts";

/** Eval surface prefix as a posix-style path for comparison. */
const EVAL_SURFACE_POSIX = "skills/canon/evals";

/** Names that are harness entrypoints — candidates must never overwrite them. */
const HARNESS_ENTRYPOINTS = new Set(["run-evals.sh"]);

// ---------------------------------------------------------------------------
// isGateEligible — fail-closed eligibility gate
// ---------------------------------------------------------------------------

/**
 * isGateEligible — pure predicate. No I/O.
 *
 * Returns true iff targetPath is a gateable plugin artifact:
 *   - No path traversal (no `..` segments after normalize)
 *   - Not a harness entrypoint (run-evals.sh)
 *   - Not a TypeScript file (.ts extension) or register-* file (tool-descriptions)
 *   - File exists (fileExists injected by the handler via existsSync)
 *   - Is an eval-surface path (skills/canon/evals/**) OR a guardrail target
 *     (reuses isGuardrailTarget from candidate-injection.ts)
 *
 * Fail-closed: any unlisted path returns false.
 *
 * @param targetPath - Path relative to the project root. May be unnormalized.
 * @param fileExists - Whether the file exists on disk (injected; keeps fn pure).
 */
export function isGateEligible(targetPath: string, fileExists: boolean): boolean {
  if (!targetPath) return false;

  const normalized = normalize(targetPath);

  // Path traversal: any segment is '..' — normalize preserves them for relative paths
  const segments = normalized.split(sep);
  if (segments.includes("..")) return false;

  const base = basename(normalized);

  // Harness entrypoint: reject run-evals.sh (a candidate controlling this bypasses the gate)
  if (HARNESS_ENTRYPOINTS.has(base)) return false;

  // Tool-description: .ts extension or register-* basename — not plugin-loaded artifacts
  const ext = extname(normalized);
  if (ext === ".ts" || base.startsWith("register-")) return false;

  // File existence check (injected)
  if (!fileExists) return false;

  // Eval-surface path (under skills/canon/evals/) — the original injection mode
  const posix = segments.join("/");
  if (posix === EVAL_SURFACE_POSIX || posix.startsWith(`${EVAL_SURFACE_POSIX}/`)) {
    return true;
  }

  // Guardrail path: first segment in PLUGIN_ARTIFACT_ROOTS, not under eval surface
  return isGuardrailTarget(targetPath);
}

// ---------------------------------------------------------------------------
// classifyArtifact — path → ArtifactClass
// ---------------------------------------------------------------------------

/**
 * classifyArtifact — classify a target path into an ArtifactClass.
 *
 * Priority order:
 *   1. skills/canon/evals/ → "eval-surface"
 *   2. principles/ → "principle"
 *   3. rules/ → "rule"
 *   4. primers/ → "primer"
 *   5. agents/ → "agent"
 *   6. templates/ → "template"
 *   7. skills/ → "skill"
 *   8. references/ → "reference"
 *   9. register-*.ts or .ts → "tool-description"
 *  10. Fall back to mapping ProvenanceArtifactKind
 *
 * @param targetPath - Path relative to the project root.
 * @param kind - ProvenanceArtifactKind from the assembled artifact (fallback).
 */
export function classifyArtifact(
  targetPath: string,
  kind: AssembledArtifact["kind"],
): ArtifactClass {
  const normalized = normalize(targetPath);
  const posix = normalized.split(sep).join("/");
  const base = basename(posix);

  if (posix.startsWith(`${EVAL_SURFACE_POSIX}/`) || posix === EVAL_SURFACE_POSIX)
    return "eval-surface";
  if (posix.startsWith("principles/")) return "principle";
  if (posix.startsWith("rules/")) return "rule";
  if (posix.startsWith("primers/")) return "primer";
  if (posix.startsWith("agents/")) return "agent";
  if (posix.startsWith("templates/")) return "template";
  if (posix.startsWith("skills/")) return "skill";
  if (posix.startsWith("references/")) return "reference";

  // Tool-description: .ts extension or register-* basename
  const ext = extname(base);
  if (ext === ".ts" || base.startsWith("register-")) return "tool-description";

  // Fallback: map ProvenanceArtifactKind
  switch (kind) {
    case "rule":
      return "rule";
    case "primer":
      return "primer";
    case "template":
      return "template";
    case "ref":
      return "reference";
    // No default needed — TypeScript exhaustiveness check omitted for unknown future kinds
  }

  return "rule"; // safe fallback for unknown kind values
}

// ---------------------------------------------------------------------------
// Reason derivation — internal helper
// ---------------------------------------------------------------------------

/**
 * deriveIneligibleReason — determine why a path is gate-ineligible.
 *
 * Called only when isGateEligible has already returned false.
 * Returns the most specific reason in priority order.
 */
function deriveIneligibleReason(
  targetPath: string,
  fileExists: boolean,
): GateIneligibleTarget["reason"] {
  const normalized = normalize(targetPath);
  const segments = normalized.split(sep);

  if (segments.includes("..")) return "path_traversal";

  const base = basename(normalized);
  if (HARNESS_ENTRYPOINTS.has(base)) return "harness_entrypoint";

  const ext = extname(normalized);
  if (ext === ".ts" || base.startsWith("register-")) return "tool_description_not_loadable";

  if (!fileExists) return "file_missing";

  // Unreachable if called only when isGateEligible returned false for a path that
  // passed the first four checks but failed the guardrail/eval-surface test.
  // Default to file_missing (safest bucket).
  return "file_missing";
}

// ---------------------------------------------------------------------------
// selectMutationTargets — filter → partition → rank → budget-cap
// ---------------------------------------------------------------------------

/**
 * selectMutationTargets — deterministic selection core. PURE (no I/O).
 *
 * Pipeline:
 *   (a) Filter: hash_verified===true (else → skipped:hash_unverified)
 *               AND confidence==="high" (else → skipped:confidence_below_high)
 *   (b) Partition: isGateEligible(path, existing[path]) → eligible vs gate_ineligible
 *   (c) Rank eligible: violation count desc, weightedCounts[principle_id] desc (stable)
 *   (d) Budget cap: take top maxTargetsPerPass (overflow → skipped:budget_exhausted)
 *   (e) Build MutationTarget with baseline_body from bodies map
 *
 * @param attributions - Raw FailureAttribution[] from attributeFailures().
 * @param bodies - Map from target_path → file content (read by the handler, fail-open "").
 * @param existing - Map from target_path → boolean existence (injected by handler).
 * @param opts - Optional selection config (maxTargetsPerPass, weightedCounts).
 */
/**
 * filterAndPartition — steps (a) and (b) of the selection pipeline.
 *
 * Filters attributions by hash_verified + confidence===high, then partitions
 * gate-eligible vs ineligible.
 */
function filterAndPartition(
  attributions: FailureAttribution[],
  existing: Record<string, boolean>,
): {
  eligible: FailureAttribution[];
  gateIneligible: GateIneligibleTarget[];
  skipped: SkippedAttribution[];
} {
  const skipped: SkippedAttribution[] = [];
  const gateIneligible: GateIneligibleTarget[] = [];
  const eligible: FailureAttribution[] = [];

  for (const attr of attributions) {
    const path = attr.target_artifact.path;
    if (!attr.target_artifact.hash_verified) {
      skipped.push({ reason: "hash_unverified", target_path: path });
      continue;
    }
    if (attr.confidence !== "high") {
      skipped.push({ reason: "confidence_below_high", target_path: path });
      continue;
    }
    const fileExists = existing[path] ?? false;
    if (!isGateEligible(path, fileExists)) {
      const artifactClass = classifyArtifact(path, attr.target_artifact.kind);
      const reason = deriveIneligibleReason(path, fileExists);
      gateIneligible.push({ artifact_class: artifactClass, reason, target_path: path });
      continue;
    }
    eligible.push(attr);
  }

  return { eligible, gateIneligible, skipped };
}

/**
 * coalesceByPath — merge same-path attributions before ranking.
 *
 * attributeFailures emits one FailureAttribution per violation (attributed_violations
 * is always a single-element array). Multiple attributions may share the same
 * target_artifact.path, each carrying one violation. Without coalescing, the same
 * path can consume multiple budget slots and its ranking uses 1 instead of the
 * aggregate count.
 *
 * This function groups eligible attributions by path and merges each group into a
 * single representative attribution whose attributed_violations is the union of all
 * violations across duplicates. The first attribution in each group supplies the
 * representative metadata (confidence, failure_kind, target_artifact, etc.).
 *
 * Post-condition: returned array has exactly one entry per distinct target_artifact.path.
 */
function coalesceByPath(eligible: FailureAttribution[]): FailureAttribution[] {
  const byPath = new Map<string, FailureAttribution[]>();
  for (const attr of eligible) {
    const path = attr.target_artifact.path;
    const bucket = byPath.get(path);
    if (bucket === undefined) {
      byPath.set(path, [attr]);
    } else {
      bucket.push(attr);
    }
  }

  return [...byPath.values()].map((group) => {
    if (group.length === 1) return group[0];
    // Merge: first attribution is the representative; union the violations.
    const representative = group[0];
    const allViolations = group.flatMap((a) => a.attributed_violations);
    return { ...representative, attributed_violations: allViolations };
  });
}

/**
 * rankAndCap — steps (c) and (d): rank eligible attributions then apply budget.
 *
 * Returns selected (within budget) and overflow (budget_exhausted).
 */
function rankAndCap(
  eligible: FailureAttribution[],
  budget: number,
  weightedCounts: Record<string, number>,
): { overflow: FailureAttribution[]; selected: FailureAttribution[] } {
  const ranked = [...eligible].sort((a, b) => {
    const violDiff = b.attributed_violations.length - a.attributed_violations.length;
    if (violDiff !== 0) return violDiff;
    const aWeight = weightedCounts[a.target_artifact.id] ?? 0;
    const bWeight = weightedCounts[b.target_artifact.id] ?? 0;
    return bWeight - aWeight;
  });

  const selected = ranked.slice(0, budget);
  const overflow = ranked.slice(budget);
  return { overflow, selected };
}

/**
 * Derive the implicated principle_id for a mutation target.
 *
 * For every kind EXCEPT agent-def, target_artifact.id IS the principle_id
 * (rule/ref/primer/template file ids == the principle they carry) — unchanged.
 *
 * For kind:"agent-def" the id is the AGENT NAME ("engineer"), not a principle
 * (ADR-0032 code-author join). Surface the violated principle from the attributed
 * violation instead, so downstream recurrence/learning stays keyed by principle.
 * A cliff_event agent-def has no attributed violation → null (a write-cliff has
 * no principle), which is also correct.
 */
function derivePrincipleId(attr: FailureAttribution): string | null {
  if (attr.target_artifact.kind === "agent-def") {
    return attr.attributed_violations[0]?.principle_id ?? null;
  }
  return attr.target_artifact.id || null;
}

/** Build a single MutationTarget from a FailureAttribution + bodies map. */
function buildMutationTarget(
  attr: FailureAttribution,
  bodies: Record<string, string>,
): MutationTarget {
  const path = attr.target_artifact.path;
  return {
    artifact_class: classifyArtifact(path, attr.target_artifact.kind),
    attributed_violation_count: attr.attributed_violations.length,
    attribution: attr,
    baseline_body: bodies[path] ?? "",
    char_span: attr.target_artifact.char_span,
    confidence: attr.confidence,
    failure_kind: attr.failure_kind,
    gate_eligible: true,
    principle_id: derivePrincipleId(attr),
    target_path: path,
  };
}

export function selectMutationTargets(
  attributions: FailureAttribution[],
  bodies: Record<string, string>,
  existing: Record<string, boolean>,
  opts: MutationSelectionOptions = {},
): SelectMutationTargetsResult {
  const { maxTargetsPerPass = DEFAULT_MAX_TARGETS_PER_PASS, weightedCounts = {} } = opts;
  const budget = maxTargetsPerPass;

  const { eligible, gateIneligible, skipped } = filterAndPartition(attributions, existing);
  const coalescedEligible = coalesceByPath(eligible);
  const { overflow, selected } = rankAndCap(coalescedEligible, budget, weightedCounts);

  const overflowSkipped: SkippedAttribution[] = overflow.map((attr) => ({
    reason: "budget_exhausted",
    target_path: attr.target_artifact.path,
  }));

  const targets = selected.map((attr) => buildMutationTarget(attr, bodies));

  return {
    gate_ineligible: gateIneligible,
    meta: { attributions_seen: attributions.length, budget, selected: targets.length },
    skipped: [...skipped, ...overflowSkipped],
    targets,
  };
}

// ---------------------------------------------------------------------------
// selectRetirementReinforcementTargets — Gap 3 Layer 3: consume attribute_outcomes
// ---------------------------------------------------------------------------

/**
 * Net-score threshold for retirement/reinforcement nomination (Gap 3 L3, DESIGN.md
 * Open question 2). Mirrors the learner's `weighted_instance_count >= 3`
 * minimum-evidence convention (skills/canon/skills/analyze-patterns/SKILL.md;
 * cross-run-analyzer.ts computeWeightedCount) — reused here as a SYMMETRIC
 * net-score band rather than a raw instance count: a principle needs a
 * trust-weighted net_score whose magnitude reaches this threshold, in either
 * direction, before it is nominated. Not a new magic number — the same "3" the
 * learner already treats as its minimum-evidence bar elsewhere.
 */
export const RETIREMENT_REINFORCEMENT_NET_SCORE_THRESHOLD = 3;

/**
 * Resolves a principle_id to its on-disk artifact (path relative to the project
 * root, plus current body). Injected so selectRetirementReinforcementTargets stays
 * I/O-free — the caller (tool handler) does the actual file read, exactly like
 * selectMutationTargets's bodies/existing maps.
 */
export type PrincipleArtifactLookup = (
  principleId: string,
) => { path: string; body: string } | null;

/** A score that could not be turned into a target — typed bucket (errors-are-values). */
export type RetirementReinforcementSkip = {
  principle_id: string;
  reason: "artifact_unresolved" | "not_gate_eligible";
};

export type RetirementReinforcementSelectionResult = {
  targets: MutationTarget[];
  skipped: RetirementReinforcementSkip[];
};

/** Confidence in a retire/reinforce candidate, derived from corroboration (distinct owning steps). */
function confidenceFromCorroboration(corroboration: number): AttributionConfidence {
  if (corroboration >= 3) return "high";
  if (corroboration >= 1) return "medium";
  return "low";
}

/** net_score <= -threshold → retire; >= +threshold → reinforce; inside the band → null (not nominated). */
function deriveProposalKind(netScore: number, threshold: number): MutationProposalKind | null {
  if (netScore <= -threshold) return "retire";
  if (netScore >= threshold) return "reinforce";
  return null;
}

/** Build a single retire/reinforce MutationTarget from a score + its resolved artifact. */
function buildRetirementReinforcementTarget(
  score: TrustWeightedScore,
  proposalKind: MutationProposalKind,
  artifact: { path: string; body: string },
): MutationTarget {
  return {
    artifact_class: classifyArtifact(artifact.path, "rule"),
    attributed_violation_count: 0,
    attribution: null,
    baseline_body: artifact.body,
    char_span: null,
    confidence: confidenceFromCorroboration(score.corroboration),
    failure_kind: null,
    gate_eligible: true,
    principle_id: score.principle_id,
    proposal_kind: proposalKind,
    score_provenance: {
      contributing_builds: score.contributing_builds,
      net_score: score.net_score,
    },
    target_path: artifact.path,
  };
}

/**
 * selectRetirementReinforcementTargets — deterministic, PURE (no I/O).
 *
 * Consumes attribute_outcomes's TrustWeightedScore[] (Gap 3 Layer 2): a net_score
 * at or beyond +/- threshold nominates a reinforce/retire MutationTarget carrying
 * score_provenance (the auditable trace, invalidate-don't-delete posture). Scores
 * inside the neutral band are silently not nominated — most principles sit there;
 * that is the expected, non-error case. Unresolvable or gate-ineligible
 * principle_ids land in the typed `skipped[]` bucket instead of being thrown or
 * silently dropped (errors-are-values).
 *
 * Every returned target has `attribution: null` and `failure_kind: null` — a
 * corpus-wide trust-weighted score has no single violation to join to, unlike the
 * violation-based `selectMutationTargets` targets above.
 */
export function selectRetirementReinforcementTargets(
  scores: TrustWeightedScore[],
  resolveArtifact: PrincipleArtifactLookup,
  opts: { threshold?: number } = {},
): RetirementReinforcementSelectionResult {
  const threshold = opts.threshold ?? RETIREMENT_REINFORCEMENT_NET_SCORE_THRESHOLD;
  const targets: MutationTarget[] = [];
  const skipped: RetirementReinforcementSkip[] = [];

  for (const score of scores) {
    const proposalKind = deriveProposalKind(score.net_score, threshold);
    if (proposalKind === null) continue;

    const artifact = resolveArtifact(score.principle_id);
    if (artifact === null) {
      skipped.push({ principle_id: score.principle_id, reason: "artifact_unresolved" });
      continue;
    }
    if (!isGateEligible(artifact.path, true)) {
      skipped.push({ principle_id: score.principle_id, reason: "not_gate_eligible" });
      continue;
    }

    targets.push(buildRetirementReinforcementTarget(score, proposalKind, artifact));
  }

  return { skipped, targets };
}
