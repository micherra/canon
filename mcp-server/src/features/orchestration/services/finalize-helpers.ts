/**
 * finalize-helpers — pure compute helpers for the orchestration journal's finalize path.
 *
 * Extracted from orchestration-journal.ts to comply with the noExcessiveLinesPerFile
 * limit (line-limit-split-into-siblings convention). All functions here are pure compute;
 * they have no side effects and no runtime dependencies beyond the JournalStep type.
 *
 * workspace-cleanup.ts imports computeFlowOutcome directly from this file.
 */

import type { JournalStep } from "../tools/orchestration-journal.ts";

/**
 * The three distinct evaluator-gate outcomes that mean "the gate did not
 * render a real verdict, and the build proceeded anyway" (ADR-0062).
 * A real `verdict: "PASS"` or `"FAIL"` is NOT a non-evaluation.
 */
export type GateNonEvaluationReason = "tool_unavailable" | "tool_error" | "PASS_parse_fallback";

export type GateNonEvaluation = {
  reason: GateNonEvaluationReason;
  step_id: string;
};

/**
 * Layer-2 loudness backstop (ADR-0062): scans each step's logged
 * `outcome.evaluator_gate` for a non-evaluation marker — a skip
 * (`tool_unavailable` | `tool_error`) or a parse-failure fallback
 * (`PASS_parse_fallback`). Keys on the DISTINCT non-evaluation values, never
 * on the mere presence of an `evaluator_gate` outcome — a real
 * `verdict: "PASS"` (or `"FAIL"`) yields no entry.
 */
export function computeGateNonEvaluations(steps: readonly JournalStep[]): GateNonEvaluation[] {
  const results: GateNonEvaluation[] = [];
  for (const step of steps) {
    const gate = step.outcome?.evaluator_gate;
    if (!gate) continue;
    if (gate.skipped === "tool_unavailable" || gate.skipped === "tool_error") {
      results.push({ reason: gate.skipped, step_id: step.step_id });
    } else if (gate.verdict === "PASS_parse_fallback") {
      results.push({ reason: "PASS_parse_fallback", step_id: step.step_id });
    }
  }
  return results;
}

/**
 * Non-firing surfacing for the T2 live-forward-checker recorder (ADR-0065),
 * the observability sibling of computeGateNonEvaluations above. A COMPLETED
 * review step whose outcome lacks `t2_recorded: true` either never threaded
 * the observability annotation (the record may still have been written —
 * firing never depends on this threading, d-t2fix-06) or genuinely never
 * fired. Either way it is surfaced to the user as an advisory, never a block.
 */
export type T2NonFiring = { step_id: string };

export function computeT2NonFiring(steps: readonly JournalStep[]): T2NonFiring[] {
  const results: T2NonFiring[] = [];
  for (const step of steps) {
    if (step.status !== "completed") continue;
    const isReviewStep = step.agent_type === "reviewer" || step.step_id === "review";
    if (!isReviewStep) continue;
    if (step.outcome?.t2_recorded !== true) {
      results.push({ step_id: step.step_id });
    }
  }
  return results;
}

/** Wall clock: max(completed_at) − min(started_at). Null when no timestamps. */
function computeTotalDurationMs(steps: readonly JournalStep[]): number | null {
  const starts = steps.map((s) => s.started_at).filter((t): t is string => typeof t === "string");
  const ends = steps.map((s) => s.completed_at).filter((t): t is string => typeof t === "string");
  if (starts.length === 0 || ends.length === 0) return null;
  const minStart = Math.min(...starts.map((s) => Date.parse(s)));
  const maxEnd = Math.max(...ends.map((s) => Date.parse(s)));
  if (!Number.isFinite(minStart) || !Number.isFinite(maxEnd)) return null;
  return maxEnd - minStart;
}

export function computeFlowOutcome(steps: readonly JournalStep[]): {
  domain_skills_used: string[];
  review_verdict: string | null;
  fix_iterations: number;
  total_steps: number;
  total_duration_ms: number | null;
} {
  const domain_skills_used = Array.from(
    new Set(steps.flatMap((s) => s.domain_skills_loaded ?? [])),
  ).sort();

  // Last verdict wins: for review→fix→re-review flows the re-review is
  // the one that answers "did this flow end approved?"
  let review_verdict: string | null = null;
  for (const s of steps) {
    if (s.outcome?.review_verdict) review_verdict = s.outcome.review_verdict;
  }

  const fix_iterations = steps.reduce((sum, s) => sum + (s.outcome?.fix_iterations ?? 0), 0);

  return {
    domain_skills_used,
    fix_iterations,
    review_verdict,
    total_duration_ms: computeTotalDurationMs(steps),
    total_steps: steps.length,
  };
}

/** L4 defense-in-depth: returns step IDs of skipped steps that have no skip_reason.
 * The L1 check in logStep/batchLogSteps should have blocked these writes,
 * but journals can be corrupted by bugs, manual edits, or older code paths. */
export function getStepsMissingSkipReason(skipped: readonly JournalStep[]): string[] {
  return skipped
    .filter((s) => typeof s.skip_reason !== "string" || !s.skip_reason.trim())
    .map((s) => s.step_id);
}
