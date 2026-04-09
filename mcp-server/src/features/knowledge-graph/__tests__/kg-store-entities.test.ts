/**
 * Knowledge Graph Store and Query Tests (Part 2)
 *
 * Uses in-memory SQLite (:memory:) for speed and isolation.
 * Each describe block gets a fresh DB via beforeEach.
 *
 * Covers: Summaries CRUD, Stats, KgQuery operations, Schema v3 vector tables.
 */

import { KgQuery } from "@graph/kg-query.ts";
import { initDatabase, runMigrations, SCHEMA_VERSION } from "@graph/kg-schema.ts";
import { KgStore } from "@graph/kg-store.ts";
import type { EntityRow, FileRow } from "@graph/kg-types.ts";
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
 * Populate a test graph with 3 files and 5 entities:
 *
 *   File A (api) — funcA (exported, calls funcB)
 *   File B (domain) — funcB (exported, calls funcC), funcD (not exported, not called = dead code)
 *   File C (shared) — funcC (exported), ClassE (exported)
 *
 * Entity edges: funcA->funcB (calls), funcB->funcC (calls)
 * File edges:   A imports B, B imports C
 */
function populateTestGraph(store: KgStore): {
  fileA: FileRow;
  fileB: FileRow;
  fileC: FileRow;
  funcA: EntityRow;
  funcB: EntityRow;
  funcC: EntityRow;
  funcD: EntityRow;
  classE: EntityRow;
} {
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
  // Dead code: unexported, never called
  const funcD = store.insertEntity(
    makeEntityRow(fileB.file_id!, {
      is_exported: false,
      name: "funcD",
      qualified_name: "src/B.ts::funcD",
    }),
  );
  const classE = store.insertEntity(
    makeEntityRow(fileC.file_id!, {
      is_exported: true,
      kind: "class",
      name: "ClassE",
      qualified_name: "src/C.ts::ClassE",
    }),
  );

  // Entity edges: funcA->funcB, funcB->funcC
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

  // File edges: A imports B, B imports C
  store.insertFileEdge({
    confidence: 1.0,
    edge_type: "imports",
    evidence: "import { funcB } from '@features/knowledge-graph/__tests__/B'",
    relation: "imports",
    source_file_id: fileA.file_id!,
    target_file_id: fileB.file_id!,
  });
  store.insertFileEdge({
    confidence: 1.0,
    edge_type: "imports",
    evidence: "import { funcC } from '@features/knowledge-graph/__tests__/C'",
    relation: "imports",
    source_file_id: fileB.file_id!,
    target_file_id: fileC.file_id!,
  });

  return { classE, fileA, fileB, fileC, funcA, funcB, funcC, funcD };
}

describe("Knowledge Graph Store — Entities and Query", () => {
  // ---- Summaries ----

  describe("KgStore CRUD — Summaries", () => {
    let db: Database.Database;
    let store: KgStore;
    let file: FileRow;

    beforeEach(() => {
      db = initDatabase(":memory:");
      store = new KgStore(db);
      file = store.upsertFile(makeFileRow({ content_hash: "hash-v1", path: "src/sumFile.ts" }));
    });

    afterEach(() => {
      store.close();
    });

    function makeSummaryParams(
      overrides: Partial<Omit<import("@graph/kg-types.ts").SummaryRow, "summary_id">> = {},
    ) {
      return {
        content_hash: "hash-v1",
        entity_id: null,
        file_id: file.file_id!,
        model: "gpt-4",
        scope: "file" as const,
        summary: "This file does X.",
        updated_at: "2024-01-01T00:00:00Z",
        ...overrides,
      };
    }

    test("upsertSummary inserts a new row and returns it with summary_id set", () => {
      const row = store.upsertSummary(makeSummaryParams());
      expect(row.summary_id).toBeDefined();
      expect(typeof row.summary_id).toBe("number");
      expect(row.file_id).toBe(file.file_id);
      expect(row.scope).toBe("file");
      expect(row.summary).toBe("This file does X.");
    });

    test('upsertSummary on duplicate (file_id, null, "file") replaces existing row', () => {
      // NULL entity_id: SQLite UNIQUE treats NULLs as distinct, so we use DELETE+INSERT.
      // The summary_id changes (new AUTOINCREMENT), but only one row exists afterwards.
      store.upsertSummary(makeSummaryParams({ summary: "First summary." }));
      const second = store.upsertSummary(
        makeSummaryParams({ content_hash: "hash-v2", summary: "Updated summary." }),
      );
      expect(second.summary).toBe("Updated summary.");
      expect(second.content_hash).toBe("hash-v2");
      // Verify only one row exists for this file (no duplicates)
      const rows = db
        .prepare(
          `SELECT COUNT(*) as cnt FROM summaries WHERE file_id = ? AND entity_id IS NULL AND scope = 'file'`,
        )
        .get(file.file_id) as { cnt: number };
      expect(rows.cnt).toBe(1);
    });

    test("getSummaryByFile returns the file-level summary for a given file_id", () => {
      store.upsertSummary(makeSummaryParams());
      const found = store.getSummaryByFile(file.file_id!);
      expect(found).toBeDefined();
      expect(found!.file_id).toBe(file.file_id);
      expect(found!.scope).toBe("file");
    });

    test("getSummaryByFile returns undefined when no summary exists", () => {
      const other = store.upsertFile(makeFileRow({ path: "src/noSummary.ts" }));
      const found = store.getSummaryByFile(other.file_id!);
      expect(found).toBeUndefined();
    });

    test("getSummariesByFiles returns summaries for all given file IDs", () => {
      const file2 = store.upsertFile(
        makeFileRow({ content_hash: "hash-a", path: "src/sumFile2.ts" }),
      );
      const file3 = store.upsertFile(
        makeFileRow({ content_hash: "hash-b", path: "src/sumFile3.ts" }),
      );
      store.upsertSummary(makeSummaryParams({ file_id: file.file_id! }));
      store.upsertSummary(makeSummaryParams({ file_id: file2.file_id! }));
      store.upsertSummary(makeSummaryParams({ file_id: file3.file_id! }));

      const results = store.getSummariesByFiles([file.file_id!, file2.file_id!]);
      expect(results).toHaveLength(2);
      const ids = results.map((r) => r.file_id);
      expect(ids).toContain(file.file_id);
      expect(ids).toContain(file2.file_id);
      expect(ids).not.toContain(file3.file_id);
    });

    test("getSummariesByFiles returns empty array for empty input", () => {
      store.upsertSummary(makeSummaryParams());
      const results = store.getSummariesByFiles([]);
      expect(results).toHaveLength(0);
    });

    test("deleteSummariesByFile removes the summary for a file", () => {
      store.upsertSummary(makeSummaryParams());
      expect(store.getSummaryByFile(file.file_id!)).toBeDefined();
      store.deleteSummariesByFile(file.file_id!);
      expect(store.getSummaryByFile(file.file_id!)).toBeUndefined();
    });

    test("getStaleSummaries returns summaries where content_hash differs from file", () => {
      // Summary has hash-v1, but now update the file to hash-v2
      store.upsertSummary(makeSummaryParams({ content_hash: "hash-v1" }));
      // Directly update the file's content_hash to simulate re-indexing
      db.prepare(`UPDATE files SET content_hash = 'hash-v2' WHERE file_id = ?`).run(file.file_id);

      const stale = store.getStaleSummaries();
      expect(stale.length).toBeGreaterThanOrEqual(1);
      const found = stale.find((s) => s.file_id === file.file_id);
      expect(found).toBeDefined();
      expect(found!.file_content_hash).toBe("hash-v2");
      expect(found!.content_hash).toBe("hash-v1");
    });

    test("getStaleSummaries returns empty array when all summaries are current", () => {
      // Summary content_hash matches the file's content_hash (both 'hash-v1')
      store.upsertSummary(makeSummaryParams({ content_hash: "hash-v1" }));
      const stale = store.getStaleSummaries();
      expect(stale).toHaveLength(0);
    });
  });

  // ---- Stats ----

  describe("KgStore CRUD — Stats", () => {
    let db: Database.Database;
    let store: KgStore;

    beforeEach(() => {
      db = initDatabase(":memory:");
      store = new KgStore(db);
    });

    afterEach(() => {
      store.close();
      void db;
    });

    test("getStats returns correct counts", () => {
      const { fileA, fileB, funcA, funcB } = populateTestGraph(store);
      void fileA;
      void fileB;
      void funcA;
      void funcB; // silence unused warning

      const stats = store.getStats();
      expect(stats.files).toBe(3);
      // funcA, funcB, funcC, funcD, ClassE = 5 entities
      expect(stats.entities).toBe(5);
      // funcA->funcB, funcB->funcC = 2 entity edges
      expect(stats.edges).toBe(2);
      // A->B, B->C = 2 file edges
      expect(stats.fileEdges).toBe(2);
    });
  });

  // KgQuery

  describe("KgQuery", () => {
    let db: Database.Database;
    let store: KgStore;
    let query: KgQuery;

    let funcA: EntityRow;
    let funcB: EntityRow;
    let funcC: EntityRow;
    let funcD: EntityRow;
    let fileA: FileRow;

    beforeEach(() => {
      db = initDatabase(":memory:");
      store = new KgStore(db);
      query = new KgQuery(db);
      ({ fileA, funcA, funcB, funcC, funcD } = populateTestGraph(store));
      void fileA;
      void funcD; // silence unused
    });

    afterEach(() => {
      store.close();
    });

    // ---- Callers / Callees ----

    describe("Callers/Callees", () => {
      test("getCallers returns callers of funcB", () => {
        const callers = query.getCallers(funcB.entity_id!);
        expect(callers).toHaveLength(1);
        expect(callers[0]?.name).toBe("funcA");
        expect(callers[0]?.edge_type).toBe("calls");
      });

      test("getCallees returns callees of funcA", () => {
        const callees = query.getCallees(funcA.entity_id!);
        expect(callees).toHaveLength(1);
        expect(callees[0]?.name).toBe("funcB");
        expect(callees[0]?.edge_type).toBe("calls");
      });
    });

    // ---- Blast Radius ----

    describe("Blast Radius", () => {
      test("blast radius from funcC includes funcB and funcA (reverse traversal — callers)", () => {
        // getBlastRadius follows reverse edges (who depends on the seed).
        // Graph: funcA calls funcB calls funcC.
        // Seed = funcC → blast radius includes funcB (direct caller) and funcA (transitive caller).
        const results = query.getBlastRadius([funcC.entity_id!], 5);
        const names = results.map((r) => r.name);
        expect(names).toContain("funcC"); // seed (depth 0)
        expect(names).toContain("funcB"); // direct caller (depth 1)
        expect(names).toContain("funcA"); // transitive caller (depth 2)
      });

      test("blast radius respects maxDepth", () => {
        // Seed = funcC with maxDepth=1 should only reach funcB (depth 1), not funcA (depth 2)
        const results = query.getBlastRadius([funcC.entity_id!], 1);
        const names = results.map((r) => r.name);
        expect(names).toContain("funcC"); // seed (depth 0)
        expect(names).toContain("funcB"); // direct caller (depth 1)
        expect(names).not.toContain("funcA"); // depth 2 — excluded by maxDepth=1
      });

      test("blast radius returns empty for empty seed", () => {
        const results = query.getBlastRadius([], 5);
        expect(results).toHaveLength(0);
      });
    });

    // ---- FTS5 Search ----

    describe("FTS5 Search", () => {
      test("search finds entity by name", () => {
        const results = query.search("funcA");
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results.some((r) => r.name === "funcA")).toBe(true);
      });

      test("search finds entity by qualified name", () => {
        const results = query.search("funcB");
        expect(results.some((r) => r.qualified_name.includes("funcB"))).toBe(true);
      });

      test("search returns empty for no match", () => {
        const results = query.search("zzz_no_match_xyz");
        expect(results).toHaveLength(0);
      });

      test("search respects limit", () => {
        // There are 5 entities, limit to 2
        // Use a broad query that matches all (prefix search on "func")
        const results = query.search("func*", 2);
        expect(results.length).toBeLessThanOrEqual(2);
      });
    });

    // ---- Dead Code ----

    describe("Dead Code", () => {
      test("findDeadCode identifies unexported unreferenced entities", () => {
        const dead = query.findDeadCode();
        // funcD is unexported and never called, in a non-test file -> dead code
        expect(dead.some((d) => d.name === "funcD")).toBe(true);
        // funcA, funcB, funcC are exported so NOT dead
        expect(dead.some((d) => d.name === "funcA")).toBe(false);
        expect(dead.some((d) => d.name === "funcB")).toBe(false);
        expect(dead.some((d) => d.name === "funcC")).toBe(false);
      });

      test("findDeadCode excludes test files when option not set", () => {
        // Insert a dead entity in a test file
        const testFile = store.upsertFile(
          makeFileRow({ layer: "test", path: "src/__tests__/A.test.ts" }),
        );
        store.insertEntity(
          makeEntityRow(testFile.file_id!, {
            is_exported: false,
            name: "testHelper",
            qualified_name: "src/__tests__/A.test.ts::testHelper",
          }),
        );
        const dead = query.findDeadCode({ includeTests: false });
        expect(dead.some((d) => d.name === "testHelper")).toBe(false);
      });

      test("findDeadCode includes test file entities when includeTests is true", () => {
        const testFile = store.upsertFile(
          makeFileRow({ layer: "test", path: "src/__tests__/A.test.ts" }),
        );
        store.insertEntity(
          makeEntityRow(testFile.file_id!, {
            is_exported: false,
            name: "testHelper",
            qualified_name: "src/__tests__/A.test.ts::testHelper",
          }),
        );
        const dead = query.findDeadCode({ includeTests: true });
        expect(dead.some((d) => d.name === "testHelper")).toBe(true);
      });
    });

    // ---- File Stats ----

    describe("File Stats", () => {
      test("getFileStats returns correct entity counts", () => {
        // fileB (populated in beforeEach) has funcB (exported) and funcD (not exported, not called = dead)
        // Use a separate fresh DB so this test is fully isolated
        const db2 = initDatabase(":memory:");
        const store2 = new KgStore(db2);
        const query2 = new KgQuery(db2);
        const g = populateTestGraph(store2);

        const stats = query2.getFileStats(g.fileB.file_id!);
        expect(stats.entityCount).toBe(2); // funcB, funcD
        expect(stats.exportCount).toBe(1); // only funcB is exported
        expect(stats.deadCodeCount).toBe(1); // funcD is dead

        store2.close();
      });

      test("getAllFilesWithStats returns all files with stats", () => {
        const db2 = initDatabase(":memory:");
        const store2 = new KgStore(db2);
        const query2 = new KgQuery(db2);
        populateTestGraph(store2);

        const allStats = query2.getAllFilesWithStats();
        expect(allStats).toHaveLength(3);
        const fileAStats = allStats.find((f) => f.path === "src/A.ts");
        expect(fileAStats).toBeDefined();
        expect(fileAStats!.entity_count).toBe(1); // funcA
        expect(fileAStats!.export_count).toBe(1); // funcA is exported

        store2.close();
      });
    });
  });

  // Schema v3 — vec0 tables and migration

  describe("Schema v3 — vector tables", () => {
    let db: Database.Database;

    beforeEach(() => {
      db = initDatabase(":memory:");
    });

    afterEach(() => {
      db.close();
    });

    test("initDatabase creates entity_vectors virtual table", () => {
      const row = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='entity_vectors'`)
        .get() as { name: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.name).toBe("entity_vectors");
    });

    test("initDatabase creates summary_vectors virtual table", () => {
      const row = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='summary_vectors'`)
        .get() as { name: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.name).toBe("summary_vectors");
    });

    test("initDatabase creates entity_vector_meta table", () => {
      const cols = db.prepare(`PRAGMA table_info(entity_vector_meta)`).all() as Array<{
        name: string;
      }>;
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain("entity_id");
      expect(colNames).toContain("text_hash");
      expect(colNames).toContain("model_id");
      expect(colNames).toContain("updated_at");
    });

    test("initDatabase creates summary_vector_meta table", () => {
      const cols = db.prepare(`PRAGMA table_info(summary_vector_meta)`).all() as Array<{
        name: string;
      }>;
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain("summary_id");
      expect(colNames).toContain("text_hash");
      expect(colNames).toContain("model_id");
      expect(colNames).toContain("updated_at");
    });

    test("schema_version is '4' for new databases", () => {
      const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
        | { value: string }
        | undefined;
      expect(row?.value).toBe("4");
      expect(SCHEMA_VERSION).toBe("4");
    });

    test("entity_vectors accepts insert with valid embedding", () => {
      // sqlite-vec pre-v1 quirk: only db.exec() with inline SQL works for vec0 inserts.
      // Prepared statement parameterized inserts fail with "Only integers are allows for
      // primary key values" — this is a known bug in sqlite-vec 0.1.6-alpha.2.
      const jsonEmbedding = `[${new Array(384).fill("0.1").join(",")}]`;
      expect(() =>
        db.exec(`INSERT INTO entity_vectors (entity_id, embedding) VALUES (1, '${jsonEmbedding}')`),
      ).not.toThrow();
    });

    test("summary_vectors accepts insert with valid embedding", () => {
      const jsonEmbedding = `[${new Array(384).fill("0.2").join(",")}]`;
      expect(() =>
        db.exec(
          `INSERT INTO summary_vectors (summary_id, embedding) VALUES (1, '${jsonEmbedding}')`,
        ),
      ).not.toThrow();
    });
  });

  describe("Schema v3 — migration from v2", () => {
    test("runMigrations upgrades v2 DB to v3 (creates vec0 tables)", () => {
      // Build a v2 DB by applying DDL manually without v3 tables
      // We simulate a v2 DB by creating base schema, setting schema_version to '2',
      // then calling runMigrations() to migrate forward.
      const db = initDatabase(":memory:");

      // Confirm the migration already ran (new DB starts at v4)
      const before = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
        value: string;
      };
      expect(before.value).toBe("4");

      // Simulate a v2 DB: downgrade schema_version to '2' and drop v3 tables
      db.exec(`UPDATE meta SET value = '2' WHERE key = 'schema_version'`);
      db.exec(`DROP TABLE IF EXISTS entity_vector_meta`);
      db.exec(`DROP TABLE IF EXISTS summary_vector_meta`);
      // Note: vec0 virtual tables need sqlite-vec loaded; can't drop and recreate
      // but we can verify meta tables are created by the migration

      // Re-run migrations — should upgrade from 2 to 3
      runMigrations(db);

      // schema_version should now be '4' (v3→v4 migration also runs)
      const after = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
        value: string;
      };
      expect(after.value).toBe("4");

      // entity_vector_meta should exist
      const metaTable = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='entity_vector_meta'`)
        .get() as { name: string } | undefined;
      expect(metaTable).toBeDefined();

      db.close();
    });

    test("runMigrations is idempotent when already at v4", () => {
      const db = initDatabase(":memory:");
      // Should not throw on double-call
      expect(() => runMigrations(db)).not.toThrow();
      const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
        value: string;
      };
      expect(row.value).toBe("4");
      db.close();
    });
  });
});
