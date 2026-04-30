/**
 * Item-count budgeting utility.
 *
 * Maps session tier to a maximum item count cap for context injection stages.
 * Used by stage 1 (file affinity) and stage 6 (KG summaries) to bound injection size.
 *
 * Canon: graceful-degradation — unknown tier values fall back to the medium cap (15)
 * rather than throwing or returning 0.
 */

import type { Session } from "@domains/flows/board-state-schemas.ts";

const TIER_CAPS: Record<"small" | "medium" | "large", number> = {
  large: 30,
  medium: 15,
  small: 5,
};

/**
 * Returns the maximum item count for context injection given a session tier.
 *
 * @param tier - The session tier ("small", "medium", or "large"), or undefined
 * @returns The item count cap for the tier; defaults to 15 (medium) for unknown or missing tier
 */
export function getItemCountCap(tier: Session["tier"]): number {
  if (!tier) return 15;
  return TIER_CAPS[tier] ?? 15;
}
