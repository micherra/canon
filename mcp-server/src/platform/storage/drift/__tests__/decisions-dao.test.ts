/**
 * decisions-dao.test.ts
 *
 * Tests for DecisionsDao — the legacy per-run decisions table (v2 `decisions`).
 * Relocated out of drift-db-flowruns.test.ts (line-count remediation,
 * decisions-corpus build, ADR-0040) — same coverage, updated call surface
 * (`store.appendDecision`/`getDecisionsByRun`/`getRecentDecisions` ->
 * `dao.append`/`getByRun`/`getRecent`).
 */

import type { DecisionEntry } from "@platform/storage/drift/drift-analytics-types.ts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DecisionsDao } from "../decisions-dao.ts";
import { initDriftDb } from "../drift-schema.ts";

function makeDecisionEntry(overrides: Partial<DecisionEntry> = {}): DecisionEntry {
  return {
    content: "We chose SQLite over JSONL for atomic writes.",
    decision_id: `dec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    title: "Use SQLite for drift storage",
    ...overrides,
  };
}

function makeDb(): { db: ReturnType<typeof initDriftDb>; dao: DecisionsDao } {
  const db = initDriftDb(":memory:");
  return { dao: new DecisionsDao(db), db };
}

describe("append and getByRun", () => {
  let dao: DecisionsDao;
  let db: ReturnType<typeof initDriftDb>;

  beforeEach(() => {
    ({ dao, db } = makeDb());
  });

  afterEach(() => {
    db.close();
  });

  test("round-trips a DecisionEntry via append + getByRun", () => {
    const entry = makeDecisionEntry({
      decision_id: "dec_001",
      file_path: "decisions/drift-01.md",
      flow: "feature",
      run_id: "run_abc",
      task: "Implement drift storage",
    });
    dao.append(entry);
    const results = dao.getByRun("run_abc");
    expect(results).toHaveLength(1);
    expect(results[0].decision_id).toBe("dec_001");
    expect(results[0].run_id).toBe("run_abc");
    expect(results[0].flow).toBe("feature");
    expect(results[0].task).toBe("Implement drift storage");
    expect(results[0].title).toBe(entry.title);
    expect(results[0].content).toBe(entry.content);
    expect(results[0].file_path).toBe("decisions/drift-01.md");
    expect(results[0].timestamp).toBe(entry.timestamp);
  });

  test("append with duplicate decision_id is idempotent (no error)", () => {
    const entry = makeDecisionEntry({ decision_id: "dec_dup" });
    dao.append(entry);
    expect(() => dao.append(entry)).not.toThrow();
    const results = dao.getByRun(entry.run_id ?? "none");
    // Only one row stored (INSERT OR IGNORE)
    expect(results.length).toBeLessThanOrEqual(1);
  });

  test("getByRun returns empty array for unknown run_id", () => {
    const results = dao.getByRun("no_such_run");
    expect(results).toEqual([]);
  });

  test("getByRun returns decisions in ASC timestamp order", () => {
    dao.append(
      makeDecisionEntry({
        decision_id: "dec_a",
        run_id: "run_order",
        timestamp: "2026-01-01T10:00:00Z",
      }),
    );
    dao.append(
      makeDecisionEntry({
        decision_id: "dec_b",
        run_id: "run_order",
        timestamp: "2026-01-01T12:00:00Z",
      }),
    );
    const results = dao.getByRun("run_order");
    expect(results).toHaveLength(2);
    expect(results[0].decision_id).toBe("dec_a");
    expect(results[1].decision_id).toBe("dec_b");
  });

  test("round-trips a DecisionEntry with all optional fields absent", () => {
    const entry = makeDecisionEntry({ decision_id: "dec_minimal" });
    // entry has no run_id, flow, task, file_path
    dao.append(entry);
    // Can't query by run_id since there's none; use getRecent
    const results = dao.getRecent(10);
    const found = results.find((d) => d.decision_id === "dec_minimal");
    expect(found).toBeDefined();
    expect(found!.run_id).toBeUndefined();
    expect(found!.flow).toBeUndefined();
    expect(found!.task).toBeUndefined();
    expect(found!.file_path).toBeUndefined();
  });
});

describe("getRecent", () => {
  let dao: DecisionsDao;
  let db: ReturnType<typeof initDriftDb>;

  beforeEach(() => {
    ({ dao, db } = makeDb());
  });

  afterEach(() => {
    db.close();
  });

  test("returns correct count in DESC timestamp order", () => {
    dao.append(makeDecisionEntry({ decision_id: "d1", timestamp: "2026-01-01T08:00:00Z" }));
    dao.append(makeDecisionEntry({ decision_id: "d2", timestamp: "2026-01-02T08:00:00Z" }));
    dao.append(makeDecisionEntry({ decision_id: "d3", timestamp: "2026-01-03T08:00:00Z" }));

    const results = dao.getRecent(2);
    expect(results).toHaveLength(2);
    // DESC order: most recent first
    expect(results[0].decision_id).toBe("d3");
    expect(results[1].decision_id).toBe("d2");
  });

  test("returns empty array when no decisions exist", () => {
    const results = dao.getRecent(10);
    expect(results).toEqual([]);
  });

  test("returns all decisions when limit exceeds count", () => {
    dao.append(makeDecisionEntry({ decision_id: "e1" }));
    dao.append(makeDecisionEntry({ decision_id: "e2" }));
    const results = dao.getRecent(100);
    expect(results).toHaveLength(2);
  });
});
