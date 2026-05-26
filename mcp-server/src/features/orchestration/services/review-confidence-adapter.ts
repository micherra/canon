/**
 * Review Confidence Adapter
 *
 * Pure adapter that computes a ConfidenceAnnotation for a reviewer violation
 * by composing signals from the drift DB history. This is the bridge between
 * the review pipeline and the shared confidence scoring engine.
 *
 * compute-effect-separation:
 * - computeViolationConfidence is pure given signals (no side effects)
 * - Signal reads happen via the structural ReviewSignalReader interface
 * - writeReview orchestrates (side effects live in the tool layer)
 *
 * bounded-context-boundaries:
 * - Uses a structural interface (ReviewSignalReader) rather than importing
 *   from platform/storage/drift directly — the tool layer injects a
 *   DriftDbSignals instance which satisfies this interface structurally
 *
 * errors-are-values:
 * - Missing file_path returns an insufficient annotation rather than throwing
 * - Signal read failures return worst-case default (0 observations)
 */

import {
  type ConfidenceAnnotation,
  type ConfidenceInput,
  computeConfidenceAnnotation,
} from "@shared/lib/confidence.ts";

/**
 * Structural interface for reading drift signals.
 * DriftDbSignals satisfies this via structural typing — no direct import needed.
 */
export type ReviewSignalReader = {
  getFileViolationHistory(filePaths: string[]): Array<{
    file_path: string;
    principle_id: string;
    violation_count: number;
    last_seen: string;
  }>;
  getPathEffects(filePaths: string[]): Array<{
    file_path: string;
    clean_streak: number;
    violation_streak: number;
    total_reviews: number;
  }>;
};

const SEVERITY_SCORES: Record<string, number> = {
  rule: 0.9,
  "strong-opinion": 0.6,
  convention: 0.3,
};

/**
 * Compute a ConfidenceAnnotation for a reviewer violation using drift DB signals.
 *
 * Signal composition:
 * - severity_tier (weight 0.3): rule=0.9, strong-opinion=0.6, convention=0.3
 * - violation_history (weight 0.35): min(violation_count / 10, 1.0)
 * - path_effects (weight 0.2): streak-based signal
 * - base_sample (weight 0.15): min(total_reviews / 10, 1.0)
 *
 * Returns an insufficient annotation when file_path is undefined, or when
 * signal reads fail.
 */
export function computeViolationConfidence(
  violation: { principle_id: string; severity: string; file_path?: string },
  signals: ReviewSignalReader,
): ConfidenceAnnotation {
  // errors-are-values: no file_path means we cannot query history
  if (!violation.file_path) {
    return {
      score: 0.5,
      tier: "insufficient",
      basis: [
        {
          signal: "no_file_path",
          weight: 1,
          detail: "violation has no file path — cannot compute confidence",
        },
      ],
      sample_size: 0,
    };
  }

  const filePath = violation.file_path;

  // severity_tier signal — always available (no DB needed)
  const severityValue = SEVERITY_SCORES[violation.severity] ?? 0.3;
  const severityInput: ConfidenceInput = {
    signal: "severity_tier",
    value: severityValue,
    weight: 0.3,
    detail: `${violation.severity}-level principle`,
    sample_size: Infinity, // always available — use a large number for min() calculation
  };

  // violation_history signal
  let violationHistoryInput: ConfidenceInput;
  try {
    const history = signals
      .getFileViolationHistory([filePath])
      .find((r) => r.principle_id === violation.principle_id);
    const violationCount = history?.violation_count ?? 0;
    violationHistoryInput = {
      signal: "violation_history",
      value: Math.min(violationCount / 10, 1.0),
      weight: 0.35,
      detail:
        violationCount > 0
          ? `violated ${violationCount} times in this file`
          : "no prior violations in this file",
      sample_size: violationCount,
    };
  } catch {
    violationHistoryInput = {
      signal: "violation_history",
      value: 0,
      weight: 0.35,
      detail: "could not read violation history",
      sample_size: 0,
    };
  }

  // path_effects signal
  let pathEffectsInput: ConfidenceInput;
  let totalReviews = 0;
  try {
    const pathEffect = signals.getPathEffects([filePath])[0];
    totalReviews = pathEffect?.total_reviews ?? 0;
    const violationStreak = pathEffect?.violation_streak ?? 0;
    const cleanStreak = pathEffect?.clean_streak ?? 0;

    let pathValue: number;
    let pathDetail: string;
    if (violationStreak > 0) {
      pathValue = Math.min(violationStreak / 5, 1.0);
      pathDetail = `violation streak of ${violationStreak}`;
    } else if (cleanStreak >= 3) {
      pathValue = 0.2; // file is usually clean, finding is surprising
      pathDetail = `clean streak of ${cleanStreak}`;
    } else {
      pathValue = 0.5; // neutral
      pathDetail = "neutral path history";
    }
    pathEffectsInput = {
      signal: "path_effects",
      value: pathValue,
      weight: 0.2,
      detail: pathDetail,
      sample_size: totalReviews,
    };
  } catch {
    pathEffectsInput = {
      signal: "path_effects",
      value: 0.5,
      weight: 0.2,
      detail: "could not read path effects",
      sample_size: 0,
    };
  }

  // base_sample signal
  const baseSampleInput: ConfidenceInput = {
    signal: "base_sample",
    value: Math.min(totalReviews / 10, 1.0),
    weight: 0.15,
    detail: `${totalReviews} total reviews of this file`,
    sample_size: totalReviews,
  };

  // Clamp the Infinity sample_size for the severity signal before passing to the engine
  const clampedSeverityInput: ConfidenceInput = {
    ...severityInput,
    sample_size: Math.max(
      violationHistoryInput.sample_size,
      pathEffectsInput.sample_size,
      baseSampleInput.sample_size,
      1, // at minimum 1 so deriveTier doesn't immediately return insufficient for severity alone
    ),
  };

  return computeConfidenceAnnotation([
    clampedSeverityInput,
    violationHistoryInput,
    pathEffectsInput,
    baseSampleInput,
  ]);
}
