/** orchestration-journal — git worktree deregistration tests (line-count split). */
// Main tests live in orchestration-journal.test.ts

import { mkdirSync, writeFileSync } from "node:fs";
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

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "canon-journal-wt-"));
});

afterEach(async () => {
  await rm(workspace, { force: true, recursive: true });
});

// ─── archiveAndDeleteWorkspace — git worktree remove ────────────────────────
describe("archiveAndDeleteWorkspace — git worktree deregistration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: git worktree remove succeeds
    mockGitExec.mockReturnValue({
      duration_ms: 5,
      exitCode: 0,
      ok: true,
      stderr: "",
      stdout: "",
      timedOut: false,
    });
  });

  test("calls git worktree remove --force before rmSync when worktree/ subdirectory exists", async () => {
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

      projectDir: process.cwd(),    });

    // Act: finalizeWorkspace with complete: true triggers archiveAndDeleteWorkspace
    const result = await finalizeWorkspace({ projectDir: process.cwd(), workspace });
    assertOk(result);
    expect(result.complete).toBe(true);

    // Assert: gitExec was called with worktree remove --force args
    expect(mockGitExec).toHaveBeenCalledWith(
      ["worktree", "remove", "--force", worktreePath],
      expect.any(String),
    );
    // gitExec call must appear before rmSync (workspace is gone after complete)
    expect(result.workspace_deleted).toBe(true);
  });

  test("rmSync still proceeds (workspace_deleted: true) when gitExec fails for worktree removal", async () => {
    // Arrange: git worktree remove fails
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

      projectDir: process.cwd(),    });

    // Act
    const result = await finalizeWorkspace({ projectDir: process.cwd(), workspace });
    assertOk(result);
    expect(result.complete).toBe(true);

    // Assert: gitExec was called (attempted), and workspace was still deleted despite failure
    expect(mockGitExec).toHaveBeenCalledWith(
      ["worktree", "remove", "--force", worktreePath],
      expect.any(String),
    );
    expect(result.workspace_deleted).toBe(true);
  });

  test("skips git worktree remove when worktree/ subdirectory does not exist", async () => {
    // Arrange: no worktree/ subdirectory
    mkdirSync(join(workspace, "plans"), { recursive: true });
    writeFileSync(join(workspace, "plans", "DESIGN.md"), "# Design\n");

    await logStep({
      agent_id: "test-agent-wt3",
      artifacts_expected: ["plans/DESIGN.md"],
      status: "completed",
      step_id: "design",
      workspace,

      projectDir: process.cwd(),    });

    // Act
    const result = await finalizeWorkspace({ projectDir: process.cwd(), workspace });
    assertOk(result);
    expect(result.complete).toBe(true);

    // Assert: gitExec was NOT called since no worktree/ exists
    expect(mockGitExec).not.toHaveBeenCalledWith(
      expect.arrayContaining(["worktree", "remove"]),
      expect.any(String),
    );
    expect(result.workspace_deleted).toBe(true);
  });
});
