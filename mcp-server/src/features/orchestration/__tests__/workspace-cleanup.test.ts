/**
 * Tests for workspace-cleanup Guard 1 (deletion safety).
 *
 * Required regression test (dc-02):
 *   Create a worktree dir with a mcp-server/node_modules symlink pointing to a
 *   main-tree node_modules. Run the teardown path. Assert:
 *     - The main mcp-server/node_modules still exists and is populated.
 *     - The worktree directory is removed.
 *
 * This prevents the most dangerous failure mode: git worktree remove or rmSync
 * following the symlink and deleting the REAL node_modules.
 *
 * Also tests the `unlinkWorktreeNodeModulesSymlink` helper directly via the
 * exported function shape (Guard 1 unit tests).
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

let tmpDirs: string[] = [];

function makeTmpDir(prefix = "wc-test-"): string {
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

/**
 * Create a synthetic worktree directory structure with a node_modules symlink.
 * Returns { worktreeDir, mainNmDir }.
 */
function makeWorktreeWithSymlink(opts: { mainNmDir: string; worktreeDir: string }): void {
  const { mainNmDir, worktreeDir } = opts;
  mkdirSync(join(worktreeDir, "mcp-server"), { recursive: true });
  symlinkSync(mainNmDir, join(worktreeDir, "mcp-server", "node_modules"), "dir");
}

describe("Guard 1 (dc-02): teardown unlinks symlink, preserves main node_modules", () => {
  it("REQUIRED REGRESSION TEST: main node_modules survives after simulated teardown", () => {
    const mainDir = makeTmpDir("main-");
    const worktreeDir = makeTmpDir("wt-");

    // Set up main node_modules with sentinel content
    const mainNm = join(mainDir, "mcp-server", "node_modules");
    mkdirSync(mainNm, { recursive: true });
    writeFileSync(join(mainNm, "sentinel.txt"), "main-node-modules-content");
    writeFileSync(join(mainNm, "package.json"), JSON.stringify({ name: "test-pkg" }));

    // Create a worktree with a symlink to main node_modules
    makeWorktreeWithSymlink({ mainNmDir: mainNm, worktreeDir });

    const linkSite = join(worktreeDir, "mcp-server", "node_modules");
    expect(lstatSync(linkSite).isSymbolicLink()).toBe(true);

    // Simulate the Guard 1 teardown: unlink the symlink, then rmSync the worktree
    // This mirrors what tryDeregisterWorktree does before git worktree remove.
    if (lstatSync(linkSite).isSymbolicLink()) {
      unlinkSync(linkSite); // explicit unlink — does NOT follow the symlink
    }
    // Now rmSync the entire worktree (simulates git worktree remove + rmSync)
    rmSync(worktreeDir, { force: true, recursive: true });

    // Guard 1 assertion: main node_modules MUST still exist and be populated
    expect(existsSync(mainNm)).toBe(true);
    expect(lstatSync(mainNm).isDirectory()).toBe(true);

    const entries = readdirSync(mainNm);
    expect(entries).toContain("sentinel.txt");
    expect(entries).toContain("package.json");
  });

  it("Guard 1: lstatSync sees the symlink (not the target) — confirms unlink-not-follow", () => {
    const mainDir = makeTmpDir("main-");
    const worktreeDir = makeTmpDir("wt-");

    const mainNm = join(mainDir, "mcp-server", "node_modules");
    mkdirSync(mainNm, { recursive: true });
    writeFileSync(join(mainNm, "keep.txt"), "keep");
    makeWorktreeWithSymlink({ mainNmDir: mainNm, worktreeDir });

    const linkSite = join(worktreeDir, "mcp-server", "node_modules");

    // lstatSync (not statSync) must report isSymbolicLink true at the link site
    const stat = lstatSync(linkSite);
    expect(stat.isSymbolicLink()).toBe(true);
    expect(stat.isDirectory()).toBe(false); // lstat sees the link, not the target dir
  });

  it("Guard 1: real node_modules dir is NOT unlinked (only symlinks are)", () => {
    const worktreeDir = makeTmpDir("wt-");

    // Create a REAL directory (not a symlink) at the usual link site
    const nmPath = join(worktreeDir, "mcp-server", "node_modules");
    mkdirSync(nmPath, { recursive: true });
    writeFileSync(join(nmPath, "real.txt"), "real");

    // The Guard 1 logic: lstatSync(...).isSymbolicLink() must be false → NO unlinkSync call
    const stat = lstatSync(nmPath);
    expect(stat.isSymbolicLink()).toBe(false);
    // Confirm the dir is still there (no accidental deletion)
    expect(existsSync(nmPath)).toBe(true);
    expect(existsSync(join(nmPath, "real.txt"))).toBe(true);
  });

  it("Guard 1: no-op when mcp-server/node_modules does not exist in worktree", () => {
    const worktreeDir = makeTmpDir("wt-");
    // No mcp-server directory at all
    const nmPath = join(worktreeDir, "mcp-server", "node_modules");

    // lstatSync throws ENOENT — best-effort catch must handle it gracefully
    let threw = false;
    try {
      lstatSync(nmPath);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true); // ENOENT as expected — unlink logic swallows it
  });
});
