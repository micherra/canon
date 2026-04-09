/**
 * Knowledge Graph Store and Query Tests (Part 1)
 *
 * Uses in-memory SQLite (:memory:) for speed and isolation.
 * Each describe block gets a fresh DB via beforeEach.
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

// Schema tests

describe("Knowledge Graph Store", () => {
  describe("Schema", () => {
    let db: Database.Database;

    beforeEach(() => {
      db = initDatabase(":memory:");
    });

    afterEach(() => {
      db.close();
    });

    test("initDatabase creates all tables", () => {
      const tables = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
        .all() as Array<{
        name: string;
      }>;
      const names = tables.map((t) => t.name);
      expect(names).toContain("files");
      expect(names).toContain("entities");
      expect(names).toContain("edges");
      expect(names).toContain("file_edges");
      expect(names).toContain("meta");
      expect(names).toContain("summaries");
    });

    test("initDatabase is idempotent (can call twice)", () => {
      // Second call should not throw
      expect(() => {
        const db2 = initDatabase(":memory:");
        db2.close();
      }).not.toThrow();
    });

    test("schema_version is set to 4", () => {
      const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
        | { value: string }
        | undefined;
      expect(row).toBeDefined();
      expect(row!.value).toBe(SCHEMA_VERSION);
      expect(row!.value).toBe("4");
    });

    test("WAL mode pragma is applied (in-memory uses memory mode)", () => {
      // SQLite in-memory databases do not support WAL — they always report 'memory'.
      // We verify the pragma call is accepted without error and the journal_mode is
      // either 'wal' (file-backed DB) or 'memory' (in-memory DB).
      const result = db.pragma("journal_mode") as Array<{ journal_mode: string }>;
      const mode = result[0]?.journal_mode;
      expect(["wal", "memory"]).toContain(mode);
    });

    test("foreign keys are enabled", () => {
      const result = db.pragma("foreign_keys") as Array<{ foreign_keys: number }>;
      expect(result[0]?.foreign_keys).toBe(1);
    });
  });

  // Summaries table

  describe("Summaries table", () => {
    let db: Database.Database;

    beforeEach(() => {
      db = initDatabase(":memory:");
    });

    afterEach(() => {
      db.close();
    });

    test("summaries table exists after initDatabase", () => {
      const row = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='summaries'`)
        .get() as { name: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.name).toBe("summaries");
    });

    test("summaries table has correct columns", () => {
      const cols = db.prepare(`PRAGMA table_info(summaries)`).all() as Array<{ name: string }>;
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain("summary_id");
      expect(colNames).toContain("file_id");
      expect(colNames).toContain("entity_id");
      expect(colNames).toContain("scope");
      expect(colNames).toContain("summary");
      expect(colNames).toContain("model");
      expect(colNames).toContain("content_hash");
      expect(colNames).toContain("updated_at");
    });

    test('SCHEMA_VERSION is "4" after initDatabase', () => {
      const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
        | { value: string }
        | undefined;
      expect(row?.value).toBe("4");
    });

    test("inserting a summary row with valid file_id succeeds", () => {
      // Insert a file first
      db.exec(`INSERT INTO files (path, mtime_ms, content_hash, language, layer, last_indexed_at)
               VALUES ('src/A.ts', 0, 'hash1', 'typescript', 'domain', '2024-01-01')`);
      const file = db.prepare(`SELECT file_id FROM files WHERE path = 'src/A.ts'`).get() as {
        file_id: number;
      };

      const insert = db.prepare(
        `INSERT INTO summaries (file_id, entity_id, scope, summary, model, content_hash, updated_at)
         VALUES (?, NULL, 'file', 'A summary.', 'gpt-4', NULL, '2024-01-01T00:00:00Z')`,
      );
      expect(() => insert.run(file.file_id)).not.toThrow();

      const row = db.prepare(`SELECT * FROM summaries WHERE file_id = ?`).get(file.file_id) as
        | { summary: string; scope: string }
        | undefined;
      expect(row).toBeDefined();
      expect(row!.summary).toBe("A summary.");
      expect(row!.scope).toBe("file");
    });

    test("inserting a summary row with invalid file_id fails (FK constraint)", () => {
      const insert = db.prepare(
        `INSERT INTO summaries (file_id, entity_id, scope, summary, model, content_hash, updated_at)
         VALUES (99999, NULL, 'file', 'Bad row.', NULL, NULL, '2024-01-01T00:00:00Z')`,
      );
      expect(() => insert.run()).toThrow();
    });

    test("ON DELETE CASCADE removes summaries when parent file is deleted", () => {
      // Insert file and summary
      db.exec(`INSERT INTO files (path, mtime_ms, content_hash, language, layer, last_indexed_at)
               VALUES ('src/B.ts', 0, 'hash2', 'typescript', 'domain', '2024-01-01')`);
      const file = db.prepare(`SELECT file_id FROM files WHERE path = 'src/B.ts'`).get() as {
        file_id: number;
      };

      db.prepare(
        `INSERT INTO summaries (file_id, entity_id, scope, summary, model, content_hash, updated_at)
         VALUES (?, NULL, 'file', 'Will cascade.', NULL, NULL, '2024-01-01T00:00:00Z')`,
      ).run(file.file_id);

      // Verify it exists
      expect(
        db.prepare(`SELECT COUNT(*) as cnt FROM summaries WHERE file_id = ?`).get(file.file_id),
      ).toMatchObject({
        cnt: 1,
      });

      // Delete the file — cascade should remove summary
      db.prepare(`DELETE FROM files WHERE file_id = ?`).run(file.file_id);

      expect(
        db.prepare(`SELECT COUNT(*) as cnt FROM summaries WHERE file_id = ?`).get(file.file_id),
      ).toMatchObject({
        cnt: 0,
      });
    });

    test("UNIQUE(file_id, entity_id, scope) rejects duplicate inserts", () => {
      // Note: SQLite treats NULLs as distinct in UNIQUE constraints, so we use
      // a non-NULL entity_id to properly test the uniqueness enforcement.
      db.exec(`INSERT INTO files (path, mtime_ms, content_hash, language, layer, last_indexed_at)
               VALUES ('src/C.ts', 0, 'hash3', 'typescript', 'domain', '2024-01-01')`);
      const file = db.prepare(`SELECT file_id FROM files WHERE path = 'src/C.ts'`).get() as {
        file_id: number;
      };

      // Insert an entity so we have a valid entity_id
      db.prepare(
        `INSERT INTO entities (file_id, name, qualified_name, kind, line_start, line_end,
           is_exported, is_default_export, signature, metadata)
         VALUES (?, 'myEnt', 'src/C.ts::myEnt', 'function', 1, 5, 0, 0, NULL, NULL)`,
      ).run(file.file_id);
      const entity = db
        .prepare(`SELECT entity_id FROM entities WHERE qualified_name = 'src/C.ts::myEnt'`)
        .get() as {
        entity_id: number;
      };

      const insertStmt = db.prepare(
        `INSERT INTO summaries (file_id, entity_id, scope, summary, model, content_hash, updated_at)
         VALUES (?, ?, 'entity', 'First.', NULL, NULL, '2024-01-01T00:00:00Z')`,
      );
      insertStmt.run(file.file_id, entity.entity_id);

      // Second insert with same (file_id, entity_id, scope) should fail
      expect(() => insertStmt.run(file.file_id, entity.entity_id)).toThrow();
    });
  });

  // KgStore CRUD

  describe("KgStore CRUD", () => {
    let db: Database.Database;
    let store: KgStore;

    beforeEach(() => {
      db = initDatabase(":memory:");
      store = new KgStore(db);
    });

    afterEach(() => {
      store.close();
    });

    // ---- Files ----

    describe("Files", () => {
      test("upsertFile inserts a new file", () => {
        const row = store.upsertFile(makeFileRow());
        expect(row.file_id).toBeDefined();
        expect(typeof row.file_id).toBe("number");
        expect(row.path).toBe("src/A.ts");
        expect(row.layer).toBe("domain");
      });

      test("upsertFile updates existing file", () => {
        const first = store.upsertFile(makeFileRow({ mtime_ms: 1000 }));
        const second = store.upsertFile(makeFileRow({ mtime_ms: 2000 }));
        // Same file_id, updated mtime
        expect(second.file_id).toBe(first.file_id);
        expect(second.mtime_ms).toBe(2000);
      });

      test("getFile returns file by path", () => {
        store.upsertFile(makeFileRow());
        const found = store.getFile("src/A.ts");
        expect(found).toBeDefined();
        expect(found!.path).toBe("src/A.ts");
      });

      test("getFile returns undefined for missing path", () => {
        const found = store.getFile("does/not/exist.ts");
        expect(found).toBeUndefined();
      });

      test("deleteFile removes file and cascades", () => {
        const file = store.upsertFile(makeFileRow());
        store.insertEntity(makeEntityRow(file.file_id!));
        store.deleteFile("src/A.ts");

        expect(store.getFile("src/A.ts")).toBeUndefined();
        // Entities should also be gone (CASCADE)
        const entities = store.getEntitiesByFile(file.file_id!);
        expect(entities).toHaveLength(0);
      });
    });

    // ---- Entities ----

    describe("Entities", () => {
      let file: FileRow;

      beforeEach(() => {
        file = store.upsertFile(makeFileRow());
      });

      test("insertEntity creates entity linked to file", () => {
        const entity = store.insertEntity(makeEntityRow(file.file_id!));
        expect(entity.entity_id).toBeDefined();
        expect(entity.file_id).toBe(file.file_id);
        expect(entity.name).toBe("myFunc");
      });

      test("getEntitiesByFile returns all entities for a file", () => {
        store.insertEntity(
          makeEntityRow(file.file_id!, { name: "fn1", qualified_name: "src/A.ts::fn1" }),
        );
        store.insertEntity(
          makeEntityRow(file.file_id!, { name: "fn2", qualified_name: "src/A.ts::fn2" }),
        );
        const entities = store.getEntitiesByFile(file.file_id!);
        expect(entities).toHaveLength(2);
      });

      test("findExportedByName finds exported entities", () => {
        store.insertEntity(
          makeEntityRow(file.file_id!, {
            is_exported: true,
            name: "pubFn",
            qualified_name: "src/A.ts::pubFn",
          }),
        );
        store.insertEntity(
          makeEntityRow(file.file_id!, {
            is_exported: false,
            name: "privFn",
            qualified_name: "src/A.ts::privFn",
          }),
        );
        const results = store.findExportedByName("pubFn");
        expect(results).toHaveLength(1);
        expect(results[0]?.name).toBe("pubFn");
        expect(results[0]?.is_exported).toBe(true);
        // Non-exported entity not returned
        expect(store.findExportedByName("privFn")).toHaveLength(0);
      });

      test("deleteEntitiesByFile removes entities", () => {
        store.insertEntity(makeEntityRow(file.file_id!));
        store.deleteEntitiesByFile(file.file_id!);
        expect(store.getEntitiesByFile(file.file_id!)).toHaveLength(0);
      });

      test("entity cascade on file delete", () => {
        store.insertEntity(makeEntityRow(file.file_id!));
        store.deleteFile(file.path);
        expect(store.getEntitiesByFile(file.file_id!)).toHaveLength(0);
      });
    });

    // ---- Edges ----

    describe("Edges", () => {
      let fileA: FileRow;
      let fileB: FileRow;
      let entityA: EntityRow;
      let entityB: EntityRow;

      beforeEach(() => {
        fileA = store.upsertFile(makeFileRow({ path: "src/A.ts" }));
        fileB = store.upsertFile(makeFileRow({ path: "src/B.ts" }));
        entityA = store.insertEntity(
          makeEntityRow(fileA.file_id!, { name: "funcA", qualified_name: "src/A.ts::funcA" }),
        );
        entityB = store.insertEntity(
          makeEntityRow(fileB.file_id!, { name: "funcB", qualified_name: "src/B.ts::funcB" }),
        );
      });

      test("insertEdge creates edge between entities", () => {
        const edge = store.insertEdge({
          confidence: 0.9,
          edge_type: "calls",
          metadata: null,
          source_entity_id: entityA.entity_id!,
          target_entity_id: entityB.entity_id!,
        });
        expect(edge.edge_id).toBeDefined();
        expect(edge.edge_type).toBe("calls");
        expect(edge.confidence).toBe(0.9);
      });

      test("getEdgesFrom returns outgoing edges", () => {
        store.insertEdge({
          confidence: 1.0,
          edge_type: "calls",
          metadata: null,
          source_entity_id: entityA.entity_id!,
          target_entity_id: entityB.entity_id!,
        });
        const edges = store.getEdgesFrom(entityA.entity_id!);
        expect(edges).toHaveLength(1);
        expect(edges[0]?.target_entity_id).toBe(entityB.entity_id);
      });

      test("getEdgesTo returns incoming edges", () => {
        store.insertEdge({
          confidence: 1.0,
          edge_type: "calls",
          metadata: null,
          source_entity_id: entityA.entity_id!,
          target_entity_id: entityB.entity_id!,
        });
        const edges = store.getEdgesTo(entityB.entity_id!);
        expect(edges).toHaveLength(1);
        expect(edges[0]?.source_entity_id).toBe(entityA.entity_id);
      });

      test("edge cascade on entity delete", () => {
        store.insertEdge({
          confidence: 1.0,
          edge_type: "calls",
          metadata: null,
          source_entity_id: entityA.entity_id!,
          target_entity_id: entityB.entity_id!,
        });
        // Delete source entity; edge should cascade away
        store.deleteEntitiesByFile(fileA.file_id!);
        expect(store.getEdgesFrom(entityA.entity_id!)).toHaveLength(0);
        expect(store.getEdgesTo(entityB.entity_id!)).toHaveLength(0);
      });
    });

    // ---- File Edges ----

    describe("File Edges", () => {
      let fileA: FileRow;
      let fileB: FileRow;

      beforeEach(() => {
        fileA = store.upsertFile(makeFileRow({ path: "src/A.ts" }));
        fileB = store.upsertFile(makeFileRow({ path: "src/B.ts" }));
      });

      test("insertFileEdge creates file-level edge", () => {
        const edge = store.insertFileEdge({
          confidence: 1.0,
          edge_type: "imports",
          evidence: "import { x } from '@features/knowledge-graph/__tests__/B'",
          relation: "imports",
          source_file_id: fileA.file_id!,
          target_file_id: fileB.file_id!,
        });
        expect(edge.file_edge_id).toBeDefined();
        expect(edge.edge_type).toBe("imports");
      });

      test("getFileEdgesFrom returns outgoing file edges", () => {
        store.insertFileEdge({
          confidence: 1.0,
          edge_type: "imports",
          evidence: null,
          relation: null,
          source_file_id: fileA.file_id!,
          target_file_id: fileB.file_id!,
        });
        const edges = store.getFileEdgesFrom(fileA.file_id!);
        expect(edges).toHaveLength(1);
        expect(edges[0]?.target_file_id).toBe(fileB.file_id);
      });

      test("file edge cascade on file delete", () => {
        store.insertFileEdge({
          confidence: 1.0,
          edge_type: "imports",
          evidence: null,
          relation: null,
          source_file_id: fileA.file_id!,
          target_file_id: fileB.file_id!,
        });
        store.deleteFile(fileA.path);
        expect(store.getFileEdgesFrom(fileA.file_id!)).toHaveLength(0);
      });
    });
  });
});
