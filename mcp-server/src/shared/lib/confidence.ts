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
  detail: z.string(),
  signal: z.string(),
  weight: z.number().min(0).max(1),
});

export const ConfidenceAnnotationSchema = z.object({
  basis: z.array(ConfidenceBasisSchema),
  sample_size: z.number().int().min(0),
  score: z.number().min(0).max(1),
  tier: z.enum(["high", "medium", "low", "insufficient"]),
});

// --- Functions ---

/**
 * Derive a confidence tier from score and sample size.
 * Returns "insufficient" when sample size is too small, regardless of score.
 * Never throws — returns "insufficient" for edge cases.
 */
export function deriveTier(score: number, sampleSize: number): ConfidenceTier {
  if (!Number.isFinite(score) || !Number.isFinite(sampleSize)) return "insufficient";
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
export function computeConfidenceAnnotation(inputs: ConfidenceInput[]): ConfidenceAnnotation {
  // If no inputs, return zero-confidence annotation
  if (inputs.length === 0) {
    return { basis: [], sample_size: 0, score: 0, tier: "insufficient" };
  }

  const sanitized = inputs.map((i) => ({
    ...i,
    sample_size: Number.isFinite(i.sample_size) ? Math.max(0, Math.floor(i.sample_size)) : 0,
    value: Number.isFinite(i.value) ? i.value : 0,
    weight: Number.isFinite(i.weight) ? i.weight : 0,
  }));

  const totalWeight = sanitized.reduce((sum, i) => sum + i.weight, 0);
  const score =
    totalWeight > 0 ? sanitized.reduce((sum, i) => sum + i.value * i.weight, 0) / totalWeight : 0;

  const sampleSize = Math.min(...sanitized.map((i) => i.sample_size));

  const basis: ConfidenceBasis[] = sanitized.map((i) => ({
    detail: i.detail,
    signal: i.signal,
    weight: totalWeight > 0 ? i.weight / totalWeight : 0,
  }));

  return {
    basis,
    sample_size: sampleSize,
    score: Math.max(0, Math.min(1, score)),
    tier: deriveTier(score, sampleSize),
  };
}
