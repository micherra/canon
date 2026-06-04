/**
 * Watch-staleness adapter — computes a decaying confidence annotation for a
 * learner watch item, based on how many days have passed since the last
 * confirming build instance.
 *
 * Signal composition (1 signal):
 * - staleness (weight 1): value falls as days_since_last_instance rises. This IS
 *   the "decay" — expressed as the signal's value→days mapping, then delegated to
 *   the shared computeConfidenceAnnotation engine. There is NO bespoke decay
 *   function (AC4): weighting and tiering are owned by the shared kernel.
 *
 * Placed in platform/storage/drift/ alongside doc-freshness-adapter.ts to
 * avoid cross-feature circular imports (same rationale as that file).
 */

import {
  type ConfidenceAnnotation,
  type ConfidenceInput,
  computeConfidenceAnnotation,
} from "@shared/lib/confidence.ts";

// Re-export so callers need not import from shared/lib directly (bounded-context boundary).
export type { ConfidenceAnnotation };

export type WatchStalenessSignals = {
  watch_id: string;
  days_since_last_instance: number; // wall-clock days since last confirming build instance
  confirming_instances: number; // how many builds have confirmed this watch
};

/**
 * Saturation constant: at/above this many days, the staleness signal value
 * floors at 0. Chosen so that 0 days → value 1.0 (high), ~15 days → medium,
 * 30+ days → low. A watch confirmed within a month of active work reads as
 * low (but not insufficient) when the codebase has moved on.
 */
const STALENESS_SATURATION_DAYS = 30;

export function computeWatchConfidence(signals: WatchStalenessSignals): ConfidenceAnnotation {
  // Non-finite or negative inputs are treated as fully stale (conservative,
  // matches doc-freshness-adapter behaviour at trust boundaries).
  const raw = signals.days_since_last_instance;
  const days = !Number.isFinite(raw) || raw < 0 ? STALENESS_SATURATION_DAYS : raw;

  // DECAY: value falls linearly as days rise, clamped to [0, 1]. This single
  // value→days mapping is the entire decay; the shared engine does the rest.
  const stalenessValue = Math.max(0, Math.min(1, 1 - days / STALENESS_SATURATION_DAYS));

  // Use confirming_instances as sample_size so a watch confirmed once reads
  // differently from one confirmed many times. Clamp to a non-negative integer;
  // if no instances yet, fall back to 0 (engine returns "insufficient", which is
  // correct — a never-confirmed watch has no evidence base).
  const sampleSize = Number.isFinite(signals.confirming_instances)
    ? Math.max(0, Math.floor(signals.confirming_instances))
    : 0;

  const inputs: ConfidenceInput[] = [
    {
      detail: `${days} days since last confirming instance (watch: ${signals.watch_id})`,
      sample_size: sampleSize,
      signal: "staleness",
      value: stalenessValue,
      weight: 1,
    },
  ];

  return computeConfidenceAnnotation(inputs);
}
