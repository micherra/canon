/**
 * clustering.test.ts
 *
 * Tests for the pure client-side clustering algorithm in ui/lib/clustering.ts.
 * All fixtures are static arrays — no randomness, deterministic results.
 */

import { describe, expect, it } from "vitest";
import { type ClusterInput, clusterFiles, findCommonPrefix } from "../lib/clustering.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFile(path: string, status: ClusterInput["status"], layer: string): ClusterInput {
  return { layer, path, status };
}

// Real-world fixture: file list reflecting the current branch git status
// (based on the branch's modified/added/deleted files)
const REAL_WORLD_FIXTURE: ClusterInput[] = [
  // Graph module — all modified
  makeFile("mcp-server/src/graph/kg-adapter-bash.ts", "modified", "graph"),
  makeFile("mcp-server/src/graph/kg-adapter-markdown.ts", "modified", "graph"),
  makeFile("mcp-server/src/graph/kg-adapter-python.ts", "modified", "graph"),
  makeFile("mcp-server/src/graph/kg-adapter-registry.ts", "modified", "graph"),
  makeFile("mcp-server/src/graph/kg-adapter-yaml.ts", "modified", "graph"),
  makeFile("mcp-server/src/graph/kg-blast-radius.ts", "modified", "graph"),
  makeFile("mcp-server/src/graph/kg-dead-code.ts", "modified", "graph"),
  makeFile("mcp-server/src/graph/kg-pipeline.ts", "modified", "graph"),
  makeFile("mcp-server/src/graph/kg-query.ts", "modified", "graph"),
  makeFile("mcp-server/src/graph/kg-store.ts", "modified", "graph"),
  makeFile("mcp-server/src/graph/kg-types.ts", "modified", "graph"),
  makeFile("mcp-server/src/graph/view-materializer.ts", "modified", "graph"),
  makeFile("mcp-server/src/graph/md-relations.ts", "added", "graph"),
  // Tools — mix of modified and deleted
  makeFile("mcp-server/src/tools/graph-query.ts", "modified", "tools"),
  makeFile("mcp-server/src/tools/pr-review-data.ts", "modified", "tools"),
  makeFile("mcp-server/src/tools/get-branch.ts", "deleted", "tools"),
  makeFile("mcp-server/src/tools/get-compliance-trend.ts", "deleted", "tools"),
  makeFile("mcp-server/src/tools/get-file-content.ts", "deleted", "tools"),
  makeFile("mcp-server/src/tools/get-pr-reviews.ts", "deleted", "tools"),
  makeFile("mcp-server/src/tools/get-summary.ts", "deleted", "tools"),
  makeFile("mcp-server/src/tools/reindex-file.ts", "deleted", "tools"),
  // UI stores
  makeFile("mcp-server/ui/stores/bridge.ts", "modified", "ui"),
  // New UI files
  makeFile("mcp-server/ui/codebase-graph.ts", "added", "ui"),
  makeFile("mcp-server/ui/compliance.ts", "added", "ui"),
  makeFile("mcp-server/ui/drift-report.ts", "added", "ui"),
  makeFile("mcp-server/ui/file-context.ts", "added", "ui"),
  makeFile("mcp-server/ui/graph-query.ts", "added", "ui"),
  makeFile("mcp-server/ui/pr-review-prep.ts", "added", "ui"),
];

// ---------------------------------------------------------------------------
// clusterFiles — core behavior
// ---------------------------------------------------------------------------

describe("clusterFiles() — empty input", () => {
  it("returns empty array for empty input", () => {
    expect(clusterFiles([])).toEqual([]);
  });
});

describe("clusterFiles() — single file", () => {
  it("returns exactly one cluster for a single file (merged into other)", () => {
    const files = [makeFile("src/foo.ts", "modified", "tools")];
    const result = clusterFiles(files);
    expect(result).toHaveLength(1);
  });

  it("the single-file cluster contains the file", () => {
    const files = [makeFile("src/foo.ts", "modified", "tools")];
    const result = clusterFiles(files);
    expect(result[0].files).toHaveLength(1);
    expect(result[0].files[0].path).toBe("src/foo.ts");
  });
});

// ---------------------------------------------------------------------------
// New-feature clusters (all-added subtree)
// ---------------------------------------------------------------------------

describe("clusterFiles() — all-added directory", () => {
  it("creates a new-feature cluster when ALL files in a directory are added", () => {
    const files = [
      makeFile("src/graph/kg-store.ts", "added", "graph"),
      makeFile("src/graph/kg-query.ts", "added", "graph"),
      makeFile("src/graph/kg-types.ts", "added", "graph"),
    ];
    const result = clusterFiles(files);
    const newFeature = result.find((c) => c.type === "new-feature");
    expect(newFeature).toBeDefined();
    expect(newFeature!.files).toHaveLength(3);
  });

  it("does NOT create new-feature cluster when directory has mixed statuses", () => {
    const files = [
      makeFile("src/graph/kg-store.ts", "added", "graph"),
      makeFile("src/graph/kg-query.ts", "modified", "graph"), // mixed!
    ];
    const result = clusterFiles(files);
    const newFeature = result.find((c) => c.type === "new-feature");
    expect(newFeature).toBeUndefined();
  });

  it("new-feature cluster title starts with 'New:'", () => {
    const files = [
      makeFile("src/adapters/foo.ts", "added", "tools"),
      makeFile("src/adapters/bar.ts", "added", "tools"),
    ];
    const result = clusterFiles(files);
    const newFeature = result.find((c) => c.type === "new-feature");
    expect(newFeature).toBeDefined();
    expect(newFeature!.title).toMatch(/^New:/);
  });
});

// ---------------------------------------------------------------------------
// Removal clusters (all-deleted subtree)
// ---------------------------------------------------------------------------

describe("clusterFiles() — all-deleted directory", () => {
  it("creates a removal cluster when ALL files in a directory are deleted", () => {
    const files = [
      makeFile("src/legacy/old-store.ts", "deleted", "graph"),
      makeFile("src/legacy/old-query.ts", "deleted", "graph"),
    ];
    const result = clusterFiles(files);
    const removal = result.find((c) => c.type === "removal");
    expect(removal).toBeDefined();
    expect(removal!.files).toHaveLength(2);
  });

  it("removal cluster title starts with 'Removed:'", () => {
    const files = [
      makeFile("src/legacy/old-store.ts", "deleted", "graph"),
      makeFile("src/legacy/old-query.ts", "deleted", "graph"),
    ];
    const result = clusterFiles(files);
    const removal = result.find((c) => c.type === "removal");
    expect(removal).toBeDefined();
    expect(removal!.title).toMatch(/^Removed:/);
  });

  it("does NOT create removal cluster when directory has mixed statuses", () => {
    const files = [
      makeFile("src/legacy/old-store.ts", "deleted", "graph"),
      makeFile("src/legacy/other.ts", "modified", "graph"), // mixed!
    ];
    const result = clusterFiles(files);
    const removal = result.find((c) => c.type === "removal");
    expect(removal).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Prefix groups
// ---------------------------------------------------------------------------

describe("clusterFiles() — shared prefix grouping", () => {
  it("groups kg-* files into a single prefix cluster", () => {
    const files = [
      makeFile("src/graph/kg-store.ts", "modified", "graph"),
      makeFile("src/graph/kg-query.ts", "modified", "graph"),
      makeFile("src/graph/kg-types.ts", "modified", "graph"),
    ];
    const result = clusterFiles(files);
    const prefixCluster = result.find((c) => c.type === "prefix-group");
    expect(prefixCluster).toBeDefined();
    expect(prefixCluster!.files).toHaveLength(3);
  });

  it("prefix cluster title includes the shared prefix", () => {
    const files = [
      makeFile("src/graph/kg-store.ts", "modified", "graph"),
      makeFile("src/graph/kg-query.ts", "modified", "graph"),
      makeFile("src/graph/kg-types.ts", "modified", "graph"),
    ];
    const result = clusterFiles(files);
    const prefixCluster = result.find((c) => c.type === "prefix-group");
    expect(prefixCluster).toBeDefined();
    expect(prefixCluster!.title.toLowerCase()).toContain("kg");
  });

  it("groups pr-* files into a prefix cluster", () => {
    const files = [
      makeFile("src/tools/pr-review-data.ts", "modified", "tools"),
      makeFile("src/tools/pr-review-prep.ts", "modified", "tools"),
    ];
    const result = clusterFiles(files);
    const prefixCluster = result.find((c) => c.type === "prefix-group");
    expect(prefixCluster).toBeDefined();
    expect(prefixCluster!.files).toHaveLength(2);
  });

  it("does NOT create a prefix group when no common prefix exists", () => {
    const files = [
      makeFile("src/graph/store.ts", "modified", "graph"),
      makeFile("src/graph/query.ts", "modified", "graph"),
      makeFile("src/graph/types.ts", "modified", "graph"),
    ];
    const result = clusterFiles(files);
    // No prefix group because filenames have no shared prefix
    const prefixCluster = result.find((c) => c.type === "prefix-group");
    expect(prefixCluster).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Layer groups (fallthrough)
// ---------------------------------------------------------------------------

describe("clusterFiles() — layer grouping (fallthrough)", () => {
  it("groups remaining files by layer", () => {
    // Files with no shared prefix and different layers
    const files = [
      makeFile("src/tools/alpha.ts", "modified", "tools"),
      makeFile("src/graph/beta.ts", "modified", "graph"),
    ];
    const result = clusterFiles(files);
    // Should produce layer-group or other clusters (1 per layer minimum when >= 2 files per layer)
    // If only 1 file per layer, they may merge into "other"
    expect(result.length).toBeGreaterThan(0);
  });

  it("groups two files in same layer into a layer-group cluster", () => {
    const files = [
      makeFile("src/tools/alpha.ts", "modified", "tools"),
      makeFile("src/tools/beta.ts", "modified", "tools"),
    ];
    const result = clusterFiles(files);
    expect(result.length).toBeGreaterThan(0);
    const hasLayerOrPrefix = result.some(
      (c) => c.type === "layer-group" || c.type === "prefix-group",
    );
    expect(hasLayerOrPrefix).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Small cluster merge
// ---------------------------------------------------------------------------

describe("clusterFiles() — small cluster merge", () => {
  it("merges 1-file clusters into 'other' cluster", () => {
    // Different directories, no common prefix, different layers -> many tiny clusters
    const files = [
      makeFile("src/a/one.ts", "modified", "tools"),
      makeFile("src/b/two.ts", "modified", "graph"),
    ];
    const result = clusterFiles(files);
    // Each 1-file group should merge — result should contain an 'other' cluster
    const other = result.find((c) => c.type === "other" || c.title.toLowerCase().includes("other"));
    expect(other).toBeDefined();
  });

  it("cluster with < 2 files is merged away", () => {
    const files = [makeFile("src/a/alone.ts", "modified", "tools")];
    const result = clusterFiles(files);
    expect(result).toHaveLength(1);
    // It ends up in the other bucket
    expect(result[0].type).toBe("other");
  });
});

// ---------------------------------------------------------------------------
// Large cluster split
// ---------------------------------------------------------------------------

describe("clusterFiles() — large cluster split", () => {
  it("splits a cluster with > 30 files into subdirectory sub-clusters", () => {
    // 35 files, split across two subdirectories
    const files: ClusterInput[] = [];
    for (let i = 0; i < 20; i++) {
      files.push(makeFile(`src/big/subA/file-${i}.ts`, "modified", "graph"));
    }
    for (let i = 0; i < 15; i++) {
      files.push(makeFile(`src/big/subB/file-${i}.ts`, "modified", "graph"));
    }
    const result = clusterFiles(files);
    const noClusterExceeds30 = result.every((c) => c.files.length <= 30);
    expect(noClusterExceeds30).toBe(true);
  });

  it("does not split clusters with <= 30 files", () => {
    const files: ClusterInput[] = [];
    for (let i = 0; i < 30; i++) {
      files.push(makeFile(`src/ok/sub/file-${i}.ts`, "added", "graph"));
    }
    const result = clusterFiles(files);
    // All 30 added files in one directory -> one new-feature cluster, 30 files
    const cluster = result.find((c) => c.type === "new-feature");
    expect(cluster).toBeDefined();
    expect(cluster!.files).toHaveLength(30);
  });
});

// ---------------------------------------------------------------------------
// Acceptance invariants
// ---------------------------------------------------------------------------

describe("clusterFiles() — acceptance invariants", () => {
  it("always returns >= 1 cluster for > 0 files", () => {
    const files = [makeFile("src/foo.ts", "modified", "tools")];
    const result = clusterFiles(files);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("no cluster exceeds 30 files", () => {
    const files: ClusterInput[] = [];
    for (let i = 0; i < 50; i++) {
      files.push(makeFile(`src/huge/file-${i}.ts`, "modified", "graph"));
    }
    const result = clusterFiles(files);
    const exceeds = result.filter((c) => c.files.length > 30);
    expect(exceeds).toHaveLength(0);
  });

  it("total files across all clusters equals input file count", () => {
    const files = [
      makeFile("src/graph/kg-store.ts", "modified", "graph"),
      makeFile("src/graph/kg-query.ts", "modified", "graph"),
      makeFile("src/tools/pr-data.ts", "modified", "tools"),
    ];
    const result = clusterFiles(files);
    const total = result.reduce((sum, c) => sum + c.files.length, 0);
    expect(total).toBe(files.length);
  });

  it("each cluster has a non-empty id, title, and description", () => {
    const files = [
      makeFile("src/graph/kg-store.ts", "modified", "graph"),
      makeFile("src/graph/kg-query.ts", "modified", "graph"),
    ];
    const result = clusterFiles(files);
    for (const cluster of result) {
      expect(cluster.id.length).toBeGreaterThan(0);
      expect(cluster.title.length).toBeGreaterThan(0);
      expect(cluster.description.length).toBeGreaterThan(0);
    }
  });

  it("real-world fixture: produces >= 1 cluster", () => {
    const result = clusterFiles(REAL_WORLD_FIXTURE);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("real-world fixture: no cluster > 30 files", () => {
    const result = clusterFiles(REAL_WORLD_FIXTURE);
    const exceeds = result.filter((c) => c.files.length > 30);
    expect(exceeds).toHaveLength(0);
  });

  it("real-world fixture: all files accounted for", () => {
    const result = clusterFiles(REAL_WORLD_FIXTURE);
    const total = result.reduce((sum, c) => sum + c.files.length, 0);
    expect(total).toBe(REAL_WORLD_FIXTURE.length);
  });
});

// ---------------------------------------------------------------------------
// findCommonPrefix — unit tests
// ---------------------------------------------------------------------------

describe("findCommonPrefix()", () => {
  it("finds kg- prefix from kg-store, kg-query, kg-types", () => {
    const result = findCommonPrefix(["kg-store.ts", "kg-query.ts", "kg-types.ts"]);
    expect(result).toBe("kg-");
  });

  it("finds pr- prefix from pr-review-data, pr-review-prep", () => {
    const result = findCommonPrefix(["pr-review-data.ts", "pr-review-prep.ts"]);
    expect(result).toBe("pr-");
  });

  it("returns null when no common prefix exists", () => {
    const result = findCommonPrefix(["store.ts", "query.ts", "types.ts"]);
    expect(result).toBeNull();
  });

  it("returns null for a single filename (no comparison possible)", () => {
    const result = findCommonPrefix(["kg-store.ts"]);
    expect(result).toBeNull();
  });

  it("returns null for empty array", () => {
    const result = findCommonPrefix([]);
    expect(result).toBeNull();
  });

  it("finds _ separator prefix: get_branch and get_query share get_", () => {
    const result = findCommonPrefix(["get_branch.ts", "get_query.ts"]);
    expect(result).toBe("get_");
  });

  it("finds . separator prefix: bridge.ts and bridge.test.ts share bridge.", () => {
    const result = findCommonPrefix(["bridge.ts", "bridge.test.ts"]);
    expect(result).toBe("bridge.");
  });
});

// ---------------------------------------------------------------------------
// synthesizeDescription — structural tests
// ---------------------------------------------------------------------------

describe("synthesizeDescription (via cluster output)", () => {
  it("new-feature cluster has non-empty description", () => {
    const files = [
      makeFile("src/graph/kg-store.ts", "added", "graph"),
      makeFile("src/graph/kg-query.ts", "added", "graph"),
    ];
    const result = clusterFiles(files);
    const newFeature = result.find((c) => c.type === "new-feature");
    expect(newFeature!.description).toBeTruthy();
  });

  it("removal cluster has non-empty description", () => {
    const files = [
      makeFile("src/legacy/old-store.ts", "deleted", "graph"),
      makeFile("src/legacy/old-query.ts", "deleted", "graph"),
    ];
    const result = clusterFiles(files);
    const removal = result.find((c) => c.type === "removal");
    expect(removal!.description).toBeTruthy();
  });

  it("layer-group cluster has non-empty description", () => {
    const files = [
      makeFile("src/tools/alpha.ts", "modified", "tools"),
      makeFile("src/tools/beta.ts", "modified", "tools"),
    ];
    const result = clusterFiles(files);
    for (const cluster of result) {
      expect(cluster.description.length).toBeGreaterThan(0);
    }
  });

  it("other cluster has non-empty description", () => {
    const files = [makeFile("src/a/alone.ts", "modified", "tools")];
    const result = clusterFiles(files);
    expect(result[0].description).toBeTruthy();
  });
});
