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
  CorpusArtifactClass,
  CorpusArtifactLookup,
  ResolvedCorpusArtifact,
} from "./corpus-artifact-lookup.ts";
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
 * Prefix → ArtifactClass lookup, checked in order. `.canon/principles/` (the overlay
 * tier) is listed before `principles/` (the built-in tier) purely for readability —
 * the two prefixes are disjoint so order between them doesn't affect the match.
 * Data-driven so `classifyArtifact` below stays a single loop instead of an N-deep
 * if-return ladder (keeps cognitive complexity under the lint ceiling).
 */
const PREFIX_ARTIFACT_CLASS: ReadonlyArray<readonly [string, ArtifactClass]> = [
  [".canon/principles/", "principle"],
  ["principles/", "principle"],
  ["rules/", "rule"],
  ["primers/", "primer"],
  ["agents/", "agent"],
  ["templates/", "template"],
  ["skills/", "skill"],
  ["references/", "reference"],
];

/**
 * classifyArtifact — classify a target path into an ArtifactClass.
 *
 * Priority order:
 *   1. skills/canon/evals/ → "eval-surface"
 *   2. PREFIX_ARTIFACT_CLASS (principles/.canon/principles/rules/primers/agents/
 *      templates/skills/references) → matching class
 *   3. register-*.ts or .ts → "tool-description"
 *   4. Fall back to mapping ProvenanceArtifactKind
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

  for (const [prefix, artifactClass] of PREFIX_ARTIFACT_CLASS) {
    if (posix.startsWith(prefix)) return artifactClass;
  }

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
// isOverlayPrincipleTarget — overlay principle-wording eligibility (ADR-0027)
// ---------------------------------------------------------------------------

/**
 * isOverlayPrincipleTarget — pure predicate. No I/O.
 *
 * Returns true iff targetPath's normalized posix form is a `.canon/principles/`
 * subtree path — the untrusted-project-local overlay principle tier. Deliberately
 * NOT folded into `isGateEligible` (which also backs `selectRetirementReinforcementTargets`
 * and the register- / tool-description exclusions) — widening that shared predicate
 * would perturb those other call sites. Overlay principle targets are selected via
 * this dedicated predicate instead; the caller in `evaluate_candidate` fail-closed
 * rejects them before any subprocess (ADR-0027 — overlay content never enters the
 * eval sandbox).
 *
 * @param targetPath - Path relative to the project root. May be unnormalized.
 */
export function isOverlayPrincipleTarget(targetPath: string): boolean {
  if (!targetPath) return false;
  const posix = normalize(targetPath).split(sep).join("/");
  return posix.startsWith(".canon/principles/");
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
    // Class-scoped medium-confidence relaxation (dc-01, PROBE-FINDINGS Probe 3): the
    // review_violation -> principle join can never exceed "medium" (transcript evidence
    // is unpopulated in v1 — deriveConfidence's hasTranscript is always false), so a
    // strict high-only filter structurally excludes the entire principle-wording class.
    // Admit "medium" ONLY when join_basis is the inferred principle join — every other
    // join_basis/class stays high-only. This is narrow and localized to SELECTION;
    // deriveConfidence itself is untouched, so no other consumer silently up-ranks the
    // join's honest MEDIUM label (ADR-0024).
    const isNarrowMediumRelaxation =
      attr.confidence === "medium" && attr.join_basis === "principle_id==artifact_id";
    if (attr.confidence !== "high" && !isNarrowMediumRelaxation) {
      skipped.push({ reason: "confidence_below_high", target_path: path });
      continue;
    }
    const fileExists = existing[path] ?? false;
    if (!isGateEligible(path, fileExists) && !isOverlayPrincipleTarget(path)) {
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
  const isOverlay = isOverlayPrincipleTarget(path);
  return {
    artifact_class: classifyArtifact(path, attr.target_artifact.kind),
    attributed_violation_count: attr.attributed_violations.length,
    attribution: attr,
    baseline_body: bodies[path] ?? "",
    char_span: attr.target_artifact.char_span,
    confidence: attr.confidence,
    failure_kind: attr.failure_kind,
    gate_eligible: true,
    holdout_exempt: isOverlay,
    principle_id: derivePrincipleId(attr),
    target_path: path,
    trust_tier: isOverlay ? "untrusted-project-local" : "trusted",
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
 * Never-pruneable allowlist — a `retire` nomination for one of these ids is
 * always skipped (`never_pruneable`), regardless of net_score. These are
 * load-bearing pipeline-integrity rules whose false retirement would be
 * catastrophic (fail-closed posture, credential/secret handling, trust
 * boundaries, artifact-write receipts, template completeness).
 *
 * Byte-parity with the prose allowlist in
 * `skills/canon/commands/review-learnings.md` (retire-refusal ~line 96 and
 * Safety rails ~line 363) — enforced by `never-pruneable-parity.test.ts`.
 * `reinforce` nominations of these ids are NOT blocked (a confidence signal
 * on a load-bearing rule is correct, not dangerous).
 */
// canon:allow-unwired: used internally at the retire guard (this file) + exported for never-pruneable-parity.test.ts byte-parity assertion
export const NEVER_PRUNEABLE_PRINCIPLE_IDS: ReadonlySet<string> = new Set([
  "fail-closed-by-default",
  "hooks-fail-closed",
  "least-privilege-access",
  "secrets-never-in-code",
  "validate-at-trust-boundaries",
  "agent-artifact-write-before-return",
  "agent-template-required",
]);

/**
 * Retire-domain class filter: these classes' positive signal is structurally
 * one-sided (reviewers honored-cite principles/rules, not
 * references/primers/templates), so their net_score can only fall — the
 * false-retirement trap, generalized (ADR-0062 Bug-1 Decision 2). A `retire`
 * nomination resolving to one of these classes is skipped
 * (`non_retirable_artifact_class`); `reinforce` may emit for any resolved
 * class.
 */
const NON_RETIRABLE_ARTIFACT_CLASSES: ReadonlySet<CorpusArtifactClass> = new Set([
  "reference",
  "primer",
  "template",
]);

/** A score that could not be turned into a target — typed bucket (errors-are-values). */
export type RetirementReinforcementSkip = {
  principle_id: string;
  reason:
    | "artifact_unresolved"
    | "not_gate_eligible"
    | "never_pruneable"
    | "non_retirable_artifact_class";
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
  artifact: ResolvedCorpusArtifact,
): MutationTarget {
  return {
    artifact_class: artifact.artifact_class,
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
 * resolveRetirementCandidate — steps 3-5 of the retire/reinforce pipeline:
 * resolve the artifact, apply the retire-only class filter, then the
 * gate-eligibility check. Extracted to keep
 * selectRetirementReinforcementTargets's loop body under the cognitive
 * complexity threshold. Only called AFTER the allowlist guard (step 2) has
 * already passed for this score — an allowlisted retire nomination never
 * reaches this function, so resolution never even runs for it (guard beats
 * resolution).
 */
function resolveRetirementCandidate(
  principleId: string,
  proposalKind: MutationProposalKind,
  resolveArtifact: CorpusArtifactLookup,
): { artifact: ResolvedCorpusArtifact } | { reason: RetirementReinforcementSkip["reason"] } {
  const artifact = resolveArtifact(principleId);
  if (artifact === null) return { reason: "artifact_unresolved" };
  if (proposalKind === "retire" && NON_RETIRABLE_ARTIFACT_CLASSES.has(artifact.artifact_class)) {
    return { reason: "non_retirable_artifact_class" };
  }
  if (!isGateEligible(artifact.path, true)) return { reason: "not_gate_eligible" };
  return { artifact };
}

/**
 * selectRetirementReinforcementTargets — deterministic, PURE (no I/O).
 *
 * Consumes attribute_outcomes's TrustWeightedScore[] (Gap 3 Layer 2): a net_score
 * at or beyond +/- threshold nominates a reinforce/retire MutationTarget carrying
 * score_provenance (the auditable trace, invalidate-don't-delete posture). Scores
 * inside the neutral band are silently not nominated — most principles sit there;
 * that is the expected, non-error case.
 *
 * Retire-only guard order (ADR-0062 Bug-1 part a):
 *   1. Never-pruneable allowlist check — BEFORE resolution (guard beats
 *      resolution, mirrors the ADR-0044 floor-beats-override posture).
 *   2. Resolve via the injected lookup — null -> artifact_unresolved.
 *   3. Class filter (retire only): reference/primer/template -> skipped
 *      non_retirable_artifact_class.
 *   4. Gate eligibility (unchanged) -> not_gate_eligible.
 * `reinforce` nominations skip steps 1 and 3 (never blocked by the allowlist
 * or the class filter) but still resolve + gate-check.
 *
 * Every returned target has `attribution: null` and `failure_kind: null` — a
 * corpus-wide trust-weighted score has no single violation to join to, unlike the
 * violation-based `selectMutationTargets` targets above.
 */
export function selectRetirementReinforcementTargets(
  scores: TrustWeightedScore[],
  resolveArtifact: CorpusArtifactLookup,
  opts: { threshold?: number } = {},
): RetirementReinforcementSelectionResult {
  const threshold = opts.threshold ?? RETIREMENT_REINFORCEMENT_NET_SCORE_THRESHOLD;
  const targets: MutationTarget[] = [];
  const skipped: RetirementReinforcementSkip[] = [];

  for (const score of scores) {
    const proposalKind = deriveProposalKind(score.net_score, threshold);
    if (proposalKind === null) continue;

    if (proposalKind === "retire" && NEVER_PRUNEABLE_PRINCIPLE_IDS.has(score.principle_id)) {
      skipped.push({ principle_id: score.principle_id, reason: "never_pruneable" });
      continue;
    }

    const resolved = resolveRetirementCandidate(score.principle_id, proposalKind, resolveArtifact);
    if ("reason" in resolved) {
      skipped.push({ principle_id: score.principle_id, reason: resolved.reason });
      continue;
    }

    targets.push(buildRetirementReinforcementTarget(score, proposalKind, resolved.artifact));
  }

  return { skipped, targets };
}
