/**
 * Doc-freshness adapter — computes a decaying confidence annotation for a
 * documentation direction doc, based on how many commits it has fallen behind.
 *
 * Signal composition (1 signal):
 * - staleness (weight 1): value falls as commits-since-sync rises. This IS the
 *   "decay" — expressed as the signal's value→commits mapping, then delegated to
 *   the shared computeConfidenceAnnotation engine. There is NO bespoke decay
 *   function (AC5): weighting and tiering are owned by the shared kernel.
 *
 * Placed in platform/storage/drift/ alongside drift-confidence-adapter.ts to
 * avoid cross-feature circular imports (same rationale as that file).
 */

import {
  type ConfidenceAnnotation,
  type ConfidenceInput,
  computeConfidenceAnnotation,
} from "@shared/lib/confidence.ts";

// Re-export so callers need not import from shared/lib directly (bounded-context boundary).
export type { ConfidenceAnnotation };

export type DocFreshnessSignals = {
  doc_path: string;
  commits_since_sync: number;
};

/**
 * Saturation constant: at/above this many commits, the staleness signal value
 * floors at 0. Chosen so that 0–few commits → value ≥ 0.7 (tier high) and a
 * clearly-stale doc (30+ commits, and certainly the ~87 from watch_ZZZ1) → tier
 * low. With saturation 40: 0 commits → 1.0 (high); 30 → 0.25 (low); 40+ → 0 (low).
 */
const STALENESS_SATURATION_COMMITS = 40;

/**
 * Sample-size semantics: a freshly-synced doc still has enough "observation" to
 * escape the deriveTier `sample_size < 5` insufficient floor. We use a fixed
 * observation count so freshness reads as high/low (decayed), not masked as
 * "insufficient" — even when the value is 0 (a clearly-stale doc must read `low`,
 * never `insufficient`).
 */
const FRESHNESS_SAMPLE_SIZE = 10;

export function computeFreshnessConfidence(signals: DocFreshnessSignals): ConfidenceAnnotation {
  // Non-finite or negative inputs are treated as fully stale (conservative).
  const raw = signals.commits_since_sync;
  const commits =
    !Number.isFinite(raw) || raw < 0 ? STALENESS_SATURATION_COMMITS : raw;

  // DECAY: value falls linearly as commits rise, clamped to [0, 1]. This single
  // value→commits mapping is the entire decay; the shared engine does the rest.
  const stalenessValue = Math.max(0, Math.min(1, 1 - commits / STALENESS_SATURATION_COMMITS));

  const inputs: ConfidenceInput[] = [
    {
      detail: `${commits} commits since last sync (repo-wide proxy)`,
      sample_size: FRESHNESS_SAMPLE_SIZE,
      signal: "staleness",
      value: stalenessValue,
      weight: 1,
    },
  ];

  return computeConfidenceAnnotation(inputs);
}
