/**
 * mutation-proposal.ts — Pure proposal shaper for accepted mutation candidates.
 *
 * One exported function:
 *   shapeMutationProposal — builds the proposal frontmatter + markdown body for a
 *                           "rewrite"/"retire" candidate that passed the §7 holdout
 *                           gate, OR for an ungated "reinforce" confidence signal.
 *
 * Precondition (caller-enforced):
 *   - "rewrite" | "retire": evalResult non-null, evalResult.accepted === true.
 *     The function is only called when the gate accepted the candidate; producing
 *     a proposal for an unaccepted candidate is an evolution-hard-gate violation.
 *   - "reinforce": evalResult === null. A reinforce candidate is byte-identical to
 *     its own baseline_body — there is nothing for a holdout eval to distinguish,
 *     so it is NEVER run through evaluate_candidate (Gap 3 L3 fix). The emitted
 *     proposal carries `gated: false` and null holdout fields, clearly marking it
 *     as an un-holdout-gated confidence/priority signal for human review — not a
 *     gated artifact-mutation proposal.
 *
 * Proposal shape consumed by /canon:review-learnings (analyze-patterns/SKILL.md:107-144).
 *
 * Canon principles:
 *   - evolution-hard-gate: caller must gate on accepted===true before invoking
 *   - simplicity-first: pure function, no classes, no I/O
 */

import type { EvaluateCandidateResult } from "../tools/evaluate-candidate.ts";
import type {
  MutationProposal,
  MutationProposalKind,
  MutationTarget,
  ScoreProvenance,
} from "./mutation-types.ts";

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

/** Serialize the score_provenance nested block (retire/reinforce only). Omitted when absent. */
function serializeScoreProvenanceLines(sp: ScoreProvenance): string[] {
  const lines = ["score_provenance:", `  net_score: ${sp.net_score}`, "  contributing_builds:"];
  for (const cb of sp.contributing_builds) {
    lines.push(
      `    - archive_id: ${cb.archive_id}`,
      `      sign: ${cb.sign}`,
      `      weight: ${cb.weight}`,
    );
  }
  return lines;
}

/** Serialize a MutationProposal as a YAML frontmatter block. */
function serializeFrontmatter(fm: MutationProposal): string {
  const lines = [
    "---",
    `id: ${fm.id}`,
    `type: ${fm.type}`,
    `confidence: ${fm.confidence}`,
    `target: ${fm.target}`,
    `target_path: ${fm.target_path}`,
    `artifact_class: ${fm.artifact_class}`,
    `holdout_baseline: ${fm.holdout_baseline ?? "null"}`,
    `holdout_candidate: ${fm.holdout_candidate ?? "null"}`,
    `accepted: ${fm.accepted}`,
    `failure_kind: ${fm.failure_kind ?? "null"}`,
    `principle_id: ${fm.principle_id ?? "null"}`,
    `join_basis: ${fm.join_basis}`,
    `hash_verified: ${fm.hash_verified}`,
    `apply_channel: ${fm.apply_channel}`,
    `proposal_kind: ${fm.proposal_kind}`,
    `gated: ${fm.gated}`,
  ];
  if (fm.score_provenance) {
    lines.push(...serializeScoreProvenanceLines(fm.score_provenance));
  }
  lines.push("---");
  return lines.join("\n");
}

/** target.attribution's hash_verified, or true when absent (retire/reinforce: freshly read from disk). */
function resolveHashVerified(target: MutationTarget): boolean {
  return target.attribution?.target_artifact.hash_verified ?? true;
}

/** target.attribution's join_basis, or a descriptive placeholder for corpus-wide candidates. */
function resolveJoinBasis(target: MutationTarget): string {
  return target.attribution?.join_basis ?? "trust_weighted_aggregate";
}

/** Retire/reinforce Observation — describes a corpus-wide trust-weighted score, not a violation. */
function buildScoreObservationSection(
  target: MutationTarget,
  proposalKind: "retire" | "reinforce",
): string {
  const sp = target.score_provenance;
  const verdict = proposalKind === "retire" ? "strongly negative" : "strongly positive";
  return [
    "## Observation",
    "",
    `Artifact \`${target.target_path}\` has a ${verdict} trust-weighted net score across the`,
    `decisions/RunSummary corpus${sp ? ` (net_score: ${sp.net_score})` : ""}.`,
    target.principle_id ? `Implicated principle: \`${target.principle_id}\`.` : "",
    "",
    `Attribution confidence: **${target.confidence}** (join basis: \`${resolveJoinBasis(target)}\`).`,
    `Hash verified: \`${resolveHashVerified(target)}\`.`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function buildObservationSection(
  target: MutationTarget,
  proposalKind: MutationProposalKind,
): string {
  if (proposalKind === "retire" || proposalKind === "reinforce") {
    return buildScoreObservationSection(target, proposalKind);
  }
  const violations = target.attribution?.attributed_violations ?? [];
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
    `Attribution confidence: **${target.confidence}** (join basis: \`${resolveJoinBasis(target)}\`).`,
    `Hash verified: \`${resolveHashVerified(target)}\`.`,
    sample,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function buildProposedChangeSection(
  target: MutationTarget,
  candidateText: string,
  proposalKind: MutationProposalKind,
): string {
  if (proposalKind === "reinforce") {
    return [
      "## Proposed Change",
      "",
      `No content change proposed for \`${target.target_path}\`. This is an informational`,
      "reinforcement — trust-weighted evidence shows the principle earns its keep.",
      "",
      "```",
      candidateText,
      "```",
    ].join("\n");
  }
  if (proposalKind === "retire") {
    return [
      "## Proposed Change",
      "",
      `Retirement candidate for \`${target.target_path}\``,
      "(invalidate-don't-delete — retired/weakened artifact body, NEVER removed from disk):",
      "",
      "```",
      candidateText,
      "```",
    ].join("\n");
  }
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

/** Trust-weighted score provenance lines — the auditable trace (retire/reinforce only). */
function buildScoreProvenanceLines(scoreProvenance: ScoreProvenance | undefined): string[] {
  if (!scoreProvenance) return [];
  return [
    "",
    "### Trust-weighted score provenance",
    "",
    `- Net score: ${scoreProvenance.net_score}`,
    "- Contributing builds:",
    ...scoreProvenance.contributing_builds.map(
      (cb) => `  - \`${cb.archive_id}\` — sign: ${cb.sign}, weight: ${cb.weight}`,
    ),
  ];
}

/** Ungated (reinforce) evidence — no holdout gate ran; score_provenance is the sole evidence. */
function buildUngatedEvidenceSection(target: MutationTarget): string {
  return [
    "## Evidence",
    "",
    "**Not holdout-gated.** This is an informational confidence signal derived from the",
    "trust-weighted attribution corpus (`attribute_outcomes`) — `evaluate_candidate` was never",
    "run, because a reinforce candidate is byte-identical to its own baseline and there is",
    "nothing for a holdout eval to distinguish.",
    ...buildScoreProvenanceLines(target.score_provenance),
  ].join("\n");
}

function buildEvidenceSection(
  target: MutationTarget,
  evalResult: EvaluateCandidateResult | null,
  proposalKind: MutationProposalKind,
): string {
  if (evalResult === null) {
    return buildUngatedEvidenceSection(target);
  }

  const holdoutLines = [
    "## Evidence",
    "",
    "### Holdout gate (§7 strict-holdout)",
    "",
    `| | Baseline | Candidate |`,
    `|---|---|---|`,
    `| Holdout passed | ${evalResult.baseline_score} | ${evalResult.candidate_score} |`,
    `| Holdout total | ${evalResult.per_split.holdout.total} | ${evalResult.per_split.holdout.total} |`,
    `| Accepted | — | ✓ |`,
  ];

  if (proposalKind === "retire") {
    return [...holdoutLines, ...buildScoreProvenanceLines(target.score_provenance)].join("\n");
  }

  return [
    ...holdoutLines,
    "",
    "### Attribution evidence",
    "",
    `- Artifact: \`${target.target_path}\``,
    `- Failure kind: \`${target.failure_kind}\``,
    `- Violations attributed: ${target.attributed_violation_count}`,
    `- Join basis: \`${resolveJoinBasis(target)}\``,
    `- Hash verified: \`${resolveHashVerified(target)}\``,
  ].join("\n");
}

function buildImpactSection(
  target: MutationTarget,
  applyChannel: MutationProposal["apply_channel"],
  proposalKind: MutationProposalKind,
): string {
  if (proposalKind === "retire") {
    return [
      "## Impact",
      "",
      `**Apply channel:** \`${applyChannel}\``,
      "",
      "**invalidate-don't-delete**: this is a RETIREMENT candidate, not a deletion request. The",
      "writer agent must mark the artifact retired (an `archived: true` frontmatter flag — the",
      "SAME loader-honored flag `write-principle`'s `--archive` mode already sets; `shared/",
      "matcher.ts`'s principle matcher excludes `archived: true` principles from every review /",
      "get_principles / review_code call) and must NEVER remove the file from disk. The artifact",
      "stays on disk, with its full history and score_provenance trace intact for audit. This is",
      "what makes the holdout gate meaningful: archiving genuinely changes which principles the",
      "eval harness loads, so a candidate that strictly improves the holdout is real signal, not",
      "a byte-identical no-op.",
      "",
      `**Artifact class:** \`${target.artifact_class}\``,
      "",
      "This proposal was generated by Canon's trust-weighted attribution consumer (Gap 3).",
      "Accept via `/canon:review-learnings`, which routes `retire` proposals to the writer",
      "agent in invalidate-don't-delete mode.",
    ].join("\n");
  }
  if (proposalKind === "reinforce") {
    return [
      "## Impact",
      "",
      `**Apply channel:** \`${applyChannel}\``,
      "",
      "**Un-holdout-gated confidence signal — NOT an artifact mutation.** This is an",
      "INFORMATIONAL reinforcement — trust-weighted positive evidence shows the principle earns",
      "its keep. It was never run through `evaluate_candidate` (a reinforce candidate is",
      "byte-identical to its own baseline, so no holdout eval could ever distinguish them —",
      "`gated: false` in this proposal's frontmatter marks that explicitly). No artifact content",
      "changes; the writer records a confidence bump only. No deletion, no retirement.",
      "",
      `**Artifact class:** \`${target.artifact_class}\``,
      "",
      "This proposal was generated by Canon's trust-weighted attribution consumer (Gap 3).",
      "Accept via `/canon:review-learnings`, which routes `reinforce` proposals to the writer agent.",
    ].join("\n");
  }
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
  /**
   * The EvaluateCandidateResult with accepted===true, for "rewrite"/"retire".
   * MUST be `null` for "reinforce" (target.proposal_kind === "reinforce") — a
   * reinforce candidate is never run through evaluate_candidate (Gap 3 L3 fix).
   */
  evalResult: EvaluateCandidateResult | null;
  /** Timestamp string for the proposal id (e.g. "20260625T143000"). */
  ts: string;
  /** 1-based index within the current pass (for filename ordering). */
  index: number;
};

/**
 * shapeMutationProposal — pure function.
 *
 * Builds a MutationProposal frontmatter + markdown body for either:
 *   - a "rewrite"/"retire" candidate that passed the §7 holdout gate. CALLER MUST
 *     ENSURE evalResult is non-null and evalResult.accepted === true before
 *     calling — producing a proposal for an unaccepted candidate violates the
 *     evolution-hard-gate invariant.
 *   - an ungated "reinforce" confidence signal. CALLER MUST pass evalResult: null
 *     — a reinforce candidate is byte-identical to its own baseline and is NEVER
 *     run through evaluate_candidate (Gap 3 L3 fix). The emitted proposal carries
 *     `gated: false` and null holdout fields.
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
  const proposalKind: MutationProposalKind = target.proposal_kind ?? "rewrite";

  // apply_channel routing: retire/reinforce → always writer (Gap 3 L3);
  // rewrite (unchanged) → principle/rule → writer; everything else → engineer-build-flow
  const applyChannel: MutationProposal["apply_channel"] =
    proposalKind === "retire" || proposalKind === "reinforce"
      ? "writer"
      : target.artifact_class === "principle" || target.artifact_class === "rule"
        ? "writer"
        : "engineer-build-flow";

  const frontmatter: MutationProposal = {
    accepted: true,
    apply_channel: applyChannel,
    artifact_class: target.artifact_class,
    confidence: confidenceToNumeric(target.confidence),
    failure_kind: target.failure_kind,
    gated: evalResult !== null,
    hash_verified: resolveHashVerified(target),
    holdout_baseline: evalResult?.baseline_score ?? null,
    holdout_candidate: evalResult?.candidate_score ?? null,
    id: `evolve-${ts}-${pad2(index)}`,
    join_basis: resolveJoinBasis(target),
    principle_id: target.principle_id,
    proposal_kind: proposalKind,
    target: target.principle_id ?? target.target_path,
    target_path: target.target_path,
    type: "evolution-candidate",
    ...(target.score_provenance ? { score_provenance: target.score_provenance } : {}),
  };

  const filename = `${pad2(index)}-evolve-${slug(target.target_path)}.md`;

  const body = [
    buildObservationSection(target, proposalKind),
    buildProposedChangeSection(target, candidateText, proposalKind),
    buildEvidenceSection(target, evalResult, proposalKind),
    buildImpactSection(target, applyChannel, proposalKind),
  ].join("\n\n");

  const markdown = `${serializeFrontmatter(frontmatter)}\n\n${body}\n`;

  return { filename, frontmatter, markdown };
}
