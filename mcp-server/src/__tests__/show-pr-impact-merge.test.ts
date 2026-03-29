/**
 * show-pr-impact-merge.test.ts
 *
 * Integration tests for the unified PR tool merge (Build 2).
 *
 * Covers gaps not addressed by the implementor unit/integration tests:
 *
 *   1. prReviews filter — principle-only reviews (no pr_number or branch) are
 *      excluded from `prReviews` when no explicit filter is given.
 *   2. prReviews filter — reviews WITH pr_number or branch pass through.
 *   3. Branch-filter path: showPrImpact({ branch }) selects matching review.
 *   4. PR-number-filter path: showPrImpact({ pr_number }) selects matching review.
 *   5. Explicit filter bypasses the principle-only exclusion (hasFilter=true).
 *   6. get_pr_review_data is absent from index.ts registrations.
 *   7. Resource URI is ui://canon/pr-review, not ui://canon/pr-impact.
 *   8. has_review field: server output does NOT include it; UI store type does —
 *      documents the gap so the UI's !!data?.has_review always reads false.
 *   9. Path traversal rejection: files with ".." in review are stripped.
 *  10. Violation without file_path uses __unassigned__ key but is still in hotspot
 *      list of the file (file from review.files), not a separate entry.
 *  11. diff_base and incremental forwarded with pr_number filter.
 *  12. Empty review.files → zero hotspots (declared gap from integration test header).
 *  13. Cross-subsystem: showPrImpact prep + review data live together in result.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

// ---------------------------------------------------------------------------
// Module-level mocks — must be declared before any imports of the mocked modules
// ---------------------------------------------------------------------------

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
  };
});

vi.mock("../graph/kg-schema.ts", () => ({
  initDatabase: vi.fn(),
}));

vi.mock("../graph/kg-blast-radius.ts", () => ({
  analyzeBlastRadius: vi.fn(),
}));

vi.mock("../tools/pr-review-data.ts", () => ({
  getPrReviewData: vi.fn(),
}));

import { existsSync } from "fs";
import { getPrReviewData } from "../tools/pr-review-data.ts";
import { showPrImpact } from "../tools/show-pr-impact.ts";
import { DriftStore } from "../drift/store.ts";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SAMPLE_PREP = {
  files: [],
  impact_files: [],
  layers: [],
  total_files: 0,
  total_violations: 0,
  net_new_files: 0,
  incremental: false,
  diff_command: "git diff main..HEAD --name-status",
  narrative: "No changed files.",
  blast_radius: [],
};

const SAMPLE_SCORE = {
  rules: { passed: 1, total: 1 },
  opinions: { passed: 0, total: 1 },
  conventions: { passed: 1, total: 1 },
};

function makeReview(
  overrides: Partial<{
    review_id: string;
    branch: string;
    pr_number: number;
    verdict: "BLOCKING" | "WARNING" | "CLEAN";
    files: string[];
    violations: Array<{ principle_id: string; severity: string; file_path?: string }>;
  }> = {},
) {
  return {
    review_id: overrides.review_id ?? `rev_${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    verdict: overrides.verdict ?? ("CLEAN" as const),
    branch: overrides.branch,
    pr_number: overrides.pr_number,
    files: overrides.files ?? ["src/a.ts"],
    violations: overrides.violations ?? [],
    honored: [],
    score: SAMPLE_SCORE,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

async function setupTmpDir() {
  tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-merge-test-"));
  await mkdir(join(tmpDir, ".canon"), { recursive: true });
  vi.mocked(existsSync).mockReturnValue(false);
  vi.mocked(getPrReviewData).mockReset();
  vi.mocked(getPrReviewData).mockResolvedValue(SAMPLE_PREP as never);
}

async function teardownTmpDir() {
  await rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
}

// ---------------------------------------------------------------------------
// 1–2. prReviews filter: principle-only vs PR-context reviews
// ---------------------------------------------------------------------------

describe("showPrImpact — prReviews filter (no explicit filter given)", () => {
  beforeEach(setupTmpDir);
  afterEach(teardownTmpDir);

  it("excludes principle-only reviews (no pr_number, no branch) from prReviews", async () => {
    const store = new DriftStore(tmpDir);
    // This review has neither pr_number nor branch — it's a principle-only review
    await store.appendReview({
      review_id: "rev_principle_only",
      timestamp: new Date().toISOString(),
      verdict: "WARNING",
      // no branch, no pr_number
      files: ["src/domain/service.ts"],
      violations: [{ principle_id: "thin-handlers", severity: "rule" }],
      honored: [],
      score: SAMPLE_SCORE,
    });

    const result = await showPrImpact(tmpDir);

    // Principle-only review should be excluded → no review in result
    expect(result.status).toBe("ok");
    expect(result.review).toBeUndefined();
    expect(result.hotspots).toEqual([]);
  });

  it("includes reviews with pr_number in prReviews when no explicit filter given", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(makeReview({ pr_number: 10, verdict: "WARNING" }));

    const result = await showPrImpact(tmpDir);

    expect(result.review).toBeDefined();
    expect(result.review!.pr_number).toBe(10);
    expect(result.review!.verdict).toBe("WARNING");
  });

  it("includes reviews with branch in prReviews when no explicit filter given", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(makeReview({ branch: "feat/auth", verdict: "BLOCKING" }));

    const result = await showPrImpact(tmpDir);

    expect(result.review).toBeDefined();
    expect(result.review!.branch).toBe("feat/auth");
    expect(result.review!.verdict).toBe("BLOCKING");
  });

  it("uses latest pr-context review when mix of principle-only and PR reviews exist", async () => {
    const store = new DriftStore(tmpDir);
    // First: principle-only (should be excluded)
    await store.appendReview({
      review_id: "rev_principle",
      timestamp: new Date().toISOString(),
      verdict: "BLOCKING",
      files: ["src/bad.ts"],
      violations: [{ principle_id: "p1", severity: "rule" }],
      honored: [],
      score: SAMPLE_SCORE,
    });
    // Second: PR review (should be used)
    await store.appendReview(makeReview({ pr_number: 55, verdict: "CLEAN", files: ["src/clean.ts"] }));

    const result = await showPrImpact(tmpDir);

    expect(result.review).toBeDefined();
    expect(result.review!.pr_number).toBe(55);
    expect(result.review!.verdict).toBe("CLEAN");
    expect(result.review!.files).toEqual(["src/clean.ts"]);
  });
});

// ---------------------------------------------------------------------------
// 3–5. Filter paths: branch, pr_number, and explicit filter bypass
// ---------------------------------------------------------------------------

describe("showPrImpact — branch and pr_number filter paths", () => {
  beforeEach(setupTmpDir);
  afterEach(teardownTmpDir);

  it("branch filter selects only reviews matching that branch", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(makeReview({ branch: "feat/login", verdict: "WARNING", files: ["src/login.ts"] }));
    await store.appendReview(makeReview({ branch: "feat/signup", verdict: "CLEAN", files: ["src/signup.ts"] }));

    // Ask for feat/login only
    const result = await showPrImpact(tmpDir, { branch: "feat/login" });

    expect(result.review).toBeDefined();
    expect(result.review!.branch).toBe("feat/login");
    expect(result.review!.verdict).toBe("WARNING");
    expect(result.review!.files).toEqual(["src/login.ts"]);
  });

  it("pr_number filter selects only reviews for that PR", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(makeReview({ pr_number: 1, verdict: "BLOCKING", files: ["src/old.ts"] }));
    await store.appendReview(makeReview({ pr_number: 2, verdict: "CLEAN", files: ["src/new.ts"] }));

    const result = await showPrImpact(tmpDir, { pr_number: 1 });

    expect(result.review).toBeDefined();
    expect(result.review!.pr_number).toBe(1);
    expect(result.review!.verdict).toBe("BLOCKING");
    expect(result.review!.files).toEqual(["src/old.ts"]);
  });

  it("explicit branch filter includes principle-only reviews for that branch (hasFilter bypass)", async () => {
    const store = new DriftStore(tmpDir);
    // A principle-only review for a specific branch
    await store.appendReview({
      review_id: "rev_branch_principle",
      timestamp: new Date().toISOString(),
      verdict: "WARNING",
      branch: "feat/specific",
      // no pr_number — would be excluded without explicit filter
      files: ["src/specific.ts"],
      violations: [{ principle_id: "p1", severity: "strong-opinion" }],
      honored: [],
      score: SAMPLE_SCORE,
    });

    // With explicit branch filter, hasFilter=true → this review IS included
    const result = await showPrImpact(tmpDir, { branch: "feat/specific" });

    expect(result.review).toBeDefined();
    expect(result.review!.branch).toBe("feat/specific");
    expect(result.review!.verdict).toBe("WARNING");
  });

  it("returns no review when branch filter matches no stored reviews", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(makeReview({ branch: "feat/other" }));

    const result = await showPrImpact(tmpDir, { branch: "feat/nonexistent" });

    expect(result.review).toBeUndefined();
    expect(result.hotspots).toEqual([]);
    expect(result.status).toBe("ok");
    expect(result.prep).toBeDefined();
  });

  it("diff_base and incremental are forwarded to getPrReviewData when combined with pr_number", async () => {
    await showPrImpact(tmpDir, {
      pr_number: 7,
      diff_base: "origin/main",
      incremental: true,
    });

    expect(getPrReviewData).toHaveBeenCalledWith(
      expect.objectContaining({
        pr_number: 7,
        diff_base: "origin/main",
        incremental: true,
      }),
      tmpDir,
    );
  });
});

// ---------------------------------------------------------------------------
// 6–7. index.ts registration: get_pr_review_data removed, URI updated
// ---------------------------------------------------------------------------

describe("index.ts tool registrations", () => {
  it("get_pr_review_data is not registered as an MCP tool in index.ts", async () => {
    // Read the index source and check that get_pr_review_data does not appear
    // as a registerTool() or registerAppTool() call.
    const { readFile } = await import("fs/promises");
    const indexSrc = await readFile(
      new URL("../../src/index.ts", import.meta.url),
      "utf-8",
    );

    // The tool name must not appear as a registration argument
    expect(indexSrc).not.toMatch(/registerTool\s*\([^)]*['"`]get_pr_review_data['"`]/);
    expect(indexSrc).not.toMatch(/registerAppTool\s*\([^)]*['"`]get_pr_review_data['"`]/);
  });

  it("show_pr_impact is registered with resource URI ui://canon/pr-review", async () => {
    const { readFile } = await import("fs/promises");
    const indexSrc = await readFile(
      new URL("../../src/index.ts", import.meta.url),
      "utf-8",
    );

    // Must contain the new URI
    expect(indexSrc).toContain("ui://canon/pr-review");
    // Must NOT contain the old URI
    expect(indexSrc).not.toContain("ui://canon/pr-impact");
  });
});

// ---------------------------------------------------------------------------
// 8. has_review field: server output shape vs UI store type contract
// ---------------------------------------------------------------------------

describe("UnifiedPrOutput — has_review field contract", () => {
  beforeEach(setupTmpDir);
  afterEach(teardownTmpDir);

  it("server output includes has_review: true when review exists", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(makeReview({ pr_number: 1, verdict: "WARNING" }));

    const result = await showPrImpact(tmpDir);

    // review IS present in the output
    expect(result.review).toBeDefined();
    // has_review: true — drives the UI review-mode three-panel layout
    expect(result.has_review).toBe(true);
  });

  it("server output includes has_review: false when no review exists", async () => {
    const result = await showPrImpact(tmpDir);

    expect(result.review).toBeUndefined();
    expect(result.has_review).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. Path traversal rejection — files with ".." stripped from review
// ---------------------------------------------------------------------------

describe("showPrImpact — path traversal protection", () => {
  beforeEach(setupTmpDir);
  afterEach(teardownTmpDir);

  it("strips files containing '..' from review.files before processing", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview({
      review_id: "rev_traversal",
      timestamp: new Date().toISOString(),
      verdict: "WARNING",
      pr_number: 1,
      files: [
        "src/safe.ts",             // safe — should stay
        "../../../etc/passwd",      // traversal — should be stripped
        "src/../etc/passwd",        // traversal — should be stripped
      ],
      violations: [
        { principle_id: "p1", severity: "rule", file_path: "src/safe.ts" },
        { principle_id: "p2", severity: "rule", file_path: "../../../etc/passwd" },
      ],
      honored: [],
      score: SAMPLE_SCORE,
    });

    const result = await showPrImpact(tmpDir);

    // Traversal paths must be stripped
    expect(result.review!.files).toContain("src/safe.ts");
    expect(result.review!.files).not.toContain("../../../etc/passwd");
    expect(result.review!.files).not.toContain("src/../etc/passwd");

    // Violations for stripped paths must also be stripped
    const violationFilePaths = result.review!.violations.map((v) => v.file_path);
    expect(violationFilePaths).not.toContain("../../../etc/passwd");
    // The safe violation remains
    const safePaths = violationFilePaths.filter(Boolean);
    expect(safePaths).toContain("src/safe.ts");
  });

  it("strips absolute-path files from review.files", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview({
      review_id: "rev_abs",
      timestamp: new Date().toISOString(),
      verdict: "WARNING",
      pr_number: 1,
      files: [
        "src/safe.ts",
        "/etc/passwd",            // absolute — should be stripped
      ],
      violations: [],
      honored: [],
      score: SAMPLE_SCORE,
    });

    const result = await showPrImpact(tmpDir);

    expect(result.review!.files).not.toContain("/etc/passwd");
    expect(result.review!.files).toContain("src/safe.ts");
  });
});

// ---------------------------------------------------------------------------
// 10. Violations without file_path are NOT assigned to hotspots
//     (they land in __unassigned__ in buildHotspots but the hotspot is per review.files entry)
// ---------------------------------------------------------------------------

describe("showPrImpact — violations without file_path", () => {
  beforeEach(setupTmpDir);
  afterEach(teardownTmpDir);

  it("violations without file_path have empty violations list in their hotspot", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(
      makeReview({
        pr_number: 1,
        files: ["src/a.ts"],
        violations: [
          // file_path is absent — violationsByFile will key it under __unassigned__
          { principle_id: "p1", severity: "rule" as const },
        ],
      }),
    );

    const result = await showPrImpact(tmpDir);

    // The hotspot for src/a.ts should have no violations assigned to it
    const hotspot = result.hotspots.find((h) => h.file === "src/a.ts");
    expect(hotspot).toBeDefined();
    expect(hotspot!.violations).toEqual([]);
    expect(hotspot!.violation_count).toBe(0);
    // risk_score: no blast radius (KG absent), no violations → 0
    expect(hotspot!.risk_score).toBe(0);
  });

  it("violations with matching file_path ARE assigned to their hotspot", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(
      makeReview({
        pr_number: 1,
        files: ["src/a.ts"],
        violations: [
          { principle_id: "p1", severity: "rule" as const, file_path: "src/a.ts" },
        ],
      }),
    );

    const result = await showPrImpact(tmpDir);

    const hotspot = result.hotspots.find((h) => h.file === "src/a.ts");
    expect(hotspot).toBeDefined();
    expect(hotspot!.violations).toHaveLength(1);
    expect(hotspot!.violations[0].principle_id).toBe("p1");
    expect(hotspot!.violation_count).toBe(1);
    expect(hotspot!.risk_score).toBe(3); // rule → weight 3, no blast radius → sum path
  });
});

// ---------------------------------------------------------------------------
// 11. Empty review.files → zero hotspots
// ---------------------------------------------------------------------------

describe("showPrImpact — empty review.files produces zero hotspots", () => {
  beforeEach(setupTmpDir);
  afterEach(teardownTmpDir);

  it("returns empty hotspots array when review.files is empty", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(
      makeReview({
        pr_number: 1,
        files: [],
        violations: [{ principle_id: "p1", severity: "rule" as const }],
      }),
    );

    const result = await showPrImpact(tmpDir);

    // review present but no files → no hotspots
    expect(result.review).toBeDefined();
    expect(result.hotspots).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 12. Cross-subsystem: prep + review both present in same call
// ---------------------------------------------------------------------------

describe("showPrImpact — cross-subsystem: prep + review coexist", () => {
  beforeEach(setupTmpDir);
  afterEach(teardownTmpDir);

  it("prep data and review data both appear in the same result when a review exists", async () => {
    const customPrep = {
      ...SAMPLE_PREP,
      files: [
        {
          path: "src/a.ts",
          layer: "tools",
          status: "modified",
        },
      ],
      total_files: 1,
      narrative: "1 file changed in PR #7.",
    };
    vi.mocked(getPrReviewData).mockResolvedValue(customPrep as never);

    const store = new DriftStore(tmpDir);
    await store.appendReview(
      makeReview({
        pr_number: 7,
        verdict: "WARNING",
        files: ["src/a.ts"],
        violations: [{ principle_id: "thin-handlers", severity: "strong-opinion" as const, file_path: "src/a.ts" }],
      }),
    );

    const result = await showPrImpact(tmpDir, { pr_number: 7 });

    // Prep layer
    expect(result.status).toBe("ok");
    expect(result.prep.total_files).toBe(1);
    expect(result.prep.narrative).toBe("1 file changed in PR #7.");
    expect(result.prep.files[0].path).toBe("src/a.ts");

    // Review layer
    expect(result.review).toBeDefined();
    expect(result.review!.verdict).toBe("WARNING");
    expect(result.review!.pr_number).toBe(7);
    expect(result.review!.files).toEqual(["src/a.ts"]);

    // Hotspot derived from review
    expect(result.hotspots).toHaveLength(1);
    expect(result.hotspots[0].file).toBe("src/a.ts");
    expect(result.hotspots[0].violation_count).toBe(1);

    // Both layers coexist — no fields missing from the spec
    expect(result).toHaveProperty("subgraph");
    expect(result).not.toHaveProperty("decisions");
    expect(result).toHaveProperty("blastRadius"); // undefined because KG absent
    expect(result.blastRadius).toBeUndefined();
  });

  it("getPrReviewData is always called exactly once regardless of whether review exists", async () => {
    // Case 1: no review
    await showPrImpact(tmpDir);
    expect(getPrReviewData).toHaveBeenCalledTimes(1);

    vi.mocked(getPrReviewData).mockClear();

    // Case 2: review exists
    const store = new DriftStore(tmpDir);
    await store.appendReview(makeReview({ pr_number: 1 }));
    await showPrImpact(tmpDir, { pr_number: 1 });
    expect(getPrReviewData).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 13. UI store type mirror — key field names match server output
// ---------------------------------------------------------------------------

describe("UI store type contract — field names match server UnifiedPrOutput", () => {
  beforeEach(setupTmpDir);
  afterEach(teardownTmpDir);

  it("server output fields align with ui/stores/pr-review.ts UnifiedPrOutput shape", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(
      makeReview({
        pr_number: 1,
        verdict: "WARNING",
        files: ["src/a.ts"],
        violations: [{ principle_id: "p1", severity: "rule" as const, file_path: "src/a.ts" }],
      }),
    );

    const result = await showPrImpact(tmpDir, { pr_number: 1 });

    // All top-level fields declared in ui/stores/pr-review.ts UnifiedPrOutput
    // must be present (except optional ones may be undefined)
    expect(result).toHaveProperty("status");         // "ok" | "no_diff_error"
    expect(result).toHaveProperty("prep");            // PrepData — always present
    expect(result).toHaveProperty("hotspots");        // PrImpactHotspot[]
    expect(result).toHaveProperty("subgraph");        // PrImpactSubgraph
    expect(result).not.toHaveProperty("decisions");  // decisions removed from output
    // review and blastRadius are optional
    expect(result.review).toBeDefined();

    // Verify prep sub-shape
    const prep = result.prep;
    expect(prep).toHaveProperty("files");
    expect(prep).toHaveProperty("layers");
    expect(prep).toHaveProperty("total_files");
    expect(prep).toHaveProperty("incremental");
    expect(prep).toHaveProperty("diff_command");
    expect(prep).toHaveProperty("narrative");
    expect(prep).toHaveProperty("blast_radius");

    // Verify review sub-shape
    const review = result.review!;
    expect(review).toHaveProperty("verdict");
    expect(review).toHaveProperty("files");
    expect(review).toHaveProperty("violations");
    expect(review).toHaveProperty("score");
    expect(review.score).toHaveProperty("rules");
    expect(review.score).toHaveProperty("opinions");
    expect(review.score).toHaveProperty("conventions");

    // Verify hotspot sub-shape
    const hotspot = result.hotspots[0];
    expect(hotspot).toHaveProperty("file");
    expect(hotspot).toHaveProperty("blast_radius_count");
    expect(hotspot).toHaveProperty("violation_count");
    expect(hotspot).toHaveProperty("risk_score");
    expect(hotspot).toHaveProperty("violations");

    // Verify subgraph sub-shape
    const subgraph = result.subgraph;
    expect(subgraph).toHaveProperty("nodes");
    expect(subgraph).toHaveProperty("edges");
    expect(subgraph).toHaveProperty("layers");
  });
});
