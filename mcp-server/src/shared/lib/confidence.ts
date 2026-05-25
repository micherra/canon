import { z } from "zod";

// --- Types ---

export type ConfidenceTier = "high" | "medium" | "low" | "insufficient";

export type ConfidenceBasis = {
  signal: string; // e.g., "violation_history", "prediction_accuracy", "severity_tier"
  weight: number; // 0-1, contribution of this signal
  detail: string; // human-readable, e.g., "violated 8 times in last 30 days"
};

export type ConfidenceAnnotation = {
  score: number; // 0-1
  tier: ConfidenceTier;
  basis: ConfidenceBasis[];
  sample_size: number;
};

export type ConfidenceInput = {
  signal: string;
  value: number; // 0-1, raw signal value
  weight: number; // 0-1, how much this signal matters
  detail: string;
  sample_size: number; // observations underlying this signal
};

// --- Zod schemas (for tool boundary validation) ---

export const ConfidenceBasisSchema = z.object({
  signal: z.string(),
  weight: z.number().min(0).max(1),
  detail: z.string(),
});

export const ConfidenceAnnotationSchema = z.object({
  score: z.number().min(0).max(1),
  tier: z.enum(["high", "medium", "low", "insufficient"]),
  basis: z.array(ConfidenceBasisSchema),
  sample_size: z.number().int().min(0),
});

// --- Functions ---

/**
 * Derive a confidence tier from score and sample size.
 * Returns "insufficient" when sample size is too small, regardless of score.
 * Never throws — returns "insufficient" for edge cases.
 */
export function deriveTier(score: number, sampleSize: number): ConfidenceTier {
  if (sampleSize < 5) return "insufficient";
  if (score >= 0.7) return "high";
  if (score >= 0.4) return "medium";
  return "low";
}

/**
 * Compute a confidence annotation from a set of weighted inputs.
 * Empty input returns a zero-confidence annotation, never throws.
 * Score is clamped to [0, 1]. Sample size is the weakest-link minimum.
 */
export function computeConfidenceAnnotation(
  inputs: ConfidenceInput[],
): ConfidenceAnnotation {
  // If no inputs, return zero-confidence annotation
  if (inputs.length === 0) {
    return { score: 0, tier: "insufficient", basis: [], sample_size: 0 };
  }

  // Weighted average of signal values
  const totalWeight = inputs.reduce((sum, i) => sum + i.weight, 0);
  const score =
    totalWeight > 0
      ? inputs.reduce((sum, i) => sum + i.value * i.weight, 0) / totalWeight
      : 0;

  // Use minimum sample_size across all inputs (weakest link)
  const sampleSize = Math.min(...inputs.map((i) => i.sample_size));

  const basis: ConfidenceBasis[] = inputs.map((i) => ({
    signal: i.signal,
    weight: totalWeight > 0 ? i.weight / totalWeight : 0, // normalized weight
    detail: i.detail,
  }));

  return {
    score: Math.max(0, Math.min(1, score)),
    tier: deriveTier(score, sampleSize),
    basis,
    sample_size: sampleSize,
  };
}
