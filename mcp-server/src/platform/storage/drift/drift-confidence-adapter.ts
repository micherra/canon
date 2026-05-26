/**
 * Drift confidence adapter — computes confidence annotations for compliance stats.
 *
 * Signal composition (3 signals):
 * - sample_size (weight 0.5): how many observations back the compliance rate
 * - trend_stability (weight 0.3): how stable the trend direction is
 * - rate_stability (weight 0.2): whether the compliance rate is in a decisive range
 *
 * Uses structural interfaces (not direct imports from shared/lib) per bounded-context-boundaries.
 * Callers must provide their own ConfidenceAnnotation / ConfidenceTier types compatible
 * with the shared schema, or use the re-exported inline types here.
 */

import {
  type ConfidenceAnnotation,
  type ConfidenceInput,
  computeConfidenceAnnotation,
  deriveTier,
} from "@shared/lib/confidence.ts";

// Re-export so callers need not import from shared/lib directly (bounded-context boundary).
export type { ConfidenceAnnotation };

export type DriftTrend = "improving" | "stable" | "declining" | "insufficient_data";

/** Minimal view of PrincipleStats needed by the adapter. Uses structural typing. */
export type ComplianceSignals = {
  principle_id: string;
  total_violations: number;
  times_honored: number;
  compliance_rate: number; // 0-100
  trend?: DriftTrend;
};

/**
 * Compute a confidence annotation for a principle's compliance statistics.
 *
 * Returns an "insufficient" annotation when there are no observations.
 * Never throws.
 */
export function computeComplianceConfidence(signals: ComplianceSignals): ConfidenceAnnotation {
  const totalObservations = signals.total_violations + signals.times_honored;

  // No data at all — return insufficient annotation immediately
  if (totalObservations === 0) {
    return {
      basis: [
        {
          detail: "no observations",
          signal: "sample_size",
          weight: 1,
        },
      ],
      sample_size: 0,
      score: 0,
      tier: "insufficient",
    };
  }

  const inputs: ConfidenceInput[] = [
    buildSampleSizeSignal(totalObservations),
    // Auxiliary signals inherit totalObservations as their sample_size so they don't
    // dominate the weakest-link minimum in computeConfidenceAnnotation.
    buildTrendStabilitySignal(signals.trend ?? "insufficient_data", totalObservations),
    buildRateStabilitySignal(signals.compliance_rate, totalObservations),
  ];

  return computeConfidenceAnnotation(inputs);
}

// --- Signal builders ---

function buildSampleSizeSignal(totalObservations: number): ConfidenceInput {
  // Saturates at 20 observations → value 1.0
  const value = Math.min(totalObservations / 20, 1.0);
  return {
    detail: `${totalObservations} total observations`,
    sample_size: totalObservations,
    signal: "sample_size",
    value,
    weight: 0.5,
  };
}

function buildTrendStabilitySignal(trend: DriftTrend, sampleSize: number): ConfidenceInput {
  const trendValues: Record<DriftTrend, number> = {
    declining: 0.6,
    improving: 0.7,
    insufficient_data: 0.2,
    stable: 0.8,
  };
  const value = trendValues[trend];
  return {
    detail: `trend: ${trend}`,
    sample_size: sampleSize,
    signal: "trend_stability",
    value,
    weight: 0.3,
  };
}

function buildRateStabilitySignal(complianceRate: number, sampleSize: number): ConfidenceInput {
  // Decisive ranges (>= 80% or <= 20%) → high confidence; middle range → lower
  const isDecisive = complianceRate >= 80 || complianceRate <= 20;
  const value = isDecisive ? 0.8 : 0.5;
  return {
    detail: `compliance rate ${complianceRate}% (${isDecisive ? "decisive" : "ambiguous"} range)`,
    sample_size: sampleSize,
    signal: "rate_stability",
    value,
    weight: 0.2,
  };
}

/**
 * Re-export deriveTier for callers that need to interpret annotations without importing shared/lib.
 */
export { deriveTier };
