/**
 * Tests for `createWorktree` — fail-closed worktree creation (Approach B).
 *
 * Covers:
 * - Happy path: real scratch git repo, path/branch returned, dir exists on disk
 * - Branch collision: error names `git worktree add`, exit code, stderr (PROBE1/2)
 * - Invalid base_commit ref: typed error (PROBE4)
 * - Empty-stderr fallback marker (seam-stubbed gitWorktreeAdd with stderr: "")
 * - Phantom-success existence assertion (seam-stubbed gitWorktreeAdd returning ok:true
 *   without creating the directory) — dc-03
 * - `linkWorktreeNodeModules` re-export intact
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initGitFixtureRepo } from "../../../../tests/git-fixture.ts";
import { createWorktree, linkWorktreeNodeModules } from "../worktree-creation.ts";

let tmpDirs: string[] = [];

function makeTmpDir(prefix = "worktree-creation-test-"): string {
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

describe("createWorktree — happy path", () => {
  it("returns worktree_path and worktree_branch, and the directory exists on disk", () => {
    const projectDir = makeTmpDir();
    const baseCommit = initGitFixtureRepo(projectDir);
    const workspace = makeTmpDir("worktree-creation-ws-");

    const result = createWorktree({
      baseCommit,
      projectDir,
      slug: "fix-the-bug",
      workspace,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.worktree_branch).toBe("canon/fix-the-bug");
      expect(result.worktree_path).toBe(join(workspace, "worktree"));
      expect(existsSync(result.worktree_path)).toBe(true);
    }
  });
});

describe("createWorktree — branch collision (PROBE1/2)", () => {
  it("returns WORKTREE_CREATE_FAILED naming git worktree add, exit code, and stderr", () => {
    const projectDir = makeTmpDir();
    const baseCommit = initGitFixtureRepo(projectDir);
    const workspace = makeTmpDir("worktree-creation-ws-");

    // Pre-create the branch canon/fix-the-bug would use, forcing a collision.
    spawnSync("git", ["branch", "canon/fix-the-bug"], { cwd: projectDir });

    const result = createWorktree({
      baseCommit,
      projectDir,
      slug: "fix-the-bug",
      workspace,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("WORKTREE_CREATE_FAILED");
      expect(result.message).toContain("git worktree add");
      expect(result.message).toContain("canon/fix-the-bug");
      expect(result.message).toMatch(/exit \d+/);
      expect(result.recoverable).toBe(true);
      expect(result.context?.exit_code).toBeDefined();
      expect(result.context?.stderr).toBeDefined();
    }
    expect(existsSync(join(workspace, "worktree"))).toBe(false);
  });
});

describe("createWorktree — invalid base_commit (PROBE4)", () => {
  it("returns WORKTREE_CREATE_FAILED for an invalid ref", () => {
    const projectDir = makeTmpDir();
    initGitFixtureRepo(projectDir);
    const workspace = makeTmpDir("worktree-creation-ws-");

    const result = createWorktree({
      baseCommit: "deadbeef1234",
      projectDir,
      slug: "fix-the-bug",
      workspace,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("WORKTREE_CREATE_FAILED");
      expect(result.message).toContain("git worktree add");
      expect(result.recoverable).toBe(true);
    }
  });
});

describe("createWorktree — non-git projectDir (PROBE5)", () => {
  it("returns WORKTREE_CREATE_FAILED, never a silent created state", () => {
    const projectDir = makeTmpDir(); // no git init
    const workspace = makeTmpDir("worktree-creation-ws-");

    const result = createWorktree({
      baseCommit: "abc123",
      projectDir,
      slug: "fix-the-bug",
      workspace,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("WORKTREE_CREATE_FAILED");
    }
    expect(existsSync(join(workspace, "worktree"))).toBe(false);
  });
});

describe("createWorktree — empty-stderr fallback marker", () => {
  it("degrades gracefully when the git failure carries no stderr", () => {
    const projectDir = makeTmpDir();
    const baseCommit = initGitFixtureRepo(projectDir);
    const workspace = makeTmpDir("worktree-creation-ws-");

    const result = createWorktree(
      { baseCommit, projectDir, slug: "fix-the-bug", workspace },
      {
        gitWorktreeAdd: () => ({
          duration_ms: 1,
          exitCode: 1,
          ok: false,
          stderr: "",
          stdout: "",
          timedOut: false,
        }),
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("<no stderr captured — possible spawn failure or timeout>");
    }
  });
});

describe("createWorktree — phantom-success existence assertion (dc-03)", () => {
  it("returns a non-recoverable WORKTREE_CREATE_FAILED when git reports success but the dir is absent", () => {
    const projectDir = makeTmpDir();
    const baseCommit = initGitFixtureRepo(projectDir);
    const workspace = makeTmpDir("worktree-creation-ws-");

    const result = createWorktree(
      { baseCommit, projectDir, slug: "fix-the-bug", workspace },
      {
        gitWorktreeAdd: () => ({
          duration_ms: 1,
          exitCode: 0,
          ok: true,
          stderr: "",
          stdout: "",
          timedOut: false,
        }),
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("WORKTREE_CREATE_FAILED");
      expect(result.recoverable).toBe(false);
      expect(result.message).toContain("does not exist on disk");
    }
  });
});

describe("linkWorktreeNodeModules re-export", () => {
  it("is exported from the service module", () => {
    expect(typeof linkWorktreeNodeModules).toBe("function");
  });
});
