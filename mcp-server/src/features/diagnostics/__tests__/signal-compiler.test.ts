/**
 * Tests for the Signal Compiler service.
 *
 * Each test creates an in-memory drift.db, seeds data via DriftDbSignals,
 * and calls compileSignals to verify the output shape and scoring behavior.
 */

import type {
  FileViolationHistoryRow,
  PathEffectRow,
} from "@platform/storage/drift/drift-db-signals.ts";
import { DriftDbSignals } from "@platform/storage/drift/drift-db-signals.ts";
import { initDriftDb } from "@platform/storage/drift/drift-schema.ts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  compileSignals,
  scorePathEffect,
  scoreViolationHistory,
} from "../services/signal-compiler.ts";

// ---- Helpers ----

function makeViolationRow(
  overrides: Partial<FileViolationHistoryRow> = {},
): FileViolationHistoryRow {
  return {
    file_path: "src/foo.ts",
    first_seen: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    last_seen: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), // 10 days ago
    principle_id: "simplicity-first",
    violation_count: 3,
    ...overrides,
  };
}

function makePathEffectRow(overrides: Partial<PathEffectRow> = {}): PathEffectRow {
  return {
    clean_streak: 0,
    file_path: "src/foo.ts",
    last_clean_at: null,
    last_violation_at: null,
    total_reviews: 5,
    total_violations: 2,
    violation_streak: 1,
    ...overrides,
  };
}

// ---- Test Setup ----

describe("compileSignals", () => {
  let db: ReturnType<typeof initDriftDb>;
  let signals: DriftDbSignals;

  beforeEach(() => {
    db = initDriftDb(":memory:");
    signals = new DriftDbSignals(db);
  });

  // Test 1: empty file paths returns empty array
  it("returns empty array for empty file paths", () => {
    const result = compileSignals([], signals);
    expect(result).toEqual([]);
  });

  // Test 2: file with no data returns FileSignals with empty signals
  it("returns FileSignals with empty signals for files with no data", () => {
    const result = compileSignals(["src/no-data.ts"], signals);
    expect(result).toHaveLength(1);
    expect(result[0]!.file_path).toBe("src/no-data.ts");
    expect(result[0]!.signals).toEqual([]);
  });

  // Test 3: violation_history signals from file_violation_history table
  it("returns violation_history signals from file_violation_history table", () => {
    signals.upsertFileViolation({
      file_path: "src/foo.ts",
      first_seen: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      last_seen: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      principle_id: "simplicity-first",
      violation_count: 3,
    });

    const result = compileSignals(["src/foo.ts"], signals);
    expect(result).toHaveLength(1);
    const fileSignals = result[0]!;
    expect(fileSignals.file_path).toBe("src/foo.ts");
    expect(fileSignals.signals).toHaveLength(1);
    expect(fileSignals.signals[0]!.type).toBe("violation_history");
    expect(fileSignals.signals[0]!.text).toContain("simplicity-first");
    expect(fileSignals.signals[0]!.text).toContain("3");
  });

  // Test 4: path_effect signals from path_effects table
  it("returns path_effect signals from path_effects table", () => {
    signals.upsertPathEffect({
      clean_streak: 0,
      file_path: "src/foo.ts",
      last_clean_at: null,
      last_violation_at: "2026-05-01T00:00:00.000Z",
      total_reviews: 10,
      total_violations: 5,
      violation_streak: 3,
    });

    const result = compileSignals(["src/foo.ts"], signals);
    expect(result).toHaveLength(1);
    const fileSignals = result[0]!;
    expect(fileSignals.signals).toHaveLength(1);
    expect(fileSignals.signals[0]!.type).toBe("path_effect");
    expect(fileSignals.signals[0]!.text).toContain("10");
    expect(fileSignals.signals[0]!.text).toContain("5");
  });

  // Test 5: signals sorted by priority (highest first via fitWithinBudget)
  it("sorts signals by priority with highest priority first", () => {
    // High violation count (recent) → high priority
    signals.upsertFileViolation({
      file_path: "src/foo.ts",
      first_seen: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      last_seen: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(), // 20 days — no recency boost
      principle_id: "no-dead-abstractions",
      violation_count: 1,
    });
    signals.upsertFileViolation({
      file_path: "src/foo.ts",
      first_seen: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      last_seen: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(), // 1 day ago — recency boost
      principle_id: "simplicity-first",
      violation_count: 10,
    });

    const result = compileSignals(["src/foo.ts"], signals, { tokenBudgetPerFile: 10000 });
    const fileSignals = result[0]!;

    // simplicity-first: min(10,10) + 3 = 13; no-dead-abstractions: min(1,10) + 0 = 1
    expect(fileSignals.signals.length).toBeGreaterThanOrEqual(2);
    expect(fileSignals.signals[0]!.priority).toBeGreaterThan(fileSignals.signals[1]!.priority);
    expect(fileSignals.signals[0]!.text).toContain("simplicity-first");
  });

  // Test 6: token budget enforcement — excess signals are dropped
  it("respects token budget and drops excess signals", () => {
    // Seed many violations
    for (let i = 0; i < 10; i++) {
      signals.upsertFileViolation({
        file_path: "src/foo.ts",
        first_seen: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
        last_seen: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        principle_id: `principle-${i}`,
        violation_count: 1,
      });
    }

    // Very tight budget — only room for ~1 signal
    const result = compileSignals(["src/foo.ts"], signals, { tokenBudgetPerFile: 10 });
    const fileSignals = result[0]!;
    // With only 10 tokens, most signals will be dropped
    expect(fileSignals.signals.length).toBeLessThan(10);
  });

  // Test 7: recency boost for violations seen within 7 days
  it("applies recency boost to violations seen within 7 days", () => {
    const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago
    const oldDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(); // 14 days ago

    const recentRow = makeViolationRow({
      last_seen: recentDate,
      principle_id: "recent-principle",
      violation_count: 3,
    });
    const oldRow = makeViolationRow({
      last_seen: oldDate,
      principle_id: "old-principle",
      violation_count: 3,
    });

    const recentScore = scoreViolationHistory(recentRow);
    const oldScore = scoreViolationHistory(oldRow);

    // Recent violation should score higher by 3 (recency boost)
    expect(recentScore).toBe(oldScore + 3);
  });

  // Test 8: violation_count contribution capped at 10
  it("caps violation_count contribution at 10 to prevent outlier dominance", () => {
    const row10 = makeViolationRow({ violation_count: 10 });
    const row100 = makeViolationRow({ violation_count: 100 });

    const score10 = scoreViolationHistory(row10);
    const score100 = scoreViolationHistory(row100);

    // Both should produce same base score (capped at 10)
    expect(score10).toBe(score100);
  });

  // Test 9: multiple files with per-file budget enforcement
  it("handles multiple files with independent per-file budget enforcement", () => {
    signals.upsertFileViolation({
      file_path: "src/a.ts",
      first_seen: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      last_seen: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
      principle_id: "simplicity-first",
      violation_count: 5,
    });
    signals.upsertFileViolation({
      file_path: "src/b.ts",
      first_seen: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
      last_seen: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      principle_id: "no-dead-abstractions",
      violation_count: 2,
    });

    const result = compileSignals(["src/a.ts", "src/b.ts", "src/c.ts"], signals);
    expect(result).toHaveLength(3);

    const aSignals = result.find((r) => r.file_path === "src/a.ts")!;
    const bSignals = result.find((r) => r.file_path === "src/b.ts")!;
    const cSignals = result.find((r) => r.file_path === "src/c.ts")!;

    expect(aSignals).toBeDefined();
    expect(bSignals).toBeDefined();
    expect(cSignals).toBeDefined();

    expect(aSignals.signals).toHaveLength(1);
    expect(aSignals.signals[0]!.text).toContain("simplicity-first");

    expect(bSignals.signals).toHaveLength(1);
    expect(bSignals.signals[0]!.text).toContain("no-dead-abstractions");

    expect(cSignals.signals).toHaveLength(0);
  });

  // Test 10: scoreViolationHistory gives higher score for recent violations
  it("scoreViolationHistory returns higher score for recent violations", () => {
    const recent = makeViolationRow({
      last_seen: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const old = makeViolationRow({
      last_seen: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    expect(scoreViolationHistory(recent)).toBeGreaterThan(scoreViolationHistory(old));
  });

  // Test 11: scorePathEffect gives higher score for files with violation streaks
  it("scorePathEffect returns higher score for files with violation streaks", () => {
    const highStreak = makePathEffectRow({ total_violations: 2, violation_streak: 5 });
    const lowStreak = makePathEffectRow({ total_violations: 2, violation_streak: 1 });

    expect(scorePathEffect(highStreak)).toBeGreaterThan(scorePathEffect(lowStreak));
  });

  // Test 12: signal text contains human-readable context
  it("signal text contains human-readable context (principle_id, counts, timestamps)", () => {
    signals.upsertFileViolation({
      file_path: "src/foo.ts",
      first_seen: "2026-04-01T12:00:00.000Z",
      last_seen: "2026-05-10T12:00:00.000Z",
      principle_id: "simplicity-first",
      violation_count: 7,
    });
    signals.upsertPathEffect({
      clean_streak: 0,
      file_path: "src/foo.ts",
      last_clean_at: null,
      last_violation_at: "2026-05-10T12:00:00.000Z",
      total_reviews: 12,
      total_violations: 7,
      violation_streak: 3,
    });

    const result = compileSignals(["src/foo.ts"], signals, { tokenBudgetPerFile: 10000 });
    const fileSignals = result[0]!;

    const violationSignal = fileSignals.signals.find((s) => s.type === "violation_history");
    const pathSignal = fileSignals.signals.find((s) => s.type === "path_effect");

    expect(violationSignal).toBeDefined();
    expect(violationSignal!.text).toContain("simplicity-first");
    expect(violationSignal!.text).toContain("7");
    expect(violationSignal!.text).toContain("2026-05-10");

    expect(pathSignal).toBeDefined();
    expect(pathSignal!.text).toContain("12"); // total_reviews
    expect(pathSignal!.text).toContain("7"); // total_violations
    expect(pathSignal!.text).toContain("3"); // violation_streak
  });
});

// ---- Scoring unit tests ----

describe("scoreViolationHistory", () => {
  it("uses base score of min(violation_count, 10)", () => {
    const row5 = makeViolationRow({
      last_seen: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      violation_count: 5,
    });
    expect(scoreViolationHistory(row5)).toBe(5);
  });

  it("adds recency boost of 3 when last_seen is within 7 days", () => {
    const row = makeViolationRow({
      last_seen: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days ago
      violation_count: 5,
    });
    expect(scoreViolationHistory(row)).toBe(8); // 5 + 3
  });

  it("does not add recency boost when last_seen is older than 7 days", () => {
    const row = makeViolationRow({
      last_seen: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), // 8 days ago
      violation_count: 5,
    });
    expect(scoreViolationHistory(row)).toBe(5); // no boost
  });
});

describe("scorePathEffect", () => {
  it("returns streak*2 + min(total_violations, 5)", () => {
    const row = makePathEffectRow({ total_violations: 10, violation_streak: 3 });
    expect(scorePathEffect(row)).toBe(3 * 2 + 5); // 6 + 5 = 11
  });

  it("caps total_violations contribution at 5", () => {
    const row5 = makePathEffectRow({ total_violations: 5, violation_streak: 0 });
    const row100 = makePathEffectRow({ total_violations: 100, violation_streak: 0 });
    expect(scorePathEffect(row5)).toBe(scorePathEffect(row100));
  });
});
