/** orchestration-journal — archive-only contract tests (no destructive teardown). */
// Main tests live in orchestration-journal.test.ts

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock git-adapter before importing modules that use it
vi.mock("@platform/adapters/git-adapter.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("@platform/adapters/git-adapter.ts")>();
  return {
    ...original,
    gitExec: vi.fn(),
  };
});

import { gitExec } from "@platform/adapters/git-adapter.ts";
import { assertOk } from "../../../../shared/lib/tool-result.ts";
import { finalizeWorkspace, logStep } from "../orchestration-journal.ts";

const mockGitExec = gitExec as ReturnType<typeof vi.fn>;

let workspace: string;
let projectDir: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "canon-journal-wt-"));
  projectDir = await mkdtemp(join(tmpdir(), "canon-journal-wt-proj-"));
});

afterEach(async () => {
  await rm(workspace, { force: true, recursive: true });
  await rm(projectDir, { force: true, recursive: true });
});

// ─── finalize archives but does not tear down ────────────────────────────────
describe("finalize archives but does not tear down", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: git would succeed if called (it must NOT be called for teardown)
    mockGitExec.mockReturnValue({
      duration_ms: 5,
      exitCode: 0,
      ok: true,
      stderr: "",
      stdout: "",
      timedOut: false,
    });
  });

  test("does NOT call git worktree remove when worktree/ subdir exists, and worktree survives", async () => {
    // Arrange: create a workspace with a completed step and a worktree/ subdir
    const worktreePath = join(workspace, "worktree");
    mkdirSync(worktreePath, { recursive: true });
    mkdirSync(join(workspace, "plans"), { recursive: true });
    writeFileSync(join(workspace, "plans", "DESIGN.md"), "# Design\n");

    await logStep({
      agent_id: "test-agent-wt1",
      artifacts_expected: ["plans/DESIGN.md"],
      status: "completed",
      step_id: "design",
      workspace,
      projectDir,
    });

    // Act: finalizeWorkspace with complete: true must NOT call git worktree remove
    const result = await finalizeWorkspace({ projectDir, workspace });
    assertOk(result);
    expect(result.complete).toBe(true);

    // Assert: gitExec was NOT called with worktree remove
    expect(mockGitExec).not.toHaveBeenCalledWith(
      expect.arrayContaining(["worktree", "remove"]),
      expect.any(String),
    );
    // Assert: gitExec was NOT called with branch -D
    expect(mockGitExec).not.toHaveBeenCalledWith(
      expect.arrayContaining(["branch", "-D"]),
      expect.any(String),
    );
    // Assert: the worktree subdir still exists (not deleted)
    expect(existsSync(worktreePath)).toBe(true);
    // Assert: the workspace dir still exists (no rmSync)
    expect(existsSync(workspace)).toBe(true);
    // Assert: teardown is deferred and observable
    expect(result.teardown_deferred).toBe(true);
    // Assert: workspace was archived
    expect(result.workspace_archived).toBe(true);
  });

  test("does NOT call git worktree remove even when git would fail, and worktree still survives", async () => {
    // Arrange: even if git would fail (should never be called anyway)
    mockGitExec.mockReturnValue({
      duration_ms: 5,
      exitCode: 128,
      ok: false,
      stderr: "fatal: not a git repository",
      stdout: "",
      timedOut: false,
    });

    const worktreePath = join(workspace, "worktree");
    mkdirSync(worktreePath, { recursive: true });
    mkdirSync(join(workspace, "plans"), { recursive: true });
    writeFileSync(join(workspace, "plans", "DESIGN.md"), "# Design\n");

    await logStep({
      agent_id: "test-agent-wt2",
      artifacts_expected: ["plans/DESIGN.md"],
      status: "completed",
      step_id: "design",
      workspace,
      projectDir,
    });

    // Act
    const result = await finalizeWorkspace({ projectDir, workspace });
    assertOk(result);
    expect(result.complete).toBe(true);

    // Assert: gitExec was NOT called for worktree remove or branch -D
    expect(mockGitExec).not.toHaveBeenCalledWith(
      expect.arrayContaining(["worktree", "remove"]),
      expect.any(String),
    );
    expect(mockGitExec).not.toHaveBeenCalledWith(
      expect.arrayContaining(["branch", "-D"]),
      expect.any(String),
    );
    // Both the worktree subdir and workspace still exist
    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(workspace)).toBe(true);
    // Teardown is deferred
    expect(result.teardown_deferred).toBe(true);
  });

  test("when worktree/ subdir does not exist, still does NOT call git worktree remove and workspace survives", async () => {
    // Arrange: no worktree/ subdirectory
    mkdirSync(join(workspace, "plans"), { recursive: true });
    writeFileSync(join(workspace, "plans", "DESIGN.md"), "# Design\n");

    await logStep({
      agent_id: "test-agent-wt3",
      artifacts_expected: ["plans/DESIGN.md"],
      status: "completed",
      step_id: "design",
      workspace,
      projectDir,
    });

    // Act
    const result = await finalizeWorkspace({ projectDir, workspace });
    assertOk(result);
    expect(result.complete).toBe(true);

    // Assert: gitExec was NOT called for worktree remove (it never should be now)
    expect(mockGitExec).not.toHaveBeenCalledWith(
      expect.arrayContaining(["worktree", "remove"]),
      expect.any(String),
    );
    expect(mockGitExec).not.toHaveBeenCalledWith(
      expect.arrayContaining(["branch", "-D"]),
      expect.any(String),
    );
    // Workspace still exists
    expect(existsSync(workspace)).toBe(true);
    // Teardown is deferred
    expect(result.teardown_deferred).toBe(true);
  });
});
