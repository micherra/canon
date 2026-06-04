/**
 * Consolidate policy — pure disposition logic for learner watch items.
 *
 * Decides whether a watch should be reinforced, decayed, archived, or
 * exempted from decay. Inputs are plain values (no I/O, no clock reads).
 * The ConfidenceAnnotation is computed by watch-staleness-adapter.ts and
 * passed in — this module is strictly a rule engine.
 *
 * Scope: learner's own store (.canon/proposed-learnings/). No write paths,
 * no references to ~/.claude or MEMORY.md (AC6).
 */

import type { ConfidenceAnnotation } from "../../../platform/storage/drift/watch-staleness-adapter.ts";

// --- Disposition ---

/** The outcome of the consolidation decision for a watch item. */
export type WatchDisposition = "reinforce" | "decay" | "archive" | "exempt";

// --- Watch state ---

/** Input state for a watch item read from .canon/proposed-learnings/. */
export type WatchState = {
  watch_id: string;
  /**
   * Lifecycle status. Promoted and confirmed items are exempt from decay
   * (anti-forgetting takes precedence over staleness — AC5).
   * Values: "promoted" | "confirmed" | "watch" | "resolved" | (any string).
   */
  status?: string;
  days_since_last_instance: number;
  confirming_instances: number;
};

// --- Watch proposal (parse boundary) ---

/**
 * Shape of a watch proposal record read from .canon/proposed-learnings/ files.
 * The named type guard isWatchProposal validates this shape at the JSON/frontmatter
 * boundary — no inline casts, no `unknown` leaking into typed code (AC4,
 * validate-at-trust-boundaries).
 */
export type WatchProposal = {
  watch_id: string;
  status: string;
  days_since_last_instance: number;
  confirming_instances: number;
  pattern?: string;
  description?: string;
};

/**
 * Named type guard for watch proposal records parsed from .canon/proposed-learnings/.
 * Validates required fields before use — unknown input must pass this check
 * before being treated as a WatchProposal.
 */
export function isWatchProposal(x: unknown): x is WatchProposal {
  if (typeof x !== "object" || x === null) return false;
  const obj = x as Record<string, unknown>;
  return (
    typeof obj.watch_id === "string" &&
    typeof obj.status === "string" &&
    typeof obj.days_since_last_instance === "number" &&
    typeof obj.confirming_instances === "number"
  );
}

// --- Thresholds ---

/**
 * Confidence score below which a watch is flagged for archival.
 * Tuned so a watch with a recent confirming instance (high score) never archives.
 * 0.25 matches the low-tier boundary used by the shared confidence engine.
 */
const ARCHIVE_CONFIDENCE_THRESHOLD = 0.25;

/**
 * Days within which a confirming instance counts as "recent" — triggers
 * reinforce rather than decay even when score is moderate.
 */
const REINFORCE_RECENT_DAYS = 7;

// --- Policy ---

/**
 * Decide the disposition for a watch item.
 *
 * Decision order (must not be reordered — AC5 depends on exempt-first):
 * 1. Promoted or confirmed → always "exempt" (anti-forgetting > decay).
 * 2. Below archive threshold → "archive".
 * 3. Recent confirming instance → "reinforce".
 * 4. Otherwise → "decay".
 *
 * Pure: takes pre-computed ConfidenceAnnotation; does no I/O and reads no clock.
 */
export function decideWatchDisposition(
  watch: WatchState,
  confidence: ConfidenceAnnotation,
): WatchDisposition {
  // AC5: promoted/confirmed items are ALWAYS exempt, regardless of staleness.
  const status = watch.status?.toLowerCase();
  if (status === "promoted" || status === "confirmed") {
    return "exempt";
  }

  // Below the archive floor → flag for removal.
  if (confidence.score < ARCHIVE_CONFIDENCE_THRESHOLD) {
    return "archive";
  }

  // Recent confirming instance → reinforce (refresh evidence).
  if (watch.days_since_last_instance <= REINFORCE_RECENT_DAYS) {
    return "reinforce";
  }

  // Anything else is in the middle zone — confidence is alive but decaying.
  return "decay";
}
