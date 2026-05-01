import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getFileContextBatch } from "../tools/get-file-context-batch.ts";

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
    await writeFile(join(tmpDir, "src", "api", "handler.ts"), `export function handleRequest() {}`);
    await writeFile(join(tmpDir, "src", "utils", "helper.ts"), `export function helper() {}`);

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
    await writeFile(join(tmpDir, "src", "api", "handler.ts"), `export function handleRequest() {}`);

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
    await writeFile(join(tmpDir, "src", "utils", "helper.ts"), `export function helper() {}`);

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

    const result = await getFileContextBatch({ file_paths: ["src/api/handler.ts"] }, tmpDir);

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
