/**
 * show-pr-impact integration tests — coverage gaps (Part 1)
 *
 * This file fills the gaps declared by prtool-04's implementor (now updated for UnifiedPrOutput):
 *   - Hotspot risk scoring with blast radius present (blast_count × max_severity_weight)
 *   - severityWeight fallback for unknown severities
 *   - Files with no violations but blast radius (risk_score = 0 because maxSeverityWeight = 0)
 *
 * Continued in show-pr-impact-integration-subgraph.test.ts:
 *   - Unknown layer names → #888888 fallback in subgraph.layers
 *   - Subgraph: non-changed blast radius nodes are NOT marked changed
 *   - Subgraph: edges with only one endpoint in the node set are excluded
 *   - Decisions: multiple decisions for same principle are all included
 *   - Multiple reviews: only latest is used
 *   - UnifiedPrOutput shape: prep always present, review optional
 *   - status is always "ok" — no more "no_review" status
 *   - Bridge argument contract: show_pr_impact called with empty arguments object
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Module-level mocks — set up before importing the module under test

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

// Mock KgQuery so buildSubgraph doesn't need a real SQLite DB
vi.mock("@graph/kg-query.ts", () => ({
  KgQuery: vi.fn(),
}));

vi.mock("../tools/pr-review-data.ts", () => ({
  getPrReviewData: vi.fn(),
}));

import { existsSync } from "node:fs";
import { analyzeBlastRadius } from "@graph/kg-blast-radius.ts";
import { KgQuery } from "@graph/kg-query.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import { DriftStore } from "@platform/storage/drift/store.ts";
import { getPrReviewData } from "../tools/pr-review-data.ts";
import { showPrImpact } from "../tools/show-pr-impact.ts";

const SAMPLE_SCORE = {
  conventions: { passed: 3, total: 3 },
  opinions: { passed: 1, total: 2 },
  rules: { passed: 2, total: 3 },
};

const SAMPLE_PREP = {
  blast_radius: [],
  diff_command: "git diff main",
  files: [],
  impact_files: [],
  incremental: false,
  layers: [],
  narrative: "No changed files.",
  net_new_files: 0,
  total_files: 0,
  total_violations: 0,
};

function makeReview(
  overrides: Partial<{
    files: string[];
    violations: Array<{
      principle_id: string;
      severity: string;
      file_path?: string;
      message?: string;
    }>;
    verdict: "BLOCKING" | "WARNING" | "CLEAN";
  }> = {},
) {
  return {
    branch: "feat/test",
    files: overrides.files ?? ["src/a.ts"],
    honored: [],
    pr_number: 1,
    review_id: `rev_test_${Math.random().toString(36).slice(2)}`,
    score: SAMPLE_SCORE,
    timestamp: new Date().toISOString(),
    verdict: overrides.verdict ?? ("WARNING" as const),
    violations: overrides.violations ?? [],
  };
}

describe("showPrImpact — hotspot risk scoring (blast radius path)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-impact-int-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(initDatabase).mockReset();
    vi.mocked(analyzeBlastRadius).mockReset();
    vi.mocked(getPrReviewData).mockReset();
    vi.mocked(getPrReviewData).mockResolvedValue(SAMPLE_PREP as never);
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
    vi.restoreAllMocks();
  });

  // Gap: risk_score = blast_radius_count × max_severity_weight (with KG)
  // The existing ranking test only uses the no-KG path (violation sum).
  // This test exercises the multiplication formula directly.

  it("computes risk_score as blast_radius_count × max_severity_weight when KG present", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(
      makeReview({
        files: ["src/core.ts", "src/utils.ts"],
        violations: [
          { file_path: "src/core.ts", principle_id: "p1", severity: "rule" }, // weight 3
          { file_path: "src/utils.ts", principle_id: "p2", severity: "convention" }, // weight 1
        ],
      }),
    );

    vi.mocked(existsSync).mockReturnValue(true);
    const mockDb = { close: vi.fn() };
    vi.mocked(initDatabase).mockReturnValue(mockDb as never);
    vi.mocked(analyzeBlastRadius).mockReturnValue({
      affected: [
        // 4 entities trace back to src/core.ts
        {
          depth: 1,
          edge_type: "dependency",
          entity_kind: "function",
          entity_name: "e1",
          file_path: "src/core.ts",
        },
        {
          depth: 1,
          edge_type: "dependency",
          entity_kind: "function",
          entity_name: "e2",
          file_path: "src/core.ts",
        },
        {
          depth: 2,
          edge_type: "dependency",
          entity_kind: "function",
          entity_name: "e3",
          file_path: "src/core.ts",
        },
        {
          depth: 2,
          edge_type: "dependency",
          entity_kind: "function",
          entity_name: "e4",
          file_path: "src/core.ts",
        },
        // 2 entities trace back to src/utils.ts
        {
          depth: 1,
          edge_type: "dependency",
          entity_kind: "class",
          entity_name: "e5",
          file_path: "src/utils.ts",
        },
        {
          depth: 2,
          edge_type: "dependency",
          entity_kind: "class",
          entity_name: "e6",
          file_path: "src/utils.ts",
        },
      ],
      affected_files: 5,
      by_depth: { 1: 5, 2: 5 },
      seed_entities: ["core", "utils"],
      total_affected: 10,
    });

    const result = await showPrImpact(tmpDir, { pr_number: 1 });

    const coreHotspot = result.hotspots.find((h) => h.file === "src/core.ts");
    const utilsHotspot = result.hotspots.find((h) => h.file === "src/utils.ts");

    // core: blast_radius_count=4, max_severity_weight=3 (rule) → risk_score=12
    expect(coreHotspot!.blast_radius_count).toBe(4);
    expect(coreHotspot!.risk_score).toBe(12); // 4 × 3

    // utils: blast_radius_count=2, max_severity_weight=1 (convention) → risk_score=2
    expect(utilsHotspot!.blast_radius_count).toBe(2);
    expect(utilsHotspot!.risk_score).toBe(2); // 2 × 1

    // core ranks above utils
    expect(result.hotspots[0].file).toBe("src/core.ts");
    expect(result.hotspots[1].file).toBe("src/utils.ts");
  });

  // Gap: file with blast radius but no violations → risk_score = 0
  // (maxSeverityWeight = 0, so blast_count × 0 = 0)

  it("assigns risk_score=0 to clean files even when they have blast radius", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(
      makeReview({
        files: ["src/clean.ts"],
        violations: [], // no violations for clean.ts
      }),
    );

    vi.mocked(existsSync).mockReturnValue(true);
    const mockDb = { close: vi.fn() };
    vi.mocked(initDatabase).mockReturnValue(mockDb as never);
    vi.mocked(analyzeBlastRadius).mockReturnValue({
      affected: [
        {
          depth: 1,
          edge_type: "dependency",
          entity_kind: "function",
          entity_name: "x",
          file_path: "src/clean.ts",
        },
        {
          depth: 1,
          edge_type: "dependency",
          entity_kind: "function",
          entity_name: "y",
          file_path: "src/clean.ts",
        },
        {
          depth: 1,
          edge_type: "dependency",
          entity_kind: "function",
          entity_name: "z",
          file_path: "src/clean.ts",
        },
      ],
      affected_files: 2,
      by_depth: { 1: 3 },
      seed_entities: ["clean"],
      total_affected: 3,
    });

    const result = await showPrImpact(tmpDir, { pr_number: 1 });

    const hotspot = result.hotspots.find((h) => h.file === "src/clean.ts");
    expect(hotspot!.blast_radius_count).toBe(3);
    expect(hotspot!.violation_count).toBe(0);
    // max_severity_weight is 0 when no violations → risk_score = 3 × 0 = 0
    expect(hotspot!.risk_score).toBe(0);
  });

  // Gap: unknown severity falls back to weight 1

  it("treats unknown severity as weight 1 in risk_score calculation", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(
      makeReview({
        files: ["src/a.ts", "src/b.ts"],
        violations: [
          { file_path: "src/a.ts", principle_id: "p1", severity: "unknown-severity" },
          { file_path: "src/b.ts", principle_id: "p2", severity: "convention" },
        ],
      }),
    );

    vi.mocked(existsSync).mockReturnValue(false);

    const result = await showPrImpact(tmpDir, { pr_number: 1 });

    const aHotspot = result.hotspots.find((h) => h.file === "src/a.ts");
    const bHotspot = result.hotspots.find((h) => h.file === "src/b.ts");

    // unknown-severity → weight 1, convention → weight 1 — they should both use sum of weights (no-KG path)
    // No blast radius: risk_score = sum(severity weights) = 1 each
    expect(aHotspot!.risk_score).toBe(1); // 1 violation × weight 1
    expect(bHotspot!.risk_score).toBe(1); // 1 convention × weight 1
  });

  // Gap: multiple violations on same file — max severity is used, not sum
  // (blast radius path: blast_count × MAX severity, not sum)

  it("uses max severity weight (not sum) when KG blast radius is present", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(
      makeReview({
        files: ["src/mixed.ts"],
        violations: [
          { file_path: "src/mixed.ts", principle_id: "p1", severity: "convention" }, // weight 1
          { file_path: "src/mixed.ts", principle_id: "p2", severity: "convention" }, // weight 1
          { file_path: "src/mixed.ts", principle_id: "p3", severity: "rule" }, // weight 3
        ],
      }),
    );

    vi.mocked(existsSync).mockReturnValue(true);
    const mockDb = { close: vi.fn() };
    vi.mocked(initDatabase).mockReturnValue(mockDb as never);
    vi.mocked(analyzeBlastRadius).mockReturnValue({
      affected: [
        {
          depth: 1,
          edge_type: "dependency",
          entity_kind: "function",
          entity_name: "x",
          file_path: "src/mixed.ts",
        },
        {
          depth: 1,
          edge_type: "dependency",
          entity_kind: "function",
          entity_name: "y",
          file_path: "src/mixed.ts",
        },
      ],
      affected_files: 1,
      by_depth: { 1: 2 },
      seed_entities: ["mixed"],
      total_affected: 2,
    });

    const result = await showPrImpact(tmpDir, { pr_number: 1 });

    const hotspot = result.hotspots.find((h) => h.file === "src/mixed.ts");
    // blast_count=2, max_severity_weight=3 (rule) → risk_score=6 (not 2×(1+1+3)=10)
    expect(hotspot!.blast_radius_count).toBe(2);
    expect(hotspot!.risk_score).toBe(6);
  });
});

// Multiple reviews: latest is used

describe("showPrImpact — multiple reviews", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-impact-multi-review-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(initDatabase).mockReset();
    vi.mocked(analyzeBlastRadius).mockReset();
    vi.mocked(getPrReviewData).mockReset();
    vi.mocked(getPrReviewData).mockResolvedValue(SAMPLE_PREP as never);
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
    vi.restoreAllMocks();
  });

  it("uses the most recent review when multiple exist", async () => {
    const store = new DriftStore(tmpDir);

    // Older review
    await store.appendReview(
      makeReview({
        files: ["src/old.ts"],
        verdict: "BLOCKING",
        violations: [{ file_path: "src/old.ts", principle_id: "p1", severity: "rule" }],
      }),
    );

    // Newer review (appended after, becomes latest)
    await store.appendReview(
      makeReview({
        files: ["src/new.ts"],
        verdict: "CLEAN",
        violations: [],
      }),
    );

    const result = await showPrImpact(tmpDir, { pr_number: 1 });

    expect(result.status).toBe("ok");
    expect(result.review!.verdict).toBe("CLEAN");
    expect(result.review!.files).toEqual(["src/new.ts"]);

    // Old review file should not appear
    const fileNames = result.hotspots.map((h) => h.file);
    expect(fileNames).not.toContain("src/old.ts");
    expect(fileNames).toContain("src/new.ts");
  });
});

// KgQuery usage is referenced in file 2 but must be suppressed here to avoid lint warnings
void KgQuery;
