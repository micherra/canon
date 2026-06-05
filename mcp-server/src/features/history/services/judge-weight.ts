/**
 * judge-weight — Pure outcome→promotion-weight function.
 *
 * Maps review outcome signals to a soft weight around neutral (1.0).
 * Used by the cross-run analyzer to weight pattern instance counts
 * so promotion readiness reflects build quality, not raw count.
 *
 * Design mirrors confidence-scorer.ts: pure computeOutcomeWeight + IO-free input.
 * All I/O lives at the analyzer edge (summaryToOutcomeSignals).
 *
 * measure-before-optimizing: every sub-weight cites the data source it reads.
 * validate-at-trust-boundaries: all input fields are optional/untrusted;
 *   non-finite numbers fall back to neutral; no throw on partial data.
 */

// ---- Signal type ----

/** Outcome signals for a single build instance, all fields optional/untrusted. */
export type OutcomeSignals = {
  /** Review verdict string, e.g. "clean" | "approve" | "warning" | "blocking".
   *  Source: RunSummary.review_results[].verdict or FlowRunEntry.review_verdict.
   *  Normalized case-insensitively; unknown strings → neutral sub-weight. */
  review_verdict?: string;
  /** Total fix-mode iterations for the build.
   *  Source: FlowRunEntry.state_iterations (fix-mode state counts).
   *  0 or absent → no penalty. Higher values → lower sub-weight. */
  fix_iterations?: number;
  /** Fraction of tests passing in the verify step (0..1).
   *  Source: FlowRunEntry.total_test_results (passed / total).
   *  Absent or non-finite → neutral sub-weight. */
  test_pass_rate?: number;
};

// ---- Tunable constants ----

/** Neutral weight — no signal or all-neutral signals produce exactly this value. */
export const NEUTRAL_WEIGHT = 1.0;

/** Minimum weight; never 0 to avoid zero-out of accumulated instances. */
export const WEIGHT_FLOOR = 0.4;

/** Maximum weight; prevents single high-quality build from dominating. */
export const WEIGHT_CEIL = 1.2;

/**
 * Verdict → sub-weight multiplier.
 * clean/approve builds get a mild uplift; blocking gets a penalty;
 * warning stays near neutral.
 *
 * Source: RunSummary.review_results[].verdict normalized to lowercase.
 */
const VERDICT_WEIGHTS: Record<string, number> = {
  approve: 1.15,
  blocking: 0.65,
  clean: 1.15,
  warning: 0.9,
};

/**
 * Fix iteration falloff: each iteration reduces the sub-weight by this fraction.
 * Sub-weight = max(WEIGHT_FLOOR, 1.0 - fix_iterations * FIX_ITERATION_FALLOFF).
 *
 * Source: FlowRunEntry.state_iterations (sum of extra iterations in fix-mode states).
 */
const FIX_ITERATION_FALLOFF = 0.1;

/**
 * Test pass-rate mapping bounds:
 *   FLOOR: pass-rate ≤ this → minimum test sub-weight (0.8).
 *   CEIL:  pass-rate ≥ this → maximum test sub-weight (1.1).
 *
 * Sub-weight is linearly interpolated between bounds.
 * Source: FlowRunEntry.total_test_results (passed / (passed + failed + skipped)).
 */
const TEST_PASS_FLOOR_RATE = 0.5; // rates at or below this → 0.8 sub-weight
const TEST_PASS_CEIL_RATE = 0.95; // rates at or above this → 1.1 sub-weight
const TEST_PASS_WEIGHT_MIN = 0.8;
const TEST_PASS_WEIGHT_MAX = 1.1;

// ---- Sub-weight helpers ----

/**
 * Compute verdict sub-weight.
 * Normalizes the verdict string case-insensitively. Unknown strings → 1.0.
 * Absent (undefined) → 1.0.
 */
function verdictSubWeight(verdict: string | undefined): number {
  if (verdict === undefined) return NEUTRAL_WEIGHT;
  const key = verdict.toLowerCase().trim();
  return VERDICT_WEIGHTS[key] ?? NEUTRAL_WEIGHT;
}

/**
 * Compute fix-iteration sub-weight.
 * Each fix iteration applies a proportional penalty.
 * Non-finite or negative values → 1.0 (neutral, no throw).
 * Source: FlowRunEntry.state_iterations for fix-mode states.
 */
function fixIterationSubWeight(iterations: number | undefined): number {
  if (iterations === undefined) return NEUTRAL_WEIGHT;
  if (!Number.isFinite(iterations) || iterations < 0) return NEUTRAL_WEIGHT;
  const raw = 1.0 - iterations * FIX_ITERATION_FALLOFF;
  return Math.max(WEIGHT_FLOOR, raw);
}

/**
 * Compute test-pass-rate sub-weight via linear interpolation between
 * TEST_PASS_FLOOR_RATE → TEST_PASS_WEIGHT_MIN and
 * TEST_PASS_CEIL_RATE  → TEST_PASS_WEIGHT_MAX.
 * Non-finite, out-of-[0,1] (after clamping at 0-1), or absent → 1.0.
 * Source: FlowRunEntry.total_test_results.
 */
function testPassRateSubWeight(passRate: number | undefined): number {
  if (passRate === undefined) return NEUTRAL_WEIGHT;
  if (!Number.isFinite(passRate)) return NEUTRAL_WEIGHT;
  // Clamp to valid range [0, 1]
  const rate = Math.max(0, Math.min(1, passRate));
  if (rate >= TEST_PASS_CEIL_RATE) return TEST_PASS_WEIGHT_MAX;
  if (rate <= TEST_PASS_FLOOR_RATE) return TEST_PASS_WEIGHT_MIN;
  // Linear interpolation
  const t = (rate - TEST_PASS_FLOOR_RATE) / (TEST_PASS_CEIL_RATE - TEST_PASS_FLOOR_RATE);
  return TEST_PASS_WEIGHT_MIN + t * (TEST_PASS_WEIGHT_MAX - TEST_PASS_WEIGHT_MIN);
}

// ---- Public pure function ----

/**
 * Compute the promotion weight for a single build instance from outcome signals.
 *
 * Returns a weight around neutral 1.0:
 *   - CLEAN/approve + 0 fixes + high pass-rate → weight > 1.0 (up to WEIGHT_CEIL).
 *   - BLOCKING + high fix iterations + low pass-rate → weight < 1.0 (down to WEIGHT_FLOOR).
 *   - All signals absent → exactly NEUTRAL_WEIGHT (1.0).
 *
 * Pure function: no I/O, no Date.now(), no side effects.
 *
 * @param signals - OutcomeSignals object with all fields optional/untrusted.
 */
export function computeOutcomeWeight(signals: OutcomeSignals): number {
  const { fix_iterations, review_verdict, test_pass_rate } = signals;

  const vw = verdictSubWeight(review_verdict);
  const fw = fixIterationSubWeight(fix_iterations);
  const tw = testPassRateSubWeight(test_pass_rate);

  const product = vw * fw * tw;
  return Math.max(WEIGHT_FLOOR, Math.min(WEIGHT_CEIL, product));
}
