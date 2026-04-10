/**
 * show-pr-impact-merge-part2.test.ts
 *
 * Split from show-pr-impact-merge.test.ts (was 621 lines).
 * Contains describes 6-9 (items 10-13 from the original coverage list):
 *
 *  10. Violations without file_path are NOT assigned to hotspots.
 *  11. Empty review.files → zero hotspots.
 *  12. Cross-subsystem: showPrImpact prep + review data coexist.
 *  13. UI store type contract — field names match server UnifiedPrOutput.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Module-level mocks — must be declared before any imports of the mocked modules

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
  };
});

vi.mock("@graph/kg-schema.ts", () => ({
  initDatabase: vi.fn(),
}));

vi.mock("@graph/kg-blast-radius.ts", () => ({
  analyzeBlastRadius: vi.fn(),
}));

vi.mock("../tools/pr-review-data.ts", () => ({
  getPrReviewData: vi.fn(),
}));

import { existsSync } from "node:fs";
import { DriftStore } from "@platform/storage/drift/store.ts";
import { getPrReviewData } from "../tools/pr-review-data.ts";
import { showPrImpact } from "../tools/show-pr-impact.ts";

const SAMPLE_PREP = {
  blast_radius: [],
  diff_command: "git diff main..HEAD --name-status",
  files: [],
  impact_files: [],
  incremental: false,
  layers: [],
  narrative: "No changed files.",
  net_new_files: 0,
  total_files: 0,
  total_violations: 0,
};

const SAMPLE_SCORE = {
  conventions: { passed: 1, total: 1 },
  opinions: { passed: 0, total: 1 },
  rules: { passed: 1, total: 1 },
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
    branch: overrides.branch,
    files: overrides.files ?? ["src/a.ts"],
    honored: [],
    pr_number: overrides.pr_number,
    review_id: overrides.review_id ?? `rev_${Math.random().toString(36).slice(2)}`,
    score: SAMPLE_SCORE,
    timestamp: new Date().toISOString(),
    verdict: overrides.verdict ?? ("CLEAN" as const),
    violations: overrides.violations ?? [],
  };
}

// Setup / teardown helpers

let tmpDir: string;

async function setupTmpDir() {
  tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-merge2-test-"));
  await mkdir(join(tmpDir, ".canon"), { recursive: true });
  vi.mocked(existsSync).mockReturnValue(false);
  vi.mocked(getPrReviewData).mockReset();
  vi.mocked(getPrReviewData).mockResolvedValue(SAMPLE_PREP as never);
}

async function teardownTmpDir() {
  await rm(tmpDir, { force: true, recursive: true });
  vi.restoreAllMocks();
}

// 10. Violations without file_path are NOT assigned to hotspots
//     (they land in __unassigned__ in buildHotspots but the hotspot is per review.files entry)

describe("showPrImpact — violations without file_path", () => {
  beforeEach(setupTmpDir);
  afterEach(teardownTmpDir);

  it("violations without file_path have empty violations list in their hotspot", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(
      makeReview({
        files: ["src/a.ts"],
        pr_number: 1,
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
        files: ["src/a.ts"],
        pr_number: 1,
        violations: [{ file_path: "src/a.ts", principle_id: "p1", severity: "rule" as const }],
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

// 11. Empty review.files → zero hotspots

describe("showPrImpact — empty review.files produces zero hotspots", () => {
  beforeEach(setupTmpDir);
  afterEach(teardownTmpDir);

  it("returns empty hotspots array when review.files is empty", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(
      makeReview({
        files: [],
        pr_number: 1,
        violations: [{ principle_id: "p1", severity: "rule" as const }],
      }),
    );

    const result = await showPrImpact(tmpDir);

    // review present but no files → no hotspots
    expect(result.review).toBeDefined();
    expect(result.hotspots).toEqual([]);
  });
});

// 12. Cross-subsystem: prep + review both present in same call

describe("showPrImpact — cross-subsystem: prep + review coexist", () => {
  beforeEach(setupTmpDir);
  afterEach(teardownTmpDir);

  it("prep data and review data both appear in the same result when a review exists", async () => {
    const customPrep = {
      ...SAMPLE_PREP,
      files: [
        {
          layer: "tools",
          path: "src/a.ts",
          status: "modified",
        },
      ],
      narrative: "1 file changed in PR #7.",
      total_files: 1,
    };
    vi.mocked(getPrReviewData).mockResolvedValue(customPrep as never);

    const store = new DriftStore(tmpDir);
    await store.appendReview(
      makeReview({
        files: ["src/a.ts"],
        pr_number: 7,
        verdict: "WARNING",
        violations: [
          {
            file_path: "src/a.ts",
            principle_id: "thin-handlers",
            severity: "strong-opinion" as const,
          },
        ],
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

// 13. UI store type mirror — key field names match server output

describe("UI store type contract — field names match server UnifiedPrOutput", () => {
  beforeEach(setupTmpDir);
  afterEach(teardownTmpDir);

  it("server output fields align with ui/stores/pr-review.ts UnifiedPrOutput shape", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(
      makeReview({
        files: ["src/a.ts"],
        pr_number: 1,
        verdict: "WARNING",
        violations: [{ file_path: "src/a.ts", principle_id: "p1", severity: "rule" as const }],
      }),
    );

    const result = await showPrImpact(tmpDir, { pr_number: 1 });

    // All top-level fields declared in ui/stores/pr-review.ts UnifiedPrOutput
    // must be present (except optional ones may be undefined)
    expect(result).toHaveProperty("status"); // "ok" | "no_diff_error"
    expect(result).toHaveProperty("prep"); // PrepData — always present
    expect(result).toHaveProperty("hotspots"); // PrImpactHotspot[]
    expect(result).toHaveProperty("subgraph"); // PrImpactSubgraph
    expect(result).not.toHaveProperty("decisions"); // decisions removed from output
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
