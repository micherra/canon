/**
 * Tests for init_workspace worktree creation.
 *
 * Covers:
 * - New workspace creation returns worktree_path and worktree_branch
 * - Resume with existing worktree returns the path
 * - Resume with missing worktree returns undefined
 * - Preflight-only calls do NOT create worktrees
 * - Worktree creation failure returns a typed WORKTREE_CREATE_FAILED error (fail-closed,
 *   Approach B — see DESIGN.md). Previously this fell back silently to `created: true`
 *   with no worktree_path; that was the bug this build fixes, not a contract to preserve.
 * - Post-failure retry does not resume the failed workspace — it self-heals via slug
 *   suffixing (dc-04)
 * - Lock is released after a worktree-creation failure
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock loadAndResolveFlow to avoid needing real flow files
vi.mock("@domains/flows/flow-parser.ts", () => ({
  loadAndResolveFlow: vi.fn().mockResolvedValue({
    description: "test",
    entry: "build",
    name: "fast-path",
    spawn_instructions: {},
    states: {
      build: { transitions: { done: "done" }, type: "single" },
      done: { type: "terminal" },
    },
  }),
}));

import { assertOk } from "@shared/lib/tool-result.ts";
import { initGitFixtureRepo } from "../../../tests/git-fixture.ts";
import { readLock } from "../services/workspace-lock.ts";
import { initWorkspaceFlow } from "../tools/init-workspace.ts";

// Scope: Tests worktree creation, resume detection, legacy path fallback, preflight-skips-worktree, and fail-closed error when worktree creation fails.

let tmpDirs: string[] = [];

function makeTmpProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "init-ws-worktree-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
});

const baseInput = {
  base_commit: "abc123",
  branch: "main",
  flow_name: "fast-path",
  // Real single-session id so create-then-resume re-acquires its own mutex
  // (same-session re-entry); omitted ids no longer match (workspace-lock P1 #2).
  session_id: "session-fixture",
  task: "fix the bug",
  tier: "small" as const,
};

// New workspace: worktree creation

describe("initWorkspaceFlow — worktree creation on new workspace", () => {
  it("returns worktree_path pointing inside {workspace}/worktree", async () => {
    const projectDir = makeTmpProjectDir();
    const baseCommit = initGitFixtureRepo(projectDir);

    const result = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );
    assertOk(result);

    expect(result.created).toBe(true);
    expect(result.worktree_path).toBeDefined();
    // New path: {workspace}/worktree (not .canon/worktrees/{slug})
    expect(result.worktree_path).toContain("/worktree");
    expect(result.worktree_path).toContain(result.workspace);
    expect(result.worktree_path).not.toContain(".canon/worktrees/");
  });

  it("returns worktree_branch matching canon/{slug}", async () => {
    const projectDir = makeTmpProjectDir();
    const baseCommit = initGitFixtureRepo(projectDir);

    const result = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );
    assertOk(result);

    expect(result.created).toBe(true);
    expect(result.worktree_branch).toBe(`canon/${result.slug}`);
  });

  it("actually creates the worktree directory on disk", async () => {
    const projectDir = makeTmpProjectDir();
    const baseCommit = initGitFixtureRepo(projectDir);

    const result = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );
    assertOk(result);

    expect(result.worktree_path).toBeDefined();
    expect(existsSync(result.worktree_path!)).toBe(true);
  });

  it("persists worktree_path and worktree_branch in session metadata", async () => {
    const projectDir = makeTmpProjectDir();
    const baseCommit = initGitFixtureRepo(projectDir);

    const result = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );
    assertOk(result);

    expect(result.session.worktree_path).toBe(result.worktree_path);
    expect(result.session.worktree_branch).toBe(result.worktree_branch);
  });
});

// Resume: worktree detection

describe("initWorkspaceFlow — resume with existing worktree", () => {
  it("returns worktree_path when worktree still exists", async () => {
    const projectDir = makeTmpProjectDir();
    const baseCommit = initGitFixtureRepo(projectDir);

    // Create workspace first
    const first = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );
    assertOk(first);
    expect(first.created).toBe(true);
    expect(first.worktree_path).toBeDefined();

    // Resume — worktree should still exist
    const second = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );
    assertOk(second);
    expect(second.created).toBe(false);
    expect(second.worktree_path).toBeDefined();
    expect(second.worktree_path).toBe(first.worktree_path);
  });

  it("returns undefined worktree_path when worktree has been deleted", async () => {
    const projectDir = makeTmpProjectDir();
    const baseCommit = initGitFixtureRepo(projectDir);

    // Create workspace first
    const first = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );
    assertOk(first);
    expect(first.created).toBe(true);

    // Forcibly remove the worktree directory (simulating manual removal)
    if (first.worktree_path && existsSync(first.worktree_path)) {
      // We need to remove the worktree properly to avoid git worktree list issues
      spawnSync("git", ["worktree", "remove", "--force", first.worktree_path], { cwd: projectDir });
    }

    // Resume — worktree should be detected as missing
    const second = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );
    assertOk(second);
    expect(second.created).toBe(false);
    expect(second.worktree_path).toBeUndefined();
    expect(second.worktree_branch).toBeUndefined();
  });
});

// Preflight-only: no worktree creation

describe("initWorkspaceFlow — preflight skips worktree creation", () => {
  it("does not create a worktree when preflight returns issues", async () => {
    const projectDir = makeTmpProjectDir();

    // Set up a dirty git repo so preflight returns issues
    spawnSync("git", ["init"], { cwd: projectDir });
    spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: projectDir });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: projectDir });
    writeFileSync(join(projectDir, "README.md"), "# test");
    spawnSync("git", ["add", "."], { cwd: projectDir });
    spawnSync("git", ["commit", "-m", "init"], { cwd: projectDir });
    // Create dirty state
    writeFileSync(join(projectDir, "dirty.txt"), "uncommitted change");

    const result = await initWorkspaceFlow(
      { ...baseInput, preflight: true },
      projectDir,
      "/fake/plugin",
    );
    assertOk(result);

    expect(result.preflight_issues).toBeDefined();
    expect(result.preflight_issues!.length).toBeGreaterThan(0);

    // No worktree should exist at new path (preflight returns empty workspace path)
    // When preflight fails, result.workspace is "" — so we just verify worktree_path is absent
    expect(result.worktree_path).toBeUndefined();
  });
});

// Fail-closed: worktree creation failure returns a typed error (dc-01, dc-02)

describe("initWorkspaceFlow — worktree creation failure (fail-closed)", () => {
  it("returns WORKTREE_CREATE_FAILED, never created:true, when not in a git repo (PROBE5)", async () => {
    // projectDir has no git repo — worktree add will fail
    const projectDir = makeTmpProjectDir();

    const result = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("WORKTREE_CREATE_FAILED");
      expect(result.message).toContain("git worktree add");
      expect(result.recoverable).toBe(true);
    }
  });

  it("returns WORKTREE_CREATE_FAILED on branch collision (PROBE1/2)", async () => {
    const projectDir = makeTmpProjectDir();
    const baseCommit = initGitFixtureRepo(projectDir);
    // Pre-create the branch canon/{slug} would use, forcing a collision.
    spawnSync("git", ["branch", "canon/fix-the-bug"], { cwd: projectDir });

    const result = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("WORKTREE_CREATE_FAILED");
      expect(result.message).toContain("git worktree add");
    }
  });

  it("returns WORKTREE_CREATE_FAILED for an invalid base_commit (PROBE4)", async () => {
    const projectDir = makeTmpProjectDir();
    initGitFixtureRepo(projectDir);

    const result = await initWorkspaceFlow(
      { ...baseInput, base_commit: "deadbeef1234" },
      projectDir,
      "/fake/plugin",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("WORKTREE_CREATE_FAILED");
    }
  });

  it("does not create a session row on failure — no workspace survives to resume (dc-04)", async () => {
    const projectDir = makeTmpProjectDir();

    const failed = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");
    expect(failed.ok).toBe(false);

    // Retry with the same input does NOT silently resume a worktree-less workspace —
    // it fails closed again (still no git repo), never returning created:true.
    const retry = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");
    expect(retry.ok).toBe(false);
    if (!retry.ok) {
      expect(retry.error_code).toBe("WORKTREE_CREATE_FAILED");
    }
  });

  it("self-heals on retry after a branch-collision failure via slug suffixing (dc-04)", async () => {
    const projectDir = makeTmpProjectDir();
    const baseCommit = initGitFixtureRepo(projectDir);
    spawnSync("git", ["branch", "canon/fix-the-bug"], { cwd: projectDir });

    const failed = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );
    expect(failed.ok).toBe(false);

    // Retry — checkSlugCollision suffixes the dir (fix-the-bug -> fix-the-bug-2),
    // yielding a fresh branch name that dodges the collision. Succeeds.
    const retry = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );
    assertOk(retry);
    expect(retry.created).toBe(true);
    expect(retry.worktree_path).toBeDefined();
    expect(existsSync(retry.worktree_path!)).toBe(true);
  });

  it("releases the workspace lock after a worktree-creation failure", async () => {
    const projectDir = makeTmpProjectDir();

    const failed = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      const failedWorkspace = failed.context?.worktree_path
        ? String(failed.context.worktree_path).replace(/\/worktree$/, "")
        : undefined;
      expect(failedWorkspace).toBeDefined();
      expect(readLock(failedWorkspace!)).toBeNull();
    }
  });
});

// Backward compat: existing behavior preserved

describe("initWorkspaceFlow — backward compat", () => {
  it("returns all existing fields regardless of worktree presence, wrapped with ok:true", async () => {
    const projectDir = makeTmpProjectDir();
    const baseCommit = initGitFixtureRepo(projectDir);

    const result = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );

    // Additive ok:true wrapping — success shape is unchanged otherwise (PRD AC#5).
    expect(result.ok).toBe(true);
    assertOk(result);
    expect(result.workspace).toBeTruthy();
    expect(result.slug).toBeTruthy();
    expect(result.board).toBeDefined();
    expect(result.session).toBeDefined();
    expect(result.created).toBe(true);
    expect(typeof result.worktree_path === "string" || result.worktree_path === undefined).toBe(
      true,
    );
  });
});

// New worktree path: {workspace}/worktree

describe("initWorkspaceFlow — worktree at {workspace}/worktree (new location)", () => {
  it("places worktree inside workspace directory, not .canon/worktrees/", async () => {
    const projectDir = makeTmpProjectDir();
    const baseCommit = initGitFixtureRepo(projectDir);

    const result = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );
    assertOk(result);

    expect(result.created).toBe(true);
    expect(result.worktree_path).toBeDefined();
    // Must be inside the workspace directory
    expect(result.worktree_path).toContain(result.workspace);
    // Must end with /worktree
    expect(result.worktree_path).toBe(join(result.workspace, "worktree"));
    // Must NOT use old .canon/worktrees/ path
    expect(result.worktree_path).not.toContain(".canon/worktrees/");
  });

  it("actually creates the worktree directory at {workspace}/worktree", async () => {
    const projectDir = makeTmpProjectDir();
    const baseCommit = initGitFixtureRepo(projectDir);

    const result = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );
    assertOk(result);

    expect(result.worktree_path).toBeDefined();
    expect(existsSync(result.worktree_path!)).toBe(true);
    expect(result.worktree_path).toBe(join(result.workspace, "worktree"));
  });

  it("resume finds worktree at {workspace}/worktree (new location)", async () => {
    const projectDir = makeTmpProjectDir();
    const baseCommit = initGitFixtureRepo(projectDir);

    // Create workspace first
    const first = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );
    assertOk(first);
    expect(first.created).toBe(true);
    expect(first.worktree_path).toBe(join(first.workspace, "worktree"));

    // Resume — should find the worktree at {workspace}/worktree
    const second = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );
    assertOk(second);
    expect(second.created).toBe(false);
    expect(second.worktree_path).toBeDefined();
    expect(second.worktree_path).toBe(join(second.workspace, "worktree"));
    expect(second.worktree_path).toBe(first.worktree_path);
  });

  it("resume falls back to .canon/worktrees/{slug} for old workspaces", async () => {
    const projectDir = makeTmpProjectDir();
    const baseCommit = initGitFixtureRepo(projectDir);

    // Create workspace at new location first, then simulate an "old" workspace
    // by creating a worktree at the legacy path and pointing the session there
    const first = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );
    assertOk(first);
    expect(first.created).toBe(true);

    // Simulate old path: move the worktree from new to old location
    // Remove new worktree and create one at the legacy path
    const legacyPath = join(projectDir, ".canon", "worktrees", first.slug);
    if (first.worktree_path && existsSync(first.worktree_path)) {
      spawnSync("git", ["worktree", "remove", "--force", first.worktree_path], { cwd: projectDir });
    }
    // Create legacy worktree manually at old path
    const { mkdirSync } = await import("node:fs");
    mkdirSync(legacyPath, { recursive: true });
    spawnSync("git", ["worktree", "add", "--detach", legacyPath, baseCommit], { cwd: projectDir });

    // Clear the persisted worktree_path from the session (simulate old workspace with no persisted path)
    const { getExecutionStore } = await import("@domains/workspaces/execution-store-cache.ts");
    const store = getExecutionStore(first.workspace);
    store.updateExecution({
      worktree_branch: null as unknown as string,
      worktree_path: null as unknown as string,
    });

    // Resume — should fall back to legacy path
    const second = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );
    assertOk(second);
    expect(second.created).toBe(false);
    expect(second.worktree_path).toBeDefined();
    expect(second.worktree_path).toBe(legacyPath);
  });
});
