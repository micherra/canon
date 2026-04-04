/**
 * Tests for aggregateReviewResults in transitions.ts
 *
 * Covers:
 * - Severity ordering: blocking > warning > clean
 * - Empty input returns clean
 * - Case-insensitive status matching
 * - Unknown statuses treated as severity 0 (below clean)
 */

import { describe, expect, it } from "vitest";
import type { ParallelPerResult } from "../orchestration/transitions.ts";
import { aggregateReviewResults } from "../orchestration/transitions.ts";

describe("aggregateReviewResults", () => {
  it("returns clean for empty results", () => {
    const result = aggregateReviewResults([]);
    expect(result.condition).toBe("clean");
    expect(result.cannotFixItems).toEqual([]);
  });

  it("returns clean when all results are clean", () => {
    const results: ParallelPerResult[] = [{ status: "clean" }, { status: "clean" }];
    const result = aggregateReviewResults(results);
    expect(result.condition).toBe("clean");
    expect(result.cannotFixItems).toEqual([]);
  });

  it("returns warning when most severe is warning", () => {
    const results: ParallelPerResult[] = [{ status: "clean" }, { status: "warning" }];
    const result = aggregateReviewResults(results);
    expect(result.condition).toBe("warning");
    expect(result.cannotFixItems).toEqual([]);
  });

  it("returns blocking when any result is blocking", () => {
    const results: ParallelPerResult[] = [
      { status: "clean" },
      { status: "warning" },
      { status: "blocking" },
    ];
    const result = aggregateReviewResults(results);
    expect(result.condition).toBe("blocking");
    expect(result.cannotFixItems).toEqual([]);
  });

  it("returns blocking when all results are blocking", () => {
    const results: ParallelPerResult[] = [{ status: "blocking" }, { status: "blocking" }];
    const result = aggregateReviewResults(results);
    expect(result.condition).toBe("blocking");
  });

  it("is case-insensitive: BLOCKING", () => {
    const results: ParallelPerResult[] = [{ status: "BLOCKING" }, { status: "clean" }];
    const result = aggregateReviewResults(results);
    expect(result.condition).toBe("blocking");
  });

  it("is case-insensitive: WARNING", () => {
    const results: ParallelPerResult[] = [{ status: "WARNING" }, { status: "clean" }];
    const result = aggregateReviewResults(results);
    expect(result.condition).toBe("warning");
  });

  it("is case-insensitive: CLEAN", () => {
    const results: ParallelPerResult[] = [{ status: "CLEAN" }];
    const result = aggregateReviewResults(results);
    expect(result.condition).toBe("clean");
  });

  it("treats unknown statuses as severity 0 — clean wins when mixed with unknown", () => {
    const results: ParallelPerResult[] = [{ status: "unknown_verdict" }, { status: "clean" }];
    const result = aggregateReviewResults(results);
    // clean has severity 1, unknown has 0, so clean wins
    expect(result.condition).toBe("clean");
  });

  it("treats unknown statuses as severity 0 — unknown alone returns unknown", () => {
    const results: ParallelPerResult[] = [{ status: "some_unknown_status" }];
    const result = aggregateReviewResults(results);
    // With only unknown (severity 0), maxCondition stays "clean" (initial)
    // This tests the initial value behavior — maxSeverity=0, maxCondition="clean"
    expect(result.condition).toBe("clean");
  });

  it("always returns empty cannotFixItems", () => {
    const results: ParallelPerResult[] = [{ item: "some-cluster", status: "blocking" }];
    const result = aggregateReviewResults(results);
    expect(result.cannotFixItems).toEqual([]);
  });
});
