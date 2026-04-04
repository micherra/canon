/**
 * Tests for init-workspace.ts — SQLite-backed workspace initialization.
 *
 * Covers:
 * - initWorkspaceFlow creates orchestration.db in workspace
 * - Resume detection works via store.getExecution()
 * - listBranchWorkspaces returns active workspaces; skips dirs without DB
 * - No .lock file created during init
 * - No board.json or session.json created
 * - Progress entry exists in DB after init
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock loadAndResolveFlow to avoid needing real flow files
vi.mock("../orchestration/flow-parser.ts", () => ({
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

import { getExecutionStore } from "../orchestration/execution-store.ts";
import { initWorkspaceFlow, listBranchWorkspaces } from "../tools/init-workspace.ts";

let tmpDirs: string[] = [];

function makeTmpProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "init-ws-test-"));
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
  task: "fix the bug",
  tier: "small" as const,
};

// initWorkspaceFlow — SQLite creation

describe("initWorkspaceFlow — SQLite creation", () => {
  it("creates orchestration.db in the workspace directory", async () => {
    const projectDir = makeTmpProjectDir();
    const result = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");

    expect(result.created).toBe(true);
    const dbPath = join(result.workspace, "orchestration.db");
    await expect(access(dbPath)).resolves.toBeUndefined();
  });

  it("does NOT create board.json", async () => {
    const projectDir = makeTmpProjectDir();
    const result = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");

    const boardPath = join(result.workspace, "board.json");
    expect(existsSync(boardPath)).toBe(false);
  });

  it("does NOT create session.json", async () => {
    const projectDir = makeTmpProjectDir();
    const result = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");

    const sessionPath = join(result.workspace, "session.json");
    expect(existsSync(sessionPath)).toBe(false);
  });

  it("does NOT create a .lock file", async () => {
    const projectDir = makeTmpProjectDir();
    const result = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");

    const lockPath = join(result.workspace, ".lock");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("progress entry exists in DB after init", async () => {
    const projectDir = makeTmpProjectDir();
    const result = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");

    const store = getExecutionStore(result.workspace);
    const progress = store.getProgress();
    expect(progress).toContain("fix the bug");
  });

  it("getExecution() succeeds immediately after initWorkspaceFlow returns", async () => {
    const projectDir = makeTmpProjectDir();
    const result = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");

    const store = getExecutionStore(result.workspace);
    const execution = store.getExecution();
    expect(execution).not.toBeNull();
    expect(execution!.task).toBe("fix the bug");
    expect(execution!.status).toBe("active");
  });

  it("returns board and session objects from the store", async () => {
    const projectDir = makeTmpProjectDir();
    const result = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");

    expect(result.board).toBeDefined();
    expect(result.board.flow).toBe("fast-path");
    expect(result.session).toBeDefined();
    expect(result.session.branch).toBe("main");
    expect(result.session.status).toBe("active");
    expect(result.slug).toBeTruthy();
  });

  it("creates standard workspace subdirectories", async () => {
    const projectDir = makeTmpProjectDir();
    const result = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");

    await Promise.all(
      ["research", "decisions", "plans", "reviews"].map((dir) =>
        expect(access(join(result.workspace, dir))).resolves.toBeUndefined(),
      ),
    );
  });
});

// initWorkspaceFlow — resume detection

describe("initWorkspaceFlow — resume detection via store", () => {
  it("returns created:false and existing board when workspace already exists", async () => {
    const projectDir = makeTmpProjectDir();

    // First creation
    const first = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");
    expect(first.created).toBe(true);

    // Second call with same task/branch should detect existing workspace
    const second = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");
    expect(second.created).toBe(false);
    expect(second.workspace).toBe(first.workspace);
    expect(second.resume_state).toBeTruthy();
  });
});

// listBranchWorkspaces

describe("listBranchWorkspaces", () => {
  it("returns workspaces with SQLite DB", async () => {
    const projectDir = makeTmpProjectDir();
    await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");

    const workspaces = await listBranchWorkspaces(projectDir, "main");
    expect(workspaces.length).toBeGreaterThanOrEqual(1);
    expect(workspaces[0].session.status).toBe("active");
  });

  it("silently skips directories without orchestration.db", async () => {
    const projectDir = makeTmpProjectDir();
    // Create a workspace directory without an orchestration.db
    const fakeWsDir = join(projectDir, ".canon", "workspaces", "main", "old-workspace");
    mkdirSync(fakeWsDir, { recursive: true });
    // No orchestration.db written — should be skipped

    const workspaces = await listBranchWorkspaces(projectDir, "main");
    // None of the returned workspaces should be the old directory
    for (const ws of workspaces) {
      expect(ws.workspace).not.toBe(fakeWsDir);
    }
  });

  it("returns empty array for branch with no workspaces", async () => {
    const projectDir = makeTmpProjectDir();
    const workspaces = await listBranchWorkspaces(projectDir, "nonexistent-branch");
    expect(workspaces).toEqual([]);
  });

  it("returns empty array when branch dir does not exist", async () => {
    const projectDir = makeTmpProjectDir();
    const workspaces = await listBranchWorkspaces(projectDir, "feat/some-new-branch");
    expect(workspaces).toEqual([]);
  });
});

// initWorkspaceFlow — concurrent initialization (P1 fix)

describe("initWorkspaceFlow — concurrent initialization race (P1)", () => {
  it("concurrent calls for the same task/branch both succeed — loser resumes instead of throwing", async () => {
    // Demonstrates the check-then-insert race: without the fix, two concurrent
    // calls can both see 'no session' and both try to INSERT the singleton
    // execution row (id=1). The loser throws a SQLITE_CONSTRAINT error.
    // With the fix, the loser catches the constraint error and returns a clean
    // resume (created: false) instead of propagating the error.
    const projectDir = makeTmpProjectDir();

    // Fire both calls simultaneously with the same input (same slug → same DB path)
    const [r1, r2] = await Promise.all([
      initWorkspaceFlow(baseInput, projectDir, "/fake/plugin"),
      initWorkspaceFlow(baseInput, projectDir, "/fake/plugin"),
    ]);

    // Both should resolve without throwing
    expect(r1.workspace).toBeTruthy();
    expect(r2.workspace).toBeTruthy();

    // They should land in the same workspace
    expect(r1.workspace).toBe(r2.workspace);

    // Exactly one created the workspace; the other resumed
    const createdCount = [r1.created, r2.created].filter(Boolean).length;
    // With the fix: exactly one created=true, one created=false
    // We accept both=false as well (if both see the existing row) but NOT a throw
    expect(createdCount).toBeLessThanOrEqual(1);

    // Both board/session results must be valid
    expect(r1.board).toBeDefined();
    expect(r2.board).toBeDefined();
    expect(r1.session.status).toBe("active");
    expect(r2.session.status).toBe("active");
  });
});
