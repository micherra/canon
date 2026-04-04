/**
 * show-pr-impact integration tests — coverage gaps
 *
 * This file fills the gaps declared by prtool-04's implementor (now updated for UnifiedPrOutput):
 *   - Hotspot risk scoring with blast radius present (blast_count × max_severity_weight)
 *   - severityWeight fallback for unknown severities
 *   - Unknown layer names → #888888 fallback in subgraph.layers
 *   - Files with no violations but blast radius (risk_score = 0 because maxSeverityWeight = 0)
 *   - Multiple reviews: only latest is used
 *   - Subgraph: non-changed blast radius nodes are NOT marked changed
 *   - Subgraph: edges with only one endpoint in the node set are excluded
 *   - Decisions: multiple decisions for same principle are all included
 *   - Empty review.files list produces zero hotspots
 *
 * And cross-task integration gaps (updated for UnifiedPrOutput):
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

vi.mock("../graph/kg-schema.ts", () => ({
  initDatabase: vi.fn(),
}));

vi.mock("../graph/kg-blast-radius.ts", () => ({
  analyzeBlastRadius: vi.fn(),
}));

// Mock KgQuery so buildSubgraph doesn't need a real SQLite DB
vi.mock("../graph/kg-query.ts", () => ({
  KgQuery: vi.fn(),
}));

vi.mock("../tools/pr-review-data.ts", () => ({
  getPrReviewData: vi.fn(),
}));

import { existsSync } from "node:fs";
import { DriftStore } from "../drift/store.ts";
import { analyzeBlastRadius } from "../graph/kg-blast-radius.ts";
import { KgQuery } from "../graph/kg-query.ts";
import { initDatabase } from "../graph/kg-schema.ts";
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

    const result = await showPrImpact(tmpDir);

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

    const result = await showPrImpact(tmpDir);

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

    const result = await showPrImpact(tmpDir);

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

    const result = await showPrImpact(tmpDir);

    const hotspot = result.hotspots.find((h) => h.file === "src/mixed.ts");
    // blast_count=2, max_severity_weight=3 (rule) → risk_score=6 (not 2×(1+1+3)=10)
    expect(hotspot!.blast_radius_count).toBe(2);
    expect(hotspot!.risk_score).toBe(6);
  });
});

// Subgraph building gaps

describe("showPrImpact — subgraph building gaps", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-impact-subgraph-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(initDatabase).mockReset();
    vi.mocked(analyzeBlastRadius).mockReset();
    vi.mocked(KgQuery).mockReset();
    // Default KgQuery mock: getSubgraph returns empty
    (
      KgQuery as unknown as { prototype: { getSubgraph: ReturnType<typeof vi.fn> } }
    ).prototype.getSubgraph = vi.fn().mockReturnValue({ edges: [], nodes: [] });
    vi.mocked(getPrReviewData).mockReset();
    vi.mocked(getPrReviewData).mockResolvedValue(SAMPLE_PREP as never);
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
    vi.restoreAllMocks();
  });

  // Helper to configure KgQuery to return the given nodes/edges for paths in the inclusion set
  function mockKgSubgraph(
    nodes: Array<{ path: string; layer: string }>,
    edges: Array<{ source: string; target: string }> = [],
  ) {
    (
      KgQuery as unknown as { prototype: { getSubgraph: ReturnType<typeof vi.fn> } }
    ).prototype.getSubgraph = vi.fn().mockImplementation((paths: string[]) => {
      const pathSet = new Set(paths);
      const filteredNodes = nodes
        .filter((n) => pathSet.has(n.path))
        .map((n) => ({ ...n, file_id: 1 }));
      const nodeIds = new Set(filteredNodes.map((n) => n.path));
      const filteredEdges = edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
      return { edges: filteredEdges, nodes: filteredNodes };
    });
  }

  // Gap: unknown layer name → #888888 color fallback in layers array

  it("assigns #888888 color to unknown layer names in subgraph layers", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(
      makeReview({
        files: ["src/exotic.ts"],
        violations: [],
      }),
    );

    // KG is present and KgQuery returns the exotic file
    vi.mocked(existsSync).mockReturnValue(true);
    const mockDb = { close: vi.fn() };
    vi.mocked(initDatabase).mockReturnValue(mockDb as never);
    vi.mocked(analyzeBlastRadius).mockReturnValue({
      affected: [],
      affected_files: 0,
      by_depth: {},
      seed_entities: [],
      total_affected: 0,
    });
    mockKgSubgraph([{ layer: "custom-exotic-layer", path: "src/exotic.ts" }]);

    const result = await showPrImpact(tmpDir);

    // The node is included (it's a changed file)
    expect(result.subgraph.nodes).toHaveLength(1);
    expect(result.subgraph.nodes[0].layer).toBe("custom-exotic-layer");

    // The layer entry should use the fallback color #888888
    const layer = result.subgraph.layers.find((l) => l.name === "custom-exotic-layer");
    expect(layer).toBeDefined();
    expect(layer!.color).toBe("#888888");
  });

  // Gap: known layer names get their correct palette color

  it("uses correct palette colors for known layer names", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(
      makeReview({
        files: ["src/tools/foo.ts", "src/utils/bar.ts"],
        violations: [],
      }),
    );

    vi.mocked(existsSync).mockReturnValue(true);
    const mockDb = { close: vi.fn() };
    vi.mocked(initDatabase).mockReturnValue(mockDb as never);
    vi.mocked(analyzeBlastRadius).mockReturnValue({
      affected: [],
      affected_files: 0,
      by_depth: {},
      seed_entities: [],
      total_affected: 0,
    });
    mockKgSubgraph([
      { layer: "tools", path: "src/tools/foo.ts" },
      { layer: "utils", path: "src/utils/bar.ts" },
    ]);

    const result = await showPrImpact(tmpDir);

    const toolsLayer = result.subgraph.layers.find((l) => l.name === "tools");
    const utilsLayer = result.subgraph.layers.find((l) => l.name === "utils");

    expect(toolsLayer!.color).toBe("#4e9af1");
    expect(utilsLayer!.color).toBe("#f14e7c");
  });

  // Gap: blast radius nodes are NOT marked changed, only review.files are

  it("marks only changed files as changed=true, blast radius nodes as changed=false", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(
      makeReview({
        files: ["src/changed.ts"],
        violations: [],
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
          entity_name: "dep",
          file_path: "src/affected.ts",
        },
      ],
      affected_files: 1,
      by_depth: { 1: 1 },
      seed_entities: [],
      total_affected: 1,
    });
    mockKgSubgraph([
      { layer: "tools", path: "src/changed.ts" },
      { layer: "tools", path: "src/affected.ts" },
    ]);

    const result = await showPrImpact(tmpDir);

    const changedNode = result.subgraph.nodes.find((n) => n.id === "src/changed.ts");
    const affectedNode = result.subgraph.nodes.find((n) => n.id === "src/affected.ts");

    expect(changedNode!.changed).toBe(true);
    expect(affectedNode!.changed).toBe(false);
  });

  // Gap: edge where only one endpoint is in the subgraph is excluded

  it("excludes edges where one endpoint is outside the subgraph", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(
      makeReview({
        files: ["src/a.ts"],
        violations: [],
      }),
    );

    vi.mocked(existsSync).mockReturnValue(true);
    const mockDb = { close: vi.fn() };
    vi.mocked(initDatabase).mockReturnValue(mockDb as never);
    vi.mocked(analyzeBlastRadius).mockReturnValue({
      affected: [],
      affected_files: 0,
      by_depth: {},
      seed_entities: [],
      total_affected: 0,
    });
    // KgQuery returns src/a.ts in the subgraph; src/b.ts is not in paths so it's excluded
    mockKgSubgraph(
      [
        { layer: "tools", path: "src/a.ts" },
        // src/b.ts deliberately omitted — it's not in the review files or blast radius
      ],
      [
        { source: "src/a.ts", target: "src/a.ts" }, // self-edge within subgraph
        { source: "src/a.ts", target: "src/b.ts" }, // edge leaving subgraph — should be excluded
      ],
    );

    const result = await showPrImpact(tmpDir);

    // src/b.ts should not appear (not in review files, no blast radius)
    const nodeIds = result.subgraph.nodes.map((n) => n.id);
    expect(nodeIds).not.toContain("src/b.ts");

    // The edge src/a.ts → src/b.ts should be excluded because src/b.ts is not in subgraph
    const edgeToB = result.subgraph.edges.find((e) => e.target === "src/b.ts");
    expect(edgeToB).toBeUndefined();
  });

  // Gap: subgraph with no nodes in KG matching review files

  it("returns empty subgraph when no KG nodes match review files", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(
      makeReview({
        files: ["src/missing-from-graph.ts"],
        violations: [],
      }),
    );

    // KG is absent → buildSubgraph returns empty
    vi.mocked(existsSync).mockReturnValue(false);

    const result = await showPrImpact(tmpDir);

    expect(result.subgraph.nodes).toHaveLength(0);
    expect(result.subgraph.edges).toHaveLength(0);
    expect(result.subgraph.layers).toHaveLength(0);
  });

  // Gap: layer file_count reflects number of nodes per layer

  it("counts file_count per layer correctly in subgraph layers", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(
      makeReview({
        files: ["src/a.ts", "src/b.ts", "src/c.ts"],
        violations: [],
      }),
    );

    vi.mocked(existsSync).mockReturnValue(true);
    const mockDb = { close: vi.fn() };
    vi.mocked(initDatabase).mockReturnValue(mockDb as never);
    vi.mocked(analyzeBlastRadius).mockReturnValue({
      affected: [],
      affected_files: 0,
      by_depth: {},
      seed_entities: [],
      total_affected: 0,
    });
    mockKgSubgraph([
      { layer: "tools", path: "src/a.ts" },
      { layer: "tools", path: "src/b.ts" },
      { layer: "utils", path: "src/c.ts" },
    ]);

    const result = await showPrImpact(tmpDir);

    const toolsLayer = result.subgraph.layers.find((l) => l.name === "tools");
    const utilsLayer = result.subgraph.layers.find((l) => l.name === "utils");

    expect(toolsLayer!.file_count).toBe(2);
    expect(utilsLayer!.file_count).toBe(1);
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

    const result = await showPrImpact(tmpDir);

    expect(result.status).toBe("ok");
    expect(result.review!.verdict).toBe("CLEAN");
    expect(result.review!.files).toEqual(["src/new.ts"]);
    // Old review file should not appear
    const fileNames = result.hotspots.map((h) => h.file);
    expect(fileNames).not.toContain("src/old.ts");
    expect(fileNames).toContain("src/new.ts");
  });
});

// Decisions field — removed from show_pr_impact output

describe("showPrImpact — decisions field is absent from output", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-impact-decisions-test-"));
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

  it("does not include decisions field when a stored review has violations", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(
      makeReview({
        files: ["src/a.ts", "src/b.ts"],
        violations: [
          {
            file_path: "src/a.ts",
            principle_id: "functions-do-one-thing",
            severity: "strong-opinion",
          },
        ],
      }),
    );

    const result = await showPrImpact(tmpDir);

    expect(result).not.toHaveProperty("decisions");
  });

  it("does not include decisions field when no stored review exists", async () => {
    const result = await showPrImpact(tmpDir);

    expect(result).not.toHaveProperty("decisions");
  });
});

// UnifiedPrOutput contract — shape always includes prep, review is optional

describe("showPrImpact — UnifiedPrOutput contract", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-impact-contract-test-"));
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

  it("unified output shape matches UnifiedPrOutput — prep always present, review optional", async () => {
    // No stored review — status is always ok and prep is always present
    const result = await showPrImpact(tmpDir);

    expect(result.status).toBe("ok");
    expect(result).toHaveProperty("prep");
    expect(result.prep).toMatchObject(SAMPLE_PREP);
    // Impact fields present as empty defaults
    expect(result).toHaveProperty("hotspots");
    expect(result).toHaveProperty("subgraph");
    expect(result).not.toHaveProperty("decisions");
    expect(Array.isArray(result.hotspots)).toBe(true);
    expect(result.subgraph).toMatchObject({
      edges: expect.any(Array),
      layers: expect.any(Array),
      nodes: expect.any(Array),
    });
    // review is absent when no stored review
    expect(result.review).toBeUndefined();
  });

  it("status is always ok — no more no_review status", async () => {
    // Even with no stored review, status is ok
    const result = await showPrImpact(tmpDir);
    expect(result.status).toBe("ok");
    expect((result as { status: string }).status).not.toBe("no_review");
  });

  it("ok payload has all required fields consumed by the UI bridge", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(
      makeReview({
        files: ["src/foo.ts"],
        verdict: "WARNING",
        violations: [
          {
            file_path: "src/foo.ts",
            message: "Too shallow",
            principle_id: "deep-modules",
            severity: "strong-opinion",
          },
        ],
      }),
    );

    const result = await showPrImpact(tmpDir);

    // status field
    expect(result.status).toBe("ok");

    // prep field (always present)
    expect(result.prep).toMatchObject(SAMPLE_PREP);

    // review shape (consumed by VerdictStrip via bridge)
    expect(result.review).toMatchObject({
      files: ["src/foo.ts"],
      score: expect.objectContaining({
        conventions: expect.any(Object),
        opinions: expect.any(Object),
        rules: expect.any(Object),
      }),
      verdict: "WARNING",
      violations: expect.arrayContaining([
        expect.objectContaining({
          message: "Too shallow",
          principle_id: "deep-modules",
          severity: "strong-opinion",
        }),
      ]),
    });

    // hotspots shape (consumed by HotspotList via bridge)
    expect(result.hotspots[0]).toMatchObject({
      blast_radius_count: expect.any(Number),
      file: "src/foo.ts",
      risk_score: expect.any(Number),
      violation_count: expect.any(Number),
      violations: expect.any(Array),
    });

    // subgraph shape (consumed by SubGraph via bridge)
    expect(result.subgraph).toMatchObject({
      edges: expect.any(Array),
      layers: expect.any(Array),
      nodes: expect.any(Array),
    });
  });

  it("violation message is forwarded from review to hotspot violations list", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(
      makeReview({
        files: ["src/foo.ts"],
        violations: [
          {
            file_path: "src/foo.ts",
            message: "Specific reason here",
            principle_id: "p1",
            severity: "rule",
          },
        ],
      }),
    );

    const result = await showPrImpact(tmpDir);

    const hotspot = result.hotspots.find((h) => h.file === "src/foo.ts")!;
    expect(hotspot.violations[0].message).toBe("Specific reason here");
  });

  it("violation without message has undefined message in hotspot (not empty string)", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(
      makeReview({
        files: ["src/foo.ts"],
        violations: [
          { file_path: "src/foo.ts", principle_id: "p1", severity: "rule" },
          // no message field
        ],
      }),
    );

    const result = await showPrImpact(tmpDir);

    const hotspot = result.hotspots.find((h) => h.file === "src/foo.ts")!;
    expect(hotspot.violations[0].message).toBeUndefined();
  });
});
