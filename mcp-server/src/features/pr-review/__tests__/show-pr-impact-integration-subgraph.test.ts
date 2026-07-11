/**
 * show-pr-impact integration tests — subgraph + contract (Part 2)
 *
 * Continuation of show-pr-impact-integration.test.ts.
 * This file covers:
 *   - Unknown layer names → #888888 fallback in subgraph.layers
 *   - Subgraph: non-changed blast radius nodes are NOT marked changed
 *   - Subgraph: edges with only one endpoint in the node set are excluded
 *   - Multiple reviews: only latest is used
 *   - Decisions: field is absent from output
 *   - UnifiedPrOutput shape: prep always present, review optional
 *   - status is always "ok" — no more "no_review" status
 *   - Bridge argument contract: show_pr_impact called with empty arguments object
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Module-level mocks — must be replicated in each split file

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

    const result = await showPrImpact(tmpDir, { pr_number: 1 });

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

    const result = await showPrImpact(tmpDir, { pr_number: 1 });

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

    const result = await showPrImpact(tmpDir, { pr_number: 1 });

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

    const result = await showPrImpact(tmpDir, { pr_number: 1 });

    const toolsLayer = result.subgraph.layers.find((l) => l.name === "tools");
    const utilsLayer = result.subgraph.layers.find((l) => l.name === "utils");

    expect(toolsLayer!.file_count).toBe(2);
    expect(utilsLayer!.file_count).toBe(1);
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

    const result = await showPrImpact(tmpDir, { pr_number: 1 });

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

    const result = await showPrImpact(tmpDir, { pr_number: 1 });

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

    const result = await showPrImpact(tmpDir, { pr_number: 1 });

    const hotspot = result.hotspots.find((h) => h.file === "src/foo.ts")!;
    expect(hotspot.violations[0].message).toBeUndefined();
  });
});
