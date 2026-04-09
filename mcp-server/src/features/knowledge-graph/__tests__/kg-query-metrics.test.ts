/**
 * KgQuery Tests (Part 2)
 *
 * Tests for getFileMetrics(), getKgFreshnessMs(), getSubgraph(),
 * and computeFileInsightMaps().
 * Uses in-memory SQLite for speed and isolation.
 */

import { computeFileInsightMaps } from "@graph/kg-query-insights.ts";
import { KgQuery } from "@graph/kg-query.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import { KgStore } from "@graph/kg-store.ts";
import type { FileRow } from "@graph/kg-types.ts";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

function makeFileRow(overrides: Partial<Omit<FileRow, "file_id">> = {}): Omit<FileRow, "file_id"> {
  return {
    content_hash: "abc123",
    language: "typescript",
    last_indexed_at: Date.now(),
    layer: "domain",
    mtime_ms: 1700000000000,
    path: "src/A.ts",
    ...overrides,
  };
}

// getFileMetrics

describe("KgQuery.getFileMetrics()", () => {
  let db: Database.Database;
  let store: KgStore;
  let query: KgQuery;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new KgStore(db);
    query = new KgQuery(db);
  });

  afterEach(() => {
    store.close();
  });

  test("returns null for a nonexistent file path", () => {
    const result = query.getFileMetrics("src/nonexistent.ts");
    expect(result).toBeNull();
  });

  test("returns FileMetrics with correct values for a basic file", () => {
    const fileA = store.upsertFile(makeFileRow({ layer: "domain", path: "src/A.ts" }));
    const fileB = store.upsertFile(makeFileRow({ layer: "shared", path: "src/B.ts" }));

    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: null,
      relation: null,
      source_file_id: fileA.file_id!,
      target_file_id: fileB.file_id!,
    });

    const metrics = query.getFileMetrics("src/A.ts");
    expect(metrics).not.toBeNull();
    expect(metrics!.in_degree).toBe(0);
    expect(metrics!.out_degree).toBe(1);
    expect(metrics!.layer).toBe("domain");
    expect(metrics!.is_hub).toBe(false);
    expect(metrics!.in_cycle).toBe(false);
    expect(metrics!.cycle_peers).toEqual([]);
    expect(metrics!.layer_violations).toEqual([]);
    expect(metrics!.layer_violation_count).toBe(0);
    expect(typeof metrics!.impact_score).toBe("number");
  });

  test("returns FileMetrics for a hub file (many in_degree)", () => {
    // Create a shared file that many files import — will be a hub
    const sharedFile = store.upsertFile(makeFileRow({ layer: "shared", path: "src/shared.ts" }));
    // Create 12 files that all import shared.ts (top 10 by degree makes it a hub)
    for (let i = 0; i < 12; i++) {
      const f = store.upsertFile(makeFileRow({ layer: "domain", path: `src/module${i}.ts` }));
      store.insertFileEdge({
        confidence: 1.0,
        edge_type: "imports",
        evidence: null,
        relation: null,
        source_file_id: f.file_id!,
        target_file_id: sharedFile.file_id!,
      });
    }

    const hubMaps = computeFileInsightMaps(db);
    const metrics = query.getFileMetrics("src/shared.ts", {
      cycleMemberPaths: hubMaps.cycleMemberPaths,
      hubPaths: hubMaps.hubPaths,
      layerViolationsByPath: hubMaps.layerViolationsByPath,
    });

    expect(metrics).not.toBeNull();
    expect(metrics!.in_degree).toBe(12);
    expect(metrics!.is_hub).toBe(true);
  });

  test("returns FileMetrics for a cycle member", () => {
    const fileA = store.upsertFile(makeFileRow({ layer: "domain", path: "src/cycle-a.ts" }));
    const fileB = store.upsertFile(makeFileRow({ layer: "domain", path: "src/cycle-b.ts" }));

    // A -> B and B -> A (cycle)
    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: null,
      relation: null,
      source_file_id: fileA.file_id!,
      target_file_id: fileB.file_id!,
    });
    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: null,
      relation: null,
      source_file_id: fileB.file_id!,
      target_file_id: fileA.file_id!,
    });

    const maps = computeFileInsightMaps(db);
    const metrics = query.getFileMetrics("src/cycle-a.ts", {
      cycleMemberPaths: maps.cycleMemberPaths,
    });

    expect(metrics).not.toBeNull();
    expect(metrics!.in_cycle).toBe(true);
    expect(metrics!.cycle_peers).toContain("src/cycle-b.ts");
  });

  test("returns FileMetrics with layer violations", () => {
    // shared -> domain is a violation (shared should not depend on domain)
    const sharedFile = store.upsertFile(makeFileRow({ layer: "shared", path: "src/shared.ts" }));
    const domainFile = store.upsertFile(makeFileRow({ layer: "domain", path: "src/domain.ts" }));

    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: null,
      relation: null,
      source_file_id: sharedFile.file_id!,
      target_file_id: domainFile.file_id!,
    });

    const maps = computeFileInsightMaps(db);
    const metrics = query.getFileMetrics("src/shared.ts", {
      layerViolationsByPath: maps.layerViolationsByPath,
    });

    expect(metrics).not.toBeNull();
    expect(metrics!.layer_violations.length).toBeGreaterThan(0);
    expect(metrics!.layer_violation_count).toBeGreaterThan(0);
    expect(metrics!.layer_violations[0].target).toBe("src/domain.ts");
    expect(metrics!.layer_violations[0].source_layer).toBe("shared");
    expect(metrics!.layer_violations[0].target_layer).toBe("domain");
  });
});

// getKgFreshnessMs

describe("KgQuery.getKgFreshnessMs()", () => {
  let db: Database.Database;
  let store: KgStore;
  let query: KgQuery;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new KgStore(db);
    query = new KgQuery(db);
  });

  afterEach(() => {
    store.close();
  });

  test("returns null for an empty DB", () => {
    const result = query.getKgFreshnessMs();
    expect(result).toBeNull();
  });

  test("returns reasonable ms value for a DB with known last_indexed_at", () => {
    const now = Date.now();
    // Insert a file with a recent last_indexed_at
    store.upsertFile({
      ...makeFileRow({ path: "src/A.ts" }),
      last_indexed_at: now - 5000, // 5 seconds ago
    });

    const freshness = query.getKgFreshnessMs();
    expect(freshness).not.toBeNull();
    // Freshness should be approximately 5000ms (within a 2-second tolerance for test execution)
    expect(freshness).toBeGreaterThanOrEqual(5000);
    expect(freshness).toBeLessThan(10000);
  });

  test("returns freshness based on OLDEST file (MIN last_indexed_at)", () => {
    const now = Date.now();
    // One very old file and one recent file
    store.upsertFile({
      ...makeFileRow({ path: "src/old.ts" }),
      last_indexed_at: now - 60000, // 60 seconds ago
    });
    store.upsertFile({
      ...makeFileRow({ path: "src/new.ts" }),
      last_indexed_at: now - 1000, // 1 second ago
    });

    const freshness = query.getKgFreshnessMs();
    expect(freshness).not.toBeNull();
    // Should use the MIN (oldest), so >= 60000ms
    expect(freshness).toBeGreaterThanOrEqual(60000);
  });
});

// getSubgraph

describe("KgQuery.getSubgraph()", () => {
  let db: Database.Database;
  let store: KgStore;
  let query: KgQuery;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new KgStore(db);
    query = new KgQuery(db);
  });

  afterEach(() => {
    store.close();
  });

  test("returns correct nodes and edges for a subset of files", () => {
    const fileA = store.upsertFile(makeFileRow({ layer: "api", path: "src/A.ts" }));
    const fileB = store.upsertFile(makeFileRow({ layer: "domain", path: "src/B.ts" }));
    const fileC = store.upsertFile(makeFileRow({ layer: "shared", path: "src/C.ts" }));
    // fileD is unrelated
    store.upsertFile(makeFileRow({ layer: "infra", path: "src/D.ts" }));

    // A -> B, B -> C
    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: null,
      relation: null,
      source_file_id: fileA.file_id!,
      target_file_id: fileB.file_id!,
    });
    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: null,
      relation: null,
      source_file_id: fileB.file_id!,
      target_file_id: fileC.file_id!,
    });

    const subgraph = query.getSubgraph(["src/A.ts", "src/B.ts"]);

    // A and B are the seed; C should be included because B -> C
    const nodePaths = subgraph.nodes.map((n) => n.path);
    expect(nodePaths).toContain("src/A.ts");
    expect(nodePaths).toContain("src/B.ts");
    expect(nodePaths).toContain("src/C.ts"); // connected to B
    // D is unrelated — should not appear
    expect(nodePaths).not.toContain("src/D.ts");

    // Should have edges for both A->B and B->C
    const edges = subgraph.edges;
    expect(edges.some((e) => e.source === "src/A.ts" && e.target === "src/B.ts")).toBe(true);
    expect(edges.some((e) => e.source === "src/B.ts" && e.target === "src/C.ts")).toBe(true);
  });

  test("returns empty nodes and edges for empty input", () => {
    const subgraph = query.getSubgraph([]);
    expect(subgraph.nodes).toEqual([]);
    expect(subgraph.edges).toEqual([]);
  });

  test("returns empty nodes and edges for paths not in DB", () => {
    const subgraph = query.getSubgraph(["src/nonexistent.ts"]);
    expect(subgraph.nodes).toEqual([]);
    expect(subgraph.edges).toEqual([]);
  });

  test("includes file_id and layer in nodes", () => {
    store.upsertFile(makeFileRow({ layer: "api", path: "src/A.ts" }));
    store.upsertFile(makeFileRow({ layer: "domain", path: "src/B.ts" }));

    const subgraph = query.getSubgraph(["src/A.ts"]);
    // With no edges, only A is returned (no connected files)
    const nodeA = subgraph.nodes.find((n) => n.path === "src/A.ts");
    expect(nodeA).toBeDefined();
    expect(nodeA!.layer).toBe("api");
    expect(typeof nodeA!.file_id).toBe("number");
  });
});

// computeFileInsightMaps

describe("computeFileInsightMaps()", () => {
  let db: Database.Database;
  let store: KgStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new KgStore(db);
  });

  afterEach(() => {
    store.close();
  });

  test("correctly identifies hubs (top 10 by total degree)", () => {
    // Create 12 files where one file has many connections
    const hubFile = store.upsertFile(makeFileRow({ layer: "shared", path: "src/hub.ts" }));
    for (let i = 0; i < 11; i++) {
      const f = store.upsertFile(makeFileRow({ layer: "domain", path: `src/mod${i}.ts` }));
      store.insertFileEdge({
        confidence: 1.0,
        edge_type: "imports",
        evidence: null,
        relation: null,
        source_file_id: f.file_id!,
        target_file_id: hubFile.file_id!,
      });
    }

    const maps = computeFileInsightMaps(db);
    expect(maps.hubPaths.has("src/hub.ts")).toBe(true);
  });

  test("correctly identifies cycle membership", () => {
    const fileA = store.upsertFile(makeFileRow({ layer: "domain", path: "src/cycle-a.ts" }));
    const fileB = store.upsertFile(makeFileRow({ layer: "domain", path: "src/cycle-b.ts" }));

    // A -> B and B -> A (cycle)
    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: null,
      relation: null,
      source_file_id: fileA.file_id!,
      target_file_id: fileB.file_id!,
    });
    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: null,
      relation: null,
      source_file_id: fileB.file_id!,
      target_file_id: fileA.file_id!,
    });

    const maps = computeFileInsightMaps(db);
    expect(maps.cycleMemberPaths.has("src/cycle-a.ts")).toBe(true);
    expect(maps.cycleMemberPaths.has("src/cycle-b.ts")).toBe(true);
    expect(maps.cycleMemberPaths.get("src/cycle-a.ts")).toContain("src/cycle-b.ts");
  });

  test("correctly identifies layer violations", () => {
    // shared -> domain is a violation
    const sharedFile = store.upsertFile(makeFileRow({ layer: "shared", path: "src/shared.ts" }));
    const domainFile = store.upsertFile(makeFileRow({ layer: "domain", path: "src/domain.ts" }));

    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: null,
      relation: null,
      source_file_id: sharedFile.file_id!,
      target_file_id: domainFile.file_id!,
    });

    const maps = computeFileInsightMaps(db);
    expect(maps.layerViolationsByPath.has("src/shared.ts")).toBe(true);
    const violations = maps.layerViolationsByPath.get("src/shared.ts")!;
    expect(violations.length).toBe(1);
    expect(violations[0].target).toBe("src/domain.ts");
    expect(violations[0].source_layer).toBe("shared");
    expect(violations[0].target_layer).toBe("domain");
  });

  test("returns empty maps for a DB with no edges", () => {
    store.upsertFile(makeFileRow({ path: "src/A.ts" }));
    const maps = computeFileInsightMaps(db);
    expect(maps.hubPaths.size).toBe(0);
    expect(maps.cycleMemberPaths.size).toBe(0);
    expect(maps.layerViolationsByPath.size).toBe(0);
  });
});
