/**
 * Tests for linkWorktreeNodeModules (AC 1, Guard 2, Guard 3 preconditions).
 *
 * Covers:
 * - Symlink is created at <worktree>/mcp-server/node_modules pointing to main node_modules (dc-01)
 * - Guard 2: resolved link target does NOT start with the worktree path (non-circular, dc-03)
 * - Helper is a no-op when main node_modules is absent (observable-best-effort)
 * - Helper does not clobber an existing link site
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { linkWorktreeNodeModules } from "../tools/init-workspace.ts";

let tmpDirs: string[] = [];

function makeTmpDir(prefix = "symlink-test-"): string {
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

describe("linkWorktreeNodeModules — dc-01: symlink creation", () => {
  it("creates a symlink at <worktree>/mcp-server/node_modules pointing to main node_modules", () => {
    const projectDir = makeTmpDir("proj-");
    const worktreeDir = makeTmpDir("wt-");

    // Create main node_modules with a sentinel file
    const mainNm = join(projectDir, "mcp-server", "node_modules");
    mkdirSync(mainNm, { recursive: true });
    writeFileSync(join(mainNm, "sentinel.txt"), "main-nm");

    // Create the worktree mcp-server dir (needed for symlink creation)
    mkdirSync(join(worktreeDir, "mcp-server"), { recursive: true });

    linkWorktreeNodeModules(worktreeDir, projectDir);

    const linkSite = join(worktreeDir, "mcp-server", "node_modules");
    expect(existsSync(linkSite)).toBe(true);
    expect(lstatSync(linkSite).isSymbolicLink()).toBe(true);

    // Resolved path should point to main node_modules (sentinel present)
    const resolved = realpathSync(linkSite);
    const mainResolved = realpathSync(mainNm);
    expect(resolved).toBe(mainResolved);
  });

  it("dc-01: sentinel file in main node_modules is accessible through the symlink", () => {
    const projectDir = makeTmpDir("proj-");
    const worktreeDir = makeTmpDir("wt-");

    const mainNm = join(projectDir, "mcp-server", "node_modules");
    mkdirSync(mainNm, { recursive: true });
    writeFileSync(join(mainNm, "sentinel.txt"), "main-nm-content");
    mkdirSync(join(worktreeDir, "mcp-server"), { recursive: true });

    linkWorktreeNodeModules(worktreeDir, projectDir);

    const linkSite = join(worktreeDir, "mcp-server", "node_modules");
    // Reading through the symlink should see the sentinel
    const content = readFileSync(join(linkSite, "sentinel.txt"), "utf-8");
    expect(content).toBe("main-nm-content");
  });
});

describe("linkWorktreeNodeModules — Guard 2 (dc-03): non-circular", () => {
  it("resolved link target does NOT start with the worktree path", () => {
    const projectDir = makeTmpDir("proj-");
    const worktreeDir = makeTmpDir("wt-");

    const mainNm = join(projectDir, "mcp-server", "node_modules");
    mkdirSync(mainNm, { recursive: true });
    writeFileSync(join(mainNm, ".keep"), "");
    mkdirSync(join(worktreeDir, "mcp-server"), { recursive: true });

    linkWorktreeNodeModules(worktreeDir, projectDir);

    const linkSite = join(worktreeDir, "mcp-server", "node_modules");
    expect(lstatSync(linkSite).isSymbolicLink()).toBe(true);

    const resolvedTarget = realpathSync(linkSite);
    const resolvedWorktree = realpathSync(worktreeDir);

    // Guard 2: the resolved target must NOT be inside the worktree — non-circular
    expect(resolvedTarget.startsWith(resolvedWorktree)).toBe(false);
  });
});

describe("linkWorktreeNodeModules — observable-best-effort: no-op when main node_modules absent", () => {
  it("does nothing (no error) when main mcp-server/node_modules does not exist", () => {
    const projectDir = makeTmpDir("proj-");
    const worktreeDir = makeTmpDir("wt-");

    // Do NOT create main node_modules
    mkdirSync(join(worktreeDir, "mcp-server"), { recursive: true });

    // Must not throw
    expect(() => linkWorktreeNodeModules(worktreeDir, projectDir)).not.toThrow();

    // Link site must not be created
    const linkSite = join(worktreeDir, "mcp-server", "node_modules");
    expect(existsSync(linkSite)).toBe(false);
  });
});

describe("linkWorktreeNodeModules — no-clobber: does not overwrite existing link site", () => {
  it("is a no-op when a node_modules already exists at the link site", () => {
    const projectDir = makeTmpDir("proj-");
    const worktreeDir = makeTmpDir("wt-");

    // Create main node_modules
    const mainNm = join(projectDir, "mcp-server", "node_modules");
    mkdirSync(mainNm, { recursive: true });
    writeFileSync(join(mainNm, "sentinel.txt"), "main");

    // Create an EXISTING entry at the link site (simulate prior run / real dir)
    const linkSite = join(worktreeDir, "mcp-server", "node_modules");
    mkdirSync(linkSite, { recursive: true });
    writeFileSync(join(linkSite, "existing.txt"), "existing");

    // Must not throw, must not replace the existing directory
    expect(() => linkWorktreeNodeModules(worktreeDir, projectDir)).not.toThrow();

    // The link site should still be a real directory, not a symlink
    expect(lstatSync(linkSite).isSymbolicLink()).toBe(false);
    expect(lstatSync(linkSite).isDirectory()).toBe(true);
    // existing.txt should still be there
    expect(existsSync(join(linkSite, "existing.txt"))).toBe(true);
  });
});
