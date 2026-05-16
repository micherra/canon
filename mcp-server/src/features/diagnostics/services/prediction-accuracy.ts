/**
 * Prediction Accuracy Service — Wave 3 accuracy scoring.
 *
 * Pure computation: no side effects, no DB access, no LLM calls.
 * Computes per-principle accuracy metrics from resolved predictions.
 *
 * Outcome format (from reconcilePredictions in prediction-tracker.ts):
 *   { pairs: Array<{ file_path, principle_id, predicted, actual }> }
 *
 * TP = predicted: true AND actual: true
 * FP = predicted: true AND actual: false
 *
 * Canon principles:
 * - bounded-context-boundaries: structural PredictionReader — no DriftDbSignals import
 * - validate-at-trust-boundaries: outcome JSON validated before processing
 * - no-llm-calls-in-mcp-tools: all computation is deterministic arithmetic
 */

// ---- Types ----

/**
 * Structural interface for reading resolved predictions.
 * DriftDbSignals satisfies this via structural typing — no direct import needed.
 * principleIds filter is optional; when absent, returns all resolved predictions.
 */
export type PredictionReader = {
  getResolvedPredictions(principleIds?: string[]): Array<{
    prediction_id: string;
    outcome: string | null;
    principle_ids: string;
    file_paths: string;
    resolved: number;
    resolved_at: string | null;
  }>;
};

/**
 * Per-principle accuracy metrics derived from resolved predictions.
 * true_positive_rate = TP / (TP + FP) — same as precision for predicted-positive cases.
 * false_positive_rate = FP / (TP + FP) — FP ratio among predicted positives.
 */
export type PrincipleAccuracy = {
  principle_id: string;
  true_positives: number;
  false_positives: number;
  true_negatives: number;
  false_negatives: number;
  precision: number;
  true_positive_rate: number;
  false_positive_rate: number;
  sample_size: number;
};

/** Map of principle_id → accuracy metrics. */
export type AccuracyMap = Map<string, PrincipleAccuracy>;

/** Calibration thresholds for signal weight tuning and pruning decisions. */
export const ACCURACY_THRESHOLDS = {
  /** Weight multiplier applied to high-precision signals. */
  BOOST_MULTIPLIER: 1.5,
  /** Weight multiplier applied to low-precision signals. */
  DAMPEN_MULTIPLIER: 0.5,
  /** Precision at or above this → boost signal weight. */
  HIGH_PRECISION: 0.7,
  /** Precision below this (but above PRUNE_PRECISION) → dampen signal weight. */
  LOW_PRECISION: 0.4,
  /** Minimum predictions required before accuracy influences signal weights. */
  MIN_SAMPLE_SIZE: 10,
  /** Precision below this with MIN_SAMPLE_SIZE+ predictions → prune signal. */
  PRUNE_PRECISION: 0.2,
} as const;

// ---- Internal ----

/**
 * A single pair outcome from the outcome JSON.
 * Only pairs with predicted: true contribute to TP/FP counts.
 */
type PairOutcome = {
  file_path: string;
  principle_id: string;
  predicted: boolean;
  actual: boolean;
};

/**
 * Mutable tally used while accumulating counts for a principle.
 */
type AccuracyTally = {
  true_positives: number;
  false_positives: number;
  true_negatives: number;
  false_negatives: number;
  sample_size: number;
};

/** Attempt to cast a raw item to a PairOutcome. Returns null if the shape is invalid. */
function toPairOutcome(item: unknown): PairOutcome | null {
  if (typeof item !== "object" || item === null) return null;
  if (!("principle_id" in item) || !("predicted" in item) || !("actual" in item)) return null;
  const p = item as {
    file_path?: unknown;
    principle_id: unknown;
    predicted: unknown;
    actual: unknown;
  };
  if (
    typeof p.principle_id !== "string" ||
    typeof p.predicted !== "boolean" ||
    typeof p.actual !== "boolean"
  ) {
    return null;
  }
  return {
    actual: p.actual,
    file_path: typeof p.file_path === "string" ? p.file_path : "",
    predicted: p.predicted,
    principle_id: p.principle_id,
  };
}

/**
 * Parse outcome JSON to pairs array.
 * Returns empty array on null input or any parse/validation error.
 * Never throws — define-errors-out-of-existence.
 */
export function parseOutcome(outcomeJson: string | null): PairOutcome[] {
  if (outcomeJson === null) return [];
  try {
    const parsed = JSON.parse(outcomeJson) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("pairs" in parsed) ||
      !Array.isArray((parsed as { pairs: unknown }).pairs)
    ) {
      return [];
    }
    const result: PairOutcome[] = [];
    for (const item of (parsed as { pairs: unknown[] }).pairs) {
      const pair = toPairOutcome(item);
      if (pair !== null) result.push(pair);
    }
    return result;
  } catch {
    return [];
  }
}

/** Finalize a tally into a PrincipleAccuracy entry. */
function finalizeAccuracy(principleId: string, tally: AccuracyTally): PrincipleAccuracy {
  const predictedPositive = tally.true_positives + tally.false_positives;
  const precision = predictedPositive > 0 ? tally.true_positives / predictedPositive : 0;
  const tpr = predictedPositive > 0 ? tally.true_positives / predictedPositive : 0;
  const fpr = predictedPositive > 0 ? tally.false_positives / predictedPositive : 0;

  return {
    false_negatives: tally.false_negatives,
    false_positive_rate: fpr,
    false_positives: tally.false_positives,
    precision,
    principle_id: principleId,
    sample_size: tally.sample_size,
    true_negatives: tally.true_negatives,
    true_positive_rate: tpr,
    true_positives: tally.true_positives,
  };
}

// ---- Public API ----

/** Apply one pair's outcome to the matching tally, creating the tally if absent. */
function applyPairToTally(tallies: Map<string, AccuracyTally>, pair: PairOutcome): void {
  if (!tallies.has(pair.principle_id)) {
    tallies.set(pair.principle_id, {
      false_negatives: 0,
      false_positives: 0,
      sample_size: 0,
      true_negatives: 0,
      true_positives: 0,
    });
  }
  const tally = tallies.get(pair.principle_id)!;

  if (pair.predicted && pair.actual) {
    tally.true_positives += 1;
    tally.sample_size += 1;
  } else if (pair.predicted && !pair.actual) {
    tally.false_positives += 1;
    tally.sample_size += 1;
  } else if (!pair.predicted && pair.actual) {
    tally.false_negatives += 1;
  } else {
    tally.true_negatives += 1;
  }
}

/**
 * Compute per-principle accuracy metrics from resolved predictions.
 *
 * Iterates resolved predictions, parses outcome JSON, and tallies TP/FP
 * per principle across all predictions. Skips predictions with null or
 * malformed outcome JSON without throwing.
 *
 * @param reader - Structural interface for reading resolved predictions
 * @param principleIds - Optional filter; when provided, only these principles are included
 * @returns AccuracyMap keyed by principle_id
 */
export function computeAccuracy(reader: PredictionReader, principleIds?: string[]): AccuracyMap {
  const predictions = reader.getResolvedPredictions(principleIds);
  const tallies = new Map<string, AccuracyTally>();
  const filterSet = principleIds ? new Set(principleIds) : undefined;

  for (const prediction of predictions) {
    const pairs = parseOutcome(prediction.outcome);
    for (const pair of pairs) {
      if (filterSet && !filterSet.has(pair.principle_id)) continue;
      applyPairToTally(tallies, pair);
    }
  }

  const result: AccuracyMap = new Map();
  for (const [principleId, tally] of tallies) {
    result.set(principleId, finalizeAccuracy(principleId, tally));
  }
  return result;
}

/**
 * Determine whether a principle's signal should be pruned from injection.
 *
 * Returns true when:
 * - precision is strictly below PRUNE_PRECISION (20%)
 * - AND sample_size is at or above MIN_SAMPLE_SIZE (10)
 *
 * Returns false when sample_size is insufficient — not enough data to prune.
 */
export function shouldPrune(accuracy: PrincipleAccuracy): boolean {
  if (accuracy.sample_size < ACCURACY_THRESHOLDS.MIN_SAMPLE_SIZE) return false;
  return accuracy.precision < ACCURACY_THRESHOLDS.PRUNE_PRECISION;
}

/**
 * Return the priority multiplier for a principle's signal weight.
 *
 * Multipliers:
 * - 1.5 (BOOST) when precision >= HIGH_PRECISION (70%)
 * - 0.5 (DAMPEN) when precision < LOW_PRECISION (40%)
 * - 1.0 (neutral) for medium precision (40%–69%) or insufficient samples
 *
 * Returns 1.0 when sample_size < MIN_SAMPLE_SIZE — not enough data to adjust.
 */
export function getPriorityMultiplier(accuracy: PrincipleAccuracy): number {
  if (accuracy.sample_size < ACCURACY_THRESHOLDS.MIN_SAMPLE_SIZE) return 1.0;

  if (accuracy.precision >= ACCURACY_THRESHOLDS.HIGH_PRECISION) {
    return ACCURACY_THRESHOLDS.BOOST_MULTIPLIER;
  }
  if (accuracy.precision < ACCURACY_THRESHOLDS.LOW_PRECISION) {
    return ACCURACY_THRESHOLDS.DAMPEN_MULTIPLIER;
  }
  return 1.0;
}

/** Format a single PrincipleAccuracy as a bullet line with precision stats. */
function formatAccuracyLine(acc: PrincipleAccuracy): string {
  return `- ${acc.principle_id}: precision=${(acc.precision * 100).toFixed(1)}% (${acc.true_positives} TP, ${acc.false_positives} FP, n=${acc.sample_size})`;
}

/** Append a section heading + lines to the output if the group is non-empty. */
function appendSection(
  lines: string[],
  heading: string,
  items: PrincipleAccuracy[],
  format: (acc: PrincipleAccuracy) => string,
): void {
  if (items.length === 0) return;
  lines.push(`\n${heading}`);
  for (const acc of items) {
    lines.push(format(acc));
  }
}

/** Classify one accuracy entry into the appropriate bucket. */
function classifyAccuracy(
  acc: PrincipleAccuracy,
  buckets: {
    pruned: PrincipleAccuracy[];
    low: PrincipleAccuracy[];
    high: PrincipleAccuracy[];
    insufficient: PrincipleAccuracy[];
  },
): void {
  if (acc.sample_size < ACCURACY_THRESHOLDS.MIN_SAMPLE_SIZE) {
    buckets.insufficient.push(acc);
  } else if (shouldPrune(acc)) {
    buckets.pruned.push(acc);
  } else if (acc.precision >= ACCURACY_THRESHOLDS.HIGH_PRECISION) {
    buckets.high.push(acc);
  } else if (acc.precision < ACCURACY_THRESHOLDS.LOW_PRECISION) {
    buckets.low.push(acc);
  }
}

/**
 * Build a human-readable accuracy summary for learner context injection.
 *
 * Returns undefined when the map is empty — no summary to produce.
 * Groups principles into three sections: pruned, low-precision, high-precision.
 * Only includes principles with MIN_SAMPLE_SIZE+ samples in the summary sections.
 */
export function buildAccuracySummary(accuracyMap: AccuracyMap): string | undefined {
  if (accuracyMap.size === 0) return undefined;

  const buckets = {
    high: [] as PrincipleAccuracy[],
    insufficient: [] as PrincipleAccuracy[],
    low: [] as PrincipleAccuracy[],
    pruned: [] as PrincipleAccuracy[],
  };
  for (const acc of accuracyMap.values()) {
    classifyAccuracy(acc, buckets);
  }

  const lines: string[] = ["## Prediction Accuracy Summary"];
  appendSection(
    lines,
    "### Prunable Signals (precision < 20%, 10+ samples)",
    buckets.pruned,
    formatAccuracyLine,
  );
  appendSection(
    lines,
    "### Low Precision Signals (precision 20%–39%, weight dampened 0.5×)",
    buckets.low,
    formatAccuracyLine,
  );
  appendSection(
    lines,
    "### High Precision Signals (precision >= 70%, weight boosted 1.5×)",
    buckets.high,
    formatAccuracyLine,
  );
  appendSection(
    lines,
    "### Insufficient Data (< 10 samples, no adjustment)",
    buckets.insufficient,
    (acc) => `- ${acc.principle_id}: n=${acc.sample_size}`,
  );

  return lines.join("\n");
}
