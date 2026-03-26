import { describe, it, expect } from "vitest";
import {
  normalizeStatus,
  evaluateTransition,
  applyReviewThresholdToCondition,
  buildHistoryEntry,
  isStuck,
  aggregateParallelPerResults,
} from "../orchestration/transitions.ts";
import type { StateDefinition, StuckWhen } from "../orchestration/flow-schema.ts";

describe("normalizeStatus", () => {
  it.each([
    ["DONE",                  "done"],
    ["FIXED",                 "done"],
    ["fixed",                 "done"],
    ["PARTIAL_FIX",           "done"],
    ["FINDINGS",              "done"],
    ["DONE_WITH_CONCERNS",    "done"],
    ["NEEDS_CONTEXT",         "hitl"],
    ["HAS_QUESTIONS",         "has_questions"],
    ["CLEAN",                 "clean"],
    ["WARNING",               "warning"],
    ["BLOCKING",              "blocking"],
    ["ALL_PASSING",           "all_passing"],
    ["IMPLEMENTATION_ISSUE",  "implementation_issue"],
    ["CANNOT_FIX",            "cannot_fix"],
    ["CRITICAL",              "critical"],
    ["UPDATED",               "updated"],
    ["NO_UPDATES",            "no_updates"],
    ["SomethingNew",          "somethingnew"],  // default: toLowerCase
  ])('normalizeStatus("%s") === "%s"', (input, expected) => {
    expect(normalizeStatus(input)).toBe(expected);
  });
});

describe("evaluateTransition", () => {
  it("returns target state when condition matches", () => {
    const state: StateDefinition = {
      type: "single",
      transitions: { done: "next_state", blocked: "error_state" },
    };
    expect(evaluateTransition(state, "done")).toBe("next_state");
  });

  it("returns null when condition does not match", () => {
    const state: StateDefinition = {
      type: "single",
      transitions: { done: "next_state" },
    };
    expect(evaluateTransition(state, "blocked")).toBeNull();
  });

  it("returns null for terminal state with no transitions", () => {
    const state: StateDefinition = {
      type: "terminal",
    };
    expect(evaluateTransition(state, "done")).toBeNull();
  });
});

describe("applyReviewThresholdToCondition", () => {
  const transitions = {
    clean: "next",
    warning: "warn_state",
    blocking: "block_state",
  };

  it("upgrades warning to blocking when threshold is warning", () => {
    const result = applyReviewThresholdToCondition("warning", "warning", transitions);
    expect(result).toBe("blocking");
  });

  it("leaves warning alone when threshold is blocking", () => {
    const result = applyReviewThresholdToCondition("blocking", "warning", transitions);
    expect(result).toBe("warning");
  });

  it("passes through when threshold is undefined", () => {
    const result = applyReviewThresholdToCondition(undefined, "warning", transitions);
    expect(result).toBe("warning");
  });

  it("does not affect non-warning conditions even with warning threshold", () => {
    const result = applyReviewThresholdToCondition("warning", "clean", transitions);
    expect(result).toBe("clean");
  });
});

describe("buildHistoryEntry", () => {
  it("builds same_violations entry", () => {
    const entry = buildHistoryEntry("same_violations", {
      principleIds: ["p1", "p2"],
      filePaths: ["a.ts", "b.ts"],
    });
    expect(entry).toEqual({
      principle_ids: ["p1", "p2"],
      file_paths: ["a.ts", "b.ts"],
    });
  });

  it("builds same_file_test entry", () => {
    const entry = buildHistoryEntry("same_file_test", {
      pairs: [{ file: "a.ts", test: "a.test.ts" }],
    });
    expect(entry).toEqual({
      pairs: [{ file: "a.ts", test: "a.test.ts" }],
    });
  });

  it("builds same_status entry", () => {
    const entry = buildHistoryEntry("same_status", { status: "warning" });
    expect(entry).toEqual({ status: "warning" });
  });

  it("builds no_progress entry", () => {
    const entry = buildHistoryEntry("no_progress", {
      commitSha: "abc123",
      artifactCount: 5,
    });
    expect(entry).toEqual({ commit_sha: "abc123", artifact_count: 5 });
  });
});

describe("isStuck", () => {
  it("returns false with fewer than 2 entries", () => {
    expect(isStuck([], "same_status")).toBe(false);
    expect(isStuck([{ status: "done" }], "same_status")).toBe(false);
  });

  describe("same_violations", () => {
    it("returns true when violations match", () => {
      const history = [
        { principle_ids: ["p1", "p2"], file_paths: ["a.ts"] },
        { principle_ids: ["p2", "p1"], file_paths: ["a.ts"] },
      ];
      expect(isStuck(history, "same_violations")).toBe(true);
    });

    it("returns false when violations differ", () => {
      const history = [
        { principle_ids: ["p1", "p2"], file_paths: ["a.ts"] },
        { principle_ids: ["p1"], file_paths: ["a.ts"] },
      ];
      expect(isStuck(history, "same_violations")).toBe(false);
    });
  });

  describe("same_file_test", () => {
    it("returns true when pairs are identical sets", () => {
      const history = [
        { pairs: [{ file: "a.ts", test: "a.test.ts" }, { file: "b.ts", test: "b.test.ts" }] },
        { pairs: [{ file: "b.ts", test: "b.test.ts" }, { file: "a.ts", test: "a.test.ts" }] },
      ];
      expect(isStuck(history, "same_file_test")).toBe(true);
    });

    it("returns false when current is a subset of previous (different lengths)", () => {
      const history = [
        { pairs: [{ file: "a.ts", test: "a.test.ts" }, { file: "b.ts", test: "b.test.ts" }] },
        { pairs: [{ file: "a.ts", test: "a.test.ts" }] },
      ];
      expect(isStuck(history, "same_file_test")).toBe(false);
    });

    it("returns false when current has new pairs", () => {
      const history = [
        { pairs: [{ file: "a.ts", test: "a.test.ts" }] },
        { pairs: [{ file: "c.ts", test: "c.test.ts" }] },
      ];
      expect(isStuck(history, "same_file_test")).toBe(false);
    });
  });

  describe("same_status", () => {
    it("returns true when statuses match", () => {
      const history = [{ status: "warning" }, { status: "warning" }];
      expect(isStuck(history, "same_status")).toBe(true);
    });

    it("returns false when statuses differ", () => {
      const history = [{ status: "warning" }, { status: "done" }];
      expect(isStuck(history, "same_status")).toBe(false);
    });
  });

  describe("no_progress", () => {
    it("returns true when commit and artifact count match", () => {
      const history = [
        { commit_sha: "abc", artifact_count: 3 },
        { commit_sha: "abc", artifact_count: 3 },
      ];
      expect(isStuck(history, "no_progress")).toBe(true);
    });

    it("returns false when commit differs", () => {
      const history = [
        { commit_sha: "abc", artifact_count: 3 },
        { commit_sha: "def", artifact_count: 3 },
      ];
      expect(isStuck(history, "no_progress")).toBe(false);
    });
  });
});

describe("aggregateParallelPerResults", () => {
  it("returns done when all results are done", () => {
    const results = [
      { status: "done", item: "a" },
      { status: "done", item: "b" },
    ];
    expect(aggregateParallelPerResults(results)).toEqual({
      condition: "done",
      cannotFixItems: [],
    });
  });

  it("returns done with cannotFixItems for mixed results", () => {
    const results = [
      { status: "done", item: "a" },
      { status: "cannot_fix", item: "b" },
      { status: "done", item: "c" },
    ];
    const result = aggregateParallelPerResults(results);
    expect(result.condition).toBe("done");
    expect(result.cannotFixItems).toEqual(["b"]);
  });

  it("returns cannot_fix when all results are cannot_fix", () => {
    const results = [
      { status: "cannot_fix", item: "a" },
      { status: "cannot_fix", item: "b" },
    ];
    const result = aggregateParallelPerResults(results);
    expect(result.condition).toBe("cannot_fix");
    expect(result.cannotFixItems).toEqual(["a", "b"]);
  });

  it("returns blocked when any result is blocked", () => {
    const results = [
      { status: "done", item: "a" },
      { status: "blocked", item: "b" },
      { status: "cannot_fix", item: "c" },
    ];
    expect(aggregateParallelPerResults(results)).toEqual({
      condition: "blocked",
      cannotFixItems: [],
    });
  });
});
