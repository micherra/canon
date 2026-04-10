/**
 * Knowledge Graph — Integration Tests (Part 3)
 *
 * Tests cross-module boundaries:
 *   6. KgStore CRUD gaps (upsert conflict path, cascade verification, boolean coercion)
 *   7. KgQuery gaps (getAncestors, getAdjacencyList)
 *   8. Adapter edge cases — malformed input and empty files
 *
 * All DB-bound tests use in-memory SQLite (:memory:).
 * DB-only workflow tests moved to kg-integration-dbonly.test.ts.
 */

import { getAdapter } from "@graph/kg-adapter-registry.ts";
import { KgQuery } from "@graph/kg-query.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import { KgStore } from "@graph/kg-store.ts";
import type { EntityRow, FileRow } from "@graph/kg-types.ts";
import { initParsers } from "@graph/kg-wasm-parser.ts";
import type Database from "better-sqlite3";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

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
