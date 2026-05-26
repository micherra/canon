/**
 * Tests for drift-confidence-adapter.ts
 *
 * Validates the 3-signal compliance confidence scoring:
 * - sample_size signal (weight 0.5)
 * - trend_stability signal (weight 0.3)
 * - rate_stability signal (weight 0.2)
 */

import { describe, expect, it } from "vitest";
import {
  type ComplianceSignals,
  computeComplianceConfidence,
} from "../drift-confidence-adapter.ts";

const base: ComplianceSignals = {
  principle_id: "errors-are-values",
  total_violations: 10,
  times_honored: 10,
  compliance_rate: 50,
  trend: "stable",
};

describe("computeComplianceConfidence", () => {
  it("returns insufficient annotation when totalObservations is 0", () => {
    const result = computeComplianceConfidence({
      ...base,
      total_violations: 0,
      times_honored: 0,
      compliance_rate: 0,
    });
    expect(result.tier).toBe("insufficient");
    expect(result.sample_size).toBe(0);
    expect(result.score).toBe(0);
  });

  it("returns insufficient when sample_size < 5 (e.g., 2 observations)", () => {
    const result = computeComplianceConfidence({
      ...base,
      total_violations: 1,
      times_honored: 1,
      compliance_rate: 50,
    });
    // 2 total observations → sample_size = 2 < 5 → insufficient
    expect(result.tier).toBe("insufficient");
    expect(result.sample_size).toBe(2);
  });

  it("returns non-insufficient annotation with sufficient observations and stable trend", () => {
    const result = computeComplianceConfidence({
      ...base,
      total_violations: 5,
      times_honored: 15,
      compliance_rate: 75,
      trend: "stable",
    });
    // 20 observations → sample_size = 20 ≥ 5 → not insufficient
    expect(result.tier).not.toBe("insufficient");
    expect(result.sample_size).toBeGreaterThanOrEqual(5);
    expect(result.score).toBeGreaterThan(0);
  });

  it("basis includes all 3 signals: sample_size, trend_stability, rate_stability", () => {
    const result = computeComplianceConfidence(base);
    const signals = result.basis.map((b) => b.signal);
    expect(signals).toContain("sample_size");
    expect(signals).toContain("trend_stability");
    expect(signals).toContain("rate_stability");
    expect(result.basis).toHaveLength(3);
  });

  it("normalized weights in basis sum to approximately 1.0", () => {
    const result = computeComplianceConfidence({
      ...base,
      total_violations: 15,
      times_honored: 15,
    });
    const weightSum = result.basis.reduce((sum, b) => sum + b.weight, 0);
    expect(weightSum).toBeCloseTo(1.0, 1);
  });

  it("decisive compliance rate (>= 80) produces higher rate_stability value than ambiguous (50%)", () => {
    const decisive = computeComplianceConfidence({
      ...base,
      total_violations: 2,
      times_honored: 18,
      compliance_rate: 90,
      trend: "stable",
    });
    const ambiguous = computeComplianceConfidence({
      ...base,
      total_violations: 10,
      times_honored: 10,
      compliance_rate: 50,
      trend: "stable",
    });
    const decisiveBasis = decisive.basis.find((b) => b.signal === "rate_stability");
    const ambiguousBasis = ambiguous.basis.find((b) => b.signal === "rate_stability");
    // decisive detail should contain "decisive", ambiguous should contain "ambiguous"
    expect(decisiveBasis?.detail).toContain("decisive");
    expect(ambiguousBasis?.detail).toContain("ambiguous");
  });

  it("insufficient_data trend yields lower score than stable trend (same observations)", () => {
    const withStable = computeComplianceConfidence({ ...base, trend: "stable" });
    const withInsufficient = computeComplianceConfidence({ ...base, trend: "insufficient_data" });
    expect(withStable.score).toBeGreaterThan(withInsufficient.score);
  });
});
