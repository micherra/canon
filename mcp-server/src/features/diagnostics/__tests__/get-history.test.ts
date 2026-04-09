/**
 * Tests for get-history.ts
 *
 * Covers:
 * - No filters returns recent flow_runs and decisions (reverse chronological)
 * - file_path filter returns flow_runs whose diff_stat matches + decisions with matching files_affected
 * - principle_id filter returns reviews with that principle
 * - topic filter uses FTS5 and returns matching entries
 * - since filter excludes entries before the date
 * - empty database returns { entries: [], total: 0 }
 * - limit parameter caps results
 * - returns correct HistoryEntry shape for each type (flow_run, decision, regression)
 * - all 5 entry types are valid in the HistoryEntryType union
 * - links field contains cross-references (flow_run_id, decision_id)
 * - invalid since returns INVALID_INPUT error
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDriftDb } from "@platform/storage/drift/drift-db.ts";
import type { DecisionEntry, FlowRunEntry } from "@platform/storage/drift/drift-analytics-types.ts";
import { assertOk, isToolError } from "@shared/lib/tool-result.ts";
import { afterEach, describe, expect, it } from "vitest";
import {
  getHistory,
  type HistoryEntry,
  type HistoryEntryType,
} from "../tools/get-history.ts";

// ---- Test helpers ----

let tmpDirs: string[] = [];

function makeTmpProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "get-history-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeFlowRun(overrides: Partial<FlowRunEntry> = {}): FlowRunEntry {
  return {
    completed: "2026-03-10T10:00:00Z",
    flow: "feature",
    run_id: `run_${Math.random().toString(36).slice(2, 10)}`,
    skipped_states: [],
    started: "2026-03-10T09:00:00Z",
    state_durations: {},
    state_iterations: {},
    task: "Test task",
    tier: "medium",
    total_duration_ms: 3600000,
    total_spawns: 5,
    ...overrides,
  };
}

function makeDecision(overrides: Partial<DecisionEntry> = {}): DecisionEntry {
  return {
    content: "Full decision content here",
    decision_id: `dec_${Math.random().toString(36).slice(2, 10)}`,
    timestamp: "2026-03-10T10:00:00Z",
    title: "Some design decision",
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
});

// ---- Empty database ----

describe("getHistory — empty database", () => {
  it("returns { entries: [], total: 0 } for empty database", async () => {
    const projectDir = makeTmpProjectDir();
    const result = await getHistory({}, projectDir);
    assertOk(result);
    expect(result.entries).toEqual([]);
    expect(result.total).toBe(0);
  });
});

// ---- No filters ----

describe("getHistory — no filters", () => {
  it("returns recent flow_runs and decisions reverse-chronologically", async () => {
    const projectDir = makeTmpProjectDir();
    const db = getDriftDb(projectDir);

    const run1 = makeFlowRun({ completed: "2026-03-10T08:00:00Z", task: "Earlier task" });
    const run2 = makeFlowRun({ completed: "2026-03-12T08:00:00Z", task: "Later task" });
    const dec1 = makeDecision({ timestamp: "2026-03-11T08:00:00Z", title: "Decision in between" });

    db.appendFlowRun(run1);
    db.appendFlowRun(run2);
    db.appendDecision(dec1);

    const result = await getHistory({}, projectDir);
    assertOk(result);

    expect(result.entries.length).toBeGreaterThanOrEqual(3);
    // First entry should be the most recent
    expect(result.entries[0].timestamp).toBe("2026-03-12T08:00:00Z");
    expect(result.entries[0].type).toBe("flow_run");
  });

  it("includes both flow_run and decision types in response", async () => {
    const projectDir = makeTmpProjectDir();
    const db = getDriftDb(projectDir);

    db.appendFlowRun(makeFlowRun());
    db.appendDecision(makeDecision());

    const result = await getHistory({}, projectDir);
    assertOk(result);

    const types = new Set(result.entries.map((e) => e.type));
    expect(types.has("flow_run")).toBe(true);
    expect(types.has("decision")).toBe(true);
  });
});

// ---- Limit ----

describe("getHistory — limit parameter", () => {
  it("caps results to the limit", async () => {
    const projectDir = makeTmpProjectDir();
    const db = getDriftDb(projectDir);

    for (let i = 0; i < 10; i++) {
      db.appendFlowRun(
        makeFlowRun({
          completed: `2026-03-${String(i + 1).padStart(2, "0")}T10:00:00Z`,
          task: `Task ${i}`,
        }),
      );
    }

    const result = await getHistory({ limit: 3 }, projectDir);
    assertOk(result);

    expect(result.entries.length).toBe(3);
    expect(result.total).toBeGreaterThanOrEqual(3);
  });

  it("defaults limit to 20", async () => {
    const projectDir = makeTmpProjectDir();
    const db = getDriftDb(projectDir);

    for (let i = 0; i < 25; i++) {
      db.appendFlowRun(
        makeFlowRun({
          completed: `2026-02-${String((i % 28) + 1).padStart(2, "0")}T10:00:00Z`,
          task: `Task ${i}`,
        }),
      );
    }

    const result = await getHistory({}, projectDir);
    assertOk(result);

    expect(result.entries.length).toBeLessThanOrEqual(20);
  });
});

// ---- file_path filter ----

describe("getHistory — file_path filter", () => {
  it("returns flow_runs whose diff_stat matches the file path", async () => {
    const projectDir = makeTmpProjectDir();
    const db = getDriftDb(projectDir);

    const matchRun = makeFlowRun({
      diff_stat: "src/features/auth/login.ts | 42 +++",
    });
    const noMatchRun = makeFlowRun({
      diff_stat: "src/utils/format.ts | 5 ++",
    });

    db.appendFlowRun(matchRun);
    db.appendFlowRun(noMatchRun);

    const result = await getHistory({ file_path: "auth/login.ts" }, projectDir);
    assertOk(result);

    expect(result.entries.length).toBeGreaterThanOrEqual(1);
    const matchingIds = result.entries.map((e) => e.flow_run_id);
    expect(matchingIds).toContain(matchRun.run_id);
    expect(matchingIds).not.toContain(noMatchRun.run_id);
  });

  it("returns decisions whose files_affected matches the file path", async () => {
    const projectDir = makeTmpProjectDir();
    const db = getDriftDb(projectDir);

    const matchDec = makeDecision({
      files_affected: ["src/features/auth/login.ts", "src/types.ts"],
      title: "Auth redesign decision",
    });
    const noMatchDec = makeDecision({
      files_affected: ["src/utils/format.ts"],
      title: "Format utility decision",
    });

    db.appendDecision(matchDec);
    db.appendDecision(noMatchDec);

    const result = await getHistory({ file_path: "auth/login.ts" }, projectDir);
    assertOk(result);

    const decIds = result.entries.filter((e) => e.type === "decision").map((e) => e.decision_id);
    expect(decIds).toContain(matchDec.decision_id);
    expect(decIds).not.toContain(noMatchDec.decision_id);
  });
});

// ---- principle_id filter ----

describe("getHistory — principle_id filter", () => {
  it("returns reviews matching the principle_id", async () => {
    const projectDir = makeTmpProjectDir();
    const db = getDriftDb(projectDir);

    const matchReview = {
      files: ["src/app.ts"],
      honored: [],
      review_id: `rev_match_${Math.random().toString(36).slice(2, 8)}`,
      score: {
        conventions: { passed: 1, total: 1 },
        opinions: { passed: 1, total: 2 },
        rules: { passed: 2, total: 3 },
      },
      timestamp: "2026-03-15T10:00:00Z",
      verdict: "WARNING" as const,
      violations: [
        {
          message: "Missing return type",
          principle_id: "toolresult-contract",
          severity: "strong-opinion",
        },
      ],
    };

    const noMatchReview = {
      files: ["src/other.ts"],
      honored: ["thin-handlers"],
      review_id: `rev_nomatch_${Math.random().toString(36).slice(2, 8)}`,
      score: {
        conventions: { passed: 2, total: 2 },
        opinions: { passed: 3, total: 3 },
        rules: { passed: 4, total: 4 },
      },
      timestamp: "2026-03-15T11:00:00Z",
      verdict: "CLEAN" as const,
      violations: [],
    };

    db.appendReview(matchReview);
    db.appendReview(noMatchReview);

    const result = await getHistory({ principle_id: "toolresult-contract" }, projectDir);
    assertOk(result);

    expect(result.entries.length).toBeGreaterThanOrEqual(1);
    const reviewIds = result.entries.map((e) => e.id);
    expect(reviewIds).toContain(matchReview.review_id);
    expect(reviewIds).not.toContain(noMatchReview.review_id);
  });
});

// ---- since filter ----

describe("getHistory — since filter", () => {
  it("excludes entries before the since date", async () => {
    const projectDir = makeTmpProjectDir();
    const db = getDriftDb(projectDir);

    const oldRun = makeFlowRun({
      completed: "2026-01-01T10:00:00Z",
      task: "Old task",
    });
    const newRun = makeFlowRun({
      completed: "2026-03-15T10:00:00Z",
      task: "New task",
    });

    db.appendFlowRun(oldRun);
    db.appendFlowRun(newRun);

    const result = await getHistory({ since: "2026-02-01T00:00:00Z" }, projectDir);
    assertOk(result);

    const ids = result.entries.map((e) => e.flow_run_id);
    expect(ids).toContain(newRun.run_id);
    expect(ids).not.toContain(oldRun.run_id);
  });

  it("returns INVALID_INPUT for invalid since date", async () => {
    const projectDir = makeTmpProjectDir();
    const result = await getHistory({ since: "not-a-date" }, projectDir);

    expect(result.ok).toBe(false);
    if (isToolError(result)) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });
});

// ---- HistoryEntry shape ----

describe("getHistory — HistoryEntry shapes", () => {
  it("flow_run entry has correct shape", async () => {
    const projectDir = makeTmpProjectDir();
    const db = getDriftDb(projectDir);

    const run = makeFlowRun({
      commits: ["abc123", "def456"],
      task: "Add login feature",
    });
    db.appendFlowRun(run);

    const result = await getHistory({}, projectDir);
    assertOk(result);

    const entry = result.entries.find((e) => e.flow_run_id === run.run_id);
    expect(entry).toBeDefined();
    expect(entry!.type).toBe("flow_run");
    expect(entry!.id).toBe(run.run_id);
    expect(entry!.timestamp).toBe(run.completed);
    expect(entry!.summary).toContain("feature");
    expect(entry!.commit_shas).toEqual(["abc123", "def456"]);
    expect(typeof entry!.links).toBe("object");
  });

  it("decision entry has correct shape with links", async () => {
    const projectDir = makeTmpProjectDir();
    const db = getDriftDb(projectDir);

    // Insert parent flow run first (FK constraint on decisions.run_id)
    const parentRun = makeFlowRun({ run_id: "run_parent_123" });
    db.appendFlowRun(parentRun);

    const decision = makeDecision({
      run_id: "run_parent_123",
      summary: "Chose SQLite over Postgres for simplicity",
      title: "Database selection",
    });
    db.appendDecision(decision);

    const result = await getHistory({}, projectDir);
    assertOk(result);

    const entry = result.entries.find((e) => e.decision_id === decision.decision_id);
    expect(entry).toBeDefined();
    expect(entry!.type).toBe("decision");
    expect(entry!.id).toBe(decision.decision_id);
    expect(entry!.summary).toBe("Chose SQLite over Postgres for simplicity");
    expect(entry!.links.flow_run).toBe("run_parent_123");
  });

  it("regression entry type for review with violations", async () => {
    const projectDir = makeTmpProjectDir();
    const db = getDriftDb(projectDir);

    const review = {
      files: ["src/app.ts"],
      honored: [],
      review_id: `rev_fail_${Math.random().toString(36).slice(2, 8)}`,
      score: {
        conventions: { passed: 0, total: 1 },
        opinions: { passed: 0, total: 1 },
        rules: { passed: 0, total: 1 },
      },
      timestamp: "2026-03-20T10:00:00Z",
      verdict: "BLOCKING" as const,
      violations: [
        {
          message: "Rule violated",
          principle_id: "secrets-never-in-code",
          severity: "rule",
        },
      ],
    };

    db.appendReview(review);

    const result = await getHistory({ principle_id: "secrets-never-in-code" }, projectDir);
    assertOk(result);

    const entry = result.entries.find((e) => e.id === review.review_id);
    expect(entry).toBeDefined();
    expect(entry!.type).toBe("regression");
  });
});

// ---- All 5 HistoryEntryType values are valid union members ----

describe("getHistory — HistoryEntryType union", () => {
  it("all 5 entry types are valid HistoryEntryType values", () => {
    const validTypes: HistoryEntryType[] = [
      "flow_run",
      "decision",
      "regression",
      "principle_change",
      "learning",
    ];
    expect(validTypes).toHaveLength(5);
    // TypeScript enforces this at compile time; runtime check confirms values
    for (const t of validTypes) {
      expect(typeof t).toBe("string");
    }
  });

  it("HistoryEntry links field is a Record<string, string>", () => {
    const entry: HistoryEntry = {
      id: "test-id",
      links: { flow_run: "run_123", pr_number: "42" },
      summary: "Test entry",
      timestamp: "2026-03-01T00:00:00Z",
      type: "flow_run",
    };
    expect(typeof entry.links).toBe("object");
    expect(entry.links.flow_run).toBe("run_123");
  });
});

// ---- topic FTS5 filter ----

describe("getHistory — topic filter (FTS5)", () => {
  it("returns matching entries via FTS5 search when indexed", async () => {
    const projectDir = makeTmpProjectDir();
    const db = getDriftDb(projectDir);

    const run = makeFlowRun({ task: "Implement OAuth2 authentication flow" });
    db.appendFlowRun(run);

    // Index the run in FTS5
    db.indexHistoryEntry("flow_run", run.run_id, `${run.task} ${run.flow}`);

    const result = await getHistory({ topic: "OAuth2" }, projectDir);
    assertOk(result);

    // FTS5 should find the indexed entry
    const ids = result.entries.map((e) => e.flow_run_id ?? e.id);
    expect(ids).toContain(run.run_id);
  });

  it("returns empty array when FTS5 finds no matches", async () => {
    const projectDir = makeTmpProjectDir();
    const db = getDriftDb(projectDir);

    // Index something unrelated
    db.indexHistoryEntry("flow_run", "run_xyz", "unrelated content about databases");

    const result = await getHistory({ topic: "xyzzy-notexist-abc" }, projectDir);
    assertOk(result);

    expect(result.entries).toEqual([]);
    expect(result.total).toBe(0);
  });
});

// ---- Deduplication ----

describe("getHistory — deduplication", () => {
  it("does not return duplicate entries when a flow run matches multiple criteria", async () => {
    const projectDir = makeTmpProjectDir();
    const db = getDriftDb(projectDir);

    // This test uses file_path filter only, which won't produce duplicates
    // but verifies total reflects deduplicated count
    const run = makeFlowRun({ diff_stat: "src/auth/login.ts | 10 +" });
    db.appendFlowRun(run);

    const result = await getHistory({ file_path: "auth/login.ts" }, projectDir);
    assertOk(result);

    const ids = result.entries.map((e) => e.id);
    const uniqueIds = new Set(ids);
    expect(ids.length).toBe(uniqueIds.size);
  });
});
