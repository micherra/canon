/**
 * Cross-run analyzer tests — weighted_instance_count (AC#2).
 *
 * Split from cross-run-analyzer.test.ts to keep each file under 600 lines.
 * P2 bug tests (summaryToOutcomeSignals ordering independence + fix_iterations)
 * are in cross-run-analyzer-p2-bugs.test.ts.
 * Uses in-memory SQLite (:memory:) via DriftDb for isolation.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DriftDb } from "../../../platform/storage/drift/drift-db.ts";
import { initDriftDb } from "../../../platform/storage/drift/drift-schema.ts";
import type { ReviewEntry } from "../../../shared/schema.ts";
import type { RunSummary } from "../history-types.ts";
import { analyzeCrossRunPatterns } from "../services/cross-run-analyzer.ts";

// ---- Helpers ----

function makeDb(): { db: ReturnType<typeof initDriftDb>; store: DriftDb } {
  const db = initDriftDb(":memory:");
  const store = new DriftDb(db);
  return { db, store };
}

function makeReviewEntry(overrides: Partial<ReviewEntry> = {}): ReviewEntry {
  return {
    files: ["src/foo.ts"],
    honored: [],
    review_id: `rev_${Math.random().toString(36).slice(2, 10)}`,
    score: {
      conventions: { passed: 1, total: 1 },
      opinions: { passed: 1, total: 1 },
      rules: { passed: 1, total: 1 },
    },
    timestamp: new Date().toISOString(),
    verdict: "CLEAN",
    violations: [],
    ...overrides,
  };
}

function makeRunSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  const now = new Date().toISOString();
  return {
    archive_id: `arc_${Math.random().toString(36).slice(2, 10)}`,
    artifact_inventory: {
      directories: [],
      files: [],
      total_files: 0,
    },
    decision_summaries: [],
    planner_context: null,
    review_results: [],
    run_metadata: {
      archived_at: now,
      branch: "main",
      completed_at: now,
      flow: "feature",
      slug: "test-slug",
      started_at: now,
      task: "Test task",
      tier: "standard",
      total_duration_ms: 60_000,
    },
    step_outcomes: [],
    version: 1,
    ...overrides,
  };
}

// ---- weighted_instance_count ----

describe("analyzeCrossRunPatterns — weighted_instance_count (AC#2)", () => {
  let store: DriftDb;
  let db: ReturnType<typeof initDriftDb>;

  beforeEach(() => {
    ({ db, store } = makeDb());
  });

  afterEach(() => {
    db.close();
  });

  test("two patterns with equal raw counts but differing verdicts produce different weighted_instance_count", () => {
    // pattern-good: 2 occurrences, both CLEAN reviews
    // pattern-bad:  2 occurrences, both BLOCKING reviews
    const cleanSummary1 = makeRunSummary({
      archive_id: "arc_clean_1",
      review_results: [
        {
          files_reviewed: 1,
          honored: [],
          principles_checked: 1,
          verdict: "CLEAN",
          violations: [
            { file_path: null, message: "", principle_id: "pattern-good", severity: "rule" },
          ],
        },
      ],
      run_metadata: {
        archived_at: "2026-01-01T01:00:00.000Z",
        branch: "main",
        completed_at: "2026-01-01T01:00:00.000Z",
        flow: "feature",
        slug: "clean-1",
        started_at: "2026-01-01T00:00:00.000Z",
        task: "T",
        tier: "standard",
        total_duration_ms: 60_000,
      },
    });
    const cleanSummary2 = makeRunSummary({
      archive_id: "arc_clean_2",
      review_results: [
        {
          files_reviewed: 1,
          honored: [],
          principles_checked: 1,
          verdict: "CLEAN",
          violations: [
            { file_path: null, message: "", principle_id: "pattern-good", severity: "rule" },
          ],
        },
      ],
      run_metadata: {
        archived_at: "2026-01-02T01:00:00.000Z",
        branch: "main",
        completed_at: "2026-01-02T01:00:00.000Z",
        flow: "feature",
        slug: "clean-2",
        started_at: "2026-01-02T00:00:00.000Z",
        task: "T",
        tier: "standard",
        total_duration_ms: 60_000,
      },
    });
    const blockSummary1 = makeRunSummary({
      archive_id: "arc_block_1",
      review_results: [
        {
          files_reviewed: 1,
          honored: [],
          principles_checked: 1,
          verdict: "BLOCKING",
          violations: [
            { file_path: null, message: "", principle_id: "pattern-bad", severity: "rule" },
          ],
        },
      ],
      run_metadata: {
        archived_at: "2026-01-01T01:00:00.000Z",
        branch: "main",
        completed_at: "2026-01-01T01:00:00.000Z",
        flow: "feature",
        slug: "block-1",
        started_at: "2026-01-01T00:00:00.000Z",
        task: "T",
        tier: "standard",
        total_duration_ms: 60_000,
      },
    });
    const blockSummary2 = makeRunSummary({
      archive_id: "arc_block_2",
      review_results: [
        {
          files_reviewed: 1,
          honored: [],
          principles_checked: 1,
          verdict: "BLOCKING",
          violations: [
            { file_path: null, message: "", principle_id: "pattern-bad", severity: "rule" },
          ],
        },
      ],
      run_metadata: {
        archived_at: "2026-01-02T01:00:00.000Z",
        branch: "main",
        completed_at: "2026-01-02T01:00:00.000Z",
        flow: "feature",
        slug: "block-2",
        started_at: "2026-01-02T00:00:00.000Z",
        task: "T",
        tier: "standard",
        total_duration_ms: 60_000,
      },
    });

    const summaries = [cleanSummary1, cleanSummary2, blockSummary1, blockSummary2];
    const result = analyzeCrossRunPatterns(store, summaries);

    const good = result.recurring_violations.find((v) => v.principle_id === "pattern-good");
    const bad = result.recurring_violations.find((v) => v.principle_id === "pattern-bad");

    // Both have occurrence_count === 2 (equal raw counts)
    expect(good?.occurrence_count).toBe(2);
    expect(bad?.occurrence_count).toBe(2);

    // But weighted_instance_count should differ — good > bad
    expect(good?.weighted_instance_count).toBeDefined();
    expect(bad?.weighted_instance_count).toBeDefined();
    expect(good!.weighted_instance_count!).toBeGreaterThan(bad!.weighted_instance_count!);
  });

  test("pattern with no matching summaries still has weighted_instance_count ≥ 0", () => {
    // Violations come only from drift.db reviews (no summaries to match)
    store.appendReview(
      makeReviewEntry({
        review_id: "rev_001",
        timestamp: "2026-01-01T00:00:00.000Z",
        violations: [{ principle_id: "drift-only", severity: "rule" }],
      }),
    );
    store.appendReview(
      makeReviewEntry({
        review_id: "rev_002",
        timestamp: "2026-01-02T00:00:00.000Z",
        violations: [{ principle_id: "drift-only", severity: "rule" }],
      }),
    );

    const result = analyzeCrossRunPatterns(store, []);
    const violation = result.recurring_violations.find((v) => v.principle_id === "drift-only");
    expect(violation).toBeDefined();
    expect(violation?.weighted_instance_count).toBeDefined();
    expect(violation!.weighted_instance_count!).toBeGreaterThanOrEqual(0);
  });
});

// Note: Bug 1 and Bug 2 summaryToOutcomeSignals tests are in cross-run-analyzer-p2-bugs.test.ts
