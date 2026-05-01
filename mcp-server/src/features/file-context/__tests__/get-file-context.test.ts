import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase } from "@graph/kg-schema.ts";
import { KgStore } from "@graph/kg-store.ts";
import type { FileRow } from "@graph/kg-types.ts";
import { DriftStore } from "@platform/storage/drift/store.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getFileContext, getFileContextBatch } from "../tools/get-file-context.ts";

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
    await rm(tmpDir, { force: true, recursive: true });
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
    await writeFile(join(tmpDir, "src", "utils", "helper.ts"), `export function helper() {}`);

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
    await writeFile(join(tmpDir, "src", "api", "handler.ts"), `export function handleRequest() {}`);

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
        content_hash: "abc123",
        entity_id: null,
        file_id: fileId,
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
          "src/api/handler.ts": {
            summary: "JSON summary (ignored)",
            updated_at: "2025-01-01T00:00:00Z",
          },
        }),
      );

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.summary).toBeNull();
    });
  });

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
        files: ["src/api/handler.ts"],
        honored: [],
        review_id: "r1",
        score: {
          conventions: { passed: 0, total: 0 },
          opinions: { passed: 0, total: 1 },
          rules: { passed: 0, total: 1 },
        },
        timestamp: "2025-01-10T00:00:00Z",
        verdict: "BLOCKING",
        violations: [
          {
            file_path: "src/api/handler.ts",
            message: "Handler is too thick",
            principle_id: "thin-handlers",
            severity: "strong-opinion",
          },
          {
            file_path: "src/api/handler.ts",
            message: "Secret found",
            principle_id: "secrets-never-in-code",
            severity: "rule",
          },
        ],
      });

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.violations).toHaveLength(2);
      expect(result.violations[0]).toEqual({
        message: "Handler is too thick",
        principle_id: "thin-handlers",
        severity: "strong-opinion",
      });
      expect(result.violations[1]).toEqual({
        message: "Secret found",
        principle_id: "secrets-never-in-code",
        severity: "rule",
      });
    });

    it("picks the most recent review when multiple reviews include the file", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );
      const driftStore = new DriftStore(tmpDir);
      await driftStore.appendReview({
        files: ["src/api/handler.ts"],
        honored: [],
        review_id: "r1",
        score: {
          conventions: { passed: 0, total: 1 },
          opinions: { passed: 1, total: 1 },
          rules: { passed: 1, total: 1 },
        },
        timestamp: "2025-01-05T00:00:00Z",
        verdict: "WARNING",
        violations: [
          {
            file_path: "src/api/handler.ts",
            principle_id: "old-violation",
            severity: "convention",
          },
        ],
      });
      await driftStore.appendReview({
        files: ["src/api/handler.ts"],
        honored: [],
        review_id: "r2",
        score: {
          conventions: { passed: 1, total: 1 },
          opinions: { passed: 1, total: 1 },
          rules: { passed: 0, total: 1 },
        },
        timestamp: "2025-01-15T00:00:00Z",
        verdict: "BLOCKING",
        violations: [
          {
            file_path: "src/api/handler.ts",
            message: "New issue",
            principle_id: "new-violation",
            severity: "rule",
          },
        ],
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
        files: ["src/api/handler.ts"],
        honored: [],
        review_id: "r1",
        score: {
          conventions: { passed: 0, total: 0 },
          opinions: { passed: 0, total: 1 },
          rules: { passed: 1, total: 1 },
        },
        timestamp: "2025-01-10T00:00:00Z",
        verdict: "WARNING",
        violations: [
          {
            file_path: "src/api/handler.ts",
            principle_id: "thin-handlers",
            severity: "strong-opinion",
          },
        ],
      });

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.violation_count).toBeGreaterThan(0);
      expect(result.violations).toHaveLength(1);
    });
  });

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
        JSON.stringify({ layers: { domain: ["src/domain/**"], utils: ["src/utils/**"] } }),
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
      expect(result.imports_by_layer.utils).toContain("src/utils/helper.ts");
      expect(result.imports_by_layer.domain).toContain("src/domain/model.ts");
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
      expect(result.imports_by_layer.utils).toContain("src/utils/helper.ts");
    });
  });

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
            api: ["src/api/**"],
            services: ["src/services/**"],
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
        JSON.stringify({
          layers: { api: ["src/api/**"], services: ["src/services/**"], utils: ["src/utils/**"] },
        }),
      );
      await writeFile(join(tmpDir, "src", "utils", "helper.ts"), `export function helper() {}`);
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `import { helper } from '../utils/helper';`,
      );
      await writeFile(
        join(tmpDir, "src", "services", "svc.ts"),
        `import { helper } from '../utils/helper';`,
      );

      // Set up the DB with file_edges so imported_by is served from DB
      const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
      const db = initDatabase(dbPath);
      const store = new KgStore(db);
      const helperId = insertFile(store, "src/utils/helper.ts", "shared");
      const handlerId = insertFile(store, "src/api/handler.ts", "api");
      const svcId = insertFile(store, "src/services/svc.ts", "services");
      insertEdge(store, handlerId, helperId); // handler imports helper
      insertEdge(store, svcId, helperId); // svc imports helper
      db.close();

      const result = await getFileContext({ file_path: "src/utils/helper.ts" }, tmpDir);
      if (!result.ok) throw new Error(result.message);

      expect(result.imported_by).toContain("src/api/handler.ts");
      expect(result.imported_by).toContain("src/services/svc.ts");
      expect(result.imported_by_layer).toBeDefined();
      const layers = Object.keys(result.imported_by_layer);
      expect(layers).toContain("api");
      expect(layers).toContain("services");
      expect(result.imported_by_layer.api).toContain("src/api/handler.ts");
      expect(result.imported_by_layer.services).toContain("src/services/svc.ts");
    });

    it("keeps the flat imported_by array alongside imported_by_layer", async () => {
      await writeFile(
        join(tmpDir, ".canon", "config.json"),
        JSON.stringify({ layers: { api: ["src/api/**"], utils: ["src/utils/**"] } }),
      );
      await writeFile(join(tmpDir, "src", "utils", "helper.ts"), `export function helper() {}`);
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `import { helper } from '../utils/helper';`,
      );

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
      expect(result.imported_by_layer.api).toContain("src/api/handler.ts");
    });

    it("falls back to file scanning when DB is absent (no file_edges)", async () => {
      await writeFile(join(tmpDir, "src", "utils", "helper.ts"), `export function helper() {}`);
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
});

describe("getFileContextBatch", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-file-ctx-batch-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
    await mkdir(join(tmpDir, "src", "api"), { recursive: true });
    await mkdir(join(tmpDir, "src", "utils"), { recursive: true });

    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({
        layers: {
          api: ["src/api/**"],
          shared: ["src/utils/**"],
        },
      }),
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("returns array of results for multiple valid files", async () => {
    await writeFile(
      join(tmpDir, "src", "api", "handler.ts"),
      `export function handleRequest() {}`,
    );
    await writeFile(
      join(tmpDir, "src", "utils", "helper.ts"),
      `export function helper() {}`,
    );

    const result = await getFileContextBatch(
      { file_paths: ["src/api/handler.ts", "src/utils/helper.ts"] },
      tmpDir,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results).toHaveLength(2);
    expect(result.results[0].file_path).toBe("src/api/handler.ts");
    expect(result.results[0].layer).toBe("api");
    expect(result.results[1].file_path).toBe("src/utils/helper.ts");
    expect(result.results[1].layer).toBe("shared");
  });

  it("handles empty file_paths array and returns empty results", async () => {
    const result = await getFileContextBatch({ file_paths: [] }, tmpDir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results).toHaveLength(0);
    expect(result.results).toEqual([]);
  });

  it("fails closed when any file is invalid — returns error for the failing file", async () => {
    await writeFile(
      join(tmpDir, "src", "api", "handler.ts"),
      `export function handleRequest() {}`,
    );

    const result = await getFileContextBatch(
      { file_paths: ["src/api/handler.ts", "src/nonexistent.ts"] },
      tmpDir,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("INVALID_INPUT");
    expect(result.message).toContain("src/nonexistent.ts");
  });

  it("fails closed even when the invalid file is first in the list", async () => {
    await writeFile(
      join(tmpDir, "src", "utils", "helper.ts"),
      `export function helper() {}`,
    );

    const result = await getFileContextBatch(
      { file_paths: ["src/missing.ts", "src/utils/helper.ts"] },
      tmpDir,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("INVALID_INPUT");
    expect(result.message).toContain("src/missing.ts");
  });

  it("each result in the batch includes the full FileContextOutput fields", async () => {
    await writeFile(
      join(tmpDir, "src", "api", "handler.ts"),
      `export function handleRequest() {}\nexport const VERSION = "1";`,
    );

    const result = await getFileContextBatch(
      { file_paths: ["src/api/handler.ts"] },
      tmpDir,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ctx = result.results[0];
    expect(ctx.content).toContain("handleRequest");
    expect(ctx.exports).toContain("handleRequest");
    expect(ctx.exports).toContain("VERSION");
    expect(ctx.imports).toBeDefined();
    expect(ctx.imported_by).toBeDefined();
    expect(ctx.layer_stack).toBeDefined();
    expect(ctx.violations).toBeDefined();
  });
});
