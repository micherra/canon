/**
 * Knowledge Graph — Integration Tests
 *
 * Tests cross-module boundaries not covered by implementor unit tests:
 *
 *   1. Pipeline → KgQuery end-to-end flow (graph-data.json write path removed — ADR-005)
 *   2. Blast Radius analysis (analyzeBlastRadius — zero gaps in implementor coverage)
 *   3. graph_query tool dispatch (DB-not-found, entity-not-found, each query type)
 *   4. Adapter Registry contract (getAdapter, getLanguage)
 *   5. Incremental reindex correctness (file change → re-parse → updated edges)
 *   6. KgStore CRUD gaps (upsert conflict path, cascade verification, boolean coercion)
 *   7. KgQuery gaps (getAncestors, getAdjacencyList)
 *
 * All filesystem-bound tests use OS temp directories created fresh per test.
 * All DB-bound tests use in-memory SQLite (:memory:).
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { getAdapter, getLanguage } from "../graph/kg-adapter-registry.ts";
import { analyzeBlastRadius } from "../graph/kg-blast-radius.ts";
import { runPipeline } from "../graph/kg-pipeline.ts";
import { KgQuery } from "../graph/kg-query.ts";
import { initDatabase } from "../graph/kg-schema.ts";
import { KgStore } from "../graph/kg-store.ts";
import type { EntityRow, FileRow } from "../graph/kg-types.ts";
import { initParsers } from "../graph/kg-wasm-parser.ts";
import { CANON_DIR, CANON_FILES } from "../shared/constants.ts";
import { getFileContext } from "../tools/get-file-context.ts";
import { graphQuery } from "../tools/graph-query.ts";
import { storeSummaries } from "../tools/store-summaries.ts";

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
    evidence: "import { funcB } from './B'",
    relation: null,
    source_file_id: fileA.file_id!,
    target_file_id: fileB.file_id!,
  });
  store.insertFileEdge({
    confidence: 1.0,
    edge_type: "imports",
    evidence: "import { funcC } from './C'",
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

  test("pipeline populates DB and KgQuery returns correct nodes and edges", async () => {
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

// 5. Blast Radius — deeper graph CTE correctness

describe("analyzeBlastRadius — deeper graph CTE correctness", () => {
  let db: Database.Database;
  let store: KgStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new KgStore(db);
  });

  afterEach(() => {
    store.close();
  });

  test("CTE traverses 4-level deep chain correctly", () => {
    // Build: root → a → b → c → d (4 hops, forward/outgoing direction)
    // With reverse traversal, seed = d reaches c (1), b (2), a (3), root (4)
    const fileRoot = store.upsertFile(makeFileRow({ content_hash: "h0", path: "root.ts" }));
    const fileA = store.upsertFile(makeFileRow({ content_hash: "h1", path: "A.ts" }));
    const fileB = store.upsertFile(makeFileRow({ content_hash: "h2", path: "B.ts" }));
    const fileC = store.upsertFile(makeFileRow({ content_hash: "h3", path: "C.ts" }));
    const fileD = store.upsertFile(makeFileRow({ content_hash: "h4", path: "D.ts" }));

    const root = store.insertEntity(
      makeEntityRow(fileRoot.file_id!, { name: "root", qualified_name: "root.ts::root" }),
    );
    const a = store.insertEntity(
      makeEntityRow(fileA.file_id!, { name: "a", qualified_name: "A.ts::a" }),
    );
    const b = store.insertEntity(
      makeEntityRow(fileB.file_id!, { name: "b", qualified_name: "B.ts::b" }),
    );
    const c = store.insertEntity(
      makeEntityRow(fileC.file_id!, { name: "c", qualified_name: "C.ts::c" }),
    );
    const d = store.insertEntity(
      makeEntityRow(fileD.file_id!, { name: "d", qualified_name: "D.ts::d" }),
    );

    store.insertEdge({
      confidence: 1,
      edge_type: "calls",
      metadata: null,
      source_entity_id: root.entity_id!,
      target_entity_id: a.entity_id!,
    });
    store.insertEdge({
      confidence: 1,
      edge_type: "calls",
      metadata: null,
      source_entity_id: a.entity_id!,
      target_entity_id: b.entity_id!,
    });
    store.insertEdge({
      confidence: 1,
      edge_type: "calls",
      metadata: null,
      source_entity_id: b.entity_id!,
      target_entity_id: c.entity_id!,
    });
    store.insertEdge({
      confidence: 1,
      edge_type: "calls",
      metadata: null,
      source_entity_id: c.entity_id!,
      target_entity_id: d.entity_id!,
    });

    // seed = d; maxDepth=4 — should reach all 5 entities (d at depth 0, c at 1, b at 2, a at 3, root at 4)
    const report4 = analyzeBlastRadius(db, ["d"], { maxDepth: 4 });
    const names4 = report4.affected.map((e) => e.entity_name);
    expect(names4).toContain("d");
    expect(names4).toContain("c");
    expect(names4).toContain("b");
    expect(names4).toContain("a");
    expect(names4).toContain("root");

    // seed = d; maxDepth=2 — should only reach d, c, b (not a or root)
    const report2 = analyzeBlastRadius(db, ["d"], { maxDepth: 2 });
    const names2 = report2.affected.map((e) => e.entity_name);
    expect(names2).toContain("d");
    expect(names2).toContain("c");
    expect(names2).toContain("b");
    expect(names2).not.toContain("a");
    expect(names2).not.toContain("root");
  });

  test("CTE handles diamond dependency pattern without duplicates", () => {
    // Diamond: root → a, root → b, a → c, b → c
    // With reverse traversal, seed = c → a (depth 1), b (depth 1), root (depth 2)
    const fileRoot = store.upsertFile(makeFileRow({ content_hash: "h0", path: "root.ts" }));
    const fileA = store.upsertFile(makeFileRow({ content_hash: "h1", path: "A.ts" }));
    const fileB = store.upsertFile(makeFileRow({ content_hash: "h2", path: "B.ts" }));
    const fileC = store.upsertFile(makeFileRow({ content_hash: "h3", path: "C.ts" }));

    store.insertEntity(
      makeEntityRow(fileRoot.file_id!, { name: "root", qualified_name: "root.ts::root" }),
    );
    const a = store.insertEntity(
      makeEntityRow(fileA.file_id!, { name: "a", qualified_name: "A.ts::a" }),
    );
    const b = store.insertEntity(
      makeEntityRow(fileB.file_id!, { name: "b", qualified_name: "B.ts::b" }),
    );
    const c = store.insertEntity(
      makeEntityRow(fileC.file_id!, { name: "c", qualified_name: "C.ts::c" }),
    );
    const root = store.insertEntity(
      makeEntityRow(fileRoot.file_id!, { name: "root2", qualified_name: "root.ts::root2" }),
    );

    store.insertEdge({
      confidence: 1,
      edge_type: "calls",
      metadata: null,
      source_entity_id: root.entity_id!,
      target_entity_id: a.entity_id!,
    });
    store.insertEdge({
      confidence: 1,
      edge_type: "calls",
      metadata: null,
      source_entity_id: root.entity_id!,
      target_entity_id: b.entity_id!,
    });
    store.insertEdge({
      confidence: 1,
      edge_type: "calls",
      metadata: null,
      source_entity_id: a.entity_id!,
      target_entity_id: c.entity_id!,
    });
    store.insertEdge({
      confidence: 1,
      edge_type: "calls",
      metadata: null,
      source_entity_id: b.entity_id!,
      target_entity_id: c.entity_id!,
    });

    // seed = c; a and b both call c, root calls both a and b
    const report = analyzeBlastRadius(db, ["c"], { maxDepth: 3 });
    const names = report.affected.map((e) => e.entity_name);

    // c should appear exactly once (it's the seed at depth 0)
    const cOccurrences = names.filter((n) => n === "c").length;
    expect(cOccurrences).toBe(1);
    // All 4 entities should be present: c (seed), a, b, root2
    expect(new Set(names).size).toBe(4);
  });

  test("CTE does not follow cycle infinitely", () => {
    // Cycle: a → b → a (would be infinite without DISTINCT + depth guard)
    const fileA = store.upsertFile(makeFileRow({ content_hash: "h1", path: "A.ts" }));
    const fileB = store.upsertFile(makeFileRow({ content_hash: "h2", path: "B.ts" }));

    const a = store.insertEntity(
      makeEntityRow(fileA.file_id!, { name: "a", qualified_name: "A.ts::a" }),
    );
    const b = store.insertEntity(
      makeEntityRow(fileB.file_id!, { name: "b", qualified_name: "B.ts::b" }),
    );

    store.insertEdge({
      confidence: 1,
      edge_type: "calls",
      metadata: null,
      source_entity_id: a.entity_id!,
      target_entity_id: b.entity_id!,
    });
    store.insertEdge({
      confidence: 1,
      edge_type: "calls",
      metadata: null,
      source_entity_id: b.entity_id!,
      target_entity_id: a.entity_id!,
    });

    // Should terminate and return both entities without infinite loop
    expect(() => analyzeBlastRadius(db, ["a"], { maxDepth: 5 })).not.toThrow();
    const report = analyzeBlastRadius(db, ["a"], { maxDepth: 5 });
    expect(report.affected.length).toBeGreaterThanOrEqual(1);
    expect(report.affected.length).toBeLessThan(100); // not exploded
  });
});

// 6. graph_query tool dispatch

describe("graphQuery tool dispatch", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(projectDir, { force: true, recursive: true });
  });

  function seedDb(projectDir: string): string {
    const dbPath = path.join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = initDatabase(dbPath);
    const store = new KgStore(db);
    populateTestGraph(store);
    store.close();
    return dbPath;
  }

  test("throws when DB does not exist", () => {
    const result = graphQuery({ query_type: "search", target: "funcA" }, projectDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("KG_NOT_INDEXED");
      expect(result.recoverable).toBe(true);
      expect(result.message).toMatch(/knowledge graph database not found/i);
    }
  });

  test("search query returns matching entities", () => {
    seedDb(projectDir);
    const result = graphQuery({ query_type: "search", target: "funcA" }, projectDir);
    if (!result.ok) throw new Error(result.message);
    expect(result.query_type).toBe("search");
    expect(result.count).toBeGreaterThanOrEqual(1);
    const names = (result.results as Array<{ name: string }>).map((r) => r.name);
    expect(names).toContain("funcA");
  });

  test("dead_code query returns unexported unreferenced entities", () => {
    seedDb(projectDir);
    const result = graphQuery({ query_type: "dead_code" }, projectDir);
    if (!result.ok) throw new Error(result.message);
    expect(result.query_type).toBe("dead_code");
    expect(result.count).toBeGreaterThanOrEqual(1);
    // funcD is dead code
    const names = (result.results as Array<{ name: string }>).map((r) => r.name);
    expect(names).toContain("funcD");
  });

  test("callers query returns callers of funcB", () => {
    seedDb(projectDir);
    const result = graphQuery({ query_type: "callers", target: "funcB" }, projectDir);
    if (!result.ok) throw new Error(result.message);
    expect(result.count).toBeGreaterThanOrEqual(1);
    const names = (result.results as Array<{ name: string }>).map((r) => r.name);
    expect(names).toContain("funcA");
  });

  test("callees query returns callees of funcA", () => {
    seedDb(projectDir);
    const result = graphQuery({ query_type: "callees", target: "funcA" }, projectDir);
    if (!result.ok) throw new Error(result.message);
    expect(result.count).toBeGreaterThanOrEqual(1);
    const names = (result.results as Array<{ name: string }>).map((r) => r.name);
    expect(names).toContain("funcB");
  });

  test("blast_radius query returns reachable entities", () => {
    seedDb(projectDir);
    // seed = funcC (funcB calls funcC, funcA calls funcB); reverse blast radius includes funcB and funcA
    const result = graphQuery(
      { options: { max_depth: 3 }, query_type: "blast_radius", target: "funcC" },
      projectDir,
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.count).toBeGreaterThanOrEqual(2);
    const names = (result.results as Array<{ name: string }>).map((r) => r.name);
    expect(names).toContain("funcB");
  });

  test("ancestors query returns containing entities", () => {
    // Build a contains edge: fileEntity → funcA
    const dbPath = path.join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = initDatabase(dbPath);
    const store = new KgStore(db);
    const { funcA } = populateTestGraph(store);

    // Insert a class that contains funcA
    const fileA = store.getFile("src/A.ts")!;
    const classContainer = store.insertEntity(
      makeEntityRow(fileA.file_id!, {
        is_exported: true,
        kind: "class",
        name: "MyClass",
        qualified_name: "src/A.ts::MyClass",
      }),
    );
    store.insertEdge({
      confidence: 1.0,
      edge_type: "contains",
      metadata: null,
      source_entity_id: classContainer.entity_id!,
      target_entity_id: funcA.entity_id!,
    });
    store.close();

    const result = graphQuery({ query_type: "ancestors", target: "funcA" }, projectDir);
    if (!result.ok) throw new Error(result.message);
    expect(result.count).toBeGreaterThanOrEqual(1);
    const names = (result.results as Array<{ name: string }>).map((r) => r.name);
    expect(names).toContain("MyClass");
  });

  test("entity-not-found returns empty result set instead of throwing", () => {
    seedDb(projectDir);
    const result = graphQuery(
      { query_type: "callers", target: "nonexistent_entity_xyz" },
      projectDir,
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.results).toHaveLength(0);
    expect(result.count).toBe(0);
  });

  test("search requires target — throws when missing", () => {
    seedDb(projectDir);
    const result = graphQuery({ query_type: "search" }, projectDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toMatch(/requires a target/i);
    }
  });

  test("callers requires target — throws when missing", () => {
    seedDb(projectDir);
    const result = graphQuery({ query_type: "callers" }, projectDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toMatch(/requires a target/i);
    }
  });

  test("search respects options.limit", () => {
    seedDb(projectDir);
    const result = graphQuery(
      { options: { limit: 2 }, query_type: "search", target: "func*" },
      projectDir,
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.results.length).toBeLessThanOrEqual(2);
  });
});

// 7. Adapter Registry contract

describe("Adapter Registry", () => {
  beforeAll(async () => {
    await initParsers();
  });

  test("getAdapter returns a LanguageAdapter for all expected extensions", () => {
    const tsExt = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
    for (const ext of tsExt) {
      const adapter = getAdapter(ext);
      expect(adapter, `adapter for ${ext}`).toBeDefined();
      expect(typeof adapter!.parse).toBe("function");
    }

    expect(getAdapter(".py")).toBeDefined();
    expect(getAdapter(".sh")).toBeDefined();
    expect(getAdapter(".md")).toBeDefined();
    expect(getAdapter(".yaml")).toBeDefined();
    expect(getAdapter(".yml")).toBeDefined();
  });

  test("getAdapter returns undefined for unknown extensions", () => {
    expect(getAdapter(".rb")).toBeUndefined();
    expect(getAdapter(".go")).toBeUndefined();
    expect(getAdapter(".rs")).toBeUndefined();
    expect(getAdapter("")).toBeUndefined();
  });

  test("getLanguage maps extensions to canonical language names", () => {
    expect(getLanguage(".ts")).toBe("typescript");
    expect(getLanguage(".tsx")).toBe("typescript");
    expect(getLanguage(".js")).toBe("javascript");
    expect(getLanguage(".jsx")).toBe("javascript");
    expect(getLanguage(".mjs")).toBe("javascript");
    expect(getLanguage(".cjs")).toBe("javascript");
    expect(getLanguage(".py")).toBe("python");
    expect(getLanguage(".sh")).toBe("bash");
    expect(getLanguage(".md")).toBe("markdown");
    expect(getLanguage(".yaml")).toBe("yaml");
    expect(getLanguage(".yml")).toBe("yaml");
  });

  test('getLanguage returns "unknown" for unrecognized extensions', () => {
    expect(getLanguage(".rb")).toBe("unknown");
    expect(getLanguage(".go")).toBe("unknown");
    expect(getLanguage("")).toBe("unknown");
  });

  test("each adapter only handles its own extensions (no cross-contamination)", () => {
    const tsAdapter = getAdapter(".ts");
    const pyAdapter = getAdapter(".py");
    const mdAdapter = getAdapter(".md");

    expect(tsAdapter).not.toBe(pyAdapter);
    expect(tsAdapter).not.toBe(mdAdapter);
    expect(pyAdapter).not.toBe(mdAdapter);
  });
});

// 8. KgStore — gaps: upsert conflict, cascade verification, boolean coercion

describe("KgStore — coverage gaps", () => {
  let db: Database.Database;
  let store: KgStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new KgStore(db);
  });

  afterEach(() => {
    store.close();
  });

  test("upsertFile ON CONFLICT updates mtime and hash, keeps same file_id", () => {
    const original = store.upsertFile(makeFileRow({ content_hash: "hash1", mtime_ms: 1000 }));
    const updated = store.upsertFile(makeFileRow({ content_hash: "hash2", mtime_ms: 2000 }));
    expect(updated.file_id).toBe(original.file_id);
    expect(updated.mtime_ms).toBe(2000);
    expect(updated.content_hash).toBe("hash2");
  });

  test("insertEntity OR IGNORE on duplicate qualified_name — only one row in DB", () => {
    const file = store.upsertFile(makeFileRow());
    const first = store.insertEntity(makeEntityRow(file.file_id!));
    expect(first.entity_id).toBeDefined();

    // Duplicate insert — same file_id + qualified_name.
    // The fixed implementation falls back to getEntityByQualifiedName when OR IGNORE fires
    // (RETURNING * emits no rows on conflict), so the call returns the existing row instead
    // of crashing with TypeError.
    const second = store.insertEntity(makeEntityRow(file.file_id!));
    expect(second.entity_id).toBe(first.entity_id);

    // Only one entity should be in the DB (OR IGNORE did not insert a duplicate)
    const entities = store.getEntitiesByFile(file.file_id!);
    expect(entities).toHaveLength(1);
  });

  test("boolean coercion: is_exported stored as 1/0 and read back as boolean", () => {
    const file = store.upsertFile(makeFileRow());
    store.insertEntity(
      makeEntityRow(file.file_id!, {
        is_default_export: true,
        is_exported: true,
        name: "exported",
        qualified_name: "src/A.ts::exported",
      }),
    );
    const entities = store.getEntitiesByFile(file.file_id!);
    expect(entities[0]!.is_exported).toBe(true);
    expect(typeof entities[0]!.is_exported).toBe("boolean");
    expect(entities[0]!.is_default_export).toBe(true);
    expect(typeof entities[0]!.is_default_export).toBe("boolean");
  });

  test("boolean coercion: is_exported=false stored as 0 and read back as boolean false", () => {
    const file = store.upsertFile(makeFileRow());
    store.insertEntity(
      makeEntityRow(file.file_id!, {
        is_default_export: false,
        is_exported: false,
        name: "private",
        qualified_name: "src/A.ts::private",
      }),
    );
    const entities = store.getEntitiesByFile(file.file_id!);
    expect(entities[0]!.is_exported).toBe(false);
    expect(typeof entities[0]!.is_exported).toBe("boolean");
  });

  test("deleteFileAndDependents cascades to entities and edges", () => {
    const { fileA, funcA, funcB } = populateTestGraph(store);

    // Verify entities and edges exist before deletion
    const entitiesBefore = store.getEntitiesByFile(fileA.file_id!);
    expect(entitiesBefore.length).toBeGreaterThan(0);

    // Also verify the edge from funcA to funcB exists
    const edgesBefore = store.getEdgesFrom(funcA.entity_id!);
    expect(edgesBefore.length).toBeGreaterThan(0);

    store.deleteFileAndDependents("src/A.ts");

    // File should be gone
    expect(store.getFile("src/A.ts")).toBeUndefined();

    // Entities in fileA should cascade-delete
    const entitiesAfter = store.getEntitiesByFile(fileA.file_id!);
    expect(entitiesAfter).toHaveLength(0);

    // Edges from funcA should cascade-delete
    const edgesAfter = store.getEdgesFrom(funcA.entity_id!);
    expect(edgesAfter).toHaveLength(0);

    // funcB (in fileB) should still exist
    const entitiesB = store.getEntitiesByFile(store.getFile("src/B.ts")!.file_id!);
    expect(entitiesB.some((e) => e.name === "funcB")).toBe(true);
    void funcB;
  });

  test("getStats returns accurate counts after mutations", () => {
    const stats0 = store.getStats();
    expect(stats0.files).toBe(0);
    expect(stats0.entities).toBe(0);

    populateTestGraph(store);

    const stats = store.getStats();
    expect(stats.files).toBe(3);
    expect(stats.entities).toBe(4); // funcA, funcB, funcC, funcD
    expect(stats.edges).toBe(2); // funcA→funcB, funcB→funcC
    expect(stats.fileEdges).toBe(2); // A→B, B→C
  });
});

// 9. KgQuery — gaps: getAncestors, getAdjacencyList

describe("KgQuery — coverage gaps (getAncestors, getAdjacencyList)", () => {
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

  test("getAncestors returns parent entities via contains edges", () => {
    const fileA = store.upsertFile(makeFileRow({ path: "src/A.ts" }));
    const classA = store.insertEntity(
      makeEntityRow(fileA.file_id!, {
        kind: "class",
        name: "ClassA",
        qualified_name: "src/A.ts::ClassA",
      }),
    );
    const method = store.insertEntity(
      makeEntityRow(fileA.file_id!, {
        kind: "function",
        name: "method",
        qualified_name: "src/A.ts::ClassA.method",
      }),
    );
    store.insertEdge({
      confidence: 1.0,
      edge_type: "contains",
      metadata: null,
      source_entity_id: classA.entity_id!,
      target_entity_id: method.entity_id!,
    });

    const ancestors = query.getAncestors(method.entity_id!);
    expect(ancestors).toHaveLength(1);
    expect(ancestors[0]!.name).toBe("ClassA");
    expect(ancestors[0]!.kind).toBe("class");
  });

  test("getAncestors returns empty array for top-level entity with no contains edges", () => {
    const fileA = store.upsertFile(makeFileRow({ path: "src/A.ts" }));
    const top = store.insertEntity(
      makeEntityRow(fileA.file_id!, { name: "topLevel", qualified_name: "src/A.ts::topLevel" }),
    );
    const ancestors = query.getAncestors(top.entity_id!);
    expect(ancestors).toHaveLength(0);
  });

  test("getAdjacencyList returns map of source → target arrays", () => {
    const { funcA, funcB, funcC } = populateTestGraph(store);

    const adj = query.getAdjacencyList();
    expect(adj).toBeInstanceOf(Map);

    // funcA → funcB should be present
    const funcANeighbors = adj.get(funcA.entity_id!);
    expect(funcANeighbors).toBeDefined();
    expect(funcANeighbors).toContain(funcB.entity_id);

    // funcB → funcC should be present
    const funcBNeighbors = adj.get(funcB.entity_id!);
    expect(funcBNeighbors).toBeDefined();
    expect(funcBNeighbors).toContain(funcC.entity_id);
  });

  test("getAdjacencyList returns empty map for empty DB", () => {
    const adj = query.getAdjacencyList();
    expect(adj.size).toBe(0);
  });

  test("getAdjacencyList handles multiple edges from same source", () => {
    const fileA = store.upsertFile(makeFileRow({ path: "src/A.ts" }));
    const fileB = store.upsertFile(makeFileRow({ path: "src/B.ts" }));
    const fileC = store.upsertFile(makeFileRow({ path: "src/C.ts" }));

    const a = store.insertEntity(
      makeEntityRow(fileA.file_id!, { name: "a", qualified_name: "src/A.ts::a" }),
    );
    const b = store.insertEntity(
      makeEntityRow(fileB.file_id!, { name: "b", qualified_name: "src/B.ts::b" }),
    );
    const c = store.insertEntity(
      makeEntityRow(fileC.file_id!, { name: "c", qualified_name: "src/C.ts::c" }),
    );

    store.insertEdge({
      confidence: 1,
      edge_type: "calls",
      metadata: null,
      source_entity_id: a.entity_id!,
      target_entity_id: b.entity_id!,
    });
    store.insertEdge({
      confidence: 1,
      edge_type: "calls",
      metadata: null,
      source_entity_id: a.entity_id!,
      target_entity_id: c.entity_id!,
    });

    const adj = query.getAdjacencyList();
    const aNeighbors = adj.get(a.entity_id!);
    expect(aNeighbors).toBeDefined();
    expect(aNeighbors).toContain(b.entity_id);
    expect(aNeighbors).toContain(c.entity_id);
    expect(aNeighbors!.length).toBe(2);
  });
});

// 10. Adapter edge cases — malformed input and empty files

describe("Adapter edge cases — malformed input and empty files", () => {
  beforeAll(async () => {
    await initParsers();
  });

  test("TypeScript adapter handles empty file without throwing", () => {
    const adapter = getAdapter(".ts");
    expect(adapter).toBeDefined();
    const result = adapter!.parse("src/empty.ts", "");
    expect(result).toBeDefined();
    expect(Array.isArray(result.entities)).toBe(true);
  });

  test("TypeScript adapter handles whitespace-only file without throwing", () => {
    const adapter = getAdapter(".ts");
    const result = adapter!.parse("src/whitespace.ts", "   \n\n  \t  ");
    expect(result).toBeDefined();
    expect(Array.isArray(result.entities)).toBe(true);
  });

  test("TypeScript adapter handles syntax errors gracefully", () => {
    const adapter = getAdapter(".ts");
    // Severely malformed — tree-sitter recovers but should not throw
    expect(() => adapter!.parse("src/broken.ts", "@@@ not valid TS $$$")).not.toThrow();
  });

  test("TypeScript adapter extracts exported function correctly", () => {
    const adapter = getAdapter(".ts");
    const result = adapter!.parse(
      "src/utils.ts",
      "export function add(a: number, b: number): number { return a + b; }",
    );
    const fn = result.entities.find((e) => e.name === "add");
    expect(fn).toBeDefined();
    expect(fn!.is_exported).toBe(true);
    expect(fn!.kind).toBe("function");
  });

  test("TypeScript adapter extracts exported class correctly", () => {
    const adapter = getAdapter(".ts");
    const result = adapter!.parse("src/Model.ts", 'export class UserModel { id: string = ""; }');
    const cls = result.entities.find((e) => e.name === "UserModel");
    expect(cls).toBeDefined();
    expect(cls!.is_exported).toBe(true);
    expect(cls!.kind).toBe("class");
  });

  test("TypeScript adapter extracts import specifiers", () => {
    const adapter = getAdapter(".ts");
    const result = adapter!.parse("src/consumer.ts", "import { foo, bar } from './utils.ts';");
    expect(result.importSpecifiers).toBeDefined();
    expect(result.importSpecifiers!.length).toBeGreaterThanOrEqual(1);
    const specifier = result.importSpecifiers!.find((s) => s.specifier.includes("utils"));
    expect(specifier).toBeDefined();
    expect(specifier!.names).toContain("foo");
    expect(specifier!.names).toContain("bar");
  });

  test("Markdown adapter handles empty file without throwing", () => {
    const adapter = getAdapter(".md");
    expect(adapter).toBeDefined();
    const result = adapter!.parse("README.md", "");
    expect(result).toBeDefined();
    expect(Array.isArray(result.entities)).toBe(true);
  });

  test("Markdown adapter handles file with only headings", () => {
    const adapter = getAdapter(".md");
    const result = adapter!.parse("docs/guide.md", "# Title\n## Section\n### Sub");
    expect(result).toBeDefined();
    expect(Array.isArray(result.entities)).toBe(true);
  });

  test("YAML adapter handles empty file without throwing", () => {
    const adapter = getAdapter(".yaml");
    expect(adapter).toBeDefined();
    const result = adapter!.parse("config.yaml", "");
    expect(result).toBeDefined();
  });

  test("YAML adapter handles malformed YAML without throwing", () => {
    const adapter = getAdapter(".yaml");
    expect(() => adapter!.parse("bad.yaml", ": : : invalid: yaml: content")).not.toThrow();
  });

  test("Bash adapter handles empty file without throwing", () => {
    const adapter = getAdapter(".sh");
    expect(adapter).toBeDefined();
    const result = adapter!.parse("scripts/deploy.sh", "");
    expect(result).toBeDefined();
    expect(Array.isArray(result.entities)).toBe(true);
  });

  test("Python adapter handles empty file without throwing", () => {
    const adapter = getAdapter(".py");
    expect(adapter).toBeDefined();
    const result = adapter!.parse("src/utils.py", "");
    expect(result).toBeDefined();
    expect(Array.isArray(result.entities)).toBe(true);
  });
});

// 11. DB-only workflow integration — risk mitigation for combined migration state
//
// Verifies: "KG present, DB-only summaries, no JSON files" works end-to-end.
// This is the primary risk mitigation test for the ADR-005 consolidation.
// All three tools (get_file_context, store_summaries) must return correct data
// when the KG DB is the sole data source and no JSON artifact files exist on disk.

describe("DB-only workflow — get_file_context + store_summaries without JSON artifacts", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: ReturnType<typeof initDatabase>;
  let store: KgStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-kg-db-only-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
    await mkdir(join(tmpDir, "src", "api"), { recursive: true });

    // Create a real source file that getFileContext can read
    await writeFile(
      join(tmpDir, "src", "api", "handler.ts"),
      `export function handleRequest() {}\nexport const MAX_RETRIES = 3;`,
    );

    // Set up KG DB with the file registered and a summary stored
    dbPath = join(tmpDir, ".canon", CANON_FILES.KNOWLEDGE_DB);
    db = initDatabase(dbPath);
    store = new KgStore(db);

    const fileRow = store.upsertFile({
      content_hash: "abc123",
      language: "typescript",
      last_indexed_at: Date.now(),
      layer: "api",
      mtime_ms: Date.now(),
      path: "src/api/handler.ts",
    });

    // Pre-seed a summary directly into the DB (no JSON file)
    store.upsertSummary({
      content_hash: "abc123",
      entity_id: null,
      file_id: fileRow.file_id!,
      model: null,
      scope: "file",
      summary: "DB-only summary for handler",
      updated_at: new Date().toISOString(),
    });

    db.close();
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  test("get_file_context returns DB summary when no summaries.json exists", async () => {
    // Verify no JSON files exist on disk before calling the tool
    expect(existsSync(join(tmpDir, ".canon", "summaries.json"))).toBe(false);
    expect(existsSync(join(tmpDir, ".canon", "graph-data.json"))).toBe(false);
    expect(existsSync(join(tmpDir, ".canon", "reverse-deps.json"))).toBe(false);

    const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);

    // Tool must succeed
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);

    // Summary must come from DB, not from any JSON file
    expect(result.summary).toBe("DB-only summary for handler");
    expect(result.file_path).toBe("src/api/handler.ts");
    expect(result.layer).toBe("api");
    expect(result.content).toContain("handleRequest");
  });

  test("get_file_context returns correct data with DB-only state (idempotent on repeated calls)", async () => {
    // Call twice — idempotent: same DB state, same result
    const result1 = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
    const result2 = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    if (!result1.ok || !result2.ok) throw new Error("Expected ok results");

    expect(result1.summary).toBe(result2.summary);
    expect(result1.summary).toBe("DB-only summary for handler");
  });

  test("store_summaries writes to DB when file is registered in KG (no JSON required for reading)", async () => {
    // Verify no summaries.json before the call
    expect(existsSync(join(tmpDir, ".canon", "summaries.json"))).toBe(false);

    await storeSummaries(
      { summaries: [{ file_path: "src/api/handler.ts", summary: "Updated via storeSummaries" }] },
      tmpDir,
    );

    // Open the DB and verify the summary was written
    const db2 = initDatabase(dbPath);
    const store2 = new KgStore(db2);
    const fileRow = store2.getFile("src/api/handler.ts");
    expect(fileRow).toBeDefined();
    const summaryRow = store2.getSummaryByFile(fileRow!.file_id!);
    db2.close();

    expect(summaryRow).toBeDefined();
    expect(summaryRow!.summary).toBe("Updated via storeSummaries");
    expect(summaryRow!.scope).toBe("file");
  });

  test("store_summaries is idempotent — calling twice with same data produces same DB state", async () => {
    const summaryInput = {
      summaries: [{ file_path: "src/api/handler.ts", summary: "Stable summary" }],
    };

    // Call twice
    await storeSummaries(summaryInput, tmpDir);
    await storeSummaries(summaryInput, tmpDir);

    // DB should have exactly one summary for the file (upsert behavior)
    const db2 = initDatabase(dbPath);
    const store2 = new KgStore(db2);
    const fileRow = store2.getFile("src/api/handler.ts");
    const summaryRow = store2.getSummaryByFile(fileRow!.file_id!);
    db2.close();

    expect(summaryRow).toBeDefined();
    expect(summaryRow!.summary).toBe("Stable summary");
  });

  test("get_file_context returns updated summary after store_summaries writes to DB", async () => {
    // First read shows the pre-seeded summary
    const before = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
    expect(before.ok).toBe(true);
    if (!before.ok) throw new Error(before.message);
    expect(before.summary).toBe("DB-only summary for handler");

    // Write a new summary via storeSummaries
    await storeSummaries(
      { summaries: [{ file_path: "src/api/handler.ts", summary: "Refreshed summary" }] },
      tmpDir,
    );

    // Second read reflects the updated summary
    const after = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
    expect(after.ok).toBe(true);
    if (!after.ok) throw new Error(after.message);
    expect(after.summary).toBe("Refreshed summary");
  });
});
