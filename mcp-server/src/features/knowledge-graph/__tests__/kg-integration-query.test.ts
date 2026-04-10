/**
 * Knowledge Graph — Integration Tests (Part 2)
 *
 * Tests cross-module boundaries:
 *   3. analyzeBlastRadius — deeper graph CTE correctness
 *   4. graph_query tool dispatch (DB-not-found, entity-not-found, each query type)
 *   5. Adapter Registry contract (getAdapter, getLanguage)
 *
 * All DB-bound tests use in-memory SQLite (:memory:).
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getAdapter, getLanguage } from "@graph/kg-adapter-registry.ts";
import { analyzeBlastRadius } from "@graph/kg-blast-radius.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import { KgStore } from "@graph/kg-store.ts";
import type { EntityRow, FileRow } from "@graph/kg-types.ts";
import { initParsers } from "@graph/kg-wasm-parser.ts";
import { CANON_DIR, CANON_FILES } from "@shared/constants.ts";
import type Database from "better-sqlite3";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { graphQuery } from "../tools/graph-query.ts";

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "kg-integration-test-"));
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
