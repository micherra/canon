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
