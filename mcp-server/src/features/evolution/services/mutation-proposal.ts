/**
 * mutation-proposal.ts — Pure proposal shaper for accepted mutation candidates.
 *
 * One exported function:
 *   shapeMutationProposal — builds the proposal frontmatter + markdown body
 *                           for a candidate that passed the §7 holdout gate.
 *
 * Precondition (caller-enforced): evalResult.accepted === true.
 * The function is only called when the gate accepted the candidate; producing a
 * proposal for an unaccepted candidate is an evolution-hard-gate violation.
 *
 * Proposal shape consumed by /canon:review-learnings (analyze-patterns/SKILL.md:107-144).
 *
 * Canon principles:
 *   - evolution-hard-gate: caller must gate on accepted===true before invoking
 *   - simplicity-first: pure function, no classes, no I/O
 */

import type { EvaluateCandidateResult } from "../tools/evaluate-candidate.ts";
import type { MutationProposal, MutationTarget } from "./mutation-types.ts";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Zero-pad a number to 2 digits. */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * slug — convert a file path to a URL-safe slug.
 *
 * Replaces all non-alphanumeric characters with hyphens, collapses
 * consecutive hyphens, and strips leading/trailing hyphens.
 */
function slug(path: string): string {
  return path
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Map attribution confidence string to numeric score. */
function confidenceToNumeric(confidence: MutationTarget["confidence"]): number {
  switch (confidence) {
    case "high":
      return 0.9;
    case "medium":
      return 0.6;
    case "low":
      return 0.3;
  }
}

/** Serialize a MutationProposal as a YAML frontmatter block. */
function serializeFrontmatter(fm: MutationProposal): string {
  return [
    "---",
    `id: ${fm.id}`,
    `type: ${fm.type}`,
    `confidence: ${fm.confidence}`,
    `target: ${fm.target}`,
    `target_path: ${fm.target_path}`,
    `artifact_class: ${fm.artifact_class}`,
    `holdout_baseline: ${fm.holdout_baseline}`,
    `holdout_candidate: ${fm.holdout_candidate}`,
    `accepted: ${fm.accepted}`,
    `failure_kind: ${fm.failure_kind}`,
    `principle_id: ${fm.principle_id ?? "null"}`,
    `join_basis: ${fm.join_basis}`,
    `hash_verified: ${fm.hash_verified}`,
    `apply_channel: ${fm.apply_channel}`,
    "---",
  ].join("\n");
}

function buildObservationSection(target: MutationTarget): string {
  const violations = target.attribution.attributed_violations;
  const sample =
    violations.length > 0
      ? `\nViolation sample:\n- ${violations
          .slice(0, 3)
          .map((v) => `\`${v.file_path}\`: ${v.message}`)
          .join("\n- ")}`
      : "";
  return [
    "## Observation",
    "",
    `Artifact \`${target.target_path}\` was present in context during a build that produced`,
    `${target.attributed_violation_count} violation(s) of type \`${target.failure_kind}\`.`,
    target.principle_id ? `Implicated principle: \`${target.principle_id}\`.` : "",
    "",
    `Attribution confidence: **${target.confidence}** (join basis: \`${target.attribution.join_basis}\`).`,
    `Hash verified: \`${target.attribution.target_artifact.hash_verified}\`.`,
    sample,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function buildProposedChangeSection(target: MutationTarget, candidateText: string): string {
  const spanNote = target.char_span
    ? `(span-guided: chars ${target.char_span[0]}–${target.char_span[1]}):`
    : "(full-file rewrite):";
  return [
    "## Proposed Change",
    "",
    `Full-file candidate rewrite for \`${target.target_path}\``,
    spanNote,
    "",
    "```",
    candidateText,
    "```",
  ].join("\n");
}

function buildEvidenceSection(target: MutationTarget, evalResult: EvaluateCandidateResult): string {
  return [
    "## Evidence",
    "",
    "### Holdout gate (§7 strict-holdout)",
    "",
    `| | Baseline | Candidate |`,
    `|---|---|---|`,
    `| Holdout passed | ${evalResult.baseline_score} | ${evalResult.candidate_score} |`,
    `| Holdout total | ${evalResult.per_split.holdout.total} | ${evalResult.per_split.holdout.total} |`,
    `| Accepted | — | ✓ |`,
    "",
    "### Attribution evidence",
    "",
    `- Artifact: \`${target.target_path}\``,
    `- Failure kind: \`${target.failure_kind}\``,
    `- Violations attributed: ${target.attributed_violation_count}`,
    `- Join basis: \`${target.attribution.join_basis}\``,
    `- Hash verified: \`${target.attribution.target_artifact.hash_verified}\``,
  ].join("\n");
}

function buildImpactSection(
  target: MutationTarget,
  applyChannel: MutationProposal["apply_channel"],
): string {
  const routingNote =
    applyChannel === "writer"
      ? "Route to the `writer` agent via the `content-flow/learn-apply` variant for conflict detection, format validation, and the actual edit."
      : "Route via an engineer build-flow under plan-approval HITL. (Non-principle enrichment for `/canon:review-learnings` is deferred — Q5 of design.)";
  return [
    "## Impact",
    "",
    `**Apply channel:** \`${applyChannel}\``,
    "",
    routingNote,
    "",
    `**Artifact class:** \`${target.artifact_class}\``,
    "",
    "This proposal was generated by Canon's trace-driven evolution loop (Phase 1).",
    "Accept via `/canon:review-learnings` which routes to the writer agent for principle/rule classes.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Options for shapeMutationProposal.
 * Using an options object keeps the call-site readable and avoids exceeding the
 * 4-parameter limit (useMaxParams biome rule).
 */
export type ShapeMutationProposalOpts = {
  /** The selected MutationTarget (gate_eligible, has baseline_body). */
  target: MutationTarget;
  /** The full-file candidate text generated by the learner. */
  candidateText: string;
  /** The EvaluateCandidateResult with accepted===true. */
  evalResult: EvaluateCandidateResult;
  /** Timestamp string for the proposal id (e.g. "20260625T143000"). */
  ts: string;
  /** 1-based index within the current pass (for filename ordering). */
  index: number;
};

/**
 * shapeMutationProposal — pure function.
 *
 * Builds a MutationProposal frontmatter + markdown body for a candidate that
 * passed the §7 holdout gate. CALLER MUST ENSURE evalResult.accepted === true
 * before calling — producing a proposal for an unaccepted candidate violates
 * the evolution-hard-gate invariant.
 *
 * Returns:
 *   - `frontmatter`: the typed MutationProposal object
 *   - `markdown`: the full proposal file (YAML frontmatter + 4 sections)
 *   - `filename`: "{pad2(index)}-evolve-{slug(target_path)}.md"
 *
 * Sections (required by /canon:review-learnings parser):
 *   ## Observation — what the attribution signal said
 *   ## Proposed Change — fenced candidate body
 *   ## Evidence — holdout scores + attribution evidence
 *   ## Impact — apply_channel note + next steps
 */
export function shapeMutationProposal(opts: ShapeMutationProposalOpts): {
  frontmatter: MutationProposal;
  markdown: string;
  filename: string;
} {
  const { target, candidateText, evalResult, ts, index } = opts;

  // apply_channel routing: principle/rule → writer; everything else → engineer-build-flow
  const applyChannel: MutationProposal["apply_channel"] =
    target.artifact_class === "principle" || target.artifact_class === "rule"
      ? "writer"
      : "engineer-build-flow";

  const frontmatter: MutationProposal = {
    accepted: true,
    apply_channel: applyChannel,
    artifact_class: target.artifact_class,
    confidence: confidenceToNumeric(target.confidence),
    failure_kind: target.failure_kind,
    hash_verified: target.attribution.target_artifact.hash_verified,
    holdout_baseline: evalResult.baseline_score,
    holdout_candidate: evalResult.candidate_score,
    id: `evolve-${ts}-${pad2(index)}`,
    join_basis: target.attribution.join_basis,
    principle_id: target.principle_id,
    target: target.principle_id ?? target.target_path,
    target_path: target.target_path,
    type: "evolution-candidate",
  };

  const filename = `${pad2(index)}-evolve-${slug(target.target_path)}.md`;

  const body = [
    buildObservationSection(target),
    buildProposedChangeSection(target, candidateText),
    buildEvidenceSection(target, evalResult),
    buildImpactSection(target, applyChannel),
  ].join("\n\n");

  const markdown = `${serializeFrontmatter(frontmatter)}\n\n${body}\n`;

  return { filename, frontmatter, markdown };
}
