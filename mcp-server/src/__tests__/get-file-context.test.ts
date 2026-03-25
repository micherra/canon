import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { getFileContext } from "../tools/get-file-context.ts";

describe("getFileContext", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-file-ctx-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
    await mkdir(join(tmpDir, "src", "api"), { recursive: true });
    await mkdir(join(tmpDir, "src", "services"), { recursive: true });
    await mkdir(join(tmpDir, "src", "utils"), { recursive: true });

    // Write config with source_dirs
    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({ source_dirs: ["src"] }),
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

    expect(result.imports).toContain("src/utils/helper.ts");
  });

  it("finds reverse dependencies (imported_by)", async () => {
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

    const result = await getFileContext({ file_path: "src/utils/helper.ts" }, tmpDir);

    expect(result.imported_by).toHaveLength(2);
    expect(result.imported_by).toContain("src/api/handler.ts");
    expect(result.imported_by).toContain("src/services/svc.ts");
  });

  it("returns empty for missing file", async () => {
    const result = await getFileContext({ file_path: "src/nonexistent.ts" }, tmpDir);

    expect(result.content).toBe("");
    expect(result.imports).toEqual([]);
    expect(result.exports).toEqual([]);
  });

  it("truncates content at 200 lines", async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `const line${i} = ${i};`);
    await writeFile(join(tmpDir, "src", "utils", "big.ts"), lines.join("\n"));

    const result = await getFileContext({ file_path: "src/utils/big.ts" }, tmpDir);

    expect(result.content).toContain("... (truncated)");
    expect(result.content.split("\n").length).toBeLessThanOrEqual(202);
  });

  // ── New fields ────────────────────────────────────────────────────────────

  describe("summary field", () => {
    it("returns null when no summaries file exists", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);

      expect(result.summary).toBeNull();
    });

    it("returns summary text from summaries.json", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );
      await writeFile(
        join(tmpDir, ".canon", "summaries.json"),
        JSON.stringify({
          "src/api/handler.ts": { summary: "Handles HTTP requests", updated_at: "2025-01-01T00:00:00Z" },
        }),
      );

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);

      expect(result.summary).toBe("Handles HTTP requests");
    });

    it("returns null when file has no matching summary entry", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );
      await writeFile(
        join(tmpDir, ".canon", "summaries.json"),
        JSON.stringify({
          "src/other/file.ts": { summary: "Some other file", updated_at: "2025-01-01T00:00:00Z" },
        }),
      );

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);

      expect(result.summary).toBeNull();
    });

    it("handles legacy string format in summaries.json", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );
      await writeFile(
        join(tmpDir, ".canon", "summaries.json"),
        JSON.stringify({
          "src/api/handler.ts": "Legacy plain text summary",
        }),
      );

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);

      expect(result.summary).toBe("Legacy plain text summary");
    });
  });

  describe("violations field", () => {
    it("returns empty array when no reviews exist", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);

      expect(result.violations).toEqual([]);
    });

    it("returns violations from the most recent review that includes the file", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );
      // Write a review with per-file violations
      const review = {
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
      };
      await writeFile(
        join(tmpDir, ".canon", "reviews.jsonl"),
        JSON.stringify(review) + "\n",
      );

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);

      expect(result.violations).toHaveLength(2);
      expect(result.violations[0]).toEqual({ principle_id: "thin-handlers", severity: "strong-opinion", message: "Handler is too thick" });
      expect(result.violations[1]).toEqual({ principle_id: "secrets-never-in-code", severity: "rule", message: "Secret found" });
    });

    it("picks the most recent review when multiple reviews include the file", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );
      const oldReview = {
        review_id: "r1",
        timestamp: "2025-01-05T00:00:00Z",
        files: ["src/api/handler.ts"],
        violations: [
          { principle_id: "old-violation", severity: "convention", file_path: "src/api/handler.ts" },
        ],
        honored: [],
        verdict: "WARNING",
        score: { rules: { passed: 1, total: 1 }, opinions: { passed: 1, total: 1 }, conventions: { passed: 0, total: 1 } },
      };
      const newReview = {
        review_id: "r2",
        timestamp: "2025-01-15T00:00:00Z",
        files: ["src/api/handler.ts"],
        violations: [
          { principle_id: "new-violation", severity: "rule", file_path: "src/api/handler.ts", message: "New issue" },
        ],
        honored: [],
        verdict: "BLOCKING",
        score: { rules: { passed: 0, total: 1 }, opinions: { passed: 1, total: 1 }, conventions: { passed: 1, total: 1 } },
      };
      await writeFile(
        join(tmpDir, ".canon", "reviews.jsonl"),
        JSON.stringify(oldReview) + "\n" + JSON.stringify(newReview) + "\n",
      );

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].principle_id).toBe("new-violation");
    });

    it("keeps violation_count for backwards compatibility", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );
      const review = {
        review_id: "r1",
        timestamp: "2025-01-10T00:00:00Z",
        files: ["src/api/handler.ts"],
        violations: [
          { principle_id: "thin-handlers", severity: "strong-opinion", file_path: "src/api/handler.ts" },
        ],
        honored: [],
        verdict: "WARNING",
        score: { rules: { passed: 1, total: 1 }, opinions: { passed: 0, total: 1 }, conventions: { passed: 0, total: 0 } },
      };
      await writeFile(
        join(tmpDir, ".canon", "reviews.jsonl"),
        JSON.stringify(review) + "\n",
      );

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);

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

      expect(result.imports_by_layer).toEqual({});
    });

    it("groups imports by their inferred layer", async () => {
      // Override config with layer mappings (keep source_dirs)
      await writeFile(
        join(tmpDir, ".canon", "config.json"),
        JSON.stringify({ source_dirs: ["src"], layers: { utils: ["src/utils"], domain: ["src/domain"] } }),
      );
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `import { helper } from '../utils/helper';\nimport { model } from '../domain/model';`,
      );
      await writeFile(join(tmpDir, "src", "utils", "helper.ts"), `export function helper() {}`);
      await mkdir(join(tmpDir, "src", "domain"), { recursive: true });
      await writeFile(join(tmpDir, "src", "domain", "model.ts"), `export function model() {}`);

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);

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
        JSON.stringify({ source_dirs: ["src"], layers: { utils: ["src/utils"] } }),
      );
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `import { helper } from '../utils/helper';`,
      );
      await writeFile(join(tmpDir, "src", "utils", "helper.ts"), `export function helper() {}`);

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);

      expect(result.imports).toContain("src/utils/helper.ts");
      expect(result.imports_by_layer["utils"]).toContain("src/utils/helper.ts");
    });
  });

  describe("layer_stack field", () => {
    it("returns default layer names when no layers config exists", async () => {
      await writeFile(
        join(tmpDir, "src", "api", "handler.ts"),
        `export function handleRequest() {}`,
      );

      const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);

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
          source_dirs: ["src"],
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

      expect(result.role).toBe("internal");
    });
  });
});
