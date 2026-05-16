/**
 * violation-patterns tests — pure functions for normalizing and grouping violations.
 *
 * All functions under test are pure (no I/O), so no test setup is needed.
 */

import { describe, expect, test } from "vitest";
import type { ReviewEntry } from "../../schema.ts";
import {
  buildRecurringViolationResults,
  findRecurringViolations,
  groupViolationsByFile,
  groupViolationsByPrinciple,
  violationsFromReviews,
} from "../violation-patterns.ts";

// ---- Helpers ----

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
    timestamp: "2026-01-01T00:00:00.000Z",
    verdict: "CLEAN",
    violations: [],
    ...overrides,
  };
}

// ---- violationsFromReviews ----

describe("violationsFromReviews", () => {
  test("returns empty array when reviews array is empty", () => {
    expect(violationsFromReviews([])).toEqual([]);
  });

  test("returns empty array when reviews have no violations", () => {
    const reviews = [makeReviewEntry({ violations: [] }), makeReviewEntry({ violations: [] })];
    expect(violationsFromReviews(reviews)).toEqual([]);
  });

  test("extracts NormalizedViolation from a single review with one violation", () => {
    const reviews = [
      makeReviewEntry({
        timestamp: "2026-01-15T00:00:00.000Z",
        violations: [
          { file_path: "src/foo.ts", principle_id: "simplicity-first", severity: "rule" },
        ],
      }),
    ];
    const result = violationsFromReviews(reviews);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      filePath: "src/foo.ts",
      principleId: "simplicity-first",
      reviewTimestamp: "2026-01-15T00:00:00.000Z",
      severity: "rule",
    });
  });

  test("extracts multiple violations from a single review", () => {
    const reviews = [
      makeReviewEntry({
        timestamp: "2026-02-01T00:00:00.000Z",
        violations: [
          { principle_id: "principle-a", severity: "rule" },
          { file_path: "src/bar.ts", principle_id: "principle-b", severity: "strong-opinion" },
        ],
      }),
    ];
    const result = violationsFromReviews(reviews);
    expect(result).toHaveLength(2);
  });

  test("flattens violations across multiple reviews", () => {
    const reviews = [
      makeReviewEntry({
        timestamp: "2026-01-01T00:00:00.000Z",
        violations: [{ principle_id: "principle-a", severity: "rule" }],
      }),
      makeReviewEntry({
        timestamp: "2026-02-01T00:00:00.000Z",
        violations: [{ principle_id: "principle-b", severity: "convention" }],
      }),
    ];
    const result = violationsFromReviews(reviews);
    expect(result).toHaveLength(2);
  });

  test("treats missing file_path as null filePath", () => {
    const reviews = [
      makeReviewEntry({
        violations: [{ principle_id: "no-file", severity: "rule" }],
      }),
    ];
    const result = violationsFromReviews(reviews);
    expect(result[0].filePath).toBeNull();
  });

  test("handles null violations array gracefully (optional field)", () => {
    // ReviewEntry violations is an array, but test the undefined/empty case
    const reviews = [makeReviewEntry({ violations: [] })];
    expect(violationsFromReviews(reviews)).toEqual([]);
  });
});

// ---- groupViolationsByPrinciple ----

describe("groupViolationsByPrinciple", () => {
  test("returns empty map for empty violations array", () => {
    expect(groupViolationsByPrinciple([])).toEqual(new Map());
  });

  test("groups violations by principleId", () => {
    const violations = [
      {
        filePath: "src/a.ts",
        principleId: "principle-x",
        reviewTimestamp: "2026-01-01T00:00:00.000Z",
        severity: "rule",
      },
      {
        filePath: "src/b.ts",
        principleId: "principle-x",
        reviewTimestamp: "2026-01-02T00:00:00.000Z",
        severity: "rule",
      },
      {
        filePath: "src/c.ts",
        principleId: "principle-y",
        reviewTimestamp: "2026-01-03T00:00:00.000Z",
        severity: "convention",
      },
    ];
    const result = groupViolationsByPrinciple(violations);
    expect(result.size).toBe(2);
    expect(result.get("principle-x")?.timestamps).toHaveLength(2);
    expect(result.get("principle-y")?.timestamps).toHaveLength(1);
  });

  test("deduplicates file paths within the same principleId", () => {
    const violations = [
      {
        filePath: "src/foo.ts",
        principleId: "p",
        reviewTimestamp: "2026-01-01T00:00:00.000Z",
        severity: "rule",
      },
      {
        filePath: "src/foo.ts",
        principleId: "p",
        reviewTimestamp: "2026-01-02T00:00:00.000Z",
        severity: "rule",
      },
    ];
    const result = groupViolationsByPrinciple(violations);
    const group = result.get("p");
    expect(group?.files.size).toBe(1);
    expect(group?.files.has("src/foo.ts")).toBe(true);
  });

  test("collects all timestamps for the same principleId", () => {
    const violations = [
      {
        filePath: null,
        principleId: "p",
        reviewTimestamp: "2026-01-01T00:00:00.000Z",
        severity: "rule",
      },
      {
        filePath: null,
        principleId: "p",
        reviewTimestamp: "2026-01-02T00:00:00.000Z",
        severity: "rule",
      },
      {
        filePath: null,
        principleId: "p",
        reviewTimestamp: "2026-01-03T00:00:00.000Z",
        severity: "rule",
      },
    ];
    const result = groupViolationsByPrinciple(violations);
    expect(result.get("p")?.timestamps).toHaveLength(3);
  });

  test("ignores null filePaths (does not add to file set)", () => {
    const violations = [
      {
        filePath: null,
        principleId: "p",
        reviewTimestamp: "2026-01-01T00:00:00.000Z",
        severity: "rule",
      },
      {
        filePath: "src/bar.ts",
        principleId: "p",
        reviewTimestamp: "2026-01-02T00:00:00.000Z",
        severity: "rule",
      },
    ];
    const result = groupViolationsByPrinciple(violations);
    const group = result.get("p");
    expect(group?.files.size).toBe(1);
    expect(group?.files.has("src/bar.ts")).toBe(true);
  });
});

// ---- buildRecurringViolationResults ----

describe("buildRecurringViolationResults", () => {
  test("returns empty array for empty map", () => {
    expect(buildRecurringViolationResults(new Map())).toEqual([]);
  });

  test("filters out principles with fewer than 2 occurrences", () => {
    const byPrinciple = new Map([
      [
        "once",
        {
          files: new Set(["src/a.ts"]),
          severity: "rule",
          timestamps: ["2026-01-01T00:00:00.000Z"],
        },
      ],
    ]);
    expect(buildRecurringViolationResults(byPrinciple)).toEqual([]);
  });

  test("includes principles with 2+ occurrences", () => {
    const byPrinciple = new Map([
      [
        "recurring",
        {
          files: new Set(["src/a.ts"]),
          severity: "rule",
          timestamps: ["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"],
        },
      ],
    ]);
    const result = buildRecurringViolationResults(byPrinciple);
    expect(result).toHaveLength(1);
    expect(result[0].principle_id).toBe("recurring");
    expect(result[0].occurrence_count).toBe(2);
  });

  test("sorts results by occurrence_count descending", () => {
    const byPrinciple = new Map([
      ["low", { files: new Set<string>(), severity: "rule", timestamps: ["t1", "t2"] }],
      [
        "high",
        { files: new Set<string>(), severity: "rule", timestamps: ["t1", "t2", "t3", "t4"] },
      ],
      ["mid", { files: new Set<string>(), severity: "rule", timestamps: ["t1", "t2", "t3"] }],
    ]);
    const result = buildRecurringViolationResults(byPrinciple);
    expect(result).toHaveLength(3);
    expect(result[0].principle_id).toBe("high");
    expect(result[0].occurrence_count).toBe(4);
    expect(result[1].principle_id).toBe("mid");
    expect(result[1].occurrence_count).toBe(3);
    expect(result[2].principle_id).toBe("low");
    expect(result[2].occurrence_count).toBe(2);
  });

  test("computes first_seen and last_seen from sorted timestamps", () => {
    const byPrinciple = new Map([
      [
        "p",
        {
          files: new Set<string>(),
          severity: "rule",
          timestamps: [
            "2026-03-01T00:00:00.000Z",
            "2026-01-01T00:00:00.000Z",
            "2026-02-01T00:00:00.000Z",
          ],
        },
      ],
    ]);
    const result = buildRecurringViolationResults(byPrinciple);
    expect(result[0].first_seen).toBe("2026-01-01T00:00:00.000Z");
    expect(result[0].last_seen).toBe("2026-03-01T00:00:00.000Z");
  });

  test("spreads files Set into affected_files array", () => {
    const byPrinciple = new Map([
      [
        "p",
        {
          files: new Set(["src/a.ts", "src/b.ts"]),
          severity: "convention",
          timestamps: ["t1", "t2"],
        },
      ],
    ]);
    const result = buildRecurringViolationResults(byPrinciple);
    expect(result[0].affected_files).toContain("src/a.ts");
    expect(result[0].affected_files).toContain("src/b.ts");
  });
});

// ---- findRecurringViolations ----

describe("findRecurringViolations", () => {
  test("returns empty array for empty inputs", () => {
    expect(findRecurringViolations([], [])).toEqual([]);
  });

  test("combines summary violations and review violations", () => {
    const summaryViolations = [
      {
        filePath: null,
        principleId: "principle-x",
        reviewTimestamp: "2026-01-01T00:00:00.000Z",
        severity: "rule",
      },
    ];
    const reviews = [
      makeReviewEntry({
        timestamp: "2026-02-01T00:00:00.000Z",
        violations: [{ principle_id: "principle-x", severity: "rule" }],
      }),
    ];
    const result = findRecurringViolations(summaryViolations, reviews);
    expect(result).toHaveLength(1);
    expect(result[0].principle_id).toBe("principle-x");
    expect(result[0].occurrence_count).toBe(2);
  });

  test("returns only violations with occurrence_count >= 2", () => {
    // principle-a: 2 occurrences (recurring)
    // principle-b: 1 occurrence (not recurring)
    const summaryViolations = [
      {
        filePath: null,
        principleId: "principle-a",
        reviewTimestamp: "2026-01-01T00:00:00.000Z",
        severity: "rule",
      },
    ];
    const reviews = [
      makeReviewEntry({
        timestamp: "2026-02-01T00:00:00.000Z",
        violations: [
          { principle_id: "principle-a", severity: "rule" },
          { principle_id: "principle-b", severity: "strong-opinion" },
        ],
      }),
    ];
    const result = findRecurringViolations(summaryViolations, reviews);
    expect(result).toHaveLength(1);
    expect(result[0].principle_id).toBe("principle-a");
  });

  test("sorts results by occurrence_count descending", () => {
    const summaryViolations = [
      { filePath: null, principleId: "principle-a", reviewTimestamp: "t0", severity: "rule" },
      { filePath: null, principleId: "principle-a", reviewTimestamp: "t1", severity: "rule" },
      { filePath: null, principleId: "principle-b", reviewTimestamp: "t0", severity: "rule" },
    ];
    const reviews = [
      makeReviewEntry({
        timestamp: "2026-03-01T00:00:00.000Z",
        violations: [
          { principle_id: "principle-a", severity: "rule" },
          { principle_id: "principle-b", severity: "rule" },
        ],
      }),
    ];
    const result = findRecurringViolations(summaryViolations, reviews);
    // principle-a: 3 occurrences, principle-b: 2 occurrences
    expect(result[0].principle_id).toBe("principle-a");
    expect(result[1].principle_id).toBe("principle-b");
  });
});

// ---- groupViolationsByFile ----

describe("groupViolationsByFile", () => {
  test("returns empty map for empty violations array", () => {
    expect(groupViolationsByFile([])).toEqual(new Map());
  });

  test("groups violations by file path", () => {
    const violations = [
      { filePath: "src/a.ts", principleId: "p1", reviewTimestamp: "t1", severity: "rule" },
      { filePath: "src/a.ts", principleId: "p1", reviewTimestamp: "t2", severity: "rule" },
      { filePath: "src/b.ts", principleId: "p2", reviewTimestamp: "t1", severity: "convention" },
    ];
    const result = groupViolationsByFile(violations);
    expect(result.size).toBe(2);
    expect(result.has("src/a.ts")).toBe(true);
    expect(result.has("src/b.ts")).toBe(true);
  });

  test("counts per-principle occurrences per file", () => {
    const violations = [
      { filePath: "src/a.ts", principleId: "p1", reviewTimestamp: "t1", severity: "rule" },
      { filePath: "src/a.ts", principleId: "p1", reviewTimestamp: "t2", severity: "rule" },
      { filePath: "src/a.ts", principleId: "p2", reviewTimestamp: "t1", severity: "convention" },
    ];
    const result = groupViolationsByFile(violations);
    const entries = result.get("src/a.ts");
    expect(entries).toBeDefined();
    const p1Entry = entries?.find((e) => e.principleId === "p1");
    const p2Entry = entries?.find((e) => e.principleId === "p2");
    expect(p1Entry?.count).toBe(2);
    expect(p2Entry?.count).toBe(1);
  });

  test("skips violations with null filePath", () => {
    const violations = [
      { filePath: null, principleId: "p1", reviewTimestamp: "t1", severity: "rule" },
      { filePath: "src/a.ts", principleId: "p1", reviewTimestamp: "t2", severity: "rule" },
    ];
    const result = groupViolationsByFile(violations);
    expect(result.size).toBe(1);
    expect(result.has("src/a.ts")).toBe(true);
  });

  test("multiple principles per file each get their own entry", () => {
    const violations = [
      { filePath: "src/x.ts", principleId: "rule-a", reviewTimestamp: "t1", severity: "rule" },
      {
        filePath: "src/x.ts",
        principleId: "rule-b",
        reviewTimestamp: "t1",
        severity: "strong-opinion",
      },
    ];
    const result = groupViolationsByFile(violations);
    const entries = result.get("src/x.ts");
    expect(entries).toHaveLength(2);
  });

  test("handles violations with same principle across multiple files independently", () => {
    const violations = [
      { filePath: "src/a.ts", principleId: "shared-p", reviewTimestamp: "t1", severity: "rule" },
      { filePath: "src/b.ts", principleId: "shared-p", reviewTimestamp: "t1", severity: "rule" },
    ];
    const result = groupViolationsByFile(violations);
    expect(result.get("src/a.ts")?.[0].count).toBe(1);
    expect(result.get("src/b.ts")?.[0].count).toBe(1);
  });
});
