/**
 * outcome-attribution.ts — Signed, trust-weighted, derive-on-read aggregator over
 * positive (honored) and negative (violation/cliff) attribution signals across a
 * corpus of builds (Gap 3 Layer 2, DESIGN.md).
 *
 * PURE aside from the injected readCurrentBody/getTranscriptExcerpt seams — no
 * Date.now()/Math.random()/network (dc-01/dc-05). `now_ms` is ALWAYS threaded in by
 * the caller. Per-build cliff events are pre-loaded by the caller (BuildRecord) —
 * they live in drift.db keyed by workspace slug, not on RunSummary itself, the same
 * way attributeFailures already needs them supplied.
 *
 * Composes (does not rewrite) the Layer 1 primitives:
 *   - attributeFailures (attribution-join.ts)    — negative signals (violation + cliff)
 *   - attributeHonored (positive-attribution.ts) — positive signals (honored[])
 *   - computeTrustWeight (attribution-weight.ts) — the signed per-contribution weight
 *
 * For each build: derive per-principle positive/negative contributions, weight each
 * via computeTrustWeight, and accumulate into a signed TrustWeightedScore per
 * principle_id. Sort: deterministic ascending by principle_id (dc-01).
 *
 * `decisions` is accepted per the DESIGN.md input contract but is NOT used to compute
 * scores in v1 — the is_adversarial_step heuristic keys on step_id, not the decisions
 * ledger (PROBE-FINDINGS Q2). Threaded through only to `meta.decisions_seen` for
 * observability, and as a forward-compatible slot (mirrors the reserved "codex" trust
 * tier in attribution-weight.ts). Typed loosely (not `CorpusDecision`) so this file
 * never imports across the features/orchestration boundary — no-cross-feature-internal-
 * import forbids it; the composition root (app/register-evolution.ts) resolves the
 * real corpus and passes it down, same precedent as ensureContextGraphFresh's decisions
 * parameter (see app/register-knowledge.ts).
 *
 * No-LLM verification: grep -niE 'anthropic|claude|messages.create|model:|Date.now|Math.random'
 * outcome-attribution.ts -> zero hits (except this comment).
 *
 * Canon principles:
 *   - command-query-separation: pure query, mutates nothing
 *   - no-llm-calls-in-mcp-tools: deterministic join + arithmetic only
 *   - errors-are-values: lossy paths (unattributed, flagged, no-principle) are typed
 *     buckets, never silently dropped
 *   - deep-modules: one function (aggregateOutcomes) over a rich three-source join
 */

import type { OutcomeSignals } from "@shared/lib/outcome-weight.ts";
import type { RunSummary } from "../../../platform/storage/archive/archive-types.ts";
import type { CliffEventRow } from "../../../platform/storage/drift/cliff-events-dao.ts";
import { attributeFailures } from "./attribution-join.ts";
import type {
  FailureAttribution,
  FailureKind,
  FlaggedAttribution,
  OwningStep,
  TranscriptEvidence,
} from "./attribution-types.ts";
import type { SignContribution, TrustTierSlot } from "./attribution-weight.ts";
import { computeTrustWeight } from "./attribution-weight.ts";
import type { HonoredEntry } from "./positive-attribution.ts";
import { attributeHonored } from "./positive-attribution.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One build's pre-loaded data: its RunSummary plus the cliff events keyed by its slug. */
export type BuildRecord = {
  archive_id: string;
  summary: RunSummary;
  cliffEvents: CliffEventRow[];
};

/** A single signed contribution trace — the auditable per-build entry (DESIGN.md). */
export type ContributingBuild = {
  archive_id: string;
  sign: 1 | -1;
  weight: number;
};

/** The signed, trust-weighted score for one principle across the whole corpus. */
export type TrustWeightedScore = {
  principle_id: string;
  net_score: number;
  positive_weight: number;
  negative_weight: number;
  /** Sum of distinct-owning-step corroboration counts across all contributions. */
  corroboration: number;
  tier_breakdown: Record<TrustTierSlot, number>;
  contributing_builds: ContributingBuild[];
};

/** A honored line that could not be scored — pass-through of attributeHonored's typed bucket. */
export type UnattributedOutcomePositive = {
  archive_id: string;
  reason: "unparseable_honored" | "no_in_context_artifact";
  honored: HonoredEntry;
};

/**
 * A negative attribution that could not be scored. Two distinct lossy classes:
 *   - pass-through of attributeFailures's own unattributed bucket (no in-context artifact)
 *   - "no_principle_id": a successfully-attributed agent-def cliff_event has no violation
 *     to derive a principle from (derivePrincipleId returns null) — attributed, but
 *     unscoreable at the principle level (mirrors select-mutation-targets.ts's
 *     derivePrincipleId "cliff agent-def -> null" precedent, Codex P2 #2).
 */
export type UnattributedOutcomeNegative =
  | {
      archive_id: string;
      reason: "no_in_context_artifact" | "no_provenance";
      violation: FailureAttribution["attributed_violations"][number];
    }
  | {
      archive_id: string;
      reason: "no_principle_id";
      target_path: string;
      failure_kind: FailureKind;
    };

/** A flagged (hash-mismatched/missing) artifact, tagged with the build it came from. */
export type TaggedFlaggedAttribution = FlaggedAttribution & { archive_id: string };

export type AggregateOutcomesResult = {
  scores: TrustWeightedScore[];
  unattributed_positive: UnattributedOutcomePositive[];
  unattributed_negative: UnattributedOutcomeNegative[];
  flagged: TaggedFlaggedAttribution[];
  meta: {
    builds_seen: number;
    decisions_seen: number;
    attributions_positive: number;
    attributions_negative: number;
  };
};

export type AggregateOutcomesInput = {
  builds: BuildRecord[];
  /** Reserved forward-compatible slot — see file header. Not used to compute scores in v1. */
  decisions: readonly unknown[];
  now_ms: number;
  /** Injected seam: read the CURRENT raw artifact body from disk. Return null on missing. */
  readCurrentBody: (path: string) => string | null;
  /** Optional seam: get transcript excerpt for (stepId, artifactId). */
  getTranscriptExcerpt?: (stepId: string, artifactId: string) => TranscriptEvidence | null;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * aggregateOutcomes — pure signed aggregation over positive + negative attribution
 * signals across a corpus of builds.
 *
 * Never throws. Lossy paths emit typed buckets. Deterministic: identical input always
 * produces an identical (deep-equal) `scores` array, sorted ascending by principle_id.
 */
export function aggregateOutcomes(input: AggregateOutcomesInput): AggregateOutcomesResult {
  const { builds, decisions, now_ms, readCurrentBody, getTranscriptExcerpt } = input;

  const buckets = newBuckets();
  for (const build of builds) {
    const signalAgeMs = computeSignalAgeMs(build.summary, now_ms);
    processNegativeSignals(build, signalAgeMs, { getTranscriptExcerpt, readCurrentBody }, buckets);
    processPositiveSignals(build, signalAgeMs, readCurrentBody, buckets);
  }

  return {
    flagged: buckets.flagged,
    meta: {
      attributions_negative: buckets.attributionsNegative,
      attributions_positive: buckets.attributionsPositive,
      builds_seen: builds.length,
      decisions_seen: decisions.length,
    },
    scores: buildScores(buckets.acc),
    unattributed_negative: buckets.unattributedNegative,
    unattributed_positive: buckets.unattributedPositive,
  };
}

// ---------------------------------------------------------------------------
// Private: per-build processing
// ---------------------------------------------------------------------------

type Accumulator = {
  net_score: number;
  positive_weight: number;
  negative_weight: number;
  corroboration: number;
  tier_breakdown: Record<TrustTierSlot, number>;
  contributing_builds: ContributingBuild[];
};

/** Mutable result buckets threaded through one aggregateOutcomes call. */
type Buckets = {
  acc: Map<string, Accumulator>;
  unattributedPositive: UnattributedOutcomePositive[];
  unattributedNegative: UnattributedOutcomeNegative[];
  flagged: TaggedFlaggedAttribution[];
  attributionsPositive: number;
  attributionsNegative: number;
};

function newBuckets(): Buckets {
  return {
    acc: new Map(),
    attributionsNegative: 0,
    attributionsPositive: 0,
    flagged: [],
    unattributedNegative: [],
    unattributedPositive: [],
  };
}

function buildScores(acc: Map<string, Accumulator>): TrustWeightedScore[] {
  return [...acc.entries()]
    .map(([principle_id, a]) => ({
      contributing_builds: a.contributing_builds,
      corroboration: a.corroboration,
      negative_weight: a.negative_weight,
      net_score: a.net_score,
      positive_weight: a.positive_weight,
      principle_id,
      tier_breakdown: a.tier_breakdown,
    }))
    .sort((a, b) =>
      a.principle_id < b.principle_id ? -1 : a.principle_id > b.principle_id ? 1 : 0,
    );
}

/** Negative (violation + cliff) signals for one build — attributeFailures composition. */
function processNegativeSignals(
  build: BuildRecord,
  signalAgeMs: number,
  seams: {
    readCurrentBody: (path: string) => string | null;
    getTranscriptExcerpt?: (stepId: string, artifactId: string) => TranscriptEvidence | null;
  },
  buckets: Buckets,
): void {
  const negativeResult = attributeFailures({
    cliffEvents: build.cliffEvents,
    getTranscriptExcerpt: seams.getTranscriptExcerpt,
    provenance: build.summary.context_provenance ?? [],
    readCurrentBody: seams.readCurrentBody,
    violations: build.summary.review_results.flatMap((r) => r.violations),
  });
  for (const flag of negativeResult.flagged) {
    buckets.flagged.push({ ...flag, archive_id: build.archive_id });
  }
  for (const attr of negativeResult.attributions) {
    buckets.attributionsNegative += 1;
    applyNegativeAttribution({ attr, buckets, build, signalAgeMs });
  }
}

/** Positive (honored[]) signals for one build — attributeHonored composition. */
function processPositiveSignals(
  build: BuildRecord,
  signalAgeMs: number,
  readCurrentBody: (path: string) => string | null,
  buckets: Buckets,
): void {
  const honoredEntries: HonoredEntry[] = build.summary.review_results.flatMap((r) =>
    r.honored.map((raw) => ({ raw, step_id: null })),
  );
  const positiveResult = attributeHonored({
    honored: honoredEntries,
    provenance: build.summary.context_provenance ?? [],
    readCurrentBody,
  });
  for (const flag of positiveResult.flagged) {
    buckets.flagged.push({ ...flag, archive_id: build.archive_id });
  }
  for (const u of positiveResult.unattributed) {
    buckets.unattributedPositive.push({ archive_id: build.archive_id, ...u });
  }
  for (const attr of positiveResult.attributions) {
    buckets.attributionsPositive += 1;
    // Keys on attr.target_artifact.id directly (NOT the derivePrincipleId helper the negative
    // path uses below) — this is safe, not a latent bug (Finding 4, Gap 3 review). The honored
    // join (positive-attribution.ts's findArtifactCandidates) matches on
    // `artifact.id === principleId`, where principleId is parsed from a REVIEW.md honored[]
    // line (`- **{principle-id}**: ...`, templates/review.md) — the reviewer only ever emits
    // principle ids there, never an agent name. An "agent-def" `target_artifact.kind` (the one
    // case where `.id` is NOT a principle id — it is the agent name, ADR-0032) cannot occur on
    // this join by construction, unlike the negative path's cliff/code-author edges, which are
    // explicitly wired to attribute agent-def artifacts (attribution-join.ts). So there is no
    // artifact-kind branch to dispatch on here; derivePrincipleId's PositiveAttribution
    // structurally has no `attributed_violations` to fall back through in the first place.
    const principleId = attr.target_artifact.id;
    const contribution = buildContribution({
      agentName: attr.owning_steps[0]?.agent_name ?? "",
      outcome: deriveOutcomeSignals(build.summary, principleId),
      owningSteps: attr.owning_steps,
      sign: 1,
      signalAgeMs,
    });
    accumulate(buckets.acc, principleId, build.archive_id, contribution);
  }
}

function newAccumulator(): Accumulator {
  return {
    contributing_builds: [],
    corroboration: 0,
    negative_weight: 0,
    net_score: 0,
    positive_weight: 0,
    tier_breakdown: { codex: 0, internal: 0 },
  };
}

/** A single weighted contribution, pre-computed, ready to fold into the accumulator. */
type Contribution = {
  sign: 1 | -1;
  weight: number;
  tier: TrustTierSlot;
  distinctOwningSteps: number;
};

function buildContribution(opts: {
  sign: 1 | -1;
  agentName: string;
  owningSteps: OwningStep[];
  signalAgeMs: number;
  outcome: OutcomeSignals;
}): Contribution {
  const distinctOwningSteps = countDistinctOwningSteps(opts.owningSteps);
  const tier: TrustTierSlot = "internal"; // no capture seam records codex origin yet (PROBE Q2)
  const signContribution: SignContribution = {
    agent_name: opts.agentName,
    distinct_owning_steps: distinctOwningSteps,
    is_adversarial_step: isAdversarialOwningSteps(opts.owningSteps),
    outcome: opts.outcome,
    sign: opts.sign,
    signal_age_ms: opts.signalAgeMs,
    tier,
  };
  return {
    distinctOwningSteps,
    sign: opts.sign,
    tier,
    weight: computeTrustWeight(signContribution),
  };
}

function accumulate(
  acc: Map<string, Accumulator>,
  principleId: string,
  archiveId: string,
  contribution: Contribution,
): void {
  const entry = acc.get(principleId) ?? newAccumulator();
  entry.net_score += contribution.weight;
  if (contribution.sign === 1) {
    entry.positive_weight += contribution.weight;
  } else {
    entry.negative_weight += Math.abs(contribution.weight);
  }
  entry.tier_breakdown[contribution.tier] += contribution.weight;
  entry.corroboration += contribution.distinctOwningSteps;
  entry.contributing_builds.push({
    archive_id: archiveId,
    sign: contribution.sign,
    weight: contribution.weight,
  });
  acc.set(principleId, entry);
}

/**
 * derivePrincipleId — local equivalent of mutation-selection.ts's private
 * derivePrincipleId (Codex P2 #2), not exported there so duplicated here (tiny, pure).
 * For an agent-def target, the artifact id is the AGENT NAME, not a principle — the
 * violated principle (if any) is used instead; a cliff_event agent-def attribution has
 * no violation, so it derives to null (unscoreable at the principle level).
 */
function derivePrincipleId(attr: FailureAttribution): string | null {
  if (attr.target_artifact.kind === "agent-def") {
    return attr.attributed_violations[0]?.principle_id ?? null;
  }
  return attr.target_artifact.id || null;
}

function applyNegativeAttribution(opts: {
  buckets: Buckets;
  build: BuildRecord;
  attr: FailureAttribution;
  signalAgeMs: number;
}): void {
  const { buckets, build, attr, signalAgeMs } = opts;
  const principleId = derivePrincipleId(attr);
  if (principleId === null) {
    buckets.unattributedNegative.push({
      archive_id: build.archive_id,
      failure_kind: attr.failure_kind,
      reason: "no_principle_id",
      target_path: attr.target_artifact.path,
    });
    return;
  }
  const contribution = buildContribution({
    agentName: attr.owning_steps[0]?.agent_name ?? "",
    outcome: deriveOutcomeSignals(build.summary, principleId),
    owningSteps: attr.owning_steps,
    sign: -1,
    signalAgeMs,
  });
  accumulate(buckets.acc, principleId, build.archive_id, contribution);
}

// ---------------------------------------------------------------------------
// Private: pure derivation helpers
// ---------------------------------------------------------------------------

/** Verdict severity, worst-first — mirrors cross-run-analyzer.ts's summaryToOutcomeSignals. */
const VERDICT_SEVERITY: Record<string, number> = {
  approve: 1,
  blocking: 3,
  clean: 1,
  warning: 2,
};

function verdictSeverity(verdict: string): number {
  return VERDICT_SEVERITY[verdict.toLowerCase().trim()] ?? 0;
}

/**
 * Derive OutcomeSignals for a principle from a build's review_results.
 *
 * Shape mirrors cross-run-analyzer.ts's summaryToOutcomeSignals: picks the WORST
 * verdict among reviews that hold a violation for this principle; falls back to the
 * first review's verdict when none match (the honored-signal case — an honored
 * principle typically has zero violations recorded for it). fix_iterations and
 * test_pass_rate are omitted (undefined, i.e. neutral in computeOutcomeWeight) — this
 * layer has no FlowRunEntry to derive them from, only the RunSummary corpus (see
 * DESIGN.md D1: derive-on-read from RunSummary + decisions, no new drift.db join).
 *
 * Reimplemented locally rather than imported: summaryToOutcomeSignals lives in
 * features/history/services/, and features/evolution/ may not import another
 * feature's internals (no-cross-feature-internal-import, same class of gap gap3-01
 * hit with judge-weight.ts — see gap3-01-primitives-SUMMARY.md Deviations).
 */
function deriveOutcomeSignals(summary: RunSummary, principleId: string): OutcomeSignals {
  const matchingReviews = summary.review_results.filter((r) =>
    r.violations.some((v) => v.principle_id === principleId),
  );
  const review_verdict =
    matchingReviews.length > 0
      ? matchingReviews.reduce((worst, r) =>
          verdictSeverity(r.verdict) > verdictSeverity(worst.verdict) ? r : worst,
        ).verdict
      : summary.review_results[0]?.verdict;
  return { review_verdict };
}

/** now_ms − Date.parse(completed_at ?? archived_at); unparseable/absent → 0 (neutral decay). */
function computeSignalAgeMs(summary: RunSummary, nowMs: number): number {
  const raw = summary.run_metadata.completed_at ?? summary.run_metadata.archived_at;
  if (raw === null || raw === undefined || raw === "") return 0;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, nowMs - parsed);
}

/** Count of unique owning-step identities: step_id, falling back to agent_id. */
function countDistinctOwningSteps(owningSteps: OwningStep[]): number {
  const keys = new Set(owningSteps.map((s) => s.step_id ?? s.agent_id ?? "unknown"));
  return keys.size;
}

/**
 * is_adversarial_step heuristic (PROBE-FINDINGS Q2): the adversarial re-review is a
 * distinct runbook step distinguishable only by step_id/ordering, not a recorded
 * structured field. Conservative: matches only an explicit "adversarial" token in the
 * step_id (the orchestrator's own runbook-step naming convention, DESIGN.md Runbook
 * step 8 "adversarial-review") — never inferred from ordering or agent_name.
 */
const ADVERSARIAL_STEP_PATTERN = /adversarial/i;

function isAdversarialOwningSteps(owningSteps: OwningStep[]): boolean {
  return owningSteps.some((s) => s.step_id !== null && ADVERSARIAL_STEP_PATTERN.test(s.step_id));
}
