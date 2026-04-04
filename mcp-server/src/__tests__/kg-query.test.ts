/**
 * KgQuery Tests
 *
 * Tests for getBlastRadius() CTE direction correctness and getFileBlastRadius().
 * Uses in-memory SQLite for speed and isolation.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { computeFileInsightMaps, KgQuery } from "../graph/kg-query.ts";
import { initDatabase } from "../graph/kg-schema.ts";
import { KgStore } from "../graph/kg-store.ts";
import type { EntityRow, FileRow } from "../graph/kg-types.ts";

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

function makeEntityRow(
  fileId: number,
  overrides: Partial<Omit<EntityRow, "entity_id" | "file_id">> = {},
): Omit<EntityRow, "entity_id"> {
  return {
    file_id: fileId,
    is_default_export: false,
    is_exported: false,
    kind: "function",
    line_end: 10,
    line_start: 1,
    metadata: null,
    name: "myFunc",
    qualified_name: "src/A.ts::myFunc",
    signature: null,
    ...overrides,
  };
}

// getBlastRadius

describe("KgQuery.getBlastRadius()", () => {
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

  test("returns entities that DEPEND ON the seed (callers), not callees", () => {
    // Setup: entity A calls entity B. Seed = B. Expected: A is in results.
    const fileA = store.upsertFile(makeFileRow({ layer: "api", path: "src/A.ts" }));
    const fileB = store.upsertFile(makeFileRow({ layer: "domain", path: "src/B.ts" }));

    const entityA = store.insertEntity(
      makeEntityRow(fileA.file_id!, {
        name: "funcA",
        qualified_name: "src/A.ts::funcA",
      }),
    );
    const entityB = store.insertEntity(
      makeEntityRow(fileB.file_id!, {
        name: "funcB",
        qualified_name: "src/B.ts::funcB",
      }),
    );

    // A calls B (A depends on B)
    store.insertEdge({
      confidence: 1.0,
      edge_type: "calls",
      metadata: null,
      source_entity_id: entityA.entity_id!,
      target_entity_id: entityB.entity_id!,
    });

    // Blast radius of B should include A (A depends on B, so changes to B affect A)
    const results = query.getBlastRadius([entityB.entity_id!], 3);

    // Should include A (the caller)
    const entityIds = results.map((r) => r.entity_id);
    expect(entityIds).toContain(entityA.entity_id);

    // Should NOT include B itself (depth = 0 is excluded from "dependents")
    // Note: the seed IS included at depth 0 in the CTE — check caller is at depth 1
    const aResult = results.find((r) => r.entity_id === entityA.entity_id);
    expect(aResult).toBeDefined();
    expect(aResult!.depth).toBe(1);
  });

  test("does NOT follow contains edges", () => {
    // Setup: file entity "contains" funcA. Seed = funcA. Result should NOT include file.
    const fileA = store.upsertFile(makeFileRow({ layer: "api", path: "src/A.ts" }));
    const fileEntity = store.insertEntity(
      makeEntityRow(fileA.file_id!, {
        kind: "file",
        name: "A",
        qualified_name: "src/A.ts",
      }),
    );
    const funcA = store.insertEntity(
      makeEntityRow(fileA.file_id!, {
        kind: "function",
        name: "funcA",
        qualified_name: "src/A.ts::funcA",
      }),
    );

    // File entity "contains" funcA
    store.insertEdge({
      confidence: 1.0,
      edge_type: "contains",
      metadata: null,
      source_entity_id: fileEntity.entity_id!,
      target_entity_id: funcA.entity_id!,
    });

    // Blast radius of funcA should NOT include fileEntity (contains is excluded)
    const results = query.getBlastRadius([funcA.entity_id!], 3);
    const entityIds = results.map((r) => r.entity_id);
    expect(entityIds).not.toContain(fileEntity.entity_id);
  });

  test("respects maxDepth", () => {
    // Setup: A calls B calls C calls D. Seed = D. maxDepth = 2.
    // Expected: C (depth 1) and B (depth 2) are included, A (depth 3) is NOT.
    const fileA = store.upsertFile(makeFileRow({ layer: "api", path: "src/A.ts" }));
    const fileB = store.upsertFile(makeFileRow({ layer: "domain", path: "src/B.ts" }));
    const fileC = store.upsertFile(makeFileRow({ layer: "domain", path: "src/C.ts" }));
    const fileD = store.upsertFile(makeFileRow({ layer: "shared", path: "src/D.ts" }));

    const entityA = store.insertEntity(
      makeEntityRow(fileA.file_id!, { name: "funcA", qualified_name: "src/A.ts::funcA" }),
    );
    const entityB = store.insertEntity(
      makeEntityRow(fileB.file_id!, { name: "funcB", qualified_name: "src/B.ts::funcB" }),
    );
    const entityC = store.insertEntity(
      makeEntityRow(fileC.file_id!, { name: "funcC", qualified_name: "src/C.ts::funcC" }),
    );
    const entityD = store.insertEntity(
      makeEntityRow(fileD.file_id!, { name: "funcD", qualified_name: "src/D.ts::funcD" }),
    );

    // A->B->C->D call chain
    store.insertEdge({
      confidence: 1.0,
      edge_type: "calls",
      metadata: null,
      source_entity_id: entityA.entity_id!,
      target_entity_id: entityB.entity_id!,
    });
    store.insertEdge({
      confidence: 1.0,
      edge_type: "calls",
      metadata: null,
      source_entity_id: entityB.entity_id!,
      target_entity_id: entityC.entity_id!,
    });
    store.insertEdge({
      confidence: 1.0,
      edge_type: "calls",
      metadata: null,
      source_entity_id: entityC.entity_id!,
      target_entity_id: entityD.entity_id!,
    });

    // Seed = D, maxDepth = 2 → should include C (depth 1) and B (depth 2)
    const results = query.getBlastRadius([entityD.entity_id!], 2);
    const entityIds = results.map((r) => r.entity_id);

    expect(entityIds).toContain(entityC.entity_id); // depth 1
    expect(entityIds).toContain(entityB.entity_id); // depth 2
    expect(entityIds).not.toContain(entityA.entity_id); // depth 3 — excluded
  });

  test("returns empty array for empty seed list", () => {
    const results = query.getBlastRadius([]);
    expect(results).toEqual([]);
  });

  test("returns only seed at depth 0 when there are no callers", () => {
    const fileA = store.upsertFile(makeFileRow({ layer: "api", path: "src/A.ts" }));
    const entityA = store.insertEntity(
      makeEntityRow(fileA.file_id!, { name: "funcA", qualified_name: "src/A.ts::funcA" }),
    );

    const results = query.getBlastRadius([entityA.entity_id!], 3);
    // Seed is included at depth 0, no callers so no depth > 0 results
    expect(results.length).toBe(1);
    expect(results[0].entity_id).toBe(entityA.entity_id);
    expect(results[0].depth).toBe(0);
  });
});

// getFileBlastRadius

describe("KgQuery.getFileBlastRadius()", () => {
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

  test("returns files that reference the seed file via file_edges", () => {
    // Setup: File A imports File B. Seed = B. Expected: A is in results.
    const fileA = store.upsertFile(
      makeFileRow({ language: "typescript", layer: "api", path: "src/A.ts" }),
    );
    const fileB = store.upsertFile(
      makeFileRow({ language: "typescript", layer: "domain", path: "src/B.ts" }),
    );

    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: "import { funcB } from './B'",
      relation: "imports",
      source_file_id: fileA.file_id!,
      target_file_id: fileB.file_id!,
    });

    const results = query.getFileBlastRadius(fileB.file_id!);

    expect(results.length).toBe(1);
    expect(results[0].file_id).toBe(fileA.file_id);
    expect(results[0].path).toBe("src/A.ts");
    expect(results[0].depth).toBe(1);
  });

  test("returns correct depth for multi-hop paths", () => {
    // Setup: A imports B, B imports C. Seed = C. Expected: B(depth 1), A(depth 2).
    const fileA = store.upsertFile(
      makeFileRow({ language: "typescript", layer: "api", path: "src/A.ts" }),
    );
    const fileB = store.upsertFile(
      makeFileRow({ language: "typescript", layer: "domain", path: "src/B.ts" }),
    );
    const fileC = store.upsertFile(
      makeFileRow({ language: "typescript", layer: "shared", path: "src/C.ts" }),
    );

    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: "import { funcB } from './B'",
      relation: "imports",
      source_file_id: fileA.file_id!,
      target_file_id: fileB.file_id!,
    });
    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: "import { funcC } from './C'",
      relation: "imports",
      source_file_id: fileB.file_id!,
      target_file_id: fileC.file_id!,
    });

    const results = query.getFileBlastRadius(fileC.file_id!, 2);

    const resultMap = new Map(results.map((r) => [r.file_id, r]));
    expect(resultMap.get(fileB.file_id!)?.depth).toBe(1);
    expect(resultMap.get(fileA.file_id!)?.depth).toBe(2);
    // Seed file itself should NOT be in results (depth > 0 filter)
    expect(resultMap.has(fileC.file_id!)).toBe(false);
  });

  test("returns empty array when no file_edges point to the seed", () => {
    const fileA = store.upsertFile(makeFileRow({ layer: "api", path: "src/A.ts" }));

    const results = query.getFileBlastRadius(fileA.file_id!);
    expect(results).toEqual([]);
  });

  test("uses shortest path depth when a file is reachable via multiple routes", () => {
    // Setup: A->C (direct), A->B->C. Seed = C. A should appear at depth 1 (shortest).
    const fileA = store.upsertFile(
      makeFileRow({ language: "typescript", layer: "api", path: "src/A.ts" }),
    );
    const fileB = store.upsertFile(
      makeFileRow({ language: "typescript", layer: "domain", path: "src/B.ts" }),
    );
    const fileC = store.upsertFile(
      makeFileRow({ language: "typescript", layer: "shared", path: "src/C.ts" }),
    );

    // A imports C directly (depth 1)
    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: "import { funcC } from './C'",
      relation: "imports",
      source_file_id: fileA.file_id!,
      target_file_id: fileC.file_id!,
    });
    // A imports B (depth 1 route to B)
    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: "import { funcB } from './B'",
      relation: "imports",
      source_file_id: fileA.file_id!,
      target_file_id: fileB.file_id!,
    });
    // B imports C (depth 2 route from A to C via B)
    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: "import { funcC } from './C'",
      relation: "imports",
      source_file_id: fileB.file_id!,
      target_file_id: fileC.file_id!,
    });

    const results = query.getFileBlastRadius(fileC.file_id!, 3);

    const resultMap = new Map(results.map((r) => [r.file_id, r]));
    // A reaches C at depth 1 directly — should use shortest path (depth 1)
    expect(resultMap.get(fileA.file_id!)?.depth).toBe(1);
    // B reaches C at depth 1
    expect(resultMap.get(fileB.file_id!)?.depth).toBe(1);
  });

  test("respects maxDepth", () => {
    // A imports B, B imports C, C imports D. Seed = D. maxDepth = 1.
    // Expected: only C (depth 1). B and A are excluded.
    const fileA = store.upsertFile(
      makeFileRow({ language: "typescript", layer: "api", path: "src/A.ts" }),
    );
    const fileB = store.upsertFile(
      makeFileRow({ language: "typescript", layer: "domain", path: "src/B.ts" }),
    );
    const fileC = store.upsertFile(
      makeFileRow({ language: "typescript", layer: "domain", path: "src/C.ts" }),
    );
    const fileD = store.upsertFile(
      makeFileRow({ language: "typescript", layer: "shared", path: "src/D.ts" }),
    );

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
    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: null,
      relation: null,
      source_file_id: fileC.file_id!,
      target_file_id: fileD.file_id!,
    });

    const results = query.getFileBlastRadius(fileD.file_id!, 1);
    const filePaths = results.map((r) => r.path);

    expect(filePaths).toContain("src/C.ts");
    expect(filePaths).not.toContain("src/B.ts");
    expect(filePaths).not.toContain("src/A.ts");
  });

  test("includes layer and language fields in results", () => {
    const fileA = store.upsertFile(
      makeFileRow({ language: "typescript", layer: "api", path: "src/A.ts" }),
    );
    const fileB = store.upsertFile(
      makeFileRow({ language: "typescript", layer: "shared", path: "src/B.ts" }),
    );

    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: null,
      relation: null,
      source_file_id: fileA.file_id!,
      target_file_id: fileB.file_id!,
    });

    const results = query.getFileBlastRadius(fileB.file_id!);

    expect(results.length).toBe(1);
    expect(results[0].layer).toBe("api");
    expect(results[0].language).toBe("typescript");
  });
});

// getFileDegrees

describe("KgQuery.getFileDegrees()", () => {
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

  test("returns correct in_degree and out_degree for a file with known edges", () => {
    const fileA = store.upsertFile(makeFileRow({ layer: "domain", path: "src/A.ts" }));
    const fileB = store.upsertFile(makeFileRow({ layer: "domain", path: "src/B.ts" }));
    const fileC = store.upsertFile(makeFileRow({ layer: "domain", path: "src/C.ts" }));

    // A imports B and C (out_degree = 2)
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
      source_file_id: fileA.file_id!,
      target_file_id: fileC.file_id!,
    });
    // B also imports C (so C has in_degree = 2)
    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: null,
      relation: null,
      source_file_id: fileB.file_id!,
      target_file_id: fileC.file_id!,
    });

    const degreesA = query.getFileDegrees(fileA.file_id!);
    expect(degreesA.in_degree).toBe(0);
    expect(degreesA.out_degree).toBe(2);

    const degreesB = query.getFileDegrees(fileB.file_id!);
    expect(degreesB.in_degree).toBe(1);
    expect(degreesB.out_degree).toBe(1);

    const degreesC = query.getFileDegrees(fileC.file_id!);
    expect(degreesC.in_degree).toBe(2);
    expect(degreesC.out_degree).toBe(0);
  });

  test("returns zero degrees for a file with no edges", () => {
    const fileA = store.upsertFile(makeFileRow({ layer: "domain", path: "src/A.ts" }));
    const degrees = query.getFileDegrees(fileA.file_id!);
    expect(degrees.in_degree).toBe(0);
    expect(degrees.out_degree).toBe(0);
  });
});

// getAllFileDegrees

describe("KgQuery.getAllFileDegrees()", () => {
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

  test("returns degree map matching manual count", () => {
    const fileA = store.upsertFile(makeFileRow({ layer: "domain", path: "src/A.ts" }));
    const fileB = store.upsertFile(makeFileRow({ layer: "domain", path: "src/B.ts" }));
    const fileC = store.upsertFile(makeFileRow({ layer: "shared", path: "src/C.ts" }));

    // A -> B, A -> C, B -> C
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
      source_file_id: fileA.file_id!,
      target_file_id: fileC.file_id!,
    });
    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: null,
      relation: null,
      source_file_id: fileB.file_id!,
      target_file_id: fileC.file_id!,
    });

    const map = query.getAllFileDegrees();

    expect(map.get(fileA.file_id!)).toEqual({ in_degree: 0, out_degree: 2 });
    expect(map.get(fileB.file_id!)).toEqual({ in_degree: 1, out_degree: 1 });
    expect(map.get(fileC.file_id!)).toEqual({ in_degree: 2, out_degree: 0 });
  });

  test("returns empty map for DB with no edges", () => {
    const map = query.getAllFileDegrees();
    expect(map.size).toBe(0);
  });
});

// getFileAdjacencyList

describe("KgQuery.getFileAdjacencyList()", () => {
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

  test("returns correct adjacency structure", () => {
    const fileA = store.upsertFile(makeFileRow({ layer: "domain", path: "src/A.ts" }));
    const fileB = store.upsertFile(makeFileRow({ layer: "domain", path: "src/B.ts" }));
    const fileC = store.upsertFile(makeFileRow({ layer: "shared", path: "src/C.ts" }));

    // A -> B, A -> C
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
      source_file_id: fileA.file_id!,
      target_file_id: fileC.file_id!,
    });

    const adj = query.getFileAdjacencyList();

    const neighborsA = adj.get(fileA.file_id!);
    expect(neighborsA).toBeDefined();
    expect(neighborsA).toContain(fileB.file_id!);
    expect(neighborsA).toContain(fileC.file_id!);
    // B has no outgoing edges, so it should not be in the map
    expect(adj.has(fileB.file_id!)).toBe(false);
  });

  test("returns empty map when no edges exist", () => {
    const adj = query.getFileAdjacencyList();
    expect(adj.size).toBe(0);
  });
});

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
