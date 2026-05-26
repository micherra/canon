/**
 * OutcomeStore Tests — DAO for violation_outcomes table (drift schema v7)
 *
 * Uses in-memory SQLite (:memory:) for speed and isolation.
 * Each test gets a fresh DB via initDriftDb(':memory:') which runs all migrations,
 * including v7 (violation_outcomes table).
 */

import type Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { initDriftDb } from "../drift-schema.ts";
import { OutcomeStore, type ViolationOutcome } from "../outcome-store.ts";

// ---- Setup helpers ----

function makeStore(): { db: Database.Database; store: OutcomeStore } {
  const db = initDriftDb(":memory:");
  const store = new OutcomeStore(db);
  return { db, store };
}

const makeOutcome = (overrides: Partial<ViolationOutcome> = {}): ViolationOutcome => ({
  file_path: "src/foo.ts",
  principle_id: "errors-are-values",
  action: "fix",
  slug: "my-workflow",
  timestamp: new Date().toISOString(),
  ...overrides,
});

// ---- recordOutcome ----

describe("OutcomeStore.recordOutcome", () => {
  test("inserts a new outcome record", () => {
    const { db, store } = makeStore();
    store.recordOutcome(makeOutcome());
    const rows = store.getOutcomesForPrinciple("errors-are-values");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      file_path: "src/foo.ts",
      principle_id: "errors-are-values",
      action: "fix",
      slug: "my-workflow",
    });
    db.close();
  });

  test("duplicate (file_path, principle_id, slug) replaces the previous record", () => {
    const { db, store } = makeStore();
    store.recordOutcome(makeOutcome({ action: "defer" }));
    store.recordOutcome(makeOutcome({ action: "fix" }));
    const rows = store.getOutcomesForPrinciple("errors-are-values");
    // Only one row — duplicate replaced
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("fix");
    db.close();
  });
});

// ---- getOutcomesForPrinciple ----

describe("OutcomeStore.getOutcomesForPrinciple", () => {
  test("returns all outcomes for a principle", () => {
    const { db, store } = makeStore();
    // Different files/slugs for same principle
    store.recordOutcome(makeOutcome({ file_path: "src/a.ts", slug: "wf-1" }));
    store.recordOutcome(makeOutcome({ file_path: "src/b.ts", slug: "wf-2" }));
    const rows = store.getOutcomesForPrinciple("errors-are-values");
    expect(rows).toHaveLength(2);
    db.close();
  });

  test("returns empty array for unknown principle", () => {
    const { db, store } = makeStore();
    const rows = store.getOutcomesForPrinciple("nonexistent-principle");
    expect(rows).toEqual([]);
    db.close();
  });
});

// ---- getOutcomeStats ----

describe("OutcomeStore.getOutcomeStats", () => {
  test("aggregates counts by action type", () => {
    const { db, store } = makeStore();
    store.recordOutcome(makeOutcome({ slug: "wf-1", action: "fix" }));
    store.recordOutcome(makeOutcome({ slug: "wf-2", action: "acknowledge" }));
    store.recordOutcome(makeOutcome({ slug: "wf-3", action: "defer" }));
    // All same principle but different slugs — 3 rows
    const stats = store.getOutcomeStats();
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      principle_id: "errors-are-values",
      fix_count: 1,
      acknowledge_count: 1,
      defer_count: 1,
      total: 3,
    });
    db.close();
  });

  test("returns empty array when no outcomes exist", () => {
    const { db, store } = makeStore();
    const stats = store.getOutcomeStats();
    expect(stats).toEqual([]);
    db.close();
  });

  test("filters by principleIds when provided", () => {
    const { db, store } = makeStore();
    store.recordOutcome(makeOutcome({ principle_id: "principle-a", slug: "wf-1" }));
    store.recordOutcome(makeOutcome({ principle_id: "principle-b", slug: "wf-2" }));
    store.recordOutcome(makeOutcome({ principle_id: "principle-c", slug: "wf-3" }));

    const stats = store.getOutcomeStats(["principle-a", "principle-b"]);
    expect(stats).toHaveLength(2);
    const ids = stats.map((s) => s.principle_id);
    expect(ids).toContain("principle-a");
    expect(ids).toContain("principle-b");
    expect(ids).not.toContain("principle-c");
    db.close();
  });
});

// ---- getOutcomesForFiles ----

describe("OutcomeStore.getOutcomesForFiles", () => {
  test("returns outcomes matching file paths", () => {
    const { db, store } = makeStore();
    store.recordOutcome(makeOutcome({ file_path: "src/target.ts", slug: "wf-1" }));
    store.recordOutcome(makeOutcome({ file_path: "src/other.ts", slug: "wf-2" }));
    const rows = store.getOutcomesForFiles(["src/target.ts"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].file_path).toBe("src/target.ts");
    db.close();
  });

  test("returns empty array for unknown files", () => {
    const { db, store } = makeStore();
    store.recordOutcome(makeOutcome());
    const rows = store.getOutcomesForFiles(["src/unknown.ts"]);
    expect(rows).toEqual([]);
    db.close();
  });
});

// ---- Schema migration ----

describe("Schema migration (v7)", () => {
  test("creates the violation_outcomes table", () => {
    const { db } = makeStore();
    // PRAGMA table_info returns rows if the table exists
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='violation_outcomes'")
      .all();
    expect(rows).toHaveLength(1);
    db.close();
  });
});
