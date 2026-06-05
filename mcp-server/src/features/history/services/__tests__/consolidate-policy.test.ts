/**
 * Tests for consolidate-policy.ts
 *
 * Validates the pure watch-disposition decision logic:
 * - Promoted / confirmed watches are always "exempt" regardless of staleness (AC5).
 * - Low-confidence non-confirmed watches are "archive".
 * - Recent confirming instance → "reinforce".
 * - Mid-range staleness → "decay".
 * - Named type guard isWatchProposal validates shape at the parse boundary.
 * - No references to ~/.claude or MEMORY.md (AC6).
 */

import { describe, expect, it } from "vitest";
import type { ConfidenceAnnotation } from "../../../../platform/storage/drift/watch-staleness-adapter.ts";
import { decideWatchDisposition, isWatchProposal, type WatchState } from "../consolidate-policy.ts";

// --- Helpers ---

function makeAnnotation(score: number, tier: ConfidenceAnnotation["tier"]): ConfidenceAnnotation {
  return {
    basis: [{ detail: "test", signal: "staleness", weight: 1 }],
    sample_size: 10,
    score,
    tier,
  };
}

const highConfidence = makeAnnotation(0.9, "high");
const mediumConfidence = makeAnnotation(0.5, "medium");
const belowArchiveThreshold = makeAnnotation(0.1, "low"); // below 0.25
const aboveArchiveThreshold = makeAnnotation(0.4, "medium"); // above 0.25

// --- decideWatchDisposition ---

describe("decideWatchDisposition", () => {
  describe("AC5 — promoted/confirmed are always exempt", () => {
    it("promoted watch at extreme staleness → exempt", () => {
      const watch: WatchState = {
        watch_id: "w1",
        status: "promoted",
        days_since_last_instance: 999,
        confirming_instances: 1,
      };
      // Even with zero-score annotation, promoted must return exempt.
      const zeroConfidence = makeAnnotation(0, "low");
      expect(decideWatchDisposition(watch, zeroConfidence)).toBe("exempt");
    });

    it("confirmed watch at extreme staleness → exempt", () => {
      const watch: WatchState = {
        watch_id: "w2",
        status: "confirmed",
        days_since_last_instance: 999,
        confirming_instances: 1,
      };
      expect(decideWatchDisposition(watch, belowArchiveThreshold)).toBe("exempt");
    });

    it("PROMOTED (upper case) → exempt (case-insensitive status check)", () => {
      const watch: WatchState = {
        watch_id: "w3",
        status: "PROMOTED",
        days_since_last_instance: 100,
        confirming_instances: 5,
      };
      expect(decideWatchDisposition(watch, makeAnnotation(0, "low"))).toBe("exempt");
    });

    it("Confirmed (mixed case) → exempt", () => {
      const watch: WatchState = {
        watch_id: "w4",
        status: "Confirmed",
        days_since_last_instance: 50,
        confirming_instances: 5,
      };
      expect(decideWatchDisposition(watch, makeAnnotation(0, "low"))).toBe("exempt");
    });
  });

  describe("archive — low confidence, non-confirmed", () => {
    it("watch-status with score below archive threshold → archive", () => {
      const watch: WatchState = {
        watch_id: "w5",
        status: "watch",
        days_since_last_instance: 25,
        confirming_instances: 10,
      };
      expect(decideWatchDisposition(watch, belowArchiveThreshold)).toBe("archive");
    });

    it("undefined status with low confidence → archive", () => {
      const watch: WatchState = {
        watch_id: "w6",
        days_since_last_instance: 30,
        confirming_instances: 10,
      };
      expect(decideWatchDisposition(watch, belowArchiveThreshold)).toBe("archive");
    });

    it("resolved status with low confidence → archive (resolved is not exempt)", () => {
      const watch: WatchState = {
        watch_id: "w7",
        status: "resolved",
        days_since_last_instance: 30,
        confirming_instances: 10,
      };
      expect(decideWatchDisposition(watch, belowArchiveThreshold)).toBe("archive");
    });
  });

  describe("reinforce — recent confirming instance", () => {
    it("days_since_last_instance = 0 with sufficient confidence → reinforce", () => {
      const watch: WatchState = {
        watch_id: "w8",
        status: "watch",
        days_since_last_instance: 0,
        confirming_instances: 10,
      };
      expect(decideWatchDisposition(watch, highConfidence)).toBe("reinforce");
    });

    it("days_since_last_instance = 7 (boundary) → reinforce", () => {
      const watch: WatchState = {
        watch_id: "w9",
        status: "watch",
        days_since_last_instance: 7,
        confirming_instances: 10,
      };
      expect(decideWatchDisposition(watch, aboveArchiveThreshold)).toBe("reinforce");
    });

    it("days_since_last_instance = 8 (just past recent boundary) → decay (not reinforce)", () => {
      const watch: WatchState = {
        watch_id: "w10",
        status: "watch",
        days_since_last_instance: 8,
        confirming_instances: 10,
      };
      expect(decideWatchDisposition(watch, aboveArchiveThreshold)).toBe("decay");
    });
  });

  describe("decay — mid staleness, above archive threshold", () => {
    it("moderate staleness, score above archive threshold → decay", () => {
      const watch: WatchState = {
        watch_id: "w11",
        status: "watch",
        days_since_last_instance: 20,
        confirming_instances: 10,
      };
      expect(decideWatchDisposition(watch, mediumConfidence)).toBe("decay");
    });

    it("no status, 15 days, medium confidence → decay", () => {
      const watch: WatchState = {
        watch_id: "w12",
        days_since_last_instance: 15,
        confirming_instances: 8,
      };
      expect(decideWatchDisposition(watch, mediumConfidence)).toBe("decay");
    });
  });

  describe("decision ordering — exempt check runs before archive check", () => {
    it("promoted watch with confidence below archive threshold still returns exempt (not archive)", () => {
      const watch: WatchState = {
        watch_id: "w13",
        status: "promoted",
        days_since_last_instance: 60,
        confirming_instances: 1,
      };
      expect(decideWatchDisposition(watch, belowArchiveThreshold)).toBe("exempt");
    });
  });
});

// --- isWatchProposal ---

describe("isWatchProposal", () => {
  it("accepts a valid watch proposal", () => {
    const input = {
      watch_id: "w1",
      status: "watch",
      days_since_last_instance: 5,
      confirming_instances: 3,
    };
    expect(isWatchProposal(input)).toBe(true);
  });

  it("accepts a valid watch proposal with optional fields", () => {
    const input = {
      watch_id: "w2",
      status: "promoted",
      days_since_last_instance: 10,
      confirming_instances: 8,
      pattern: "some-pattern",
      description: "some description",
    };
    expect(isWatchProposal(input)).toBe(true);
  });

  it("rejects null", () => {
    expect(isWatchProposal(null)).toBe(false);
  });

  it("rejects a non-object (string)", () => {
    expect(isWatchProposal("watch")).toBe(false);
  });

  it("rejects missing watch_id", () => {
    const input = { status: "watch", days_since_last_instance: 5, confirming_instances: 3 };
    expect(isWatchProposal(input)).toBe(false);
  });

  it("rejects numeric watch_id (wrong type)", () => {
    const input = {
      watch_id: 42,
      status: "watch",
      days_since_last_instance: 5,
      confirming_instances: 3,
    };
    expect(isWatchProposal(input)).toBe(false);
  });

  it("rejects missing days_since_last_instance", () => {
    const input = { watch_id: "w3", status: "watch", confirming_instances: 3 };
    expect(isWatchProposal(input)).toBe(false);
  });

  it("rejects string days_since_last_instance (wrong type)", () => {
    const input = {
      watch_id: "w4",
      status: "watch",
      days_since_last_instance: "5",
      confirming_instances: 3,
    };
    expect(isWatchProposal(input)).toBe(false);
  });

  it("rejects missing confirming_instances", () => {
    const input = { watch_id: "w5", status: "watch", days_since_last_instance: 5 };
    expect(isWatchProposal(input)).toBe(false);
  });

  it("rejects missing status", () => {
    const input = { watch_id: "w6", days_since_last_instance: 5, confirming_instances: 3 };
    expect(isWatchProposal(input)).toBe(false);
  });

  it("rejects an empty object", () => {
    expect(isWatchProposal({})).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isWatchProposal(undefined)).toBe(false);
  });
});
