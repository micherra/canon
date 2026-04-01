/**
 * Knowledge Graph — Integration Tests
 *
 * Tests cross-module boundaries not covered by implementor unit tests:
 *
 *   1. Pipeline → Materializer → graph-data.json shape (end-to-end flow)
 *   2. View Materializer unit contract (happy path, empty DB, edge type mapping, inferKind)
 *   3. Blast Radius analysis (analyzeBlastRadius — zero gaps in implementor coverage)
 *   4. graph_query tool dispatch (DB-not-found, entity-not-found, each query type)
 *   5. Adapter Registry contract (getAdapter, getLanguage)
 *   6. Incremental reindex correctness (file change → re-parse → updated edges)
 *   7. KgStore CRUD gaps (upsert conflict path, cascade verification, boolean coercion)
 *   8. KgQuery gaps (getAncestors, getAdjacencyList)
 *
 * All filesystem-bound tests use OS temp directories created fresh per test.
 * All DB-bound tests use in-memory SQLite (:memory:).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { CANON_DIR, CANON_FILES } from "../constants.ts";
import { getAdapter, getLanguage } from "../graph/kg-adapter-registry.ts";
import { analyzeBlastRadius } from "../graph/kg-blast-radius.ts";
import { runPipeline } from "../graph/kg-pipeline.ts";
import { KgQuery } from "../graph/kg-query.ts";
import { initDatabase } from "../graph/kg-schema.ts";
import { KgStore } from "../graph/kg-store.ts";
import type { EdgeType, EntityRow, FileRow } from "../graph/kg-types.ts";
import { initParsers } from "../graph/kg-wasm-parser.ts";
import { materialize, materializeToFile } from "../graph/view-materializer.ts";
import { graphQuery } from "../tools/graph-query.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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

/**
 * Populate a graph with 3 files and a call chain funcA → funcB → funcC.
 * funcD is dead code (unexported, unreferenced, in fileB).
 */
function populateTestGraph(store: KgStore) {
  const fileA = store.upsertFile(makeFileRow({ path: "src/A.ts", layer: "api" }));
  const fileB = store.upsertFile(makeFileRow({ path: "src/B.ts", layer: "domain" }));
  const fileC = store.upsertFile(makeFileRow({ path: "src/C.ts", layer: "shared" }));

  const funcA = store.insertEntity(
    makeEntityRow(fileA.file_id!, { name: "funcA", qualified_name: "src/A.ts::funcA", is_exported: true }),
  );
  const funcB = store.insertEntity(
    makeEntityRow(fileB.file_id!, { name: "funcB", qualified_name: "src/B.ts::funcB", is_exported: true }),
  );
  const funcC = store.insertEntity(
    makeEntityRow(fileC.file_id!, { name: "funcC", qualified_name: "src/C.ts::funcC", is_exported: true }),
  );
  const funcD = store.insertEntity(
    makeEntityRow(fileB.file_id!, { name: "funcD", qualified_name: "src/B.ts::funcD", is_exported: false }),
  );

  // Entity edges: funcA → funcB → funcC
  store.insertEdge({
    source_entity_id: funcA.entity_id!,
    target_entity_id: funcB.entity_id!,
    edge_type: "calls",
    confidence: 1.0,
    metadata: null,
  });
  store.insertEdge({
    source_entity_id: funcB.entity_id!,
    target_entity_id: funcC.entity_id!,
    edge_type: "calls",
    confidence: 1.0,
    metadata: null,
  });

  // File edges
  store.insertFileEdge({
    source_file_id: fileA.file_id!,
    target_file_id: fileB.file_id!,
    edge_type: "imports",
    confidence: 1.0,
    evidence: "import { funcB } from './B'",
    relation: null,
  });
  store.insertFileEdge({
    source_file_id: fileB.file_id!,
    target_file_id: fileC.file_id!,
    edge_type: "imports",
    confidence: 1.0,
    evidence: "import { funcC } from './C'",
    relation: null,
  });

  return { fileA, fileB, fileC, funcA, funcB, funcC, funcD };
}

// ===========================================================================
// 1. View Materializer — unit contract
// ===========================================================================

describe("materialize — view materializer contract", () => {
  let db: Database.Database;
  let store: KgStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new KgStore(db);
  });

  afterEach(() => {
    store.close();
  });

  test("returns empty nodes and edges for an empty database", () => {
    const result = materialize(db, "/tmp/project");
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
    expect(result.insights.overview.total_files).toBe(0);
    expect(result.insights.overview.total_edges).toBe(0);
  });

  test("populates nodes from files table with correct shape", () => {
    populateTestGraph(store);
    const result = materialize(db, "/tmp/project");

    expect(result.nodes.length).toBe(3);
    const nodeA = result.nodes.find((n) => n.id === "src/A.ts");
    expect(nodeA).toBeDefined();
    expect(nodeA!.layer).toBe("api");
    expect(nodeA!.extension).toBe("ts");
    expect(nodeA!.violation_count).toBe(0);
    expect(nodeA!.changed).toBe(false);
  });

  test("populates KG enrichment fields (entity_count, export_count, dead_code_count)", () => {
    populateTestGraph(store);
    const result = materialize(db, "/tmp/project");

    // fileB has funcB (exported) and funcD (dead)
    const nodeB = result.nodes.find((n) => n.id === "src/B.ts");
    expect(nodeB).toBeDefined();
    expect(nodeB!.entity_count).toBeGreaterThanOrEqual(2); // funcB + funcD (+ possibly file entity)
    expect(nodeB!.export_count).toBeGreaterThanOrEqual(1); // funcB
    expect(nodeB!.dead_code_count).toBe(1); // funcD
  });

  test("populates edges from file_edges table with correct shape", () => {
    populateTestGraph(store);
    const result = materialize(db, "/tmp/project");

    expect(result.edges.length).toBe(2);
    const edgeAB = result.edges.find((e) => e.source === "src/A.ts" && e.target === "src/B.ts");
    expect(edgeAB).toBeDefined();
    expect(edgeAB!.type).toBe("import");
    expect(edgeAB!.confidence).toBe(1.0);
  });

  test("mapEdgeType: imports → import, re-exports → re-export, composition → composition, others → import", () => {
    const fileA = store.upsertFile(makeFileRow({ path: "src/A.ts" }));
    const fileB = store.upsertFile(makeFileRow({ path: "src/B.ts" }));
    const fileC = store.upsertFile(makeFileRow({ path: "src/C.ts" }));
    const fileD = store.upsertFile(makeFileRow({ path: "src/D.ts" }));

    store.insertFileEdge({
      source_file_id: fileA.file_id!,
      target_file_id: fileB.file_id!,
      edge_type: "re-exports",
      confidence: 1.0,
      evidence: null,
      relation: null,
    });
    store.insertFileEdge({
      source_file_id: fileA.file_id!,
      target_file_id: fileC.file_id!,
      edge_type: "composition",
      confidence: 1.0,
      evidence: null,
      relation: null,
    });
    store.insertFileEdge({
      source_file_id: fileA.file_id!,
      target_file_id: fileD.file_id!,
      edge_type: "some-unknown-type" as EdgeType,
      confidence: 1.0,
      evidence: null,
      relation: null,
    });

    const result = materialize(db, "/tmp/project");
    const edges = result.edges;

    const reExport = edges.find((e) => e.target === "src/B.ts");
    expect(reExport!.type).toBe("re-export");

    const composition = edges.find((e) => e.target === "src/C.ts");
    expect(composition!.type).toBe("composition");

    const unknown = edges.find((e) => e.target === "src/D.ts");
    expect(unknown!.type).toBe("import"); // fallback
  });

  test("inferKind classifies paths correctly", () => {
    const paths = [
      { path: "src/__tests__/foo.test.ts", expectedKind: "test" },
      { path: "src/bar.spec.js", expectedKind: "test" },
      { path: "config.yaml", expectedKind: "config" },
      { path: "tsconfig.json", expectedKind: "config" },
      { path: "README.md", expectedKind: "doc" },
      { path: "scripts/build.sh", expectedKind: "script" },
      { path: "src/main.ts", expectedKind: "source" },
    ];

    for (const { path: filePath } of paths) {
      const file = store.upsertFile(makeFileRow({ path: filePath, content_hash: `hash-${filePath}` }));
      void file;
    }

    const result = materialize(db, "/tmp/project");
    for (const { path: filePath, expectedKind } of paths) {
      const node = result.nodes.find((n) => n.id === filePath);
      expect(node, `expected node for ${filePath}`).toBeDefined();
      expect(node!.kind, `kind for ${filePath}`).toBe(expectedKind);
    }
  });

  test("insights overview counts match nodes and edges", () => {
    populateTestGraph(store);
    const result = materialize(db, "/tmp/project");

    expect(result.insights.overview.total_files).toBe(result.nodes.length);
    expect(result.insights.overview.total_edges).toBe(result.edges.length);
  });

  test("generated_at is a valid ISO timestamp", () => {
    const result = materialize(db, "/tmp/project");
    expect(() => new Date(result.generated_at)).not.toThrow();
    expect(new Date(result.generated_at).getFullYear()).toBeGreaterThan(2020);
  });
});

// ===========================================================================
// 2. materializeToFile — file write integration
// ===========================================================================

describe("materializeToFile — file write integration", () => {
  let db: Database.Database;
  let store: KgStore;
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTempDir();
    db = initDatabase(":memory:");
    store = new KgStore(db);
  });

  afterEach(() => {
    store.close();
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("writes graph-data.json with correct shape", () => {
    populateTestGraph(store);
    materializeToFile(db, projectDir);

    const outPath = path.join(projectDir, CANON_DIR, CANON_FILES.GRAPH_DATA);
    expect(existsSync(outPath)).toBe(true);

    const raw = readFileSync(outPath, "utf8");
    const data = JSON.parse(raw);
    expect(data).toHaveProperty("nodes");
    expect(data).toHaveProperty("edges");
    expect(data).toHaveProperty("layers");
    expect(data).toHaveProperty("insights");
    expect(data).toHaveProperty("generated_at");
    expect(Array.isArray(data.nodes)).toBe(true);
    expect(Array.isArray(data.edges)).toBe(true);
  });

  test("is idempotent — calling twice overwrites cleanly", () => {
    populateTestGraph(store);
    materializeToFile(db, projectDir);
    materializeToFile(db, projectDir);

    const outPath = path.join(projectDir, CANON_DIR, CANON_FILES.GRAPH_DATA);
    const data = JSON.parse(readFileSync(outPath, "utf8"));
    expect(data.nodes.length).toBe(3);
  });

  test("creates .canon directory if it does not exist", () => {
    const canonDir = path.join(projectDir, CANON_DIR);
    expect(existsSync(canonDir)).toBe(false);

    materializeToFile(db, projectDir);

    expect(existsSync(canonDir)).toBe(true);
  });
});

// ===========================================================================
// 3. Pipeline → Materializer end-to-end flow
// ===========================================================================

describe("Pipeline → Materializer end-to-end flow", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("pipeline populates DB and materializer produces valid graph-data.json", async () => {
    writeProjectFile(projectDir, "src/a.ts", "export function hello() {}");
    writeProjectFile(projectDir, "src/b.ts", "import { hello } from './a.ts';");

    const dbPath = path.join(projectDir, "test.db");
    await runPipeline(projectDir, { dbPath, incremental: false });

    const db = new Database(dbPath);
    try {
      // Materializer should produce valid output from pipeline DB
      const graphData = materialize(db, projectDir);

      expect(graphData.nodes.length).toBeGreaterThanOrEqual(2);
      expect(graphData.edges.length).toBeGreaterThanOrEqual(1);

      // a.ts should have an import edge from b.ts
      const importEdge = graphData.edges.find((e) => e.source === "src/b.ts" && e.target === "src/a.ts");
      expect(importEdge).toBeDefined();
      expect(importEdge!.type).toBe("import");
    } finally {
      db.close();
    }
  });

  test("materializeToFile writes correct data after pipeline run", async () => {
    writeProjectFile(projectDir, "src/utils.ts", 'export const VERSION = "1.0";');

    const dbPath = path.join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
    mkdirSync(path.dirname(dbPath), { recursive: true });
    await runPipeline(projectDir, { dbPath, incremental: false });

    const db = new Database(dbPath);
    try {
      materializeToFile(db, projectDir);
    } finally {
      db.close();
    }

    const outPath = path.join(projectDir, CANON_DIR, CANON_FILES.GRAPH_DATA);
    expect(existsSync(outPath)).toBe(true);
    const data = JSON.parse(readFileSync(outPath, "utf8"));
    // Should contain src/utils.ts node
    const utilsNode = data.nodes.find((n: { id: string }) => n.id === "src/utils.ts");
    expect(utilsNode).toBeDefined();
  });

  test("incremental reindex updates edges when import is added", async () => {
    writeProjectFile(projectDir, "src/a.ts", "export function greet() {}");
    writeProjectFile(projectDir, "src/b.ts", "// no imports yet");

    const dbPath = path.join(projectDir, "test.db");
    await runPipeline(projectDir, { dbPath, incremental: false });

    // Verify no edge from b.ts → a.ts initially
    const dbBefore = new Database(dbPath);
    const graphBefore = materialize(dbBefore, projectDir);
    dbBefore.close();
    const edgeBefore = graphBefore.edges.find((e) => e.source === "src/b.ts" && e.target === "src/a.ts");
    expect(edgeBefore).toBeUndefined();

    // Update b.ts to import from a.ts
    writeProjectFile(projectDir, "src/b.ts", "import { greet } from './a.ts';");

    // Re-run pipeline (non-incremental to force re-parse)
    await runPipeline(projectDir, { dbPath, incremental: false });

    const dbAfter = new Database(dbPath);
    const graphAfter = materialize(dbAfter, projectDir);
    dbAfter.close();

    const edgeAfter = graphAfter.edges.find((e) => e.source === "src/b.ts" && e.target === "src/a.ts");
    expect(edgeAfter).toBeDefined();
  });
});

// ===========================================================================
// 4. Blast Radius Analysis — analyzeBlastRadius (0% covered before)
// ===========================================================================

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
      makeFileRow({ path: "src/__tests__/helpers.test.ts", layer: "test", content_hash: "testhash" }),
    );
    const testEntity = store.insertEntity(
      makeEntityRow(testFile.file_id!, {
        name: "testHelper",
        qualified_name: "src/__tests__/helpers.test.ts::testHelper",
        is_exported: false,
      }),
    );

    // testHelper calls funcC — so funcC's blast radius (reverse) includes testHelper
    const { funcC } = populateTestGraph(store);
    store.insertEdge({
      source_entity_id: testEntity.entity_id!,
      target_entity_id: funcC.entity_id!,
      edge_type: "calls",
      confidence: 0.8,
      metadata: null,
    });

    const report = analyzeBlastRadius(db, ["funcC"], { maxDepth: 2, includeTests: false });
    const names = report.affected.map((e) => e.entity_name);
    expect(names).not.toContain("testHelper");
  });

  test("includes test file entities when includeTests is true (default)", () => {
    const testFile = store.upsertFile(
      makeFileRow({ path: "src/__tests__/helpers.test.ts", layer: "test", content_hash: "testhash" }),
    );
    const testEntity = store.insertEntity(
      makeEntityRow(testFile.file_id!, {
        name: "testHelper",
        qualified_name: "src/__tests__/helpers.test.ts::testHelper",
        is_exported: false,
      }),
    );

    // testHelper calls funcC — so funcC's blast radius (reverse) includes testHelper
    const { funcC } = populateTestGraph(store);
    store.insertEdge({
      source_entity_id: testEntity.entity_id!,
      target_entity_id: funcC.entity_id!,
      edge_type: "calls",
      confidence: 0.8,
      metadata: null,
    });

    const report = analyzeBlastRadius(db, ["funcC"], { maxDepth: 2, includeTests: true });
    const names = report.affected.map((e) => e.entity_name);
    expect(names).toContain("testHelper");
  });
});

// ===========================================================================
// 5. Blast Radius — deeper graph CTE correctness
// ===========================================================================

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
    const fileRoot = store.upsertFile(makeFileRow({ path: "root.ts", content_hash: "h0" }));
    const fileA = store.upsertFile(makeFileRow({ path: "A.ts", content_hash: "h1" }));
    const fileB = store.upsertFile(makeFileRow({ path: "B.ts", content_hash: "h2" }));
    const fileC = store.upsertFile(makeFileRow({ path: "C.ts", content_hash: "h3" }));
    const fileD = store.upsertFile(makeFileRow({ path: "D.ts", content_hash: "h4" }));

    const root = store.insertEntity(
      makeEntityRow(fileRoot.file_id!, { name: "root", qualified_name: "root.ts::root" }),
    );
    const a = store.insertEntity(makeEntityRow(fileA.file_id!, { name: "a", qualified_name: "A.ts::a" }));
    const b = store.insertEntity(makeEntityRow(fileB.file_id!, { name: "b", qualified_name: "B.ts::b" }));
    const c = store.insertEntity(makeEntityRow(fileC.file_id!, { name: "c", qualified_name: "C.ts::c" }));
    const d = store.insertEntity(makeEntityRow(fileD.file_id!, { name: "d", qualified_name: "D.ts::d" }));

    store.insertEdge({
      source_entity_id: root.entity_id!,
      target_entity_id: a.entity_id!,
      edge_type: "calls",
      confidence: 1,
      metadata: null,
    });
    store.insertEdge({
      source_entity_id: a.entity_id!,
      target_entity_id: b.entity_id!,
      edge_type: "calls",
      confidence: 1,
      metadata: null,
    });
    store.insertEdge({
      source_entity_id: b.entity_id!,
      target_entity_id: c.entity_id!,
      edge_type: "calls",
      confidence: 1,
      metadata: null,
    });
    store.insertEdge({
      source_entity_id: c.entity_id!,
      target_entity_id: d.entity_id!,
      edge_type: "calls",
      confidence: 1,
      metadata: null,
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
    const fileRoot = store.upsertFile(makeFileRow({ path: "root.ts", content_hash: "h0" }));
    const fileA = store.upsertFile(makeFileRow({ path: "A.ts", content_hash: "h1" }));
    const fileB = store.upsertFile(makeFileRow({ path: "B.ts", content_hash: "h2" }));
    const fileC = store.upsertFile(makeFileRow({ path: "C.ts", content_hash: "h3" }));

    store.insertEntity(makeEntityRow(fileRoot.file_id!, { name: "root", qualified_name: "root.ts::root" }));
    const a = store.insertEntity(makeEntityRow(fileA.file_id!, { name: "a", qualified_name: "A.ts::a" }));
    const b = store.insertEntity(makeEntityRow(fileB.file_id!, { name: "b", qualified_name: "B.ts::b" }));
    const c = store.insertEntity(makeEntityRow(fileC.file_id!, { name: "c", qualified_name: "C.ts::c" }));
    const root = store.insertEntity(
      makeEntityRow(fileRoot.file_id!, { name: "root2", qualified_name: "root.ts::root2" }),
    );

    store.insertEdge({
      source_entity_id: root.entity_id!,
      target_entity_id: a.entity_id!,
      edge_type: "calls",
      confidence: 1,
      metadata: null,
    });
    store.insertEdge({
      source_entity_id: root.entity_id!,
      target_entity_id: b.entity_id!,
      edge_type: "calls",
      confidence: 1,
      metadata: null,
    });
    store.insertEdge({
      source_entity_id: a.entity_id!,
      target_entity_id: c.entity_id!,
      edge_type: "calls",
      confidence: 1,
      metadata: null,
    });
    store.insertEdge({
      source_entity_id: b.entity_id!,
      target_entity_id: c.entity_id!,
      edge_type: "calls",
      confidence: 1,
      metadata: null,
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
    const fileA = store.upsertFile(makeFileRow({ path: "A.ts", content_hash: "h1" }));
    const fileB = store.upsertFile(makeFileRow({ path: "B.ts", content_hash: "h2" }));

    const a = store.insertEntity(makeEntityRow(fileA.file_id!, { name: "a", qualified_name: "A.ts::a" }));
    const b = store.insertEntity(makeEntityRow(fileB.file_id!, { name: "b", qualified_name: "B.ts::b" }));

    store.insertEdge({
      source_entity_id: a.entity_id!,
      target_entity_id: b.entity_id!,
      edge_type: "calls",
      confidence: 1,
      metadata: null,
    });
    store.insertEdge({
      source_entity_id: b.entity_id!,
      target_entity_id: a.entity_id!,
      edge_type: "calls",
      confidence: 1,
      metadata: null,
    });

    // Should terminate and return both entities without infinite loop
    expect(() => analyzeBlastRadius(db, ["a"], { maxDepth: 5 })).not.toThrow();
    const report = analyzeBlastRadius(db, ["a"], { maxDepth: 5 });
    expect(report.affected.length).toBeGreaterThanOrEqual(1);
    expect(report.affected.length).toBeLessThan(100); // not exploded
  });
});

// ===========================================================================
// 6. graph_query tool dispatch
// ===========================================================================

describe("graphQuery tool dispatch", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
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
    const result = graphQuery({ query_type: "blast_radius", target: "funcC", options: { max_depth: 3 } }, projectDir);
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
        name: "MyClass",
        qualified_name: "src/A.ts::MyClass",
        kind: "class",
        is_exported: true,
      }),
    );
    store.insertEdge({
      source_entity_id: classContainer.entity_id!,
      target_entity_id: funcA.entity_id!,
      edge_type: "contains",
      confidence: 1.0,
      metadata: null,
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
    const result = graphQuery({ query_type: "callers", target: "nonexistent_entity_xyz" }, projectDir);
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
    const result = graphQuery({ query_type: "search", target: "func*", options: { limit: 2 } }, projectDir);
    if (!result.ok) throw new Error(result.message);
    expect(result.results.length).toBeLessThanOrEqual(2);
  });
});

// ===========================================================================
// 7. Adapter Registry contract
// ===========================================================================

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

// ===========================================================================
// 8. KgStore — gaps: upsert conflict, cascade verification, boolean coercion
// ===========================================================================

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
    const original = store.upsertFile(makeFileRow({ mtime_ms: 1000, content_hash: "hash1" }));
    const updated = store.upsertFile(makeFileRow({ mtime_ms: 2000, content_hash: "hash2" }));
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
        name: "exported",
        qualified_name: "src/A.ts::exported",
        is_exported: true,
        is_default_export: true,
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
        name: "private",
        qualified_name: "src/A.ts::private",
        is_exported: false,
        is_default_export: false,
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

// ===========================================================================
// 9. KgQuery — gaps: getAncestors, getAdjacencyList
// ===========================================================================

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
      makeEntityRow(fileA.file_id!, { name: "ClassA", qualified_name: "src/A.ts::ClassA", kind: "class" }),
    );
    const method = store.insertEntity(
      makeEntityRow(fileA.file_id!, { name: "method", qualified_name: "src/A.ts::ClassA.method", kind: "function" }),
    );
    store.insertEdge({
      source_entity_id: classA.entity_id!,
      target_entity_id: method.entity_id!,
      edge_type: "contains",
      confidence: 1.0,
      metadata: null,
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

    const a = store.insertEntity(makeEntityRow(fileA.file_id!, { name: "a", qualified_name: "src/A.ts::a" }));
    const b = store.insertEntity(makeEntityRow(fileB.file_id!, { name: "b", qualified_name: "src/B.ts::b" }));
    const c = store.insertEntity(makeEntityRow(fileC.file_id!, { name: "c", qualified_name: "src/C.ts::c" }));

    store.insertEdge({
      source_entity_id: a.entity_id!,
      target_entity_id: b.entity_id!,
      edge_type: "calls",
      confidence: 1,
      metadata: null,
    });
    store.insertEdge({
      source_entity_id: a.entity_id!,
      target_entity_id: c.entity_id!,
      edge_type: "calls",
      confidence: 1,
      metadata: null,
    });

    const adj = query.getAdjacencyList();
    const aNeighbors = adj.get(a.entity_id!);
    expect(aNeighbors).toBeDefined();
    expect(aNeighbors).toContain(b.entity_id);
    expect(aNeighbors).toContain(c.entity_id);
    expect(aNeighbors!.length).toBe(2);
  });
});

// ===========================================================================
// 10. Adapter edge cases — malformed input and empty files
// ===========================================================================

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
