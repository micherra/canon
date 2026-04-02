import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { getFileContext } from "../tools/get-file-context.ts";
import { initDatabase } from "../graph/kg-schema.ts";
import { KgStore } from "../graph/kg-store.ts";
import type { FileRow } from "../graph/kg-types.ts";
import { DriftStore } from "../drift/store.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert a file row and return its file_id. */
function insertFile(store: KgStore, path: string, layer: string): number {
  const fileRow: Omit<FileRow, "file_id"> = {
    path,
    mtime_ms: Date.now(),
    content_hash: `hash-${path}`,
    language: "typescript",
    layer,
    last_indexed_at: Date.now(),
  };
  store.upsertFile(fileRow);
  return store.getFile(path)!.file_id!;
}

/** Insert a file_edge between two already-inserted file_ids. */
function insertEdge(store: KgStore, sourceId: number, targetId: number): void {
  store.insertFileEdge({
    source_file_id: sourceId,
    target_file_id: targetId,
    edge_type: "imports",
    confidence: 1.0,
    evidence: null,
    relation: null,
  });
}

describe("getFileContext", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-file-ctx-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
    await mkdir(join(tmpDir, "src", "api"), { recursive: true });
    await mkdir(join(tmpDir, "src", "services"), { recursive: true });
    await mkdir(join(tmpDir, "src", "utils"), { recursive: true });

    // Write config with layers using rooted globs so files under src/ are scanned.
    // Use the canonical layer names (api, domain, shared) so layer inference tests pass.
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
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns file content, layer, and exports", async () => {
    await writeFile(
      join(tmpDir, "src", "api", "handler.ts"),
      `export function handleRequest() {}\nexport const MAX_RETRIES = 3;`,
    );

    const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
    if (!result.ok) throw new Error(result.message);

    expect(result.file_path).toBe("src/api/handler.ts");
    expect(result.layer).toBe("api");
    expect(result.content).toContain("handleRequest");
    expect(result.exports).toContain("handleRequest");
    expect(result.exports).toContain("MAX_RETRIES");
  });

  it("resolves imports to project-relative paths", async () => {
    await writeFile(
      join(tmpDir, "src", "api", "handler.ts"),
      `import { helper } from '../utils/helper';`,
    );
    await writeFile(
      join(tmpDir, "src", "utils", "helper.ts"),
      `export function helper() {}`,
    );

    const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
    if (!result.ok) throw new Error(result.message);

    expect(result.imports).toContain("src/utils/helper.ts");
  });

  it("returns INVALID_INPUT for path traversal outside project directory", async () => {
    const result = await getFileContext({ file_path: "../../etc/passwd" }, tmpDir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("traverses");
    }
  });

  it("returns INVALID_INPUT for missing file", async () => {
    const result = await getFileContext({ file_path: "src/nonexistent.ts" }, tmpDir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("src/nonexistent.ts");
    }
  });

  it("returns ok: true for existing file", async () => {
    await writeFile(
      join(tmpDir, "src", "api", "handler.ts"),
      `export function handleRequest() {}`,
    );

    const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain("handleRequest");
  });

  it("truncates content at 200 lines", async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `const line${i} = ${i};`);
    await writeFile(join(tmpDir, "src", "utils", "big.ts"), lines.join("\n"));

    const result = await getFileContext({ file_path: "src/utils/big.ts" }, tmpDir);
    if (!result.ok) throw new Error(result.message);

    expect(result.content).toContain("... (truncated)");
    expect(result.content.split("\n").length).toBeLessThanOrEqual(202);
  });

  // ── summary field ──────────────────────────────────────────────────────────

  describe("summary field", () => {
    it("returns null when no DB exists", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.summary).toBeNull();
    });

    it("returns summary from DB when present", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );

      const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
      const db = initDatabase(dbPath);
      const store = new KgStore(db);
      const fileId = insertFile(store, "src/api/handler.ts", "api");
      store.upsertSummary({
        file_id: fileId,
        entity_id: null,
        scope: "file",
        summary: "DB-sourced summary",
        model: null,
        content_hash: "abc123",
        updated_at: new Date().toISOString(),
      });
      db.close();

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.summary).toBe("DB-sourced summary");
    });

    it("returns null when DB exists but file has no summary entry", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );

      const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
      const db = initDatabase(dbPath);
      const store = new KgStore(db);
      insertFile(store, "src/api/handler.ts", "api");
      // no summary written
      db.close();

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.summary).toBeNull();
    });

    it("ignores summaries.json even when it exists (DB is the sole source)", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );
      // Write a JSON file — it should be ignored
      await writeFile(
        join(tmpDir, ".canon", "summaries.json"),
        JSON.stringify({
          "src/api/handler.ts": { summary: "JSON summary (ignored)", updated_at: "2025-01-01T00:00:00Z" },
        }),
      );

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.summary).toBeNull();
    });
  });

  // ── violations field ───────────────────────────────────────────────────────

  describe("violations field", () => {
    it("returns empty array when no reviews exist", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.violations).toEqual([]);
    });

    it("returns violations from the most recent review that includes the file", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );
      // Write a review with per-file violations
      const driftStore = new DriftStore(tmpDir);
      await driftStore.appendReview({
        review_id: "r1",
        timestamp: "2025-01-10T00:00:00Z",
        files: ["src/api/handler.ts"],
        violations: [
          { principle_id: "thin-handlers", severity: "strong-opinion", file_path: "src/api/handler.ts", message: "Handler is too thick" },
          { principle_id: "secrets-never-in-code", severity: "rule", file_path: "src/api/handler.ts", message: "Secret found" },
        ],
        honored: [],
        verdict: "BLOCKING",
        score: { rules: { passed: 0, total: 1 }, opinions: { passed: 0, total: 1 }, conventions: { passed: 0, total: 0 } },
      });

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.violations).toHaveLength(2);
      expect(result.violations[0]).toEqual({ principle_id: "thin-handlers", severity: "strong-opinion", message: "Handler is too thick" });
      expect(result.violations[1]).toEqual({ principle_id: "secrets-never-in-code", severity: "rule", message: "Secret found" });
    });

    it("picks the most recent review when multiple reviews include the file", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );
      const driftStore = new DriftStore(tmpDir);
      await driftStore.appendReview({
        review_id: "r1",
        timestamp: "2025-01-05T00:00:00Z",
        files: ["src/api/handler.ts"],
        violations: [
          { principle_id: "old-violation", severity: "convention", file_path: "src/api/handler.ts" },
        ],
        honored: [],
        verdict: "WARNING",
        score: { rules: { passed: 1, total: 1 }, opinions: { passed: 1, total: 1 }, conventions: { passed: 0, total: 1 } },
      });
      await driftStore.appendReview({
        review_id: "r2",
        timestamp: "2025-01-15T00:00:00Z",
        files: ["src/api/handler.ts"],
        violations: [
          { principle_id: "new-violation", severity: "rule", file_path: "src/api/handler.ts", message: "New issue" },
        ],
        honored: [],
        verdict: "BLOCKING",
        score: { rules: { passed: 0, total: 1 }, opinions: { passed: 1, total: 1 }, conventions: { passed: 1, total: 1 } },
      });

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].principle_id).toBe("new-violation");
    });

    it("keeps violation_count for backwards compatibility", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );
      const driftStore = new DriftStore(tmpDir);
      await driftStore.appendReview({
        review_id: "r1",
        timestamp: "2025-01-10T00:00:00Z",
        files: ["src/api/handler.ts"],
        violations: [
          { principle_id: "thin-handlers", severity: "strong-opinion", file_path: "src/api/handler.ts" },
        ],
        honored: [],
        verdict: "WARNING",
        score: { rules: { passed: 1, total: 1 }, opinions: { passed: 0, total: 1 }, conventions: { passed: 0, total: 0 } },
      });

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.violation_count).toBeGreaterThan(0);
      expect(result.violations).toHaveLength(1);
    });
  });

  // ── imports_by_layer field ─────────────────────────────────────────────────

  describe("imports_by_layer field", () => {
    it("returns empty object when no imports", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.imports_by_layer).toEqual({});
    });

    it("groups imports by their inferred layer", async () => {
      // Override config with layer mappings using rooted globs so src/ is scanned
      await writeFile(
        join(tmpDir, ".canon", "config.json"),
        JSON.stringify({ layers: { utils: ["src/utils/**"], domain: ["src/domain/**"] } }),
      );
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `import { helper } from '../utils/helper';\nimport { model } from '../domain/model';`,
      );
      await writeFile(join(tmpDir, "src", "utils", "helper.ts"), `export function helper() {}`);
      await mkdir(join(tmpDir, "src", "domain"), { recursive: true });
      await writeFile(join(tmpDir, "src", "domain", "model.ts"), `export function model() {}`);

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.imports_by_layer).toBeDefined();
      const layers = Object.keys(result.imports_by_layer);
      expect(layers).toContain("utils");
      expect(layers).toContain("domain");
      expect(result.imports_by_layer["utils"]).toContain("src/utils/helper.ts");
      expect(result.imports_by_layer["domain"]).toContain("src/domain/model.ts");
    });

    it("keeps the flat imports array alongside imports_by_layer", async () => {
      await writeFile(
        join(tmpDir, ".canon", "config.json"),
        JSON.stringify({ layers: { utils: ["src/utils/**"] } }),
      );
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `import { helper } from '../utils/helper';`,
      );
      await writeFile(join(tmpDir, "src", "utils", "helper.ts"), `export function helper() {}`);

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.imports).toContain("src/utils/helper.ts");
      expect(result.imports_by_layer["utils"]).toContain("src/utils/helper.ts");
    });
  });

  // ── layer_stack field ──────────────────────────────────────────────────────

  describe("layer_stack field", () => {
    it("returns default layer names when no layers config exists", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      // Default layer mappings are always provided (api, ui, domain, data, infra, shared)
      expect(result.layer_stack.length).toBeGreaterThan(0);
      expect(result.layer_stack).toContain("api");
      // Should be sorted alphabetically
      expect(result.layer_stack).toEqual([...result.layer_stack].sort());
    });

    it("returns sorted unique layer names from config", async () => {
      await writeFile(
        join(tmpDir, ".canon", "config.json"),
        JSON.stringify({
          layers: {
            services: ["src/services/**"],
            api: ["src/api/**"],
            utils: ["src/utils/**"],
          },
        }),
      );
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.layer_stack).toEqual(["api", "services", "utils"]);
    });
  });

  // ── role field ─────────────────────────────────────────────────────────────

  describe("role field", () => {
    it("returns 'internal' when no graph metrics available", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.role).toBe("internal");
    });
  });

  // ── imported_by_layer field ────────────────────────────────────────────────

  describe("imported_by_layer field", () => {
    it("returns empty object when nothing imports this file", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.imported_by_layer).toEqual({});
    });

    it("groups imported_by files by their inferred layer (from DB file_edges)", async () => {
      await writeFile(
        join(tmpDir, ".canon", "config.json"),
        JSON.stringify({ layers: { api: ["src/api/**"], services: ["src/services/**"], utils: ["src/utils/**"] } }),
      );
      await writeFile(join(tmpDir, "src", "utils", "helper.ts"), `export function helper() {}`);
      await writeFile(join(tmpDir, "src", "api", "handler.ts"), `import { helper } from '../utils/helper';`);
      await writeFile(join(tmpDir, "src", "services", "svc.ts"), `import { helper } from '../utils/helper';`);

      // Set up the DB with file_edges so imported_by is served from DB
      const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
      const db = initDatabase(dbPath);
      const store = new KgStore(db);
      const helperId = insertFile(store, "src/utils/helper.ts", "shared");
      const handlerId = insertFile(store, "src/api/handler.ts", "api");
      const svcId = insertFile(store, "src/services/svc.ts", "services");
      insertEdge(store, handlerId, helperId); // handler imports helper
      insertEdge(store, svcId, helperId);     // svc imports helper
      db.close();

      const result = await getFileContext({ file_path: "src/utils/helper.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.imported_by).toContain("src/api/handler.ts");
      expect(result.imported_by).toContain("src/services/svc.ts");
      expect(result.imported_by_layer).toBeDefined();
      const layers = Object.keys(result.imported_by_layer);
      expect(layers).toContain("api");
      expect(layers).toContain("services");
      expect(result.imported_by_layer["api"]).toContain("src/api/handler.ts");
      expect(result.imported_by_layer["services"]).toContain("src/services/svc.ts");
    });

    it("keeps the flat imported_by array alongside imported_by_layer", async () => {
      await writeFile(
        join(tmpDir, ".canon", "config.json"),
        JSON.stringify({ layers: { api: ["src/api/**"], utils: ["src/utils/**"] } }),
      );
      await writeFile(join(tmpDir, "src", "utils", "helper.ts"), `export function helper() {}`);
      await writeFile(join(tmpDir, "src", "api", "handler.ts"), `import { helper } from '../utils/helper';`);

      // Set up DB file_edges
      const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
      const db = initDatabase(dbPath);
      const store = new KgStore(db);
      const helperId = insertFile(store, "src/utils/helper.ts", "shared");
      const handlerId = insertFile(store, "src/api/handler.ts", "api");
      insertEdge(store, handlerId, helperId);
      db.close();

      const result = await getFileContext({ file_path: "src/utils/helper.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.imported_by).toContain("src/api/handler.ts");
      expect(result.imported_by_layer["api"]).toContain("src/api/handler.ts");
    });

    it("falls back to file scanning when DB is absent (no file_edges)", async () => {
      await writeFile(
        join(tmpDir, "src", "utils", "helper.ts"),
        `export function helper() {}`,
      );
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `import { helper } from '../utils/helper';`,
      );
      await writeFile(
        join(tmpDir, "src", "services", "svc.ts"),
        `import { helper } from '../utils/helper';`,
      );

      // No DB — should fall back to scan
      const result = await getFileContext({ file_path: "src/utils/helper.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.imported_by).toHaveLength(2);
      expect(result.imported_by).toContain("src/api/handler.ts");
      expect(result.imported_by).toContain("src/services/svc.ts");
    });
  });

  // ── shape field ────────────────────────────────────────────────────────────

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
      await writeFile(join(tmpDir, "src", "api", "handler.ts"), `export function handleRequest() {}`);
      await writeFile(join(tmpDir, "src", "utils", "helper.ts"), `export function helper() {}`);
      for (let i = 0; i < 10; i++) {
        await mkdir(join(tmpDir, "src", "services"), { recursive: true });
        await writeFile(join(tmpDir, "src", "services", `svc${i}.ts`), `export function svc() {}`);
      }

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
      await writeFile(join(tmpDir, "src", "api", "handler.ts"), `export function handleRequest() {}`);
      await writeFile(join(tmpDir, "src", "services", "caller.ts"), `export function caller() {}`);
      for (let i = 0; i < 10; i++) {
        await writeFile(join(tmpDir, "src", "utils", `dep${i}.ts`), `export function dep() {}`);
      }

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
      await writeFile(join(tmpDir, "src", "api", "handler.ts"), `export function handleRequest() {}`);
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

  // ── project_max_impact field ───────────────────────────────────────────────

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
      await writeFile(join(tmpDir, "src", "api", "handler.ts"), `export function handleRequest() {}`);
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

  // ── graph_metrics field — KgQuery-based ───────────────────────────────────

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
      await writeFile(join(tmpDir, "src", "api", "handler.ts"), `export function handleRequest() {}`);
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
      await writeFile(join(tmpDir, "src", "api", "handler.ts"), `export function handleRequest() {}`);

      const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
      const db = initDatabase(dbPath);
      const store = new KgStore(db);
      const handlerId = insertFile(store, "src/api/handler.ts", "api");

      // Give handler high in_degree (9 importers) → total degree ≥ 9 → top-10
      for (let i = 0; i < 9; i++) {
        await mkdir(join(tmpDir, "src", "services"), { recursive: true });
        await writeFile(join(tmpDir, "src", "services", `svc${i}.ts`), `export function svc() {}`);
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

  // ── blast_radius field ─────────────────────────────────────────────────────

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
        path: "src/api/handler.ts",
        mtime_ms: Date.now(),
        content_hash: "abc",
        language: "typescript",
        layer: "api",
        last_indexed_at: Date.now(),
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

  // ── summary field — DB-first reads (legacy compat tests preserved) ─────────

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
        path: "src/api/handler.ts",
        mtime_ms: Date.now(),
        content_hash: "abc123",
        language: "typescript",
        layer: "api",
        last_indexed_at: Date.now(),
      };
      store.upsertFile(fileRow);
      const insertedRow = store.getFile("src/api/handler.ts")!;
      store.upsertSummary({
        file_id: insertedRow.file_id!,
        entity_id: null,
        scope: "file",
        summary: "DB-sourced summary",
        model: null,
        content_hash: "abc123",
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
        path: "src/api/handler.ts",
        mtime_ms: Date.now(),
        content_hash: "abc123",
        language: "typescript",
        layer: "api",
        last_indexed_at: Date.now(),
      };
      store.upsertFile(fileRow);
      db.close();

      // summaries.json also written but should be ignored
      await writeFile(
        join(tmpDir, ".canon", "summaries.json"),
        JSON.stringify({
          "src/api/handler.ts": { summary: "JSON version (ignored)", updated_at: "2025-01-01T00:00:00Z" },
        }),
      );

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.summary).toBeNull();
    });
  });
});
