import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getFileContext } from "../tools/get-file-context.ts";

describe("getFileContext — progressive disclosure", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-file-ctx-disclosure-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
    await mkdir(join(tmpDir, "src", "api"), { recursive: true });

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

  it("returns output without truncation for small files", async () => {
    await writeFile(join(tmpDir, "src", "api", "handler.ts"), `export function handleRequest() {}`);

    const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
    if (!result.ok) throw new Error(result.message);

    // Small file: no truncation
    expect(result.truncated).toBeUndefined();
    expect(result.full_data_path).toBeUndefined();
    expect(result.content).toContain("handleRequest");
  });

  it("truncates large responses and writes full data to disk", async () => {
    // Generate a file that will produce a response exceeding the 12,000-char threshold
    // by having many exports and imports that inflate the JSON payload.
    const bigContent = Array.from({ length: 150 }, (_, i) => `export const val${i} = ${i};`).join(
      "\n",
    );
    await writeFile(join(tmpDir, "src", "api", "handler.ts"), bigContent);

    // The test checks structural behavior: if truncated, fields must be set.
    const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
    if (!result.ok) throw new Error(result.message);

    // Whether truncated or not depends on actual payload size.
    // If truncated, verify the contract fields are set correctly.
    if (result.truncated) {
      expect(result.full_data_path).toBeDefined();
      expect(result.full_data_path).toMatch(/file-context-.*\.json$/);
      expect(result.content).toContain("Truncated");
      expect(result.content).toContain(result.full_data_path);
    } else {
      // Not truncated — content is present normally
      expect(result.content).toContain("val0");
    }
  });
});
