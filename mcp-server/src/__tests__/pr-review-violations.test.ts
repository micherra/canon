import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DriftStore } from "../drift/store.ts";
import type { ReviewEntry } from "../schema.ts";
import { buildFileViolationMap } from "../tools/pr-review-data.ts";

describe("buildFileViolationMap — unit", () => {
  it("returns empty map for empty reviews array", () => {
    const result = buildFileViolationMap([]);
    expect(result.size).toBe(0);
  });

  it("groups violations by file_path", () => {
    const reviews: ReviewEntry[] = [
      {
        files: ["src/tools/foo.ts"],
        honored: [],
        review_id: "rev_1",
        score: {
          conventions: { passed: 0, total: 0 },
          opinions: { passed: 0, total: 2 },
          rules: { passed: 1, total: 1 },
        },
        timestamp: "2026-03-20T10:00:00Z",
        verdict: "WARNING",
        violations: [
          {
            file_path: "src/tools/foo.ts",
            message: "Too many responsibilities",
            principle_id: "functions-do-one-thing",
            severity: "strong-opinion",
          },
          {
            file_path: "src/graph/bar.ts",
            principle_id: "no-hidden-side-effects",
            severity: "strong-opinion",
          },
        ],
      },
    ];

    const result = buildFileViolationMap(reviews);

    expect(result.size).toBe(2);

    const fooViolations = result.get("src/tools/foo.ts");
    expect(fooViolations).toHaveLength(1);
    expect(fooViolations![0].principle_id).toBe("functions-do-one-thing");
    expect(fooViolations![0].severity).toBe("strong-opinion");
    expect(fooViolations![0].message).toBe("Too many responsibilities");

    const barViolations = result.get("src/graph/bar.ts");
    expect(barViolations).toHaveLength(1);
    expect(barViolations![0].principle_id).toBe("no-hidden-side-effects");
  });

  it("falls back to review.files[0] when violation has no file_path", () => {
    const reviews: ReviewEntry[] = [
      {
        files: ["src/tools/fallback.ts"],
        honored: [],
        review_id: "rev_2",
        score: {
          conventions: { passed: 0, total: 0 },
          opinions: { passed: 0, total: 1 },
          rules: { passed: 0, total: 0 },
        },
        timestamp: "2026-03-20T11:00:00Z",
        verdict: "WARNING",
        violations: [
          {
            principle_id: "simplicity-first",
            severity: "strong-opinion",
            // no file_path
          },
        ],
      },
    ];

    const result = buildFileViolationMap(reviews);
    expect(result.size).toBe(1);

    const violations = result.get("src/tools/fallback.ts");
    expect(violations).toHaveLength(1);
    expect(violations![0].principle_id).toBe("simplicity-first");
  });

  it("handles multiple reviews with overlapping files (accumulates, does not overwrite)", () => {
    const reviews: ReviewEntry[] = [
      {
        files: ["src/shared.ts"],
        honored: [],
        review_id: "rev_3",
        score: {
          conventions: { passed: 0, total: 0 },
          opinions: { passed: 0, total: 0 },
          rules: { passed: 0, total: 1 },
        },
        timestamp: "2026-03-18T10:00:00Z",
        verdict: "BLOCKING",
        violations: [
          {
            file_path: "src/shared.ts",
            principle_id: "principle-a",
            severity: "rule",
          },
        ],
      },
      {
        files: ["src/shared.ts"],
        honored: [],
        review_id: "rev_4",
        score: {
          conventions: { passed: 0, total: 1 },
          opinions: { passed: 0, total: 0 },
          rules: { passed: 0, total: 0 },
        },
        timestamp: "2026-03-19T10:00:00Z",
        verdict: "WARNING",
        violations: [
          {
            file_path: "src/shared.ts",
            principle_id: "principle-b",
            severity: "convention",
          },
        ],
      },
    ];

    const result = buildFileViolationMap(reviews);
    expect(result.size).toBe(1);

    const violations = result.get("src/shared.ts");
    expect(violations).toHaveLength(2);
    const ids = violations!.map((v) => v.principle_id);
    expect(ids).toContain("principle-a");
    expect(ids).toContain("principle-b");
  });

  it("maps all three severity values correctly", () => {
    const reviews: ReviewEntry[] = [
      {
        files: ["src/multi.ts"],
        honored: [],
        review_id: "rev_5",
        score: {
          conventions: { passed: 0, total: 1 },
          opinions: { passed: 0, total: 1 },
          rules: { passed: 0, total: 1 },
        },
        timestamp: "2026-03-20T12:00:00Z",
        verdict: "BLOCKING",
        violations: [
          { file_path: "src/a.ts", principle_id: "p-rule", severity: "rule" },
          { file_path: "src/b.ts", principle_id: "p-opinion", severity: "strong-opinion" },
          { file_path: "src/c.ts", principle_id: "p-conv", severity: "convention" },
        ],
      },
    ];

    const result = buildFileViolationMap(reviews);

    expect(result.get("src/a.ts")![0].severity).toBe("rule");
    expect(result.get("src/b.ts")![0].severity).toBe("strong-opinion");
    expect(result.get("src/c.ts")![0].severity).toBe("convention");
  });

  it("skips violations with no file_path and empty files array", () => {
    const reviews: ReviewEntry[] = [
      {
        files: [],
        honored: [],
        review_id: "rev_6",
        score: {
          conventions: { passed: 0, total: 1 },
          opinions: { passed: 0, total: 0 },
          rules: { passed: 0, total: 0 },
        },
        timestamp: "2026-03-20T13:00:00Z",
        verdict: "WARNING",
        violations: [
          {
            principle_id: "orphan-principle",
            severity: "convention",
            // no file_path, files is empty
          },
        ],
      },
    ];

    const result = buildFileViolationMap(reviews);
    expect(result.size).toBe(0);
  });
});

describe("getPrReviewData — violations integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-violations-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("attaches violations from DriftStore reviews to matching PrFileInfo entries", async () => {
    // Write a reviews.jsonl with a known violation for a changed file
    const review: ReviewEntry = {
      files: ["src/tools/some-tool.ts"],
      honored: ["no-hidden-side-effects"],
      review_id: "rev_integration",
      score: {
        conventions: { passed: 0, total: 0 },
        opinions: { passed: 0, total: 1 },
        rules: { passed: 1, total: 1 },
      },
      timestamp: "2026-03-25T10:00:00Z",
      verdict: "WARNING",
      violations: [
        {
          file_path: "src/tools/some-tool.ts",
          message: "Does too many things",
          principle_id: "functions-do-one-thing",
          severity: "strong-opinion",
        },
      ],
    };
    // Seed review via DriftStore (which uses SQLite, not reviews.jsonl)
    const driftStore = new DriftStore(tmpDir);
    await driftStore.appendReview(review);

    const diffOutput = "M\tsrc/tools/some-tool.ts\nA\tsrc/tools/new-file.ts\n";
    vi.doMock("child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => cb(null, diffOutput, ""),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    const changedFile = result.impact_files.find((f) => f.path === "src/tools/some-tool.ts");
    expect(changedFile).toBeDefined();
    expect(changedFile!.violations).toHaveLength(1);
    expect(changedFile!.violations![0].principle_id).toBe("functions-do-one-thing");
    expect(changedFile!.violations![0].severity).toBe("strong-opinion");
    expect(changedFile!.violations![0].message).toBe("Does too many things");
  });

  it("files with no violations are excluded from impact_files", async () => {
    // No reviews.jsonl at all
    const diffOutput = "M\tsrc/some-clean-file.ts\n";
    vi.doMock("child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => cb(null, diffOutput, ""),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    // Low-risk file with no violations should be in files (summary) but not impact_files
    expect(result.files.find((f) => f.path === "src/some-clean-file.ts")).toBeDefined();
    expect(result.impact_files.find((f) => f.path === "src/some-clean-file.ts")).toBeUndefined();
  });
});
