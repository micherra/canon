/**
 * attribution-weight.ts — Pure trust/decay/corroboration weight, composing
 * computeOutcomeWeight (judge-weight.ts) as the outcome-quality factor.
 *
 * PURE: no I/O, no Date.now(), no Math.random() — `signal_age_ms` is ALWAYS threaded
 * in by the caller (determinism boundary, dc-01/dc-05).
 *
 * signed = sign * roleTierWeight(agent_name, is_adversarial_step, tier)
 *        * corroborationWeight(distinct_owning_steps)
 *        * decay(signal_age_ms)
 *        * computeOutcomeWeight(outcome)
 *
 * No-LLM verification: grep -niE 'anthropic|claude|messages.create|model:|Date.now|Math.random'
 * attribution-weight.ts -> zero hits (except this comment).
 *
 * Canon principles:
 *   - no-llm-calls-in-mcp-tools: pure arithmetic only, no model calls
 *   - errors-are-values: non-finite/absent inputs fall back to neutral, never thrown
 *   - deep-modules: one small exported interface (computeTrustWeight) over composed sub-weights
 *   - no-cross-feature-internal-import: computeOutcomeWeight is imported from the shared
 *     kernel (@shared/lib/outcome-weight.ts), not from features/history/ directly —
 *     judge-weight.ts (features/history/services/) re-exports the same engine unchanged.
 */

import type { OutcomeSignals } from "@shared/lib/outcome-weight.ts";
import { computeOutcomeWeight } from "@shared/lib/outcome-weight.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Trust-tier slot for the signal's origin. OPEN enum: "codex" is a RESERVED,
 * v1-UNUSED slot (PROBE Q2 — no capture seam records external-Codex origin yet).
 * Defaults to "internal" so a future capture seam can add codex-origin scoring
 * without re-scoring already-recorded history differently.
 */
export type TrustTierSlot = "internal" | "codex";

/** A single signed contribution to a principle's trust-weighted score. */
export type SignContribution = {
  /** +1 for a positive (honored) signal, -1 for a negative (violation/cliff) signal. */
  sign: 1 | -1;
  /** Provenance agent_name, e.g. "canon:engineer", "canon:reviewer", "canon:security". */
  agent_name: string;
  /** Count of DISTINCT steps whose context held the matching artifact — corroboration signal. */
  distinct_owning_steps: number;
  /** Signal age in milliseconds, derived by the caller from `now - run_metadata.completed_at`.
   *  NEVER Date.now() — always threaded in for determinism. */
  signal_age_ms: number;
  /** Outcome-quality signals, composed via computeOutcomeWeight (judge-weight.ts). */
  outcome: OutcomeSignals;
  /** Trust-tier slot. Defaults to "internal" when omitted. "codex" is reserved/unused in v1. */
  tier?: TrustTierSlot;
  /** true for a FRESH (non-author) adversarial re-review step; false/omitted for first-pass. */
  is_adversarial_step?: boolean;
};

// ---------------------------------------------------------------------------
// Tunable constants — role tier
// ---------------------------------------------------------------------------

/** security/reviewer top tier — highest-trust in-context holder (diverse-lens jury, ADR-0046). */
export const ROLE_TIER_SECURITY_REVIEWER_WEIGHT = 1.3;

/** engineer/author tier — the code-authoring agent, middle trust. */
export const ROLE_TIER_ENGINEER_AUTHOR_WEIGHT = 1.0;

/** Any other role not matched above — lowest trust tier. */
export const ROLE_TIER_OTHER_WEIGHT = 0.7;

/**
 * Multiplier applied when the step is a FRESH (non-author) adversarial re-review, per
 * watch_CCCCCCCCCCCC1 — a careful adversarial catch outweighs a first-pass review.
 */
export const ADVERSARIAL_STEP_MULTIPLIER = 1.2;

/**
 * Trust-tier slot multiplier. "codex" is a RESERVED, v1-UNUSED higher tier (PROBE Q2) —
 * no capture seam sets it today; every real contribution defaults to "internal".
 */
export const TIER_SLOT_WEIGHTS: Record<TrustTierSlot, number> = {
  codex: 1.15,
  internal: 1.0,
};

/** Bounds on the combined role-tier product — prevents any single factor combo from dominating. */
export const ROLE_TIER_WEIGHT_FLOOR = 0.5;
export const ROLE_TIER_WEIGHT_CEIL = 2.0;

// ---------------------------------------------------------------------------
// Tunable constants — corroboration
// ---------------------------------------------------------------------------

/** Weight added per DISTINCT owning step beyond the first (more independent holders -> higher). */
export const CORROBORATION_STEP_INCREMENT = 0.08;

/** Ceiling — a single build's step count cannot dominate the corroboration factor. */
export const CORROBORATION_CEIL = 1.5;

// ---------------------------------------------------------------------------
// Tunable constants — decay
// ---------------------------------------------------------------------------

/** Exponential half-life for signal decay: 14 days. Named + exported per task plan. */
export const DECAY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

/** Floor — decay never reaches exactly 0 (stale signal still counts, just attenuated). */
export const DECAY_FLOOR = 0.05;

/** Neutral weight — matches judge-weight.ts NEUTRAL_WEIGHT; used as every sub-weight's fallback. */
const NEUTRAL_WEIGHT = 1.0;

// ---------------------------------------------------------------------------
// Sub-weight helpers (private — computeTrustWeight is the sole public interface)
// ---------------------------------------------------------------------------

/** Classify an agent_name into a role tier. Matches by substring, case-insensitive. */
function roleTierBaseWeight(agentName: string): number {
  const normalized = agentName.toLowerCase();
  if (normalized.includes("security") || normalized.includes("review")) {
    return ROLE_TIER_SECURITY_REVIEWER_WEIGHT;
  }
  if (normalized.includes("engineer") || normalized.includes("author")) {
    return ROLE_TIER_ENGINEER_AUTHOR_WEIGHT;
  }
  return ROLE_TIER_OTHER_WEIGHT;
}

/**
 * Combined role-tier weight: base role tier x adversarial-step multiplier x trust-tier slot,
 * clamped to [ROLE_TIER_WEIGHT_FLOOR, ROLE_TIER_WEIGHT_CEIL].
 */
function roleTierWeight(
  agentName: string,
  isAdversarialStep: boolean,
  tier: TrustTierSlot,
): number {
  const base = roleTierBaseWeight(agentName);
  const adversarial = isAdversarialStep ? ADVERSARIAL_STEP_MULTIPLIER : 1.0;
  const tierWeight = TIER_SLOT_WEIGHTS[tier] ?? TIER_SLOT_WEIGHTS.internal;
  const product = base * adversarial * tierWeight;
  return Math.max(ROLE_TIER_WEIGHT_FLOOR, Math.min(ROLE_TIER_WEIGHT_CEIL, product));
}

/**
 * Corroboration weight: monotonic non-decreasing in distinctOwningSteps, ceilinged.
 * Non-finite or <1 -> neutral (1.0, i.e. a single owning step has no corroboration boost).
 */
function corroborationWeight(distinctOwningSteps: number): number {
  if (!Number.isFinite(distinctOwningSteps) || distinctOwningSteps <= 1) return NEUTRAL_WEIGHT;
  const raw = NEUTRAL_WEIGHT + (distinctOwningSteps - 1) * CORROBORATION_STEP_INCREMENT;
  return Math.min(CORROBORATION_CEIL, raw);
}

/**
 * Exponential decay over signalAgeMs. age 0 -> 1.0 (no attenuation), monotonically
 * decreasing, floored above 0. Non-finite or negative age -> neutral (no decay applied).
 * NEVER calls Date.now() — signalAgeMs is always threaded in by the caller.
 */
function decay(signalAgeMs: number): number {
  if (!Number.isFinite(signalAgeMs) || signalAgeMs < 0) return NEUTRAL_WEIGHT;
  const raw = 0.5 ** (signalAgeMs / DECAY_HALF_LIFE_MS);
  return Math.max(DECAY_FLOOR, raw);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the signed, trust-weighted contribution of a single provenance-attributed
 * signal (positive honored or negative violation/cliff) to a principle's net score.
 *
 * Pure, IO-free, deterministic: identical input always produces identical (===) output.
 * Never throws — non-finite/absent inputs degrade to neutral sub-weights.
 *
 * @param c - The signed contribution: sign, source agent, corroboration count, signal
 *   age (threaded, never wall-clock), outcome-quality signals, optional tier/adversarial flag.
 * @returns The signed weight: positive contributions push a principle's score up,
 *   negative contributions push it down; magnitude reflects trust + corroboration +
 *   recency + outcome quality.
 */
export function computeTrustWeight(c: SignContribution): number {
  const tier = c.tier ?? "internal";
  const isAdversarialStep = c.is_adversarial_step ?? false;

  const role = roleTierWeight(c.agent_name, isAdversarialStep, tier);
  const corroboration = corroborationWeight(c.distinct_owning_steps);
  const decayed = decay(c.signal_age_ms);
  const outcome = computeOutcomeWeight(c.outcome);

  return c.sign * role * corroboration * decayed * outcome;
}
