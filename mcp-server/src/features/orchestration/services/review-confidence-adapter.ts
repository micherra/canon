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
  convention: 0.3,
  rule: 0.9,
  "strong-opinion": 0.6,
};

/** Build the severity_tier ConfidenceInput — always available, no DB needed. */
function buildSeveritySignal(severity: string): ConfidenceInput {
  return {
    detail: `${severity}-level principle`,
    sample_size: Infinity, // always available — clamped later against observed sample sizes
    signal: "severity_tier",
    value: SEVERITY_SCORES[severity] ?? 0.3,
    weight: 0.3,
  };
}

/** Build the violation_history ConfidenceInput from drift DB history. */
function buildViolationHistorySignal(
  filePath: string,
  principleId: string,
  signals: ReviewSignalReader,
): ConfidenceInput {
  try {
    const history = signals
      .getFileViolationHistory([filePath])
      .find((r) => r.principle_id === principleId);
    const violationCount = history?.violation_count ?? 0;
    return {
      detail:
        violationCount > 0
          ? `violated ${violationCount} times in this file`
          : "no prior violations in this file",
      sample_size: violationCount,
      signal: "violation_history",
      value: Math.min(violationCount / 10, 1.0),
      weight: 0.35,
    };
  } catch {
    return {
      detail: "could not read violation history",
      sample_size: 0,
      signal: "violation_history",
      value: 0,
      weight: 0.35,
    };
  }
}

/** Build the path_effects ConfidenceInput and return total_reviews for base_sample. */
function buildPathEffectsSignal(
  filePath: string,
  signals: ReviewSignalReader,
): { input: ConfidenceInput; totalReviews: number } {
  try {
    const pathEffect = signals.getPathEffects([filePath])[0];
    const totalReviews = pathEffect?.total_reviews ?? 0;
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
    return {
      input: {
        detail: pathDetail,
        sample_size: totalReviews,
        signal: "path_effects",
        value: pathValue,
        weight: 0.2,
      },
      totalReviews,
    };
  } catch {
    return {
      input: {
        detail: "could not read path effects",
        sample_size: 0,
        signal: "path_effects",
        value: 0.5,
        weight: 0.2,
      },
      totalReviews: 0,
    };
  }
}

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
      basis: [
        {
          detail: "violation has no file path — cannot compute confidence",
          signal: "no_file_path",
          weight: 1,
        },
      ],
      sample_size: 0,
      score: 0.5,
      tier: "insufficient",
    };
  }

  const filePath = violation.file_path;

  const severityInput = buildSeveritySignal(violation.severity);
  const violationHistoryInput = buildViolationHistorySignal(
    filePath,
    violation.principle_id,
    signals,
  );
  const { input: pathEffectsInput, totalReviews } = buildPathEffectsSignal(filePath, signals);

  const baseSampleInput: ConfidenceInput = {
    detail: `${totalReviews} total reviews of this file`,
    sample_size: totalReviews,
    signal: "base_sample",
    value: Math.min(totalReviews / 10, 1.0),
    weight: 0.15,
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
