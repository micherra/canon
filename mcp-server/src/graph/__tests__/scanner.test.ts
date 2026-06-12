/**
 * Tests for the KG scanner — Guard 4 (symlinked node_modules no-traversal).
 *
 * Covers (dc-05):
 * - scanSourceFiles returns zero paths under a node_modules symlink-to-dir
 * - scanSourceFiles also excludes real node_modules directories
 * - Symlink-to-dir entries fail the isDirectory() gate for Dirent (Guard 4 behavioral check)
 *
 * The scanner uses readdir with { withFileTypes: true }. A symlink-to-dir dirent
 * reports isDirectory() === false (Dirent reflects the link, not the target), so
 * processEntry's `entry.isDirectory()` gate skips it before the excludeDirs check
 * even fires. The DEFAULT_EXCLUDE_DIRS name exclusion is defense-in-depth.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanSourceFiles } from "../scanner.ts";

let tmpDirs: string[] = [];

function makeTmpDir(prefix = "scanner-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
});

describe("scanSourceFiles — Guard 4 (dc-05): symlinked node_modules is not traversed", () => {
  it("returns zero paths under a node_modules symlink-to-dir containing .ts files", async () => {
    const root = makeTmpDir("scan-root-");
    const realNmTarget = makeTmpDir("real-nm-");

    // Create a real node_modules directory somewhere OUTSIDE root
    // with a TypeScript file inside it
    mkdirSync(join(realNmTarget, "some-pkg"), { recursive: true });
    writeFileSync(join(realNmTarget, "some-pkg", "index.ts"), "export const x = 1;");

    // Create the project mcp-server structure with a symlink to the real node_modules
    mkdirSync(join(root, "mcp-server"), { recursive: true });
    symlinkSync(realNmTarget, join(root, "mcp-server", "node_modules"), "dir");

    // Add a legitimate source file so the scanner has something to find
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "app.ts"), "export const app = true;");

    const files = await scanSourceFiles(root);

    // Guard 4 assertion: no file path should contain node_modules
    const nodeModulesPaths = files.filter((f) => f.includes("node_modules"));
    expect(nodeModulesPaths).toHaveLength(0);

    // The legitimate source file IS found
    expect(files).toContain("src/app.ts");
  });

  it("also excludes real node_modules directories (name-based exclusion)", async () => {
    const root = makeTmpDir("scan-root-real-nm-");

    // Create a REAL node_modules directory (not a symlink) with a .ts file
    mkdirSync(join(root, "node_modules", "my-pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules", "my-pkg", "index.ts"), "export default {};");

    // Add a legitimate source file
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "main.ts"), "const x = 1;");

    const files = await scanSourceFiles(root);

    // No file under node_modules should appear
    expect(files.filter((f) => f.includes("node_modules"))).toHaveLength(0);
    expect(files).toContain("src/main.ts");
  });

  it("returns zero files from root when root contains only a node_modules symlink", async () => {
    const root = makeTmpDir("scan-root-nm-only-");
    const realNm = makeTmpDir("real-nm-only-");

    // Put a .ts file in the real nm directory
    writeFileSync(join(realNm, "leaked.ts"), "export const leaked = true;");

    // Root has only the symlink
    symlinkSync(realNm, join(root, "node_modules"), "dir");

    const files = await scanSourceFiles(root);
    expect(files).toHaveLength(0);
  });
});
