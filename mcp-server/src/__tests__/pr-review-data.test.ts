import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { getPrReviewData, recordPrReview } from "../tools/pr-review-data.js";
import { PrStore } from "../drift/pr-store.js";

describe("getPrReviewData", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-review-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("generates diff command for PR number", async () => {
    const result = await getPrReviewData(
      { pr_number: 42 },
      tmpDir,
      "/nonexistent"
    );
    expect(result.diff_command).toContain("gh pr diff 42");
  });

  it("generates diff command for branch", async () => {
    const result = await getPrReviewData(
      { branch: "feature/auth", diff_base: "main" },
      tmpDir,
      "/nonexistent"
    );
    expect(result.diff_command).toContain("git diff main..feature/auth");
  });

  it("defaults to main..HEAD without branch or PR", async () => {
    const result = await getPrReviewData({}, tmpDir, "/nonexistent");
    expect(result.diff_command).toContain("git diff main..HEAD");
  });

  it("supports incremental review with last reviewed SHA", async () => {
    // Seed a previous review
    const store = new PrStore(tmpDir);
    await store.appendReview({
      pr_review_id: "prrev_test",
      timestamp: "2026-03-16T00:00:00Z",
      pr_number: 42,
      last_reviewed_sha: "abc123",
      verdict: "WARNING",
      files: ["src/foo.ts"],
      violations: [{ principle_id: "p1", severity: "strong-opinion" }],
      honored: [],
      score: {
        rules: { passed: 1, total: 1 },
        opinions: { passed: 0, total: 1 },
        conventions: { passed: 0, total: 0 },
      },
    });

    const result = await getPrReviewData(
      { pr_number: 42, incremental: true },
      tmpDir,
      "/nonexistent"
    );
    expect(result.incremental).toBe(true);
    expect(result.last_reviewed_sha).toBe("abc123");
    expect(result.diff_command).toContain("git diff abc123..HEAD");
  });
});

describe("recordPrReview", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-record-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("records a PR review and writes to pr-reviews.jsonl", async () => {
    const result = await recordPrReview(
      {
        pr_number: 42,
        verdict: "CLEAN",
        files: ["src/foo.ts"],
        violations: [],
        honored: ["p1"],
        score: {
          rules: { passed: 1, total: 1 },
          opinions: { passed: 1, total: 1 },
          conventions: { passed: 0, total: 0 },
        },
      },
      tmpDir
    );

    expect(result.recorded).toBe(true);
    expect(result.id).toMatch(/^prrev_\d{8}_[0-9a-f]{4}$/);

    const content = await readFile(
      join(tmpDir, ".canon", "pr-reviews.jsonl"),
      "utf-8"
    );
    const entries = content
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    expect(entries).toHaveLength(1);
    expect(entries[0].pr_number).toBe(42);
    expect(entries[0].verdict).toBe("CLEAN");
  });
});

describe("PrStore", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-store-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("filters reviews by PR number", async () => {
    const store = new PrStore(tmpDir);
    await store.appendReview({
      pr_review_id: "prrev_1",
      timestamp: "2026-03-16T00:00:00Z",
      pr_number: 42,
      verdict: "CLEAN",
      files: [],
      violations: [],
      honored: [],
      score: {
        rules: { passed: 0, total: 0 },
        opinions: { passed: 0, total: 0 },
        conventions: { passed: 0, total: 0 },
      },
    });
    await store.appendReview({
      pr_review_id: "prrev_2",
      timestamp: "2026-03-16T01:00:00Z",
      pr_number: 99,
      verdict: "WARNING",
      files: [],
      violations: [],
      honored: [],
      score: {
        rules: { passed: 0, total: 0 },
        opinions: { passed: 0, total: 0 },
        conventions: { passed: 0, total: 0 },
      },
    });

    const all = await store.getReviews();
    expect(all).toHaveLength(2);

    const pr42 = await store.getReviews(42);
    expect(pr42).toHaveLength(1);
    expect(pr42[0].pr_review_id).toBe("prrev_1");
  });

  it("gets last review for a PR", async () => {
    const store = new PrStore(tmpDir);
    await store.appendReview({
      pr_review_id: "prrev_1",
      timestamp: "2026-03-16T00:00:00Z",
      pr_number: 42,
      last_reviewed_sha: "sha1",
      verdict: "WARNING",
      files: [],
      violations: [],
      honored: [],
      score: {
        rules: { passed: 0, total: 0 },
        opinions: { passed: 0, total: 0 },
        conventions: { passed: 0, total: 0 },
      },
    });
    await store.appendReview({
      pr_review_id: "prrev_2",
      timestamp: "2026-03-16T01:00:00Z",
      pr_number: 42,
      last_reviewed_sha: "sha2",
      verdict: "CLEAN",
      files: [],
      violations: [],
      honored: [],
      score: {
        rules: { passed: 0, total: 0 },
        opinions: { passed: 0, total: 0 },
        conventions: { passed: 0, total: 0 },
      },
    });

    const last = await store.getLastReviewForPr(42);
    expect(last).not.toBeNull();
    expect(last!.pr_review_id).toBe("prrev_2");
    expect(last!.last_reviewed_sha).toBe("sha2");
  });

  it("returns null for PR with no reviews", async () => {
    const store = new PrStore(tmpDir);
    const last = await store.getLastReviewForPr(999);
    expect(last).toBeNull();
  });
});
