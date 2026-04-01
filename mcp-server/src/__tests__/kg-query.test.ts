/**
 * KgQuery Tests
 *
 * Tests for getBlastRadius() CTE direction correctness and getFileBlastRadius().
 * Uses in-memory SQLite for speed and isolation.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { KgQuery } from "../graph/kg-query.ts";
import { initDatabase } from "../graph/kg-schema.ts";
import { KgStore } from "../graph/kg-store.ts";
import type { EntityRow, FileRow } from "../graph/kg-types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFileRow(overrides: Partial<Omit<FileRow, "file_id">> = {}): Omit<FileRow, "file_id"> {
  return {
    path: "src/A.ts",
    mtime_ms: 1700000000000,
    content_hash: "abc123",
    language: "typescript",
    layer: "domain",
    last_indexed_at: Date.now(),
    ...overrides,
  };
}

function makeEntityRow(
  fileId: number,
  overrides: Partial<Omit<EntityRow, "entity_id" | "file_id">> = {},
): Omit<EntityRow, "entity_id"> {
  return {
    file_id: fileId,
    name: "myFunc",
    qualified_name: "src/A.ts::myFunc",
    kind: "function",
    line_start: 1,
    line_end: 10,
    is_exported: false,
    is_default_export: false,
    signature: null,
    metadata: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getBlastRadius
// ---------------------------------------------------------------------------

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
    const fileA = store.upsertFile(makeFileRow({ path: "src/A.ts", layer: "api" }));
    const fileB = store.upsertFile(makeFileRow({ path: "src/B.ts", layer: "domain" }));

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
      source_entity_id: entityA.entity_id!,
      target_entity_id: entityB.entity_id!,
      edge_type: "calls",
      confidence: 1.0,
      metadata: null,
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
    const fileA = store.upsertFile(makeFileRow({ path: "src/A.ts", layer: "api" }));
    const fileEntity = store.insertEntity(
      makeEntityRow(fileA.file_id!, {
        name: "A",
        qualified_name: "src/A.ts",
        kind: "file",
      }),
    );
    const funcA = store.insertEntity(
      makeEntityRow(fileA.file_id!, {
        name: "funcA",
        qualified_name: "src/A.ts::funcA",
        kind: "function",
      }),
    );

    // File entity "contains" funcA
    store.insertEdge({
      source_entity_id: fileEntity.entity_id!,
      target_entity_id: funcA.entity_id!,
      edge_type: "contains",
      confidence: 1.0,
      metadata: null,
    });

    // Blast radius of funcA should NOT include fileEntity (contains is excluded)
    const results = query.getBlastRadius([funcA.entity_id!], 3);
    const entityIds = results.map((r) => r.entity_id);
    expect(entityIds).not.toContain(fileEntity.entity_id);
  });

  test("respects maxDepth", () => {
    // Setup: A calls B calls C calls D. Seed = D. maxDepth = 2.
    // Expected: C (depth 1) and B (depth 2) are included, A (depth 3) is NOT.
    const fileA = store.upsertFile(makeFileRow({ path: "src/A.ts", layer: "api" }));
    const fileB = store.upsertFile(makeFileRow({ path: "src/B.ts", layer: "domain" }));
    const fileC = store.upsertFile(makeFileRow({ path: "src/C.ts", layer: "domain" }));
    const fileD = store.upsertFile(makeFileRow({ path: "src/D.ts", layer: "shared" }));

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
      source_entity_id: entityA.entity_id!,
      target_entity_id: entityB.entity_id!,
      edge_type: "calls",
      confidence: 1.0,
      metadata: null,
    });
    store.insertEdge({
      source_entity_id: entityB.entity_id!,
      target_entity_id: entityC.entity_id!,
      edge_type: "calls",
      confidence: 1.0,
      metadata: null,
    });
    store.insertEdge({
      source_entity_id: entityC.entity_id!,
      target_entity_id: entityD.entity_id!,
      edge_type: "calls",
      confidence: 1.0,
      metadata: null,
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
    const fileA = store.upsertFile(makeFileRow({ path: "src/A.ts", layer: "api" }));
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

// ---------------------------------------------------------------------------
// getFileBlastRadius
// ---------------------------------------------------------------------------

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
    const fileA = store.upsertFile(makeFileRow({ path: "src/A.ts", layer: "api", language: "typescript" }));
    const fileB = store.upsertFile(makeFileRow({ path: "src/B.ts", layer: "domain", language: "typescript" }));

    store.insertFileEdge({
      source_file_id: fileA.file_id!,
      target_file_id: fileB.file_id!,
      edge_type: "imports",
      confidence: 1.0,
      evidence: "import { funcB } from './B'",
      relation: "imports",
    });

    const results = query.getFileBlastRadius(fileB.file_id!);

    expect(results.length).toBe(1);
    expect(results[0].file_id).toBe(fileA.file_id);
    expect(results[0].path).toBe("src/A.ts");
    expect(results[0].depth).toBe(1);
  });

  test("returns correct depth for multi-hop paths", () => {
    // Setup: A imports B, B imports C. Seed = C. Expected: B(depth 1), A(depth 2).
    const fileA = store.upsertFile(makeFileRow({ path: "src/A.ts", layer: "api", language: "typescript" }));
    const fileB = store.upsertFile(makeFileRow({ path: "src/B.ts", layer: "domain", language: "typescript" }));
    const fileC = store.upsertFile(makeFileRow({ path: "src/C.ts", layer: "shared", language: "typescript" }));

    store.insertFileEdge({
      source_file_id: fileA.file_id!,
      target_file_id: fileB.file_id!,
      edge_type: "imports",
      confidence: 1.0,
      evidence: "import { funcB } from './B'",
      relation: "imports",
    });
    store.insertFileEdge({
      source_file_id: fileB.file_id!,
      target_file_id: fileC.file_id!,
      edge_type: "imports",
      confidence: 1.0,
      evidence: "import { funcC } from './C'",
      relation: "imports",
    });

    const results = query.getFileBlastRadius(fileC.file_id!, 2);

    const resultMap = new Map(results.map((r) => [r.file_id, r]));
    expect(resultMap.get(fileB.file_id!)?.depth).toBe(1);
    expect(resultMap.get(fileA.file_id!)?.depth).toBe(2);
    // Seed file itself should NOT be in results (depth > 0 filter)
    expect(resultMap.has(fileC.file_id!)).toBe(false);
  });

  test("returns empty array when no file_edges point to the seed", () => {
    const fileA = store.upsertFile(makeFileRow({ path: "src/A.ts", layer: "api" }));

    const results = query.getFileBlastRadius(fileA.file_id!);
    expect(results).toEqual([]);
  });

  test("uses shortest path depth when a file is reachable via multiple routes", () => {
    // Setup: A->C (direct), A->B->C. Seed = C. A should appear at depth 1 (shortest).
    const fileA = store.upsertFile(makeFileRow({ path: "src/A.ts", layer: "api", language: "typescript" }));
    const fileB = store.upsertFile(makeFileRow({ path: "src/B.ts", layer: "domain", language: "typescript" }));
    const fileC = store.upsertFile(makeFileRow({ path: "src/C.ts", layer: "shared", language: "typescript" }));

    // A imports C directly (depth 1)
    store.insertFileEdge({
      source_file_id: fileA.file_id!,
      target_file_id: fileC.file_id!,
      edge_type: "imports",
      confidence: 1.0,
      evidence: "import { funcC } from './C'",
      relation: "imports",
    });
    // A imports B (depth 1 route to B)
    store.insertFileEdge({
      source_file_id: fileA.file_id!,
      target_file_id: fileB.file_id!,
      edge_type: "imports",
      confidence: 1.0,
      evidence: "import { funcB } from './B'",
      relation: "imports",
    });
    // B imports C (depth 2 route from A to C via B)
    store.insertFileEdge({
      source_file_id: fileB.file_id!,
      target_file_id: fileC.file_id!,
      edge_type: "imports",
      confidence: 1.0,
      evidence: "import { funcC } from './C'",
      relation: "imports",
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
    const fileA = store.upsertFile(makeFileRow({ path: "src/A.ts", layer: "api", language: "typescript" }));
    const fileB = store.upsertFile(makeFileRow({ path: "src/B.ts", layer: "domain", language: "typescript" }));
    const fileC = store.upsertFile(makeFileRow({ path: "src/C.ts", layer: "domain", language: "typescript" }));
    const fileD = store.upsertFile(makeFileRow({ path: "src/D.ts", layer: "shared", language: "typescript" }));

    store.insertFileEdge({
      source_file_id: fileA.file_id!,
      target_file_id: fileB.file_id!,
      edge_type: "imports",
      confidence: 1.0,
      evidence: null,
      relation: null,
    });
    store.insertFileEdge({
      source_file_id: fileB.file_id!,
      target_file_id: fileC.file_id!,
      edge_type: "imports",
      confidence: 1.0,
      evidence: null,
      relation: null,
    });
    store.insertFileEdge({
      source_file_id: fileC.file_id!,
      target_file_id: fileD.file_id!,
      edge_type: "imports",
      confidence: 1.0,
      evidence: null,
      relation: null,
    });

    const results = query.getFileBlastRadius(fileD.file_id!, 1);
    const filePaths = results.map((r) => r.path);

    expect(filePaths).toContain("src/C.ts");
    expect(filePaths).not.toContain("src/B.ts");
    expect(filePaths).not.toContain("src/A.ts");
  });

  test("includes layer and language fields in results", () => {
    const fileA = store.upsertFile(makeFileRow({ path: "src/A.ts", layer: "api", language: "typescript" }));
    const fileB = store.upsertFile(makeFileRow({ path: "src/B.ts", layer: "shared", language: "typescript" }));

    store.insertFileEdge({
      source_file_id: fileA.file_id!,
      target_file_id: fileB.file_id!,
      edge_type: "imports",
      confidence: 1.0,
      evidence: null,
      relation: null,
    });

    const results = query.getFileBlastRadius(fileB.file_id!);

    expect(results.length).toBe(1);
    expect(results[0].layer).toBe("api");
    expect(results[0].language).toBe("typescript");
  });
});
