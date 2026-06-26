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
import type { FailureAttribution } from "./attribution-types.ts";
import { isGuardrailTarget } from "./candidate-injection.ts";
import type {
  ArtifactClass,
  GateIneligibleTarget,
  MutationSelectionOptions,
  MutationTarget,
  SelectMutationTargetsResult,
  SkippedAttribution,
} from "./mutation-types.ts";
import { DEFAULT_MAX_TARGETS_PER_PASS } from "./mutation-types.ts";

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
    principle_id: attr.target_artifact.id || null,
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
  const { overflow, selected } = rankAndCap(eligible, budget, weightedCounts);

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
