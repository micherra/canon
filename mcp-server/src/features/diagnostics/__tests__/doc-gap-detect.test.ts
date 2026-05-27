/**
 * Tests for the Doc-Gap Detection service.
 *
 * Pure-function tests use in-memory directory entries.
 * I/O tests create temp directories on disk.
 *
 * Test plan:
 *
 * detectDocGaps (pure):
 * - directory with 3 .ts files and no CLAUDE.md -> gap
 * - directory with CLAUDE.md -> no gap
 * - directory with 1 source file -> no gap (threshold = 2)
 * - directory with only .md files (non-agent) -> no gap
 *
 * scanDirectories (I/O):
 * - finds directories and checks for CLAUDE.md presence
 * - excludes directories in the excludeDirs list
 */

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectDocGaps, scanDirectories } from "../services/doc-gap-detect.ts";

// ---- detectDocGaps (pure function) ----

describe("detectDocGaps", () => {
  it("flags a directory with 3 .ts files and no CLAUDE.md as a gap", () => {
    const entries = [
      {
        dir: "src/features/foo",
        files: ["index.ts", "helper.ts", "types.ts"],
        hasClaudeMd: false,
      },
    ];
    const output = detectDocGaps(entries);
    expect(output.gaps).toHaveLength(1);
    expect(output.gaps[0].directory).toBe("src/features/foo");
    expect(output.gaps[0].source_file_count).toBe(3);
    expect(output.gaps[0].source_extensions).toContain(".ts");
    expect(output.directories_scanned).toBe(1);
    expect(output.directories_with_docs).toBe(0);
  });

  it("does not flag a directory that has a CLAUDE.md", () => {
    const entries = [
      {
        dir: "src/features/bar",
        files: ["index.ts", "helper.ts"],
        hasClaudeMd: true,
      },
    ];
    const output = detectDocGaps(entries);
    expect(output.gaps).toHaveLength(0);
    expect(output.directories_with_docs).toBe(1);
  });

  it("does not flag a directory with only 1 source file (threshold is 2)", () => {
    const entries = [
      {
        dir: "src/features/tiny",
        files: ["index.ts"],
        hasClaudeMd: false,
      },
    ];
    const output = detectDocGaps(entries);
    expect(output.gaps).toHaveLength(0);
  });

  it("does not flag a directory with only non-source .md files", () => {
    const entries = [
      {
        dir: "docs/guides",
        files: ["intro.md", "setup.md", "api.md"],
        hasClaudeMd: false,
      },
    ];
    const output = detectDocGaps(entries);
    expect(output.gaps).toHaveLength(0);
  });

  it("counts source extensions correctly across mixed file types", () => {
    const entries = [
      {
        dir: "src/scripts",
        files: ["deploy.sh", "build.sh", "README.md"],
        hasClaudeMd: false,
      },
    ];
    const output = detectDocGaps(entries);
    expect(output.gaps).toHaveLength(1);
    expect(output.gaps[0].source_file_count).toBe(2);
    expect(output.gaps[0].source_extensions).toContain(".sh");
    expect(output.gaps[0].source_extensions).not.toContain(".md");
  });

  it("returns correct aggregate counts across multiple directories", () => {
    const entries = [
      { dir: "src/a", files: ["a.ts", "b.ts"], hasClaudeMd: false },
      { dir: "src/b", files: ["c.ts", "d.ts"], hasClaudeMd: true },
      { dir: "src/c", files: ["e.ts"], hasClaudeMd: false },
    ];
    const output = detectDocGaps(entries);
    expect(output.directories_scanned).toBe(3);
    expect(output.directories_with_docs).toBe(1);
    expect(output.gaps).toHaveLength(1);
    expect(output.gaps[0].directory).toBe("src/a");
  });
});

// ---- scanDirectories (I/O function) ----

describe("scanDirectories", () => {
  let testRoot: string;

  beforeEach(async () => {
    testRoot = join(tmpdir(), `doc-gap-test-${Date.now()}`);
    await mkdir(testRoot, { recursive: true });
  });

  afterEach(async () => {
    // Clean up temp dirs
    const { rm } = await import("node:fs/promises");
    await rm(testRoot, { recursive: true, force: true });
  });

  it("detects a directory without CLAUDE.md as hasClaudeMd: false", async () => {
    const subDir = join(testRoot, "src");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "index.ts"), "export {};");
    await writeFile(join(subDir, "helper.ts"), "export {};");

    const results = await scanDirectories(testRoot, []);
    const srcEntry = results.find((r) => r.dir === subDir);
    expect(srcEntry).toBeDefined();
    expect(srcEntry!.hasClaudeMd).toBe(false);
    expect(srcEntry!.files).toContain("index.ts");
  });

  it("detects a directory with CLAUDE.md as hasClaudeMd: true", async () => {
    const subDir = join(testRoot, "src");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "CLAUDE.md"), "# Guidelines");
    await writeFile(join(subDir, "index.ts"), "export {};");

    const results = await scanDirectories(testRoot, []);
    const srcEntry = results.find((r) => r.dir === subDir);
    expect(srcEntry).toBeDefined();
    expect(srcEntry!.hasClaudeMd).toBe(true);
  });

  it("excludes directories in the excludeDirs list", async () => {
    const nodeModulesDir = join(testRoot, "node_modules");
    await mkdir(nodeModulesDir, { recursive: true });
    await writeFile(join(nodeModulesDir, "some-lib.ts"), "export {};");

    const results = await scanDirectories(testRoot, ["node_modules"]);
    const excluded = results.find((r) => r.dir === nodeModulesDir);
    expect(excluded).toBeUndefined();
  });

  it("scans nested subdirectories recursively", async () => {
    const deepDir = join(testRoot, "src", "features", "auth");
    await mkdir(deepDir, { recursive: true });
    await writeFile(join(deepDir, "auth.ts"), "export {};");
    await writeFile(join(deepDir, "types.ts"), "export {};");

    const results = await scanDirectories(testRoot, []);
    const deepEntry = results.find((r) => r.dir === deepDir);
    expect(deepEntry).toBeDefined();
    expect(deepEntry!.files.length).toBeGreaterThanOrEqual(2);
  });
});
