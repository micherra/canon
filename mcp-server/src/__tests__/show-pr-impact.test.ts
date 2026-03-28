/**
 * show-pr-impact tool — unit tests
 *
 * Tests:
 *   1. No stored review → status: "ok", prep always present, review undefined, empty hotspots/subgraph
 *   2. PR review, no KG → status: "ok", review + prep present, blastRadius undefined
 *   3. PR review + KG → status: "ok", blast radius populated, hotspots ranked correctly
 *   4. Hotspot ranking → sorted by risk_score descending
 *   5. Decision cross-reference → only relevant decisions included
 *   6. Subgraph filtering → nodes/edges filtered to changed files + blast radius affected files
 *   7. UnifiedPrOutput shape — prep field always present
 *   8. diff_base and incremental params forwarded to getPrReviewData
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

// ---------------------------------------------------------------------------
// Module-level mocks — set up before importing the module under test
// ---------------------------------------------------------------------------

// Mock existsSync to control KG availability
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
  };
});

// Mock initDatabase and analyzeBlastRadius so tests don't need a real SQLite DB
vi.mock("../graph/kg-schema.js", () => ({
  initDatabase: vi.fn(),
}));

vi.mock("../graph/kg-blast-radius.js", () => ({
  analyzeBlastRadius: vi.fn(),
}));

// Mock getPrReviewData so tests don't need git/diff infrastructure
vi.mock("../tools/pr-review-data.js", () => ({
  getPrReviewData: vi.fn(),
}));

import { existsSync } from "fs";
import { initDatabase } from "../graph/kg-schema.ts";
import { analyzeBlastRadius } from "../graph/kg-blast-radius.ts";
import { getPrReviewData } from "../tools/pr-review-data.ts";

import { showPrImpact } from "../tools/show-pr-impact.ts";
import { DriftStore } from "../drift/store.ts";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const SAMPLE_SCORE = {
  rules: { passed: 1, total: 2 },
  opinions: { passed: 2, total: 3 },
  conventions: { passed: 3, total: 3 },
};

// Minimal stub for PrReviewDataOutput returned by mocked getPrReviewData
const SAMPLE_PREP = {
  files: [],
  impact_files: [],
  layers: [],
  total_files: 0,
  total_violations: 0,
  net_new_files: 0,
  incremental: false,
  diff_command: "git diff main",
  narrative: "No changed files.",
  blast_radius: [],
};

const SAMPLE_REVIEW = {
  review_id: "rev_test_001",
  timestamp: new Date().toISOString(),
  verdict: "WARNING" as const,
  branch: "feat/my-feature",
  pr_number: 42,
  files: ["src/tools/foo.ts", "src/tools/bar.ts"],
  violations: [
    {
      principle_id: "functions-do-one-thing",
      severity: "strong-opinion",
      file_path: "src/tools/foo.ts",
      message: "Function does too many things",
    },
    {
      principle_id: "deep-modules",
      severity: "rule",
      file_path: "src/tools/bar.ts",
    },
  ],
  honored: ["validate-at-trust-boundaries"],
  score: SAMPLE_SCORE,
};

const SAMPLE_BLAST_RADIUS = {
  seed_entities: ["foo", "bar"],
  total_affected: 5,
  affected_files: 3,
  by_depth: { 0: 2, 1: 2, 2: 1 },
  affected: [
    { entity_name: "baz", entity_kind: "function", file_path: "src/tools/baz.ts", depth: 1, edge_type: "dependency" },
    { entity_name: "qux", entity_kind: "class", file_path: "src/utils/qux.ts", depth: 2, edge_type: "dependency" },
  ],
};

const SAMPLE_GRAPH_DATA = {
  nodes: [
    { id: "src/tools/foo.ts", layer: "tools", violation_count: 1 },
    { id: "src/tools/bar.ts", layer: "tools", violation_count: 0 },
    { id: "src/tools/baz.ts", layer: "tools", violation_count: 0 },
    { id: "src/utils/qux.ts", layer: "utils", violation_count: 0 },
    { id: "src/unrelated.ts", layer: "domain", violation_count: 0 },
  ],
  edges: [
    { source: "src/tools/foo.ts", target: "src/tools/bar.ts", confidence: 1 },
    { source: "src/tools/bar.ts", target: "src/tools/baz.ts", confidence: 1 },
    { source: "src/tools/baz.ts", target: "src/utils/qux.ts", confidence: 1 },
    // Edge that crosses out of our subgraph — should be excluded
    { source: "src/unrelated.ts", target: "src/tools/foo.ts", confidence: 1 },
  ],
};

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe("showPrImpact", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-show-pr-impact-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });

    // Default: existsSync returns false (no KG)
    vi.mocked(existsSync).mockReturnValue(false);

    // Default: analyzeBlastRadius not called
    vi.mocked(initDatabase).mockReset();
    vi.mocked(analyzeBlastRadius).mockReset();

    // Default: getPrReviewData returns minimal prep stub
    vi.mocked(getPrReviewData).mockReset();
    vi.mocked(getPrReviewData).mockResolvedValue(SAMPLE_PREP as never);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. No stored PR review — prep always present
  // -------------------------------------------------------------------------

  it("returns ok with prep data when no stored PR review exists", async () => {
    const result = await showPrImpact(tmpDir);

    expect(result.status).toBe("ok");
    // prep is always populated
    expect(result.prep).toBeDefined();
    expect(result.prep).toMatchObject(SAMPLE_PREP);
    // impact fields are empty/absent
    expect(result.hotspots).toEqual([]);
    expect(result.subgraph).toEqual({ nodes: [], edges: [], layers: [] });
    expect(result.review).toBeUndefined();
    expect(result.blastRadius).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 2. Stored PR review present, no KG
  // -------------------------------------------------------------------------

  it("returns ok with review + prep data but no blast radius when KG is absent", async () => {
    // Write a PR review
    const store = new DriftStore(tmpDir);
    await store.appendReview(SAMPLE_REVIEW);

    // KG not present (default mock: existsSync → false)
    vi.mocked(existsSync).mockReturnValue(false);

    const result = await showPrImpact(tmpDir);

    expect(result.status).toBe("ok");
    // prep is always populated
    expect(result.prep).toBeDefined();
    expect(result.prep).toMatchObject(SAMPLE_PREP);
    // review is populated from stored data
    expect(result.review).toBeDefined();
    expect(result.review!.verdict).toBe("WARNING");
    expect(result.review!.branch).toBe("feat/my-feature");
    expect(result.review!.pr_number).toBe(42);
    expect(result.review!.files).toEqual(["src/tools/foo.ts", "src/tools/bar.ts"]);
    expect(result.review!.violations).toHaveLength(2);

    // Blast radius is absent
    expect(result.blastRadius).toBeUndefined();

    // Hotspots computed from violations only (no blast radius counts)
    expect(result.hotspots.length).toBeGreaterThan(0);

    // initDatabase should NOT have been called
    expect(initDatabase).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 3. PR review + KG
  // -------------------------------------------------------------------------

  it("returns ok with blast radius when KG is available", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(SAMPLE_REVIEW);

    // KG present
    vi.mocked(existsSync).mockReturnValue(true);
    const mockDb = { close: vi.fn() };
    vi.mocked(initDatabase).mockReturnValue(mockDb as never);
    vi.mocked(analyzeBlastRadius).mockReturnValue(SAMPLE_BLAST_RADIUS);

    const result = await showPrImpact(tmpDir);

    expect(result.status).toBe("ok");
    expect(result.blastRadius).toBeDefined();
    expect(result.blastRadius!.total_affected).toBe(5);
    expect(result.blastRadius!.affected_files).toBe(3);
    expect(result.blastRadius!.by_depth).toEqual({ 0: 2, 1: 2, 2: 1 });
    expect(result.blastRadius!.affected).toHaveLength(2);

    // DB should be closed after use
    expect(mockDb.close).toHaveBeenCalledOnce();

    // analyzeBlastRadius called with the review's file list
    expect(analyzeBlastRadius).toHaveBeenCalledWith(
      mockDb,
      SAMPLE_REVIEW.files,
      { maxDepth: 3, includeTests: false },
    );
  });

  // -------------------------------------------------------------------------
  // 4. Hotspot ranking
  // -------------------------------------------------------------------------

  it("ranks hotspots by risk_score descending", async () => {
    // 3 files: one with rule violation + blast radius, one with strong-opinion, one with convention
    const review = {
      ...SAMPLE_REVIEW,
      files: ["src/a.ts", "src/b.ts", "src/c.ts"],
      violations: [
        { principle_id: "p1", severity: "convention", file_path: "src/c.ts" },    // weight 1
        { principle_id: "p2", severity: "strong-opinion", file_path: "src/b.ts" }, // weight 2
        { principle_id: "p3", severity: "rule", file_path: "src/a.ts" },           // weight 3
      ],
    };
    const store = new DriftStore(tmpDir);
    await store.appendReview(review);

    // No KG — blast radius from review only
    vi.mocked(existsSync).mockReturnValue(false);

    const result = await showPrImpact(tmpDir);

    expect(result.hotspots.length).toBeGreaterThanOrEqual(3);

    // The file with "rule" violation should rank first
    expect(result.hotspots[0].file).toBe("src/a.ts");
    expect(result.hotspots[0].risk_score).toBeGreaterThan(result.hotspots[1].risk_score);
    expect(result.hotspots[1].file).toBe("src/b.ts");
    expect(result.hotspots[1].risk_score).toBeGreaterThan(result.hotspots[2].risk_score);
    expect(result.hotspots[2].file).toBe("src/c.ts");
  });

  it("includes all files in hotspot list (including files with no violations)", async () => {
    const review = {
      ...SAMPLE_REVIEW,
      files: ["src/a.ts", "src/b.ts"],
      violations: [
        { principle_id: "p1", severity: "rule", file_path: "src/a.ts" },
      ],
    };
    const store = new DriftStore(tmpDir);
    await store.appendReview(review);

    vi.mocked(existsSync).mockReturnValue(false);

    const result = await showPrImpact(tmpDir);

    // Both files should be in hotspots
    const files = result.hotspots.map((h) => h.file);
    expect(files).toContain("src/a.ts");
    expect(files).toContain("src/b.ts");

    // src/b.ts has no violations
    const bHotspot = result.hotspots.find((h) => h.file === "src/b.ts");
    expect(bHotspot!.violation_count).toBe(0);
    expect(bHotspot!.risk_score).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 5. Decisions field — always empty
  // -------------------------------------------------------------------------

  it("does not include decisions field in output", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(SAMPLE_REVIEW);

    vi.mocked(existsSync).mockReturnValue(false);

    const result = await showPrImpact(tmpDir);

    expect(result).not.toHaveProperty("decisions");
  });

  // -------------------------------------------------------------------------
  // 6. Subgraph filtering
  // -------------------------------------------------------------------------

  it("filters subgraph to changed files + blast radius affected files", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(SAMPLE_REVIEW); // files: foo.ts, bar.ts

    // Write graph-data.json
    await writeFile(
      join(tmpDir, ".canon", "graph-data.json"),
      JSON.stringify(SAMPLE_GRAPH_DATA),
      "utf-8",
    );

    vi.mocked(existsSync)
      .mockImplementation((p) => {
        const pathStr = String(p);
        // KG path exists for the DB check, false for other paths
        if (pathStr.includes("knowledge-graph.db")) return true;
        return true; // let the actual readFile for graph-data.json work
      });

    const mockDb = { close: vi.fn() };
    vi.mocked(initDatabase).mockReturnValue(mockDb as never);
    vi.mocked(analyzeBlastRadius).mockReturnValue(SAMPLE_BLAST_RADIUS);
    // SAMPLE_BLAST_RADIUS affected: baz.ts + qux.ts

    const result = await showPrImpact(tmpDir);

    // Changed files: foo.ts, bar.ts; Blast radius affected: baz.ts, qux.ts
    const nodeIds = result.subgraph.nodes.map((n) => n.id);
    expect(nodeIds).toContain("src/tools/foo.ts");
    expect(nodeIds).toContain("src/tools/bar.ts");
    expect(nodeIds).toContain("src/tools/baz.ts");
    expect(nodeIds).toContain("src/utils/qux.ts");

    // Unrelated node should NOT be in subgraph
    expect(nodeIds).not.toContain("src/unrelated.ts");

    // Only edges where both endpoints are in subgraph
    for (const edge of result.subgraph.edges) {
      expect(nodeIds).toContain(edge.source);
      expect(nodeIds).toContain(edge.target);
    }

    // Changed files marked as changed
    const fooNode = result.subgraph.nodes.find((n) => n.id === "src/tools/foo.ts");
    expect(fooNode!.changed).toBe(true);

    // Layers extracted from included nodes
    expect(result.subgraph.layers.length).toBeGreaterThan(0);
  });

  it("returns empty subgraph when graph-data.json is absent", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(SAMPLE_REVIEW);

    vi.mocked(existsSync).mockReturnValue(false);

    const result = await showPrImpact(tmpDir);

    expect(result.subgraph.nodes).toEqual([]);
    expect(result.subgraph.edges).toEqual([]);
    expect(result.subgraph.layers).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 7. KG error handling
  // -------------------------------------------------------------------------

  it("continues without blast radius when analyzeBlastRadius throws", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(SAMPLE_REVIEW);

    vi.mocked(existsSync).mockReturnValue(true);
    const mockDb = { close: vi.fn() };
    vi.mocked(initDatabase).mockReturnValue(mockDb as never);
    vi.mocked(analyzeBlastRadius).mockImplementation(() => {
      throw new Error("KG query failed");
    });

    // Should not throw
    const result = await showPrImpact(tmpDir);

    expect(result.status).toBe("ok");
    expect(result.blastRadius).toBeUndefined();
    // DB should still be closed even on error
    expect(mockDb.close).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // 8. UnifiedPrOutput — prep field always present
  // -------------------------------------------------------------------------

  it("prep data is always populated even when no stored review exists", async () => {
    // No review stored — getPrReviewData still returns prep data
    const result = await showPrImpact(tmpDir);

    expect(result.prep).toBeDefined();
    expect(result.prep.narrative).toBe("No changed files.");
    expect(result.prep.diff_command).toBe("git diff main");
    expect(Array.isArray(result.prep.blast_radius)).toBe(true);
  });

  it("prep data includes files and narrative from getPrReviewData", async () => {
    const customPrep = {
      ...SAMPLE_PREP,
      files: [
        {
          path: "src/foo.ts",
          layer: "tools",
          status: "modified",
          bucket: "needs-attention",
          reason: "Has violations",
        },
      ],
      total_files: 1,
      narrative: "This PR touches the tools layer.",
    };
    vi.mocked(getPrReviewData).mockResolvedValue(customPrep as never);

    const result = await showPrImpact(tmpDir);

    expect(result.prep.files).toHaveLength(1);
    expect(result.prep.files[0].path).toBe("src/foo.ts");
    expect(result.prep.narrative).toBe("This PR touches the tools layer.");
  });

  it("when stored review exists, review/hotspots/subgraph are populated alongside prep", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(SAMPLE_REVIEW);
    vi.mocked(existsSync).mockReturnValue(false);

    const result = await showPrImpact(tmpDir);

    // Both layers present
    expect(result.prep).toBeDefined();
    expect(result.review).toBeDefined();
    expect(result.hotspots.length).toBeGreaterThan(0);
    expect(result.subgraph).toBeDefined();
  });

  it("diff_base and incremental params are forwarded to getPrReviewData", async () => {
    await showPrImpact(tmpDir, { diff_base: "origin/develop", incremental: true });

    expect(getPrReviewData).toHaveBeenCalledWith(
      expect.objectContaining({ diff_base: "origin/develop", incremental: true }),
      tmpDir,
    );
  });

  // -------------------------------------------------------------------------
  // 9. Recommendations surfaced from stored review
  // -------------------------------------------------------------------------

  it("surfaces recommendations from stored review when present", async () => {
    const recommendations = [
      {
        file_path: "src/tools/foo.ts",
        title: "thin-handlers",
        message: "Business logic should move to a service layer.",
        source: "principle" as const,
      },
      {
        title: "Missing error handling",
        message: "JSON.parse is unguarded — wrap in try/catch.",
        source: "holistic" as const,
      },
    ];

    const reviewWithRecs = {
      ...SAMPLE_REVIEW,
      recommendations,
    };

    const store = new DriftStore(tmpDir);
    await store.appendReview(reviewWithRecs);
    vi.mocked(existsSync).mockReturnValue(false);

    const result = await showPrImpact(tmpDir);

    expect(result.recommendations).toEqual(recommendations);
  });

  it("recommendations absent in output when stored review has no recommendations", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(SAMPLE_REVIEW); // no recommendations field
    vi.mocked(existsSync).mockReturnValue(false);

    const result = await showPrImpact(tmpDir);

    expect(result.recommendations).toBeUndefined();
  });

  it("recommendations absent in output when no stored review", async () => {
    const result = await showPrImpact(tmpDir);

    expect(result.recommendations).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Registration tests
// ---------------------------------------------------------------------------

describe("show_pr_impact registration", () => {
  it("registers with correct name and _meta.ui.resourceUri", () => {
    const { registerAppTool } = require("@modelcontextprotocol/ext-apps/server");

    interface RecordedTool { name: string; config: Record<string, unknown> }
    const tools: RecordedTool[] = [];
    const mockServer = {
      registerTool(name: string, config: Record<string, unknown>, _cb: unknown) {
        tools.push({ name, config });
      },
    };

    const prReviewResourceUri = "ui://canon/pr-review";

    registerAppTool(
      mockServer,
      "show_pr_impact",
      {
        title: "PR Review",
        description: "Opens the PR Review view.",
        inputSchema: {},
        _meta: { ui: { resourceUri: prReviewResourceUri } },
      },
      async () => ({ content: [{ type: "text" as const, text: "{}" }] }),
    );

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("show_pr_impact");

    const meta = tools[0].config._meta as Record<string, unknown>;
    expect(meta["ui/resourceUri"]).toBe(prReviewResourceUri);
  });
});
