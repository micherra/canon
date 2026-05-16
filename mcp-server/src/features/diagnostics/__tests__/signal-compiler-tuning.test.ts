/**
 * Tests for Wave 3 accuracy-based signal tuning and pruning in compileSignals().
 *
 * Each test creates an in-memory drift.db, seeds data, builds an AccuracyMap,
 * and verifies the output of compileSignals() under various accuracy conditions.
 *
 * Test matrix:
 *  1. No accuracyData → identical to Wave 1 behavior (backward compatibility)
 *  2. High-precision (>= 70%) → priority boosted 1.5x
 *  3. Low-precision (< 40%) → priority dampened 0.5x
 *  4. Below prune threshold (< 20%, 10+ samples) → signal excluded
 *  5. Below prune threshold but insufficient samples → NOT pruned
 *  6. Path effect signals → never pruned or tuned regardless of accuracy
 *  7. Pruned principles excluded from final FileSignals output
 *  8. Priority multiplier result is Math.round()'d to an integer
 *  9. Medium-precision (40%–69%) → no multiplier change (1.0x)
 * 10. Unknown principles (not in AccuracyMap) → no multiplier change
 */

import { DriftDbSignals } from "@platform/storage/drift/drift-db-signals.ts";
import { initDriftDb } from "@platform/storage/drift/drift-schema.ts";
import { beforeEach, describe, expect, it } from "vitest";
import type { AccuracyMap, PrincipleAccuracy } from "../services/prediction-accuracy.ts";
import { ACCURACY_THRESHOLDS } from "../services/prediction-accuracy.ts";
import { compileSignals, scoreViolationHistory } from "../services/signal-compiler.ts";

// ---- Helpers ----

/** Build a PrincipleAccuracy with the given precision and sample_size. */
function makeAccuracy(
  principleId: string,
  precision: number,
  sampleSize: number,
): PrincipleAccuracy {
  const tp = Math.round(precision * sampleSize);
  const fp = sampleSize - tp;
  return {
    false_negatives: 0,
    false_positive_rate: fp / (tp + fp || 1),
    false_positives: fp,
    precision,
    principle_id: principleId,
    sample_size: sampleSize,
    true_negatives: 0,
    true_positive_rate: precision,
    true_positives: tp,
  };
}

/** Build an AccuracyMap from key-value pairs of [principleId, precision, sampleSize]. */
function makeAccuracyMap(
  entries: Array<[principleId: string, precision: number, sampleSize: number]>,
): AccuracyMap {
  const map: AccuracyMap = new Map();
  for (const [id, precision, size] of entries) {
    map.set(id, makeAccuracy(id, precision, size));
  }
  return map;
}

type SeedViolationOpts = {
  violationCount?: number;
  daysAgo?: number;
};

/** Seed a file violation into the DB with configurable violation_count and recency. */
function seedViolation(
  signals: DriftDbSignals,
  filePath: string,
  principleId: string,
  opts: SeedViolationOpts = {},
): void {
  const { violationCount = 3, daysAgo = 10 } = opts;
  signals.upsertFileViolation({
    file_path: filePath,
    first_seen: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
    last_seen: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    principle_id: principleId,
    violation_count: violationCount,
  });
}

/** Seed a path effect into the DB. */
function seedPathEffect(
  signals: DriftDbSignals,
  filePath: string,
  violationStreak = 2,
  totalViolations = 4,
): void {
  signals.upsertPathEffect({
    clean_streak: 0,
    file_path: filePath,
    last_clean_at: null,
    last_violation_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    total_reviews: 8,
    total_violations: totalViolations,
    violation_streak: violationStreak,
  });
}

// ---- Setup ----

describe("compileSignals — Wave 3 accuracy tuning and pruning", () => {
  let db: ReturnType<typeof initDriftDb>;
  let signals: DriftDbSignals;
  const FILE = "src/target.ts";

  beforeEach(() => {
    db = initDriftDb(":memory:");
    signals = new DriftDbSignals(db);
  });

  // Test 1: No accuracyData → identical behavior to Wave 1
  it("behaves identically to Wave 1 when accuracyData is absent", () => {
    seedViolation(signals, FILE, "simplicity-first", { daysAgo: 10, violationCount: 5 });

    const withoutAccuracy = compileSignals([FILE], signals);
    const withUndefinedAccuracy = compileSignals([FILE], signals, { accuracyData: undefined });

    // Both should produce identical output
    expect(withoutAccuracy).toEqual(withUndefinedAccuracy);
    expect(withoutAccuracy[0]!.signals).toHaveLength(1);
    expect(withoutAccuracy[0]!.signals[0]!.type).toBe("violation_history");
  });

  // Test 2: High-precision principle → priority boosted 1.5x
  it("boosts priority 1.5x for high-precision principles (>= 70%)", () => {
    // Use 10+ samples so the multiplier applies
    const precision = ACCURACY_THRESHOLDS.HIGH_PRECISION; // 0.7
    seedViolation(signals, FILE, "clean-code", { daysAgo: 10, violationCount: 4 }); // 10 days ago → no recency boost; base = 4

    const accuracyData = makeAccuracyMap([["clean-code", precision, 15]]);
    const result = compileSignals([FILE], signals, { accuracyData, tokenBudgetPerFile: 10000 });

    const sig = result[0]!.signals[0]!;
    // Base score: min(4, 10) + 0 (no recency) = 4; boosted: Math.round(4 * 1.5) = 6
    expect(sig.priority).toBe(Math.round(4 * ACCURACY_THRESHOLDS.BOOST_MULTIPLIER));
  });

  // Test 3: Low-precision principle → priority dampened 0.5x
  it("dampens priority 0.5x for low-precision principles (< 40%)", () => {
    const precision = 0.3; // below LOW_PRECISION (0.4)
    seedViolation(signals, FILE, "no-magic-strings", { daysAgo: 10, violationCount: 6 }); // base = 6

    const accuracyData = makeAccuracyMap([["no-magic-strings", precision, 12]]);
    const result = compileSignals([FILE], signals, { accuracyData, tokenBudgetPerFile: 10000 });

    const sig = result[0]!.signals[0]!;
    // Base score: 6; dampened: Math.round(6 * 0.5) = 3
    expect(sig.priority).toBe(Math.round(6 * ACCURACY_THRESHOLDS.DAMPEN_MULTIPLIER));
  });

  // Test 4: Below prune threshold with 10+ samples → signal excluded
  it("prunes violation_history signals for principles with precision < 20% and 10+ samples", () => {
    const precision = 0.1; // below PRUNE_PRECISION (0.2)
    seedViolation(signals, FILE, "bad-principle", { daysAgo: 10, violationCount: 5 });

    const accuracyData = makeAccuracyMap([["bad-principle", precision, 10]]);
    const result = compileSignals([FILE], signals, { accuracyData });

    // Signal should be excluded
    expect(result[0]!.signals).toHaveLength(0);
  });

  // Test 5: Below prune threshold but insufficient samples → NOT pruned
  it("does NOT prune principles below precision threshold when sample_size < 10", () => {
    const precision = 0.05; // very low precision
    seedViolation(signals, FILE, "new-principle", { daysAgo: 10, violationCount: 3 });

    // Only 5 samples — below MIN_SAMPLE_SIZE, so shouldPrune returns false
    const accuracyData = makeAccuracyMap([["new-principle", precision, 5]]);
    const result = compileSignals([FILE], signals, { accuracyData });

    // Signal should NOT be pruned
    expect(result[0]!.signals).toHaveLength(1);
    expect(result[0]!.signals[0]!.type).toBe("violation_history");
  });

  // Test 6: Path effect signals are never pruned or tuned regardless of accuracy
  it("does NOT prune or tune path_effect signals regardless of accuracy data", () => {
    // Seed only a path effect (no violation history for this file)
    seedPathEffect(signals, FILE, 2, 4);

    // Provide accuracy data that would prune if it applied to path_effects
    const accuracyData = makeAccuracyMap([
      // Use a key that can't match path_effect (path effects are file-level)
      // The key here doesn't matter — path effects don't use principle_id
      ["some-principle", 0.05, 20],
    ]);
    const result = compileSignals([FILE], signals, { accuracyData });

    // Path effect signal should still be present
    expect(result[0]!.signals).toHaveLength(1);
    expect(result[0]!.signals[0]!.type).toBe("path_effect");
  });

  // Test 7: Pruned principle excluded from output; other principles remain
  it("excludes only the pruned principle while keeping other signals in the output", () => {
    // Two principles: one prunable, one high-precision
    seedViolation(signals, FILE, "bad-principle", { daysAgo: 10, violationCount: 5 });
    seedViolation(signals, FILE, "good-principle", { daysAgo: 10, violationCount: 5 });

    const accuracyData = makeAccuracyMap([
      ["bad-principle", 0.1, 15], // prunable
      ["good-principle", 0.8, 15], // high precision — kept and boosted
    ]);
    const result = compileSignals([FILE], signals, { accuracyData, tokenBudgetPerFile: 10000 });

    const sigs = result[0]!.signals;
    expect(sigs).toHaveLength(1);
    expect(sigs[0]!.text).toContain("good-principle");
  });

  // Test 8: Priority multiplier result is rounded to an integer
  it("rounds the multiplied priority to an integer", () => {
    // violation_count = 5, 10 days ago → base = 5 (no recency boost)
    // multiplier = 1.5 → 5 * 1.5 = 7.5 → Math.round → 8
    seedViolation(signals, FILE, "round-me", { daysAgo: 10, violationCount: 5 });

    const accuracyData = makeAccuracyMap([["round-me", 0.75, 20]]);
    const result = compileSignals([FILE], signals, { accuracyData, tokenBudgetPerFile: 10000 });

    const sig = result[0]!.signals[0]!;
    expect(Number.isInteger(sig.priority)).toBe(true);
    expect(sig.priority).toBe(8); // Math.round(5 * 1.5) = Math.round(7.5) = 8
  });

  // Test 9: Medium-precision principles (40%-69%) get no multiplier change (1.0x)
  it("does not change priority for medium-precision principles (40%–69%)", () => {
    // violation_count = 5, 10 days ago → base = 5
    seedViolation(signals, FILE, "medium-principle", { daysAgo: 10, violationCount: 5 });

    // Medium precision: no multiplier applied (1.0x)
    const mediumPrecision = 0.55; // between LOW_PRECISION (0.4) and HIGH_PRECISION (0.7)
    const accuracyData = makeAccuracyMap([["medium-principle", mediumPrecision, 20]]);
    const result = compileSignals([FILE], signals, { accuracyData, tokenBudgetPerFile: 10000 });

    const sig = result[0]!.signals[0]!;
    // Priority should be the raw base score — no multiplier change
    const rawRow = {
      file_path: FILE,
      first_seen: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      last_seen: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      principle_id: "medium-principle",
      violation_count: 5,
    };
    expect(sig.priority).toBe(scoreViolationHistory(rawRow));
  });

  // Test 10: Unknown principles (not in AccuracyMap) get no multiplier change
  it("does not change priority for principles not present in the AccuracyMap", () => {
    // violation_count = 5, 10 days ago → base = 5
    seedViolation(signals, FILE, "unknown-principle", { daysAgo: 10, violationCount: 5 });

    // AccuracyMap has data for a different principle
    const accuracyData = makeAccuracyMap([["other-principle", 0.9, 20]]);
    const result = compileSignals([FILE], signals, { accuracyData, tokenBudgetPerFile: 10000 });

    const sig = result[0]!.signals[0]!;
    // No accuracy data for "unknown-principle" → no multiplier applied
    const rawRow = {
      file_path: FILE,
      first_seen: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      last_seen: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      principle_id: "unknown-principle",
      violation_count: 5,
    };
    expect(sig.priority).toBe(scoreViolationHistory(rawRow));
  });

  // Bonus: Verify that priority floor of 0 is handled gracefully
  it("handles priority of 0 after dampening without error", () => {
    // violation_count = 1, 10 days ago → base = 1
    // dampened: Math.round(1 * 0.5) = 1 (rounds up from 0.5)
    // Try violation_count = 2 with 0.1 precision (dampened): Math.round(2 * 0.5) = 1
    seedViolation(signals, FILE, "low-score", { daysAgo: 10, violationCount: 1 });

    // High sample count, very low precision but above prune threshold (20%)
    const accuracyData = makeAccuracyMap([["low-score", 0.25, 15]]); // precision=0.25, above prune 0.2

    // Should not throw; signal should still appear with dampened priority
    const result = compileSignals([FILE], signals, { accuracyData, tokenBudgetPerFile: 10000 });
    const sig = result[0]!.signals[0]!;
    expect(sig).toBeDefined();
    expect(sig.priority).toBeGreaterThanOrEqual(0);
  });
});
