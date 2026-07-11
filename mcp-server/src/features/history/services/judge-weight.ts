/**
 * judge-weight — Re-export shim over the shared outcome-weight engine.
 *
 * The pure implementation moved to @shared/lib/outcome-weight.ts (Gap 3,
 * ADR-0005/ADR-0006) so features/evolution/services/attribution-weight.ts can compose
 * `computeOutcomeWeight` as its outcome-quality factor without a
 * `no-cross-feature-internal-import` violation — features may depend on the shared
 * kernel, but not on each other's internals. This file's public API (all exports
 * below) is UNCHANGED — existing callers (cross-run-analyzer.ts, judge-weight.test.ts)
 * need no changes.
 */

export type { OutcomeSignals } from "@shared/lib/outcome-weight.ts";
// biome-ignore lint/performance/noBarrelFile: intentional compat re-export — preserves this file's public API after the engine moved to @shared/lib/outcome-weight.ts
export {
  computeOutcomeWeight,
  NEUTRAL_WEIGHT,
  WEIGHT_CEIL,
  WEIGHT_FLOOR,
} from "@shared/lib/outcome-weight.ts";
