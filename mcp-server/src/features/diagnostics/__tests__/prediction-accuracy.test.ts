/**
 * Tests for prediction-accuracy.ts — TDD, red-green-refactor
 *
 * The service is pure computation: no DB access, no LLM calls.
 * All tests use in-memory readers constructed with stub data.
 *
 * Outcome JSON format (from reconcilePredictions in prediction-tracker.ts):
 *   { pairs: Array<{ file_path, principle_id, predicted, actual }> }
 *
 * TP = predicted: true AND actual: true
 * FP = predicted: true AND actual: false
 * TN = predicted: false AND actual: false (not currently tracked — always FP or TP)
 * FN = predicted: false AND actual: true (not applicable — only predicted pairs stored)
 */

import { describe, expect, it } from "vitest";
import type { PredictionReader, PrincipleAccuracy } from "../services/prediction-accuracy.ts";
import {
  ACCURACY_THRESHOLDS,
  buildAccuracySummary,
  computeAccuracy,
  getPriorityMultiplier,
  shouldPrune,
} from "../services/prediction-accuracy.ts";

// ---- Helpers ----

/** Build a minimal resolved prediction row. */
function makeResolvedPrediction(
  predictionId: string,
  principleIds: string[],
  filePaths: string[],
  pairs: Array<{ file_path: string; principle_id: string; predicted: boolean; actual: boolean }>,
): {
  prediction_id: string;
  outcome: string | null;
  principle_ids: string;
  file_paths: string;
  resolved: number;
  resolved_at: string | null;
} {
  return {
    file_paths: JSON.stringify(filePaths),
    outcome: JSON.stringify({ pairs }),
    prediction_id: predictionId,
    principle_ids: JSON.stringify(principleIds),
    resolved: 1,
    resolved_at: "2026-05-01T12:00:00Z",
  };
}

/** A PredictionReader backed by a fixed array. */
function makeReader(
  rows: ReturnType<typeof makeResolvedPrediction>[],
  filterPrincipleIds?: string[],
): PredictionReader {
  return {
    getResolvedPredictions(principleIds?: string[]) {
      const ids = principleIds ?? filterPrincipleIds;
      if (!ids) return rows;
      return rows.filter((r) => {
        const pids = JSON.parse(r.principle_ids) as string[];
        return pids.some((pid) => ids.includes(pid));
      });
    },
  };
}

/** Build a PrincipleAccuracy with given counts. */
function makeAccuracy(
  principleId: string,
  tp: number,
  fp: number,
  sampleSize: number,
): PrincipleAccuracy {
  const denom = tp + fp;
  const precision = denom > 0 ? tp / denom : 0;
  const fpr = denom > 0 ? fp / denom : 0;
  return {
    false_negatives: 0,
    false_positive_rate: fpr,
    false_positives: fp,
    precision,
    principle_id: principleId,
    sample_size: sampleSize,
    true_negatives: 0,
    true_positive_rate: denom > 0 ? tp / denom : 0,
    true_positives: tp,
  };
}

// ---- Test 1: empty map when no resolved predictions ----

describe("computeAccuracy — empty cases", () => {
  it("returns empty map when no resolved predictions", () => {
    const reader = makeReader([]);
    const result = computeAccuracy(reader);
    expect(result.size).toBe(0);
  });

  it("returns empty map when reader returns empty array for given principleIds filter", () => {
    const reader = makeReader([]);
    const result = computeAccuracy(reader, ["some-principle"]);
    expect(result.size).toBe(0);
  });
});

// ---- Test 2: correctly tallies TP and FP ----

describe("computeAccuracy — TP/FP tallying", () => {
  it("correctly tallies TP and FP from prediction outcomes", () => {
    const prediction = makeResolvedPrediction(
      "pred_001",
      ["principle-a"],
      ["src/foo.ts"],
      [
        { actual: true, file_path: "src/foo.ts", predicted: true, principle_id: "principle-a" }, // TP
        { actual: false, file_path: "src/foo.ts", predicted: true, principle_id: "principle-a" }, // FP
        { actual: true, file_path: "src/foo.ts", predicted: true, principle_id: "principle-a" }, // TP
      ],
    );

    const reader = makeReader([prediction]);
    const result = computeAccuracy(reader);

    expect(result.has("principle-a")).toBe(true);
    const acc = result.get("principle-a")!;
    expect(acc.true_positives).toBe(2);
    expect(acc.false_positives).toBe(1);
  });

  it("only counts predicted=true pairs (ignores predicted=false rows)", () => {
    const prediction = makeResolvedPrediction(
      "pred_002",
      ["principle-b"],
      ["src/bar.ts"],
      [
        { actual: true, file_path: "src/bar.ts", predicted: true, principle_id: "principle-b" }, // TP
        { actual: true, file_path: "src/bar.ts", predicted: false, principle_id: "principle-b" }, // FN — should not affect TP count
        { actual: false, file_path: "src/bar.ts", predicted: false, principle_id: "principle-b" }, // TN — should not affect FP count
      ],
    );

    const reader = makeReader([prediction]);
    const result = computeAccuracy(reader);

    const acc = result.get("principle-b")!;
    expect(acc.true_positives).toBe(1);
    expect(acc.false_positives).toBe(0);
  });
});

// ---- Test 3: precision computation ----

describe("computeAccuracy — precision", () => {
  it("computes precision = TP / (TP + FP) correctly", () => {
    const prediction = makeResolvedPrediction(
      "pred_003",
      ["principle-c"],
      ["src/c.ts"],
      [
        { actual: true, file_path: "src/c.ts", predicted: true, principle_id: "principle-c" }, // TP
        { actual: true, file_path: "src/c.ts", predicted: true, principle_id: "principle-c" }, // TP
        { actual: true, file_path: "src/c.ts", predicted: true, principle_id: "principle-c" }, // TP
        { actual: false, file_path: "src/c.ts", predicted: true, principle_id: "principle-c" }, // FP
      ],
    );

    const reader = makeReader([prediction]);
    const result = computeAccuracy(reader);

    const acc = result.get("principle-c")!;
    expect(acc.precision).toBeCloseTo(0.75); // 3/(3+1)
  });

  it("computes precision as 0 when TP + FP = 0 (no predicted=true pairs)", () => {
    const prediction = makeResolvedPrediction(
      "pred_004",
      ["principle-d"],
      ["src/d.ts"],
      [
        { actual: false, file_path: "src/d.ts", predicted: false, principle_id: "principle-d" }, // TN only
      ],
    );

    const reader = makeReader([prediction]);
    const result = computeAccuracy(reader);

    // principle-d may not appear in map if no predicted=true pairs — or precision=0
    if (result.has("principle-d")) {
      const acc = result.get("principle-d")!;
      expect(acc.precision).toBe(0);
      expect(acc.true_positives).toBe(0);
      expect(acc.false_positives).toBe(0);
    }
    // Alternatively, the principle may simply not appear in the map at all
    // (no predicted=true pairs = nothing to score). Both behaviors are acceptable.
  });
});

// ---- Test 4: multiple principles in same prediction ----

describe("computeAccuracy — multiple principles", () => {
  it("handles multiple principles in the same prediction", () => {
    const prediction = makeResolvedPrediction(
      "pred_005",
      ["principle-x", "principle-y"],
      ["src/x.ts"],
      [
        { actual: true, file_path: "src/x.ts", predicted: true, principle_id: "principle-x" }, // TP for x
        { actual: false, file_path: "src/x.ts", predicted: true, principle_id: "principle-x" }, // FP for x
        { actual: true, file_path: "src/x.ts", predicted: true, principle_id: "principle-y" }, // TP for y
        { actual: true, file_path: "src/x.ts", predicted: true, principle_id: "principle-y" }, // TP for y
      ],
    );

    const reader = makeReader([prediction]);
    const result = computeAccuracy(reader);

    expect(result.has("principle-x")).toBe(true);
    expect(result.has("principle-y")).toBe(true);

    const accX = result.get("principle-x")!;
    expect(accX.true_positives).toBe(1);
    expect(accX.false_positives).toBe(1);
    expect(accX.precision).toBeCloseTo(0.5);

    const accY = result.get("principle-y")!;
    expect(accY.true_positives).toBe(2);
    expect(accY.false_positives).toBe(0);
    expect(accY.precision).toBe(1.0);
  });

  it("accumulates counts across multiple predictions for the same principle", () => {
    const pred1 = makeResolvedPrediction(
      "pred_multi_1",
      ["principle-shared"],
      ["src/a.ts"],
      [
        { actual: true, file_path: "src/a.ts", predicted: true, principle_id: "principle-shared" }, // TP
        { actual: false, file_path: "src/a.ts", predicted: true, principle_id: "principle-shared" }, // FP
      ],
    );
    const pred2 = makeResolvedPrediction(
      "pred_multi_2",
      ["principle-shared"],
      ["src/b.ts"],
      [
        { actual: true, file_path: "src/b.ts", predicted: true, principle_id: "principle-shared" }, // TP
        { actual: true, file_path: "src/b.ts", predicted: true, principle_id: "principle-shared" }, // TP
      ],
    );

    const reader = makeReader([pred1, pred2]);
    const result = computeAccuracy(reader);

    const acc = result.get("principle-shared")!;
    expect(acc.true_positives).toBe(3); // 1 + 2
    expect(acc.false_positives).toBe(1);
    expect(acc.precision).toBeCloseTo(0.75); // 3/4
  });
});

// ---- Test 5: malformed outcome JSON ----

describe("computeAccuracy — malformed/null outcome", () => {
  it("skips predictions with malformed outcome JSON", () => {
    const row = {
      file_paths: JSON.stringify(["src/bad.ts"]),
      outcome: "{ this is not valid json !!!",
      prediction_id: "pred_bad_json",
      principle_ids: JSON.stringify(["principle-z"]),
      resolved: 1,
      resolved_at: "2026-05-01T00:00:00Z",
    };

    const reader: PredictionReader = {
      getResolvedPredictions: () => [row],
    };

    const result = computeAccuracy(reader);
    // Malformed JSON means the prediction is skipped — no entry for principle-z
    expect(result.size).toBe(0);
  });

  // ---- Test 6: null outcome ----

  it("skips predictions with null outcome", () => {
    const row = {
      file_paths: JSON.stringify(["src/null.ts"]),
      outcome: null,
      prediction_id: "pred_null_outcome",
      principle_ids: JSON.stringify(["principle-null"]),
      resolved: 1,
      resolved_at: "2026-05-01T00:00:00Z",
    };

    const reader: PredictionReader = {
      getResolvedPredictions: () => [row],
    };

    const result = computeAccuracy(reader);
    expect(result.size).toBe(0);
  });
});

// ---- Test 7–9: shouldPrune ----

describe("shouldPrune", () => {
  it("returns false when sample_size < MIN_SAMPLE_SIZE (10)", () => {
    const acc = makeAccuracy("principle-prune", 0, 3, 9); // low precision but insufficient samples
    expect(shouldPrune(acc)).toBe(false);
  });

  it("returns true when precision < 20% with 10+ samples", () => {
    // precision = 1/10 = 0.10 (below PRUNE_PRECISION 0.20)
    const acc = makeAccuracy("principle-prune", 1, 9, 10); // 1 TP, 9 FP → precision 0.10
    expect(shouldPrune(acc)).toBe(true);
  });

  it("returns false when precision >= 20%", () => {
    // precision = 3/10 = 0.30 (at or above PRUNE_PRECISION 0.20)
    const acc = makeAccuracy("principle-prune", 3, 7, 10);
    expect(shouldPrune(acc)).toBe(false);
  });

  it("returns false at exactly MIN_SAMPLE_SIZE - 1 samples regardless of precision", () => {
    const acc = makeAccuracy("principle-edge", 0, 9, 9); // precision=0, samples=9
    expect(shouldPrune(acc)).toBe(false);
  });

  it("returns false when precision is exactly 20%", () => {
    // precision = 2/10 = 0.20 — exactly at threshold, should NOT prune
    const acc = makeAccuracy("principle-exact", 2, 8, 10);
    expect(shouldPrune(acc)).toBe(false);
  });
});

// ---- Test 10–13: getPriorityMultiplier ----

describe("getPriorityMultiplier", () => {
  it("returns 1.0 when sample_size is below MIN_SAMPLE_SIZE", () => {
    const acc = makeAccuracy("principle-m", 9, 0, 9); // high precision but below threshold
    expect(getPriorityMultiplier(acc)).toBe(1.0);
  });

  it("returns BOOST_MULTIPLIER (1.5) for high precision (>= 70%)", () => {
    // precision = 7/10 = 0.70 — exactly at threshold
    const acc = makeAccuracy("principle-high", 7, 3, 10);
    expect(getPriorityMultiplier(acc)).toBe(ACCURACY_THRESHOLDS.BOOST_MULTIPLIER);
  });

  it("returns DAMPEN_MULTIPLIER (0.5) for low precision (< 40%)", () => {
    // precision = 3/10 = 0.30 — below LOW_PRECISION 0.40
    const acc = makeAccuracy("principle-low", 3, 7, 10);
    expect(getPriorityMultiplier(acc)).toBe(ACCURACY_THRESHOLDS.DAMPEN_MULTIPLIER);
  });

  it("returns 1.0 for medium precision (40% - 69%)", () => {
    // precision = 5/10 = 0.50 — between thresholds
    const acc = makeAccuracy("principle-mid", 5, 5, 10);
    expect(getPriorityMultiplier(acc)).toBe(1.0);
  });

  it("returns 1.0 at exactly LOW_PRECISION (40%)", () => {
    // precision = 4/10 = 0.40 — exactly at LOW_PRECISION threshold (not below)
    const acc = makeAccuracy("principle-edge-low", 4, 6, 10);
    expect(getPriorityMultiplier(acc)).toBe(1.0);
  });
});

// ---- Test 14–15: buildAccuracySummary ----

describe("buildAccuracySummary", () => {
  it("returns undefined when map is empty", () => {
    const result = buildAccuracySummary(new Map());
    expect(result).toBeUndefined();
  });

  it("categorizes principles into pruned/low/high sections", () => {
    const map = new Map<string, PrincipleAccuracy>();

    // Pruned: precision < 20%, sample >= 10
    const prunedAcc = makeAccuracy("principle-to-prune", 1, 9, 10); // precision=0.10
    map.set("principle-to-prune", prunedAcc);

    // Low precision: precision < 40%, sample >= 10
    const lowAcc = makeAccuracy("principle-low-prec", 3, 7, 10); // precision=0.30
    map.set("principle-low-prec", lowAcc);

    // High precision: precision >= 70%, sample >= 10
    const highAcc = makeAccuracy("principle-high-prec", 8, 2, 10); // precision=0.80
    map.set("principle-high-prec", highAcc);

    const summary = buildAccuracySummary(map);
    expect(summary).toBeDefined();
    expect(typeof summary).toBe("string");

    // Should mention all three principles
    expect(summary).toContain("principle-to-prune");
    expect(summary).toContain("principle-low-prec");
    expect(summary).toContain("principle-high-prec");
  });

  it("returns a non-empty string when map has at least one entry", () => {
    const map = new Map<string, PrincipleAccuracy>();
    map.set("principle-only", makeAccuracy("principle-only", 5, 5, 10));

    const summary = buildAccuracySummary(map);
    expect(summary).toBeDefined();
    expect(summary!.length).toBeGreaterThan(0);
  });

  it("includes sample size information in the summary", () => {
    const map = new Map<string, PrincipleAccuracy>();
    map.set("principle-sample", makeAccuracy("principle-sample", 7, 3, 10));

    const summary = buildAccuracySummary(map);
    // Should include sample count somewhere
    expect(summary).toContain("10");
  });
});
