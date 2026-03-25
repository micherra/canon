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
});
