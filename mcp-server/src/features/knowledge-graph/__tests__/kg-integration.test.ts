/**
 * Knowledge Graph — Integration Tests (Part 1)
 *
 * Tests cross-module boundaries:
 *   1. Pipeline → KgQuery end-to-end flow (graph-data.json write path removed — ADR-005)
 *   2. Blast Radius analysis (analyzeBlastRadius — zero gaps in implementor coverage)
 *
 * All filesystem-bound tests use OS temp directories created fresh per test.
 * All DB-bound tests use in-memory SQLite (:memory:).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyzeBlastRadius } from "@graph/kg-blast-radius.ts";
import { runPipeline } from "@graph/kg-pipeline.ts";
import { KgQuery } from "@graph/kg-query.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import { KgStore } from "@graph/kg-store.ts";
import type { EntityRow, FileRow } from "@graph/kg-types.ts";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "kg-integration-test-"));
}

function writeProjectFile(dir: string, relPath: string, content: string): void {
  const abs = path.join(dir, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

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

/**
 * Populate a graph with 3 files and a call chain funcA → funcB → funcC.
 * funcD is dead code (unexported, unreferenced, in fileB).
 */
function populateTestGraph(store: KgStore) {
  const fileA = store.upsertFile(makeFileRow({ layer: "api", path: "src/A.ts" }));
  const fileB = store.upsertFile(makeFileRow({ layer: "domain", path: "src/B.ts" }));
  const fileC = store.upsertFile(makeFileRow({ layer: "shared", path: "src/C.ts" }));

  const funcA = store.insertEntity(
    makeEntityRow(fileA.file_id!, {
      is_exported: true,
      name: "funcA",
      qualified_name: "src/A.ts::funcA",
    }),
  );
  const funcB = store.insertEntity(
    makeEntityRow(fileB.file_id!, {
      is_exported: true,
      name: "funcB",
      qualified_name: "src/B.ts::funcB",
    }),
  );
  const funcC = store.insertEntity(
    makeEntityRow(fileC.file_id!, {
      is_exported: true,
      name: "funcC",
      qualified_name: "src/C.ts::funcC",
    }),
  );
  const funcD = store.insertEntity(
    makeEntityRow(fileB.file_id!, {
      is_exported: false,
      name: "funcD",
      qualified_name: "src/B.ts::funcD",
    }),
  );

  // Entity edges: funcA → funcB → funcC
  store.insertEdge({
    confidence: 1.0,
    edge_type: "calls",
    metadata: null,
    source_entity_id: funcA.entity_id!,
    target_entity_id: funcB.entity_id!,
  });
  store.insertEdge({
    confidence: 1.0,
    edge_type: "calls",
    metadata: null,
    source_entity_id: funcB.entity_id!,
    target_entity_id: funcC.entity_id!,
  });

  // File edges
  store.insertFileEdge({
    confidence: 1.0,
    edge_type: "imports",
    evidence: "import { funcB } from '@features/knowledge-graph/__tests__/B'",
    relation: null,
    source_file_id: fileA.file_id!,
    target_file_id: fileB.file_id!,
  });
  store.insertFileEdge({
    confidence: 1.0,
    edge_type: "imports",
    evidence: "import { funcC } from '@features/knowledge-graph/__tests__/C'",
    relation: null,
    source_file_id: fileB.file_id!,
    target_file_id: fileC.file_id!,
  });

  return { fileA, fileB, fileC, funcA, funcB, funcC, funcD };
}

// 1. Pipeline → KgQuery end-to-end flow
// (view-materializer.ts deleted — ADR-005; graph-data.json write path removed)

describe("Pipeline → KgQuery end-to-end flow", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(projectDir, { force: true, recursive: true });
  });

  test("pipeline populates DB and KgQuery returns correct nodes and edges", {
    timeout: 15_000,
  }, async () => {
    writeProjectFile(projectDir, "src/a.ts", "export function hello() {}");
    writeProjectFile(projectDir, "src/b.ts", "import { hello } from './a.ts';");

    const dbPath = path.join(projectDir, "test.db");
    await runPipeline(projectDir, { dbPath, incremental: false });

    const db = new Database(dbPath);
    try {
      const query = new KgQuery(db);
      const filesWithStats = query.getAllFilesWithStats();
      expect(filesWithStats.length).toBeGreaterThanOrEqual(2);

      // b.ts should have an import edge targeting a.ts
      const fileEdgeRows = db
        .prepare(
          `SELECT fe.edge_type, src.path AS source_path, tgt.path AS target_path
           FROM file_edges fe
           JOIN files src ON src.file_id = fe.source_file_id
           JOIN files tgt ON tgt.file_id = fe.target_file_id`,
        )
        .all() as Array<{ edge_type: string; source_path: string; target_path: string }>;

      const importEdge = fileEdgeRows.find(
        (e) => e.source_path === "src/b.ts" && e.target_path === "src/a.ts",
      );
      expect(importEdge).toBeDefined();
      expect(importEdge!.edge_type).toBe("imports");
    } finally {
      db.close();
    }
  });

  test("incremental reindex updates edges when import is added", async () => {
    writeProjectFile(projectDir, "src/a.ts", "export function greet() {}");
    writeProjectFile(projectDir, "src/b.ts", "// no imports yet");

    const dbPath = path.join(projectDir, "test.db");
    await runPipeline(projectDir, { dbPath, incremental: false });

    // Verify no edge from b.ts → a.ts initially
    const dbBefore = new Database(dbPath);
    const edgesBefore = dbBefore
      .prepare(
        `SELECT src.path AS source_path, tgt.path AS target_path
         FROM file_edges fe
         JOIN files src ON src.file_id = fe.source_file_id
         JOIN files tgt ON tgt.file_id = fe.target_file_id`,
      )
      .all() as Array<{ source_path: string; target_path: string }>;
    dbBefore.close();
    const edgeBefore = edgesBefore.find(
      (e) => e.source_path === "src/b.ts" && e.target_path === "src/a.ts",
    );
    expect(edgeBefore).toBeUndefined();

    // Update b.ts to import from a.ts
    writeProjectFile(projectDir, "src/b.ts", "import { greet } from './a.ts';");

    // Re-run pipeline (non-incremental to force re-parse)
    await runPipeline(projectDir, { dbPath, incremental: false });

    const dbAfter = new Database(dbPath);
    const edgesAfter = dbAfter
      .prepare(
        `SELECT src.path AS source_path, tgt.path AS target_path
         FROM file_edges fe
         JOIN files src ON src.file_id = fe.source_file_id
         JOIN files tgt ON tgt.file_id = fe.target_file_id`,
      )
      .all() as Array<{ source_path: string; target_path: string }>;
    dbAfter.close();

    const edgeAfter = edgesAfter.find(
      (e) => e.source_path === "src/b.ts" && e.target_path === "src/a.ts",
    );
    expect(edgeAfter).toBeDefined();
  });
});

// 4. Blast Radius Analysis — analyzeBlastRadius (0% covered before)

describe("analyzeBlastRadius", () => {
  let db: Database.Database;
  let store: KgStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new KgStore(db);
  });

  afterEach(() => {
    store.close();
  });

  test("returns empty report for empty targets array", () => {
    populateTestGraph(store);
    const report = analyzeBlastRadius(db, []);
    expect(report.total_affected).toBe(0);
    expect(report.affected_files).toBe(0);
    expect(report.seed_entities).toHaveLength(0);
    expect(report.affected).toHaveLength(0);
  });

  test("returns empty report when target does not resolve to any entity", () => {
    populateTestGraph(store);
    const report = analyzeBlastRadius(db, ["nonexistent_function_xyz"]);
    expect(report.total_affected).toBe(0);
    expect(report.seed_entities).toHaveLength(0);
  });

  test("resolves entity by name and returns blast radius results", () => {
    populateTestGraph(store);
    // funcA calls funcB which calls funcC — reverse blast radius from funcC covers all 3
    const report = analyzeBlastRadius(db, ["funcC"]);
    expect(report.total_affected).toBeGreaterThanOrEqual(1);
    expect(report.seed_entities).toContain("funcC");
  });

  test("blast radius at depth 1 only reaches direct callers", () => {
    populateTestGraph(store);
    // funcA → funcB → funcC; seed = funcC, maxDepth=1 should reach funcB but not funcA
    const report = analyzeBlastRadius(db, ["funcC"], { maxDepth: 1 });
    const names = report.affected.map((e) => e.entity_name);
    expect(names).toContain("funcC"); // seed (depth 0)
    expect(names).toContain("funcB"); // depth 1 (direct caller)
    expect(names).not.toContain("funcA"); // depth 2 — excluded by maxDepth=1
  });

  test("blast radius at depth 2 reaches transitive callers", () => {
    populateTestGraph(store);
    // seed = funcC; funcB calls funcC (depth 1), funcA calls funcB (depth 2)
    const report = analyzeBlastRadius(db, ["funcC"], { maxDepth: 2 });
    const names = report.affected.map((e) => e.entity_name);
    expect(names).toContain("funcC");
    expect(names).toContain("funcB");
    expect(names).toContain("funcA");
  });

  test("depth 0 entries are labeled seed, depth > 0 labeled dependency", () => {
    populateTestGraph(store);
    const report = analyzeBlastRadius(db, ["funcC"], { maxDepth: 2 });
    const seedEntries = report.affected.filter((e) => e.depth === 0);
    const depEntries = report.affected.filter((e) => e.depth > 0);
    expect(seedEntries.every((e) => e.edge_type === "seed")).toBe(true);
    expect(depEntries.every((e) => e.edge_type === "dependency")).toBe(true);
  });

  test("by_depth summary counts are correct", () => {
    populateTestGraph(store);
    // seed = funcC; depth 0: funcC, depth 1: funcB, depth 2: funcA
    const report = analyzeBlastRadius(db, ["funcC"], { maxDepth: 2 });
    expect(report.by_depth[0]).toBeGreaterThanOrEqual(1);
    expect(report.by_depth[1]).toBeGreaterThanOrEqual(1);
    expect(report.by_depth[2]).toBeGreaterThanOrEqual(1);
  });

  test("affected_files count reflects unique files hit", () => {
    populateTestGraph(store);
    // seed = funcC; funcB in B.ts (depth 1), funcA in A.ts (depth 2)
    const report = analyzeBlastRadius(db, ["funcC"], { maxDepth: 3 });
    // funcC in C.ts, funcB in B.ts, funcA in A.ts
    expect(report.affected_files).toBeGreaterThanOrEqual(2);
  });

  test("resolves file path target to entities in that file", () => {
    populateTestGraph(store);
    // 'src/C.ts' looks like a file path (contains '/')
    const report = analyzeBlastRadius(db, ["src/C.ts"], { maxDepth: 1 });
    // funcC is in src/C.ts; blast radius from it at depth 1 (no outgoing edges)
    expect(report.seed_entities.length).toBeGreaterThanOrEqual(1);
    expect(report.total_affected).toBeGreaterThanOrEqual(1);
  });

  test("deduplicates seed entities when multiple targets resolve to same entity", () => {
    populateTestGraph(store);
    // Both 'funcA' (by name search) and 'src/A.ts::funcA' (qualified name) resolve to funcA
    // Passing funcA twice should not duplicate it
    const report1 = analyzeBlastRadius(db, ["funcA"], { maxDepth: 1 });
    const report2 = analyzeBlastRadius(db, ["funcA", "funcA"], { maxDepth: 1 });
    expect(report2.total_affected).toBe(report1.total_affected);
  });

  test("excludes test file entities when includeTests is false", () => {
    const testFile = store.upsertFile(
      makeFileRow({
        content_hash: "testhash",
        layer: "test",
        path: "src/__tests__/helpers.test.ts",
      }),
    );
    const testEntity = store.insertEntity(
      makeEntityRow(testFile.file_id!, {
        is_exported: false,
        name: "testHelper",
        qualified_name: "src/__tests__/helpers.test.ts::testHelper",
      }),
    );

    // testHelper calls funcC — so funcC's blast radius (reverse) includes testHelper
    const { funcC } = populateTestGraph(store);
    store.insertEdge({
      confidence: 0.8,
      edge_type: "calls",
      metadata: null,
      source_entity_id: testEntity.entity_id!,
      target_entity_id: funcC.entity_id!,
    });

    const report = analyzeBlastRadius(db, ["funcC"], { includeTests: false, maxDepth: 2 });
    const names = report.affected.map((e) => e.entity_name);
    expect(names).not.toContain("testHelper");
  });

  test("includes test file entities when includeTests is true (default)", () => {
    const testFile = store.upsertFile(
      makeFileRow({
        content_hash: "testhash",
        layer: "test",
        path: "src/__tests__/helpers.test.ts",
      }),
    );
    const testEntity = store.insertEntity(
      makeEntityRow(testFile.file_id!, {
        is_exported: false,
        name: "testHelper",
        qualified_name: "src/__tests__/helpers.test.ts::testHelper",
      }),
    );

    // testHelper calls funcC — so funcC's blast radius (reverse) includes testHelper
    const { funcC } = populateTestGraph(store);
    store.insertEdge({
      confidence: 0.8,
      edge_type: "calls",
      metadata: null,
      source_entity_id: testEntity.entity_id!,
      target_entity_id: funcC.entity_id!,
    });

    const report = analyzeBlastRadius(db, ["funcC"], { includeTests: true, maxDepth: 2 });
    const names = report.affected.map((e) => e.entity_name);
    expect(names).toContain("testHelper");
  });
});
