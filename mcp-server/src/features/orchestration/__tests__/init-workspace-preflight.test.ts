/**
 * Tests for init_workspace preflight checks.
 *
 * Covers: git status detection, stale session detection,
 * and backward compatibility when preflight is omitted.
 *
 * Note: .lock file detection removed 2026-03-30 — SQLite WAL handles
 * write serialization; file-based locking is no longer used.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initGitFixtureRepo } from "../../../tests/git-fixture.ts";

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

import { initWorkspaceFlow } from "../tools/init-workspace.ts";

// Scope: Tests preflight gate behavior — dirty git state blocks workspace creation, .lock files are ignored, clean state passes.

let tmpDirs: string[] = [];

function makeTmpProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "preflight-test-"));
  tmpDirs.push(dir);
  return dir;
}

/** Create a tmp dir with an initialized git repo (clean working tree). Returns the HEAD sha. */
function makeTmpGitRepo(): { projectDir: string; baseCommit: string } {
  const projectDir = makeTmpProjectDir();
  const baseCommit = initGitFixtureRepo(projectDir);
  return { baseCommit, projectDir };
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
  task: "fix the bug",
  tier: "small" as const,
};

describe("init_workspace — preflight checks", () => {
  it("skips preflight when preflight option is omitted", async () => {
    const { projectDir, baseCommit } = makeTmpGitRepo();
    const result = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit },
      projectDir,
      "/fake/plugin",
    );
    assertOk(result);

    // Should proceed to create workspace normally
    expect(result.created).toBe(true);
    expect(result.preflight_issues).toBeUndefined();
  });

  it("returns no issues on clean state with preflight: true", async () => {
    const { projectDir, baseCommit } = makeTmpGitRepo();

    const result = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit, preflight: true },
      projectDir,
      "/fake/plugin",
    );
    assertOk(result);

    // Clean state — should proceed to create workspace
    expect(result.created).toBe(true);
    expect(result.preflight_issues).toBeUndefined();
  });

  it("reports uncommitted changes when git working tree is dirty", async () => {
    const { projectDir, baseCommit } = makeTmpGitRepo();

    // Create dirty state
    writeFileSync(join(projectDir, "dirty.txt"), "uncommitted");

    const result = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit, preflight: true },
      projectDir,
      "/fake/plugin",
    );
    assertOk(result);

    expect(result.created).toBe(false);
    expect(result.preflight_issues).toBeDefined();
    expect(result.preflight_issues!.some((i) => i.includes("Uncommitted changes"))).toBe(true);
  });

  it("returns empty workspace and candidate_workspace when preflight has issues", async () => {
    const { projectDir, baseCommit } = makeTmpGitRepo();

    // Create dirty state
    writeFileSync(join(projectDir, "dirty.txt"), "uncommitted");

    const result = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit, preflight: true },
      projectDir,
      "/fake/plugin",
    );
    assertOk(result);

    // workspace must be empty string (not a real path) when preflight fails
    expect(result.workspace).toBe("");
    // candidate_workspace holds the would-be path
    expect(result.candidate_workspace).toBeDefined();
    expect(result.candidate_workspace).toContain("fix-the-bug");
    // preflight_issues explains why
    expect(result.preflight_issues).toBeDefined();
    expect(result.preflight_issues!.length).toBeGreaterThan(0);
  });

  it("workspace contains path and candidate_workspace is undefined when preflight passes", async () => {
    const { projectDir, baseCommit } = makeTmpGitRepo();

    const result = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit, preflight: true },
      projectDir,
      "/fake/plugin",
    );
    assertOk(result);

    // When preflight passes, workspace is set and candidate_workspace is not
    expect(result.workspace).toBeTruthy();
    expect(result.candidate_workspace).toBeUndefined();
    expect(result.created).toBe(true);
  });

  it("does not report a lock issue even when .lock file exists (SQLite handles concurrency)", async () => {
    const projectDir = makeTmpProjectDir();

    // Create a workspace directory with a .lock file (legacy artifact)
    const wsDir = join(projectDir, ".canon", "workspaces", "main", "fix-the-bug");
    mkdirSync(wsDir, { recursive: true });
    const lock = { pid: process.pid, started: new Date().toISOString() };
    writeFileSync(join(wsDir, ".lock"), JSON.stringify(lock));

    // Init git repo (clean) so the git status check passes
    const baseCommit = initGitFixtureRepo(projectDir);

    const result = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit, preflight: true },
      projectDir,
      "/fake/plugin",
    );
    assertOk(result);

    // .lock file is ignored — SQLite WAL handles concurrency
    // The workspace may be created (no lock issues reported)
    expect(result.preflight_issues?.some((i) => i.includes("lock"))).toBeFalsy();
  });
});
