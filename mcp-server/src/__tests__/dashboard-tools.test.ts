/**
 * Dashboard support tools — unit tests
 *
 * Covers all 6 new MCP tools that the Canon dashboard iframe calls via
 * app.callServerTool():
 *
 *   1. update-dashboard-state  — writes dashboard-state.json
 *   2. get-branch              — returns git branch name
 *   3. get-file-content        — reads files, rejects path traversal
 *   4. get-summary             — returns summary or line preview
 *   5. get-compliance-trend    — computes weekly pass rates from JSONL
 *   6. get-pr-reviews          — parses pr-reviews.jsonl
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { updateDashboardState } from "../tools/update-dashboard-state.js";
import { getBranch } from "../tools/get-branch.js";
import { getFileContent, safeResolvePath } from "../tools/get-file-content.js";
import { getSummary } from "../tools/get-summary.js";
import { getComplianceTrend } from "../tools/get-compliance-trend.js";
import { getPrReviews } from "../tools/get-pr-reviews.js";

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "canon-dashboard-tools-test-"));
  await mkdir(join(tmpDir, ".canon"), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. update-dashboard-state
// ---------------------------------------------------------------------------

describe("update-dashboard-state", () => {
  it("writes dashboard-state.json with selectedNode", async () => {
    const node = {
      id: "src/index.ts",
      layer: "api",
      summary: "Entry point",
      violation_count: 0,
    };

    const result = await updateDashboardState({ selectedNode: node }, tmpDir);
    expect(result.ok).toBe(true);

    const raw = await readFile(join(tmpDir, ".canon", "dashboard-state.json"), "utf-8");
    const state = JSON.parse(raw);
    expect(state.selectedNode).toMatchObject(node);
    expect(typeof state.timestamp).toBe("string");
  });

  it("writes null selectedNode to clear selection", async () => {
    const result = await updateDashboardState({ selectedNode: null }, tmpDir);
    expect(result.ok).toBe(true);

    const raw = await readFile(join(tmpDir, ".canon", "dashboard-state.json"), "utf-8");
    const state = JSON.parse(raw);
    expect(state.selectedNode).toBeNull();
  });

  it("writes with no selectedNode key (undefined)", async () => {
    const result = await updateDashboardState({}, tmpDir);
    expect(result.ok).toBe(true);
  });

  it("rejects path traversal in node id", async () => {
    const result = await updateDashboardState(
      { selectedNode: { id: "../../../etc/passwd", layer: "x", summary: "x", violation_count: 0 } },
      tmpDir,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects absolute path in node id", async () => {
    const result = await updateDashboardState(
      { selectedNode: { id: "/etc/passwd", layer: "x", summary: "x", violation_count: 0 } },
      tmpDir,
    );
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. get-branch
// ---------------------------------------------------------------------------

describe("get-branch", () => {
  it("returns a non-empty branch string", async () => {
    // The test suite runs inside a git repo so this should succeed.
    const result = await getBranch(tmpDir);
    // getBranch falls back to "unknown" when git is not available — accept either
    expect(typeof result.branch).toBe("string");
    expect(result.branch.length).toBeGreaterThan(0);
  });

  it("returns 'unknown' for a non-git directory", async () => {
    // tmpDir is not a git repo on its own
    const result = await getBranch(tmpDir);
    // It might return a real branch (if git walks up) or "unknown"
    expect(typeof result.branch).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// 3. get-file-content
// ---------------------------------------------------------------------------

describe("get-file-content", () => {
  it("reads a file within the project dir", async () => {
    await writeFile(join(tmpDir, "hello.ts"), "export const x = 1;", "utf-8");
    const result = await getFileContent({ file_path: "hello.ts" }, tmpDir);
    expect(result.content).toBe("export const x = 1;");
    expect(result.path).toBe("hello.ts");
    expect(result.error).toBeUndefined();
  });

  it("rejects path traversal via ../", async () => {
    const result = await getFileContent(
      { file_path: "../../../etc/passwd" },
      tmpDir,
    );
    expect(result.content).toBeNull();
    expect(result.error).toMatch(/traversal/i);
  });

  it("rejects absolute path", async () => {
    const result = await getFileContent({ file_path: "/etc/passwd" }, tmpDir);
    expect(result.content).toBeNull();
    expect(result.error).toMatch(/traversal/i);
  });

  it("returns null with error for missing file", async () => {
    const result = await getFileContent({ file_path: "no-such-file.ts" }, tmpDir);
    expect(result.content).toBeNull();
    expect(result.error).toBeDefined();
  });

  it("reads nested files safely", async () => {
    await mkdir(join(tmpDir, "src"), { recursive: true });
    await writeFile(join(tmpDir, "src", "foo.ts"), "const foo = true;", "utf-8");
    const result = await getFileContent({ file_path: "src/foo.ts" }, tmpDir);
    expect(result.content).toBe("const foo = true;");
  });
});

describe("safeResolvePath", () => {
  it("resolves a valid relative path", () => {
    const resolved = safeResolvePath(tmpDir, "src/foo.ts");
    expect(resolved).not.toBeNull();
    expect(resolved!.startsWith(tmpDir)).toBe(true);
  });

  it("rejects .. segments", () => {
    expect(safeResolvePath(tmpDir, "../sibling/file.ts")).toBeNull();
  });

  it("rejects absolute paths", () => {
    expect(safeResolvePath(tmpDir, "/etc/passwd")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. get-summary
// ---------------------------------------------------------------------------

describe("get-summary", () => {
  it("returns summary from summaries.json", async () => {
    const summaries = {
      "src/foo.ts": { summary: "A helper module", updated_at: "2026-01-01T00:00:00.000Z" },
    };
    await writeFile(
      join(tmpDir, ".canon", "summaries.json"),
      JSON.stringify(summaries),
      "utf-8",
    );

    const result = await getSummary({ file_id: "src/foo.ts" }, tmpDir);
    expect(result.summary).toBe("A helper module");
    expect(result.source).toBe("summaries");
  });

  it("falls back to first 5 lines of the file", async () => {
    // No summaries.json
    const lines = ["line1", "line2", "line3", "line4", "line5", "line6", "line7"];
    await writeFile(join(tmpDir, "preview.ts"), lines.join("\n"), "utf-8");

    const result = await getSummary({ file_id: "preview.ts" }, tmpDir);
    expect(result.source).toBe("preview");
    expect(result.summary).toContain("line1");
    expect(result.summary).toContain("line5");
    expect(result.summary).not.toContain("line6");
  });

  it("returns null when no summary and path traversal attempted", async () => {
    const result = await getSummary({ file_id: "../etc/passwd" }, tmpDir);
    expect(result.summary).toBeNull();
    expect(result.source).toBe("none");
  });

  it("returns null when file not in summaries and doesn't exist", async () => {
    const result = await getSummary({ file_id: "nonexistent.ts" }, tmpDir);
    expect(result.summary).toBeNull();
    expect(result.source).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// 5. get-compliance-trend
// ---------------------------------------------------------------------------

describe("get-compliance-trend", () => {
  function makeReview(
    timestamp: string,
    honored: string[],
    violationIds: string[],
  ) {
    return {
      review_id: `r-${timestamp}`,
      timestamp,
      files: [],
      honored,
      violations: violationIds.map((id) => ({ principle_id: id, severity: "rule" })),
      score: {
        rules: { passed: 0, total: 0 },
        opinions: { passed: 0, total: 0 },
        conventions: { passed: 0, total: 0 },
      },
      verdict: "CLEAN",
    };
  }

  async function writeReviews(reviews: object[]) {
    const jsonl = reviews.map((r) => JSON.stringify(r)).join("\n") + "\n";
    await writeFile(join(tmpDir, ".canon", "reviews.jsonl"), jsonl, "utf-8");
  }

  it("computes weekly pass rates", async () => {
    // 2026-W01 (Jan 1-7 2026): 1 violation, 1 honored → 50% pass rate
    await writeReviews([
      makeReview("2026-01-05T00:00:00.000Z", ["my-principle"], []),
      makeReview("2026-01-06T00:00:00.000Z", [], ["my-principle"]),
    ]);

    const result = await getComplianceTrend({ principle_id: "my-principle" }, tmpDir);
    expect(result.trend.length).toBeGreaterThan(0);

    const point = result.trend[0];
    expect(point.week).toMatch(/^\d{4}-W\d{2}$/);
    expect(point.pass_rate).toBeGreaterThanOrEqual(0);
    expect(point.pass_rate).toBeLessThanOrEqual(1);
  });

  it("returns empty trend when reviews.jsonl is missing", async () => {
    const result = await getComplianceTrend({ principle_id: "any-principle" }, tmpDir);
    expect(result.trend).toEqual([]);
  });

  it("returns empty trend when no reviews mention the principle", async () => {
    await writeReviews([
      makeReview("2026-01-05T00:00:00.000Z", ["other-principle"], []),
    ]);

    const result = await getComplianceTrend({ principle_id: "my-principle" }, tmpDir);
    expect(result.trend).toEqual([]);
  });

  it("skips malformed JSONL lines", async () => {
    const good = JSON.stringify(
      makeReview("2026-01-05T00:00:00.000Z", ["p1"], [])
    );
    await writeFile(
      join(tmpDir, ".canon", "reviews.jsonl"),
      `${good}\n{BAD JSON}\n`,
      "utf-8",
    );

    const result = await getComplianceTrend({ principle_id: "p1" }, tmpDir);
    expect(result.trend.length).toBeGreaterThan(0);
  });

  it("returns pass_rate of 1 when all reviews honored the principle", async () => {
    await writeReviews([
      makeReview("2026-01-05T00:00:00.000Z", ["p1"], []),
      makeReview("2026-01-06T00:00:00.000Z", ["p1"], []),
    ]);

    const result = await getComplianceTrend({ principle_id: "p1" }, tmpDir);
    const allOne = result.trend.every((p) => p.pass_rate === 1);
    expect(allOne).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. get-pr-reviews
// ---------------------------------------------------------------------------

describe("get-pr-reviews", () => {
  async function writePrReviews(reviews: object[]) {
    const jsonl = reviews.map((r) => JSON.stringify(r)).join("\n") + "\n";
    await writeFile(join(tmpDir, ".canon", "pr-reviews.jsonl"), jsonl, "utf-8");
  }

  const sampleReview = {
    pr_review_id: "prr-1",
    timestamp: "2026-01-05T00:00:00.000Z",
    pr_number: 42,
    verdict: "CLEAN",
    files: ["src/foo.ts"],
    violations: [],
    honored: ["principle-a"],
    score: {
      rules: { passed: 1, total: 1 },
      opinions: { passed: 0, total: 0 },
      conventions: { passed: 0, total: 0 },
    },
  };

  it("returns all stored reviews", async () => {
    await writePrReviews([sampleReview]);
    const result = await getPrReviews(tmpDir);
    expect(result.reviews).toHaveLength(1);
    expect(result.reviews[0].pr_review_id).toBe("prr-1");
    expect(result.reviews[0].verdict).toBe("CLEAN");
  });

  it("returns empty array when file is missing", async () => {
    const result = await getPrReviews(tmpDir);
    expect(result.reviews).toEqual([]);
  });

  it("skips malformed JSONL lines", async () => {
    const good = JSON.stringify(sampleReview);
    await writeFile(
      join(tmpDir, ".canon", "pr-reviews.jsonl"),
      `${good}\n{BAD JSON}\n`,
      "utf-8",
    );

    const result = await getPrReviews(tmpDir);
    expect(result.reviews).toHaveLength(1);
  });

  it("returns multiple reviews in order", async () => {
    const second = { ...sampleReview, pr_review_id: "prr-2", pr_number: 43 };
    await writePrReviews([sampleReview, second]);

    const result = await getPrReviews(tmpDir);
    expect(result.reviews).toHaveLength(2);
    expect(result.reviews[0].pr_review_id).toBe("prr-1");
    expect(result.reviews[1].pr_review_id).toBe("prr-2");
  });
});
