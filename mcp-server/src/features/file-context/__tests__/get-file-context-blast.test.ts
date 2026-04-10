import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase } from "@graph/kg-schema.ts";
import { KgStore } from "@graph/kg-store.ts";
import type { FileRow } from "@graph/kg-types.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getFileContext } from "../tools/get-file-context.ts";

/** Insert a file row and return its file_id. */
function insertFile(store: KgStore, path: string, layer: string): number {
  const fileRow: Omit<FileRow, "file_id"> = {
    content_hash: `hash-${path}`,
    language: "typescript",
    last_indexed_at: Date.now(),
    layer,
    mtime_ms: Date.now(),
    path,
  };
  store.upsertFile(fileRow);
  return store.getFile(path)!.file_id!;
}

/** Insert a file_edge between two already-inserted file_ids. */
function insertEdge(store: KgStore, sourceId: number, targetId: number): void {
  store.insertFileEdge({
    confidence: 1.0,
    edge_type: "imports",
    evidence: null,
    relation: null,
    source_file_id: sourceId,
    target_file_id: targetId,
  });
}

describe("getFileContext — shape, metrics, blast radius", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-file-ctx-blast-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
    await mkdir(join(tmpDir, "src", "api"), { recursive: true });
    await mkdir(join(tmpDir, "src", "services"), { recursive: true });
    await mkdir(join(tmpDir, "src", "utils"), { recursive: true });

    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({
        layers: {
          api: ["src/api/**"],
          domain: ["src/services/**"],
          shared: ["src/utils/**"],
        },
      }),
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  describe("shape field", () => {
    it("returns Internal shape when no graph metrics available", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.shape).toBeDefined();
      expect(result.shape.label).toBe("Internal");
      expect(result.shape.description).toBeTruthy();
    });

    it("returns Leaf shape for in_degree=0 node (file in DB with no importers)", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );
      await writeFile(join(tmpDir, "src", "utils", "helper.ts"), `export function helper() {}`);

      const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
      const db = initDatabase(dbPath);
      const store = new KgStore(db);
      const handlerId = insertFile(store, "src/api/handler.ts", "api");
      const helperId = insertFile(store, "src/utils/helper.ts", "shared");
      // handler imports helper → handler in_degree=0, helper in_degree=1
      insertEdge(store, handlerId, helperId);
      db.close();

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.shape.label).toBe("Leaf");
      expect(result.shape.description).toBe("Nothing depends on this. Safe to change.");
    });

    it("returns Sink shape for high in_degree, low out_degree node", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );
      await writeFile(join(tmpDir, "src", "utils", "helper.ts"), `export function helper() {}`);
      await mkdir(join(tmpDir, "src", "services"), { recursive: true });
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          writeFile(join(tmpDir, "src", "services", `svc${i}.ts`), `export function svc() {}`),
        ),
      );

      const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
      const db = initDatabase(dbPath);
      const store = new KgStore(db);
      const handlerId = insertFile(store, "src/api/handler.ts", "api");
      const helperId = insertFile(store, "src/utils/helper.ts", "shared");
      // 10 services import handler (in_degree=10)
      for (let i = 0; i < 10; i++) {
        const svcId = insertFile(store, `src/services/svc${i}.ts`, "services");
        insertEdge(store, svcId, handlerId);
      }
      // handler imports helper (out_degree=1)
      insertEdge(store, handlerId, helperId);
      db.close();

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.shape.label).toBe("Sink");
    });

    it("returns High fan-out hub shape for low in_degree, high out_degree node", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );
      await writeFile(join(tmpDir, "src", "services", "caller.ts"), `export function caller() {}`);
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          writeFile(join(tmpDir, "src", "utils", `dep${i}.ts`), `export function dep() {}`),
        ),
      );

      const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
      const db = initDatabase(dbPath);
      const store = new KgStore(db);
      const handlerId = insertFile(store, "src/api/handler.ts", "api");
      const callerId = insertFile(store, "src/services/caller.ts", "services");
      // 1 caller imports handler (in_degree=1)
      insertEdge(store, callerId, handlerId);
      // handler imports 10 deps (out_degree=10)
      for (let i = 0; i < 10; i++) {
        const depId = insertFile(store, `src/utils/dep${i}.ts`, "shared");
        insertEdge(store, handlerId, depId);
      }
      db.close();

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.shape.label).toBe("High fan-out hub");
    });

    it("prefixes shape label with 'Cycle member — ' when in cycle (from DB)", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );
      await writeFile(join(tmpDir, "src", "services", "svc.ts"), `export function svc() {}`);

      const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
      const db = initDatabase(dbPath);
      const store = new KgStore(db);
      const handlerId = insertFile(store, "src/api/handler.ts", "api");
      const svcId = insertFile(store, "src/services/svc.ts", "services");
      // Cycle: handler → svc → handler
      insertEdge(store, handlerId, svcId);
      insertEdge(store, svcId, handlerId);
      db.close();

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.shape.label).toMatch(/^Cycle member — /);
    });
  });

  describe("project_max_impact field", () => {
    it("returns 0 when no DB exists", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.project_max_impact).toBe(0);
    });

    it("computes project_max_impact from DB file_edges degree data", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );
      await writeFile(join(tmpDir, "src", "utils", "helper.ts"), `export function helper() {}`);

      const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
      const db = initDatabase(dbPath);
      const store = new KgStore(db);
      const handlerId = insertFile(store, "src/api/handler.ts", "api");
      const helperId = insertFile(store, "src/utils/helper.ts", "shared");
      // helper has in_degree=1 (handler imports it) → non-zero impact
      insertEdge(store, handlerId, helperId);
      db.close();

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      // helper has in_degree=1, so max_impact should be > 0
      expect(result.project_max_impact).toBeGreaterThan(0);
    });
  });

  describe("graph_metrics field", () => {
    it("is undefined when KG DB does not exist", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.graph_metrics).toBeUndefined();
    });

    it("is undefined when file is not in the KG DB", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );

      // Create an empty DB (no files registered)
      const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
      const db = initDatabase(dbPath);
      db.close();

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.graph_metrics).toBeUndefined();
    });

    it("returns correct in_degree and out_degree from DB", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );
      await writeFile(join(tmpDir, "src", "utils", "helper.ts"), `export function helper() {}`);

      const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
      const db = initDatabase(dbPath);
      const store = new KgStore(db);
      const handlerId = insertFile(store, "src/api/handler.ts", "api");
      const helperId = insertFile(store, "src/utils/helper.ts", "shared");
      insertEdge(store, handlerId, helperId); // handler imports helper
      db.close();

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.graph_metrics).toBeDefined();
      expect(result.graph_metrics!.in_degree).toBe(0);
      expect(result.graph_metrics!.out_degree).toBe(1);
    });

    it("is_hub is true for a file in the top-10 by total degree", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );

      const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
      const db = initDatabase(dbPath);
      const store = new KgStore(db);
      const handlerId = insertFile(store, "src/api/handler.ts", "api");

      // Give handler high in_degree (9 importers) → total degree ≥ 9 → top-10
      await mkdir(join(tmpDir, "src", "services"), { recursive: true });
      await Promise.all(
        Array.from({ length: 9 }, (_, i) =>
          writeFile(join(tmpDir, "src", "services", `svc${i}.ts`), `export function svc() {}`),
        ),
      );
      for (let i = 0; i < 9; i++) {
        const svcId = insertFile(store, `src/services/svc${i}.ts`, "services");
        insertEdge(store, svcId, handlerId);
      }
      db.close();

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.graph_metrics).toBeDefined();
      expect(result.graph_metrics!.is_hub).toBe(true);
    });
  });

  describe("blast_radius field — UnifiedBlastRadiusReport shape", () => {
    it("returns UnifiedBlastRadiusReport shape when KG database is available", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );

      // Create a KG database with the seed file registered
      const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
      const db = initDatabase(dbPath);
      const store = new KgStore(db);

      const fileRow: Omit<FileRow, "file_id"> = {
        content_hash: "abc",
        language: "typescript",
        last_indexed_at: Date.now(),
        layer: "api",
        mtime_ms: Date.now(),
        path: "src/api/handler.ts",
      };
      store.upsertFile(fileRow);
      db.close();

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      // blast_radius should be present and have UnifiedBlastRadiusReport shape
      expect(result.blast_radius).toBeDefined();
      const br = result.blast_radius!;
      expect(br.seed_file).toBe("src/api/handler.ts");
      expect(br.summary).toBeDefined();
      expect(typeof br.summary.severity).toBe("string");
      expect(Array.isArray(br.affected)).toBe(true);
      expect(typeof br.by_depth).toBe("object");
      // With no dependents, severity should be 'contained'
      expect(br.summary.severity).toBe("contained");
    });

    it("blast_radius is undefined when KG database does not exist", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );

      // No KG database created
      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.blast_radius).toBeUndefined();
    });
  });

  describe("summary field — DB-first reads", () => {
    it("returns summary from DB when present (DB-first path)", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );

      const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
      const db = initDatabase(dbPath);
      const store = new KgStore(db);
      const fileRow: Omit<FileRow, "file_id"> = {
        content_hash: "abc123",
        language: "typescript",
        last_indexed_at: Date.now(),
        layer: "api",
        mtime_ms: Date.now(),
        path: "src/api/handler.ts",
      };
      store.upsertFile(fileRow);
      const insertedRow = store.getFile("src/api/handler.ts")!;
      store.upsertSummary({
        content_hash: "abc123",
        entity_id: null,
        file_id: insertedRow.file_id!,
        model: null,
        scope: "file",
        summary: "DB-sourced summary",
        updated_at: new Date().toISOString(),
      });
      db.close();

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.summary).toBe("DB-sourced summary");
    });

    it("returns null when neither DB nor JSON has a summary (DB is sole source)", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );

      // KG DB exists but no summary for the file
      const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
      const db = initDatabase(dbPath);
      const store = new KgStore(db);
      const fileRow: Omit<FileRow, "file_id"> = {
        content_hash: "abc123",
        language: "typescript",
        last_indexed_at: Date.now(),
        layer: "api",
        mtime_ms: Date.now(),
        path: "src/api/handler.ts",
      };
      store.upsertFile(fileRow);
      db.close();

      // summaries.json also written but should be ignored
      await writeFile(
        join(tmpDir, ".canon", "summaries.json"),
        JSON.stringify({
          "src/api/handler.ts": {
            summary: "JSON version (ignored)",
            updated_at: "2025-01-01T00:00:00Z",
          },
        }),
      );

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.summary).toBeNull();
    });
  });
});
