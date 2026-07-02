/**
 * get-evolution-outcomes.ts — get_evolution_outcomes MCP tool handler.
 *
 * Reads the drift.db `applied_evolutions` row for a proposal, then splits the
 * TARGET-SCOPED signal into a pre/post cohort anchored on `applied_at` and
 * reports a candidate-regression HYPOTHESIS with a reused confidence tier.
 *
 * VOCABULARY CONSTRAINT (grep-enforced, mirrors ADR-0024): every narrative and
 * `hypothesis` string uses presence/correlation phrasing ("coincides with",
 * "observed after apply", "correlated with", "candidate-regression"). The
 * forbidden causation words are absent from this whole file — a unit test greps
 * the source and asserts zero matches. This is a correlation report, never an
 * assertion of proof.
 *
 * Read posture: FAIL-OPEN. An absent signal yields cohort zeros + an
 * `insufficient` verdict, not an error. The only errors are `INVALID_INPUT`
 * (empty proposal_id) and `PROPOSAL_NOT_RECORDED` (no applied_evolutions row).
 *
 * Target-scoped signal selection (never a global signal):
 * - principle-carrying targets → reviews⋈violations filtered by principle_id.
 * - agent-def cliff targets (principle_id null) → cliff_events filtered by the
 *   agent derived from target_path (canon: prefix stripped).
 *
 * ADR-002: ToolResult contract; no subprocess, no node:child_process, no model calls.
 * no-cross-feature-internal-import: imports only @platform/storage/drift + @shared/lib.
 */

import type {
  AppliedEvolutionRow,
  AppliedEvolutionsDao,
} from "@platform/storage/drift/applied-evolutions-dao.ts";
import type { DriftDb } from "@platform/storage/drift/drift-db.ts";
import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import type { ConfidenceAnnotation } from "@shared/lib/confidence.ts";
import { deriveTier } from "@shared/lib/confidence.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolError, toolOk } from "@shared/lib/tool-result.ts";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

export const GetEvolutionOutcomesInputSchema = z.object({
  project_dir: z
    .string()
    .describe("Absolute path to the project root (contains .canon/). Drift.db lives under it."),
  proposal_id: z
    .string()
    .describe("MutationProposal.id of a previously recorded applied evolution."),
});

type GetEvolutionOutcomesInput = z.input<typeof GetEvolutionOutcomesInputSchema>;

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/** Which target-scoped signal the cohort split was computed over. */
export type EvolutionSignal = "review_violation" | "cliff_event";

/** A verdict is a HYPOTHESIS bucket — never an assertion of proof. */
export type EvolutionVerdict =
  | "regression_candidate"
  | "no_signal_change"
  | "improvement_candidate"
  | "ambiguous"
  | "insufficient";

/** One side of the pre/post cohort split. `rate` = events normalized by cohort denominator. */
export type EvolutionCohort = {
  events: number;
  reviews_or_runs: number;
  rate: number;
  window: [string, string];
};

/** The full get_evolution_outcomes result struct (see DESIGN.md contract). */
export type GetEvolutionOutcomesResult = {
  proposal_id: string;
  target_path: string;
  artifact_class: string;
  principle_id: string | null;
  applied_at: string;
  apply_base_commit: string | null;
  signal: EvolutionSignal;
  cohort: { pre: EvolutionCohort; post: EvolutionCohort };
  delta: number;
  verdict: EvolutionVerdict;
  confidence: ConfidenceAnnotation;
  ambiguous: boolean;
  confounding_proposal_ids: string[];
  hypothesis: string;
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Strip a leading `canon:` prefix from an agent identifier. */
function normalizeAgent(agent: string): string {
  return agent.replace(/^canon:/, "");
}

/** Derive the agent name for an agent-def target (e.g. `agents/engineer.md` → `engineer`). */
function deriveAgentFromTargetPath(targetPath: string): string {
  const base = targetPath.split("/").pop() ?? targetPath;
  return normalizeAgent(base.replace(/\.md$/, ""));
}

/**
 * A stable key identifying the signal a target touches. Two applied evolutions
 * share a signal (and thus confound each other) when their keys match.
 */
function signalKey(row: Pick<AppliedEvolutionRow, "principle_id" | "target_path">): string {
  return row.principle_id
    ? `principle:${row.principle_id}`
    : `agent:${deriveAgentFromTargetPath(row.target_path)}`;
}

/** Build a cohort from bucketed event/denominator counts and a window. */
function buildCohort(
  events: number,
  denominator: number,
  window: [string, string],
): EvolutionCohort {
  return {
    events,
    rate: denominator > 0 ? events / denominator : 0,
    reviews_or_runs: denominator,
    window,
  };
}

/** Compute [min, max] timestamp of a set of events; falls back to the anchor when empty. */
function windowOf(timestamps: string[], anchor: string): [string, string] {
  if (timestamps.length === 0) return [anchor, anchor];
  const sorted = [...timestamps].sort();
  return [sorted[0], sorted[sorted.length - 1]];
}

/**
 * Principle signal cohorts: reviews⋈violations filtered by principle_id, split on
 * `anchor`. `events` = matching-principle violations; denominator = cohort review
 * count. Resolved violations are included so the historical record is complete
 * (drift-report two-views invariant). Fail-open: no reviews → zeroed cohorts.
 */
function computePrincipleCohorts(
  db: DriftDb,
  principleId: string,
  anchor: string,
): { pre: EvolutionCohort; post: EvolutionCohort } {
  const reviews = db.getReviews({ includeResolvedViolations: true, principleId });
  let preEvents = 0;
  let preReviews = 0;
  const preTs: string[] = [];
  let postEvents = 0;
  let postReviews = 0;
  const postTs: string[] = [];

  for (const review of reviews) {
    const matching = (review.violations ?? []).filter((v) => v.principle_id === principleId).length;
    if (review.timestamp < anchor) {
      preReviews += 1;
      preEvents += matching;
      preTs.push(review.timestamp);
    } else {
      postReviews += 1;
      postEvents += matching;
      postTs.push(review.timestamp);
    }
  }

  return {
    post: buildCohort(postEvents, postReviews, windowOf(postTs, anchor)),
    pre: buildCohort(preEvents, preReviews, windowOf(preTs, anchor)),
  };
}

/**
 * Agent-def cliff signal cohorts: cliff_events split on `anchor`. `events` = cliffs
 * for `agent`; denominator = total cliffs in the cohort (rate = share attributable
 * to this agent). Fail-open: no cliffs → zeroed cohorts.
 */
function computeCliffCohorts(
  db: DriftDb,
  agent: string,
  anchor: string,
): { pre: EvolutionCohort; post: EvolutionCohort } {
  const all = db.getCliffEvents().getAll();
  let preAgent = 0;
  let preTotal = 0;
  const preTs: string[] = [];
  let postAgent = 0;
  let postTotal = 0;
  const postTs: string[] = [];

  for (const ev of all) {
    const isAgent = ev.agent_type != null && normalizeAgent(ev.agent_type) === agent;
    if (ev.detected_at < anchor) {
      preTotal += 1;
      if (isAgent) {
        preAgent += 1;
        preTs.push(ev.detected_at);
      }
    } else {
      postTotal += 1;
      if (isAgent) {
        postAgent += 1;
        postTs.push(ev.detected_at);
      }
    }
  }

  return {
    post: buildCohort(postAgent, postTotal, windowOf(postTs, anchor)),
    pre: buildCohort(preAgent, preTotal, windowOf(preTs, anchor)),
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * get_evolution_outcomes — fail-open target-scoped regression HYPOTHESIS reader.
 *
 * @returns the outcome struct on success; `INVALID_INPUT` when `proposal_id` is
 *   empty; `PROPOSAL_NOT_RECORDED` when no `applied_evolutions` row exists.
 *   Absent signal rows are NOT an error — they yield an `insufficient` verdict.
 */
export async function getEvolutionOutcomes(
  input: GetEvolutionOutcomesInput,
): Promise<ToolResult<GetEvolutionOutcomesResult>> {
  const { proposal_id, project_dir } = input;

  if (!proposal_id) {
    return toolError("INVALID_INPUT", "proposal_id must be a non-empty string.", false);
  }
  if (!project_dir) {
    return toolError("INVALID_INPUT", "project_dir must be a non-empty string.", false);
  }

  const db = getDriftDb(project_dir);
  const applied = db.getAppliedEvolutions();
  const row = applied.getByProposalId(proposal_id);
  if (!row) {
    return toolError(
      "PROPOSAL_NOT_RECORDED",
      `No applied_evolutions row for proposal_id "${proposal_id}". ` +
        "Only applied evolution-candidates are recorded.",
      false,
    );
  }

  // ---- Cohort split (anchored on applied_at) ----
  const anchor = row.applied_at;
  const signal: EvolutionSignal = row.principle_id ? "review_violation" : "cliff_event";
  const scopeLabel = row.principle_id
    ? `principle "${row.principle_id}"`
    : `agent "${deriveAgentFromTargetPath(row.target_path)}"`;

  const { pre, post } = row.principle_id
    ? computePrincipleCohorts(db, row.principle_id, anchor)
    : computeCliffCohorts(db, deriveAgentFromTargetPath(row.target_path), anchor);

  return toolOk(finalizeOutcome({ applied, post, pre, row, scopeLabel, signal }));
}

/**
 * Assemble the outcome struct from the cohort split: delta, reused confidence
 * tier, ambiguous-confound detection, verdict bucket, and hypothesis narrative.
 * Extracted from the handler to keep each function within complexity limits.
 */
function finalizeOutcome(args: {
  applied: AppliedEvolutionsDao;
  row: AppliedEvolutionRow;
  signal: EvolutionSignal;
  scopeLabel: string;
  pre: EvolutionCohort;
  post: EvolutionCohort;
}): GetEvolutionOutcomesResult {
  const { applied, row, signal, scopeLabel, pre, post } = args;

  // Delta + confidence (reused deriveTier, keyed on target-scoped event count).
  const delta = post.rate - pre.rate;
  const sampleSize = Math.min(pre.events, post.events);
  const score = Math.min(1, Math.abs(delta));
  const tier = deriveTier(score, sampleSize);
  const confidence: ConfidenceAnnotation = {
    basis: [
      {
        detail: `${pre.events} pre / ${post.events} post ${signal} events for ${scopeLabel}`,
        signal,
        weight: 1,
      },
    ],
    sample_size: sampleSize,
    score,
    tier,
  };

  // Ambiguous-confound detection: another applied evolution whose apply window is
  // at/after this one AND touches the SAME signal overlaps this post-window; its
  // effect is inseparable here.
  const thisKey = signalKey(row);
  const confoundingIds = applied
    .listAppliedSince(row.applied_at)
    .filter((r) => r.proposal_id !== row.proposal_id && signalKey(r) === thisKey)
    .map((r) => r.proposal_id);
  const ambiguous = confoundingIds.length > 0;

  const verdict = deriveVerdict(ambiguous, tier, delta);

  return {
    ambiguous,
    applied_at: row.applied_at,
    apply_base_commit: row.apply_base_commit,
    artifact_class: row.artifact_class,
    cohort: { post, pre },
    confidence,
    confounding_proposal_ids: confoundingIds,
    delta,
    hypothesis: buildHypothesis({
      ambiguous,
      confoundingIds,
      delta,
      post,
      pre,
      scopeLabel,
      signal,
      tier,
      verdict,
    }),
    principle_id: row.principle_id,
    proposal_id: row.proposal_id,
    signal,
    target_path: row.target_path,
    verdict,
  };
}

/**
 * Map (ambiguous, confidence tier, delta) to a verdict bucket. A concurrent
 * confound outranks a directional read (the effect is inseparable); a sparse
 * cohort floors to `insufficient` (the honest common case near-term).
 */
function deriveVerdict(ambiguous: boolean, tier: string, delta: number): EvolutionVerdict {
  if (ambiguous) return "ambiguous";
  if (tier === "insufficient") return "insufficient";
  if (delta > 0) return "regression_candidate";
  if (delta < 0) return "improvement_candidate";
  return "no_signal_change";
}

/** Build the candidate-regression hypothesis narrative (presence/correlation vocabulary only). */
function buildHypothesis(ctx: {
  scopeLabel: string;
  signal: EvolutionSignal;
  pre: EvolutionCohort;
  post: EvolutionCohort;
  delta: number;
  tier: string;
  verdict: EvolutionVerdict;
  ambiguous: boolean;
  confoundingIds: string[];
}): string {
  const direction = ctx.delta > 0 ? "rose" : ctx.delta < 0 ? "fell" : "held steady";
  const base =
    `Observed after apply: the ${ctx.signal} rate for ${ctx.scopeLabel} ${direction} ` +
    `from ${ctx.pre.rate.toFixed(3)} (pre) to ${ctx.post.rate.toFixed(3)} (post), ` +
    `a delta of ${ctx.delta.toFixed(3)}. This is a correlation coinciding with the apply, ` +
    `offered as a candidate-regression hypothesis at confidence "${ctx.tier}" — not a proven link.`;
  if (ctx.ambiguous) {
    return (
      `${base} Concurrent applied evolutions on the same signal overlap this post-window ` +
      `(${ctx.confoundingIds.join(", ")}), so the shift is not separable to this proposal alone.`
    );
  }
  return base;
}
