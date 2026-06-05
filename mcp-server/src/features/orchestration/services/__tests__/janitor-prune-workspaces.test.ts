/**
 * Janitor service tests — prune_workspaces task.
 *
 * Split from janitor.test.ts to keep each file under 600 lines.
 */

import { existsSync, utimesSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// --- module mocks ---

vi.mock("@shared/lib/config.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("@shared/lib/config.ts")>();
  return {
    ...original,
    loadJanitorConfig: vi.fn(),
  };
});

vi.mock("@shared/lib/janitor-lock.ts", () => ({
  acquireJanitorLock: vi.fn(),
  commitJanitorLock: vi.fn(),
  getLastJanitorTimestamp: vi.fn(),
  releaseJanitorLock: vi.fn(),
}));

vi.mock("@platform/adapters/git-adapter.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("@platform/adapters/git-adapter.ts")>();
  return {
    ...original,
    gitExec: vi.fn(),
  };
});

vi.mock("@features/history/services/archive-service.ts", () => ({
  archiveWorkspace: vi.fn().mockResolvedValue({
    archive_path: "/tmp/archive",
    archived: true,
    manifest_entry: null,
    run_summary_generated: false,
  }),
}));

// Import after mocks are set up
import { archiveWorkspace } from "@features/history/services/archive-service.ts";
import { gitExec } from "@platform/adapters/git-adapter.ts";
import { loadJanitorConfig } from "@shared/lib/config.ts";
import {
  acquireJanitorLock,
  commitJanitorLock,
  getLastJanitorTimestamp,
  releaseJanitorLock,
} from "@shared/lib/janitor-lock.ts";
import { runJanitor } from "../janitor.ts";

const mockLoadJanitorConfig = loadJanitorConfig as ReturnType<typeof vi.fn>;
const mockAcquireJanitorLock = acquireJanitorLock as ReturnType<typeof vi.fn>;
const mockCommitJanitorLock = commitJanitorLock as ReturnType<typeof vi.fn>;
const mockReleaseJanitorLock = releaseJanitorLock as ReturnType<typeof vi.fn>;
const mockGetLastJanitorTimestamp = getLastJanitorTimestamp as ReturnType<typeof vi.fn>;
const mockGitExec = gitExec as ReturnType<typeof vi.fn>;
const mockArchiveWorkspace = archiveWorkspace as ReturnType<typeof vi.fn>;

type GitResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  duration_ms: number;
};

function makeGitWorktreeListResult(lines: string[]): GitResult {
  return {
    duration_ms: 10,
    exitCode: 0,
    ok: true,
    stderr: "",
    stdout: `${lines.join("\n")}\n`,
    timedOut: false,
  };
}

/** Set the mtime of a path to a past timestamp (ms). */
function setMtime(p: string, ms: number): void {
  const secs = ms / 1000;
  utimesSync(p, secs, secs);
}

let tmpDir: string;
let canonDir: string;
let canonWorkspacesDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "janitor-ws-test-"));
  canonDir = join(tmpDir, ".canon");
  canonWorkspacesDir = join(canonDir, "workspaces");
  await mkdir(canonDir, { recursive: true });

  mockLoadJanitorConfig.mockResolvedValue({
    enabled: true,
    max_abandoned_workspace_age_hours: null,
    min_hours_between_runs: 1,
  });
  mockGetLastJanitorTimestamp.mockResolvedValue(null);
  mockAcquireJanitorLock.mockResolvedValue({ acquired: true, previousMtime: null });
  mockCommitJanitorLock.mockResolvedValue(undefined);
  mockReleaseJanitorLock.mockResolvedValue(undefined);
  mockGitExec.mockReturnValue(makeGitWorktreeListResult([]));
});

afterEach(async () => {
  vi.clearAllMocks();
  await rm(tmpDir, { recursive: true });
});

// --- prune_workspaces task ---

describe("prune_workspaces task", () => {
  const ABANDONED_AGE_HOURS = 48;
  const ABANDONED_AGE_MS = ABANDONED_AGE_HOURS * 60 * 60 * 1000;

  test("skips workspaces with a .lock file (active workspace)", async () => {
    mockLoadJanitorConfig.mockResolvedValue({
      enabled: true,
      max_abandoned_workspace_age_hours: 24,
      min_hours_between_runs: 1,
    });

    const branchDir = join(canonWorkspacesDir, "main");
    const slugDir = join(branchDir, "active-build");
    await mkdir(slugDir, { recursive: true });
    await writeFile(join(slugDir, ".lock"), "pid=1234");

    // Set mtime to 100h ago (well past threshold)
    setMtime(slugDir, Date.now() - 100 * 60 * 60 * 1000);

    const result = await runJanitor(tmpDir);

    expect(result.tasks.prune_workspaces.status).toBe("skipped");
    expect(existsSync(slugDir)).toBe(true);
  });

  test("skips abandoned workspaces younger than max_abandoned_workspace_age_hours", async () => {
    mockLoadJanitorConfig.mockResolvedValue({
      enabled: true,
      max_abandoned_workspace_age_hours: ABANDONED_AGE_HOURS,
      min_hours_between_runs: 1,
    });

    const branchDir = join(canonWorkspacesDir, "main");
    const slugDir = join(branchDir, "recent-build");
    await mkdir(slugDir, { recursive: true });
    // No .completed, no .lock — abandoned workspace

    // Set mtime to 1h ago (younger than 48h threshold)
    setMtime(slugDir, Date.now() - 1 * 60 * 60 * 1000);

    const result = await runJanitor(tmpDir);

    expect(result.tasks.prune_workspaces.status).toBe("skipped");
    expect(existsSync(slugDir)).toBe(true);
  });

  test("archives and removes abandoned workspaces older than max_abandoned_workspace_age_hours", async () => {
    mockLoadJanitorConfig.mockResolvedValue({
      enabled: true,
      max_abandoned_workspace_age_hours: ABANDONED_AGE_HOURS,
      min_hours_between_runs: 1,
    });

    const branchDir = join(canonWorkspacesDir, "main");
    const slugDir = join(branchDir, "stale-build");
    await mkdir(slugDir, { recursive: true });
    // No .completed, no .lock — abandoned workspace

    // Set mtime to 72h ago (past the 48h threshold)
    setMtime(slugDir, Date.now() - 72 * 60 * 60 * 1000);

    const result = await runJanitor(tmpDir);

    expect(result.tasks.prune_workspaces.status).toBe("success");
    expect(result.tasks.prune_workspaces.detail).toContain("1");
    expect(existsSync(slugDir)).toBe(false);
    expect(mockArchiveWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: "main",
        projectDir: tmpDir,
        slug: "stale-build",
        workspacePath: slugDir,
      }),
    );
  });

  test("does NOT prune abandoned workspace (no .completed) when max_abandoned_workspace_age_hours is null", async () => {
    // Default config: max_abandoned_workspace_age_hours = null
    const branchDir = join(canonWorkspacesDir, "main");
    const slugDir = join(branchDir, "abandoned-build");
    await mkdir(slugDir, { recursive: true });
    // No .completed marker — abandoned workspace

    // Make it very old (200h)
    setMtime(slugDir, Date.now() - 200 * 60 * 60 * 1000);

    const result = await runJanitor(tmpDir);

    // Skipped because null means never auto-prune abandoned workspaces
    expect(result.tasks.prune_workspaces.status).toBe("skipped");
    expect(existsSync(slugDir)).toBe(true);
  });

  test("prunes abandoned workspace (no .completed) when older than max_abandoned_workspace_age_hours", async () => {
    mockLoadJanitorConfig.mockResolvedValue({
      enabled: true,
      max_abandoned_workspace_age_hours: 72,
      min_hours_between_runs: 1,
    });

    const branchDir = join(canonWorkspacesDir, "main");
    const slugDir = join(branchDir, "abandoned-build");
    await mkdir(slugDir, { recursive: true });
    // No .completed marker — abandoned workspace

    // Make it old enough (100h > 72h threshold)
    setMtime(slugDir, Date.now() - 100 * 60 * 60 * 1000);

    const result = await runJanitor(tmpDir);

    expect(result.tasks.prune_workspaces.status).toBe("success");
    expect(existsSync(slugDir)).toBe(false);
  });

  test("does NOT prune abandoned workspace younger than max_abandoned_workspace_age_hours", async () => {
    mockLoadJanitorConfig.mockResolvedValue({
      enabled: true,
      max_abandoned_workspace_age_hours: 72,
      min_hours_between_runs: 1,
    });

    const branchDir = join(canonWorkspacesDir, "main");
    const slugDir = join(branchDir, "young-abandoned");
    await mkdir(slugDir, { recursive: true });
    // No .completed marker — abandoned workspace

    // Make it only 12h old (younger than 72h threshold)
    setMtime(slugDir, Date.now() - 12 * 60 * 60 * 1000);

    const result = await runJanitor(tmpDir);

    expect(result.tasks.prune_workspaces.status).toBe("skipped");
    expect(existsSync(slugDir)).toBe(true);
  });

  test("skips abandoned workspace with .lock even when max_abandoned_workspace_age_hours is set", async () => {
    mockLoadJanitorConfig.mockResolvedValue({
      enabled: true,
      max_abandoned_workspace_age_hours: 24,
      min_hours_between_runs: 1,
    });

    const branchDir = join(canonWorkspacesDir, "main");
    const slugDir = join(branchDir, "locked-build");
    await mkdir(slugDir, { recursive: true });
    await writeFile(join(slugDir, ".lock"), "pid=9999");
    // No .completed marker

    setMtime(slugDir, Date.now() - 100 * 60 * 60 * 1000);

    const result = await runJanitor(tmpDir);

    expect(result.tasks.prune_workspaces.status).toBe("skipped");
    expect(existsSync(slugDir)).toBe(true);
  });

  test("removes empty branch directory after all slugs are pruned", async () => {
    mockLoadJanitorConfig.mockResolvedValue({
      enabled: true,
      max_abandoned_workspace_age_hours: ABANDONED_AGE_HOURS,
      min_hours_between_runs: 1,
    });

    const branchDir = join(canonWorkspacesDir, "main");
    const slugDir = join(branchDir, "only-slug");
    await mkdir(slugDir, { recursive: true });
    // No .completed, no .lock — abandoned workspace

    // Make it stale
    setMtime(slugDir, Date.now() - (ABANDONED_AGE_MS + 1000));

    const result = await runJanitor(tmpDir);

    expect(result.tasks.prune_workspaces.status).toBe("success");
    // Both the slug and the now-empty branch dir are gone
    expect(existsSync(slugDir)).toBe(false);
    expect(existsSync(branchDir)).toBe(false);
  });

  test("keeps non-empty branch directory when some slugs are retained", async () => {
    mockLoadJanitorConfig.mockResolvedValue({
      enabled: true,
      max_abandoned_workspace_age_hours: ABANDONED_AGE_HOURS,
      min_hours_between_runs: 1,
    });

    const branchDir = join(canonWorkspacesDir, "main");
    const staleSlug = join(branchDir, "stale-slug");
    const recentSlug = join(branchDir, "recent-slug");
    await mkdir(staleSlug, { recursive: true });
    await mkdir(recentSlug, { recursive: true });
    // Both abandoned (no .completed, no .lock)

    // Make stale-slug old, recent-slug fresh
    setMtime(staleSlug, Date.now() - (ABANDONED_AGE_MS + 1000));
    setMtime(recentSlug, Date.now() - 1 * 60 * 60 * 1000);

    const result = await runJanitor(tmpDir);

    expect(result.tasks.prune_workspaces.status).toBe("success");
    expect(existsSync(staleSlug)).toBe(false);
    expect(existsSync(recentSlug)).toBe(true);
    // Branch dir still exists because recentSlug remains
    expect(existsSync(branchDir)).toBe(true);
  });

  test("needs_prune is true when stale abandoned workspaces are pruned", async () => {
    mockLoadJanitorConfig.mockResolvedValue({
      enabled: true,
      max_abandoned_workspace_age_hours: ABANDONED_AGE_HOURS,
      min_hours_between_runs: 1,
    });

    const branchDir = join(canonWorkspacesDir, "main");
    const slugDir = join(branchDir, "stale-main-build");
    await mkdir(slugDir, { recursive: true });
    // No .completed, no .lock — abandoned workspace

    setMtime(slugDir, Date.now() - (ABANDONED_AGE_MS + 1000));

    const result = await runJanitor(tmpDir);

    expect(result.needs_prune).toBe(true);
  });

  test("prunes abandoned stale workspace under any branch, not just main", async () => {
    mockLoadJanitorConfig.mockResolvedValue({
      enabled: true,
      max_abandoned_workspace_age_hours: ABANDONED_AGE_HOURS,
      min_hours_between_runs: 1,
    });

    const branchDir = join(canonWorkspacesDir, "feat--some-feature");
    const slugDir = join(branchDir, "build-001");
    await mkdir(slugDir, { recursive: true });
    // No .completed, no .lock — abandoned workspace

    setMtime(slugDir, Date.now() - (ABANDONED_AGE_MS + 1000));

    const result = await runJanitor(tmpDir);

    expect(result.tasks.prune_workspaces.status).toBe("success");
    expect(existsSync(slugDir)).toBe(false);
  });

  test("runs git worktree remove before rmSync when workspace contains a worktree/ subdirectory", async () => {
    mockLoadJanitorConfig.mockResolvedValue({
      enabled: true,
      max_abandoned_workspace_age_hours: ABANDONED_AGE_HOURS,
      min_hours_between_runs: 1,
    });

    const branchDir = join(canonWorkspacesDir, "main");
    const slugDir = join(branchDir, "worktree-build");
    const worktreeSubDir = join(slugDir, "worktree");
    await mkdir(worktreeSubDir, { recursive: true });
    // No .lock — abandoned workspace

    setMtime(slugDir, Date.now() - (ABANDONED_AGE_MS + 1000));

    const expectedWorktreePath = worktreeSubDir;

    mockGitExec.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return makeGitWorktreeListResult([]);
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        return { duration_ms: 10, exitCode: 0, ok: true, stderr: "", stdout: "", timedOut: false };
      }
      return makeGitWorktreeListResult([]);
    });

    const result = await runJanitor(tmpDir);

    expect(result.tasks.prune_workspaces.status).toBe("success");
    expect(mockGitExec).toHaveBeenCalledWith(
      ["worktree", "remove", "--force", expectedWorktreePath],
      tmpDir,
    );
    expect(existsSync(slugDir)).toBe(false);
  });

  test("proceeds with rmSync when git worktree remove fails", async () => {
    mockLoadJanitorConfig.mockResolvedValue({
      enabled: true,
      max_abandoned_workspace_age_hours: ABANDONED_AGE_HOURS,
      min_hours_between_runs: 1,
    });

    const branchDir = join(canonWorkspacesDir, "main");
    const slugDir = join(branchDir, "worktree-fail-build");
    const worktreeSubDir = join(slugDir, "worktree");
    await mkdir(worktreeSubDir, { recursive: true });
    // No .lock — abandoned workspace

    setMtime(slugDir, Date.now() - (ABANDONED_AGE_MS + 1000));

    mockGitExec.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return makeGitWorktreeListResult([]);
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        return {
          duration_ms: 5,
          exitCode: 128,
          ok: false,
          stderr: "not a worktree",
          stdout: "",
          timedOut: false,
        };
      }
      return makeGitWorktreeListResult([]);
    });

    const result = await runJanitor(tmpDir);

    // rmSync ran despite worktree remove failure
    expect(result.tasks.prune_workspaces.status).toBe("success");
    expect(existsSync(slugDir)).toBe(false);
  });

  test("does not call git worktree remove when workspace has no worktree/ subdirectory", async () => {
    mockLoadJanitorConfig.mockResolvedValue({
      enabled: true,
      max_abandoned_workspace_age_hours: ABANDONED_AGE_HOURS,
      min_hours_between_runs: 1,
    });

    const branchDir = join(canonWorkspacesDir, "main");
    const slugDir = join(branchDir, "no-worktree-build");
    // Create slug dir WITHOUT a worktree/ subdirectory
    await mkdir(slugDir, { recursive: true });
    // No .lock — abandoned workspace

    setMtime(slugDir, Date.now() - (ABANDONED_AGE_MS + 1000));

    const result = await runJanitor(tmpDir);

    expect(result.tasks.prune_workspaces.status).toBe("success");
    // gitExec should only be called for worktree list (from pruneWorktreesTask), NOT for worktree remove
    const removeCall = mockGitExec.mock.calls.find(
      (args: string[][]) => args[0][0] === "worktree" && args[0][1] === "remove",
    );
    expect(removeCall).toBeUndefined();
    expect(existsSync(slugDir)).toBe(false);
  });
});

// --- prune_husk_dirs task ---

describe("prune_husk_dirs task", () => {
  test("removes a completely empty top-level branch dir and reports count", async () => {
    // Create a completely empty branch dir (husk)
    const huskDir = join(canonWorkspacesDir, "canon--adopt-release-please");
    await mkdir(huskDir, { recursive: true });

    const result = await runJanitor(tmpDir);

    expect(result.tasks.prune_husk_dirs).toBeDefined();
    expect(result.tasks.prune_husk_dirs.status).toBe("success");
    expect(result.tasks.prune_husk_dirs.detail).toContain("1");
    expect(existsSync(huskDir)).toBe(false);
  });

  test("does not remove a non-empty top-level branch dir", async () => {
    // Create a branch dir with a slug subdir inside it
    const branchDir = join(canonWorkspacesDir, "canon--http-epic-1b");
    const slugDir = join(branchDir, "my-workspace-slug");
    await mkdir(slugDir, { recursive: true });

    const result = await runJanitor(tmpDir);

    expect(result.tasks.prune_husk_dirs.status).toBe("skipped");
    expect(existsSync(branchDir)).toBe(true);
    expect(existsSync(slugDir)).toBe(true);
  });

  test("reports skipped with message when no husk dirs exist", async () => {
    // No workspaces dir at all
    const result = await runJanitor(tmpDir);

    expect(result.tasks.prune_husk_dirs).toBeDefined();
    expect(result.tasks.prune_husk_dirs.status).toBe("skipped");
  });

  test("sets needs_prune true when husk dirs are removed", async () => {
    const huskDir = join(canonWorkspacesDir, "canon--empty-husk");
    await mkdir(huskDir, { recursive: true });

    const result = await runJanitor(tmpDir);

    expect(result.needs_prune).toBe(true);
  });

  test("removes multiple empty husk dirs and reports total count", async () => {
    const husk1 = join(canonWorkspacesDir, "canon--husk-one");
    const husk2 = join(canonWorkspacesDir, "canon--husk-two");
    const husk3 = join(canonWorkspacesDir, "canon--husk-three");
    await mkdir(husk1, { recursive: true });
    await mkdir(husk2, { recursive: true });
    await mkdir(husk3, { recursive: true });

    const result = await runJanitor(tmpDir);

    expect(result.tasks.prune_husk_dirs.status).toBe("success");
    expect(result.tasks.prune_husk_dirs.detail).toContain("3");
    expect(existsSync(husk1)).toBe(false);
    expect(existsSync(husk2)).toBe(false);
    expect(existsSync(husk3)).toBe(false);
  });

  test("skips non-directory entries under workspaces dir", async () => {
    // A file (not dir) at the top level of workspaces should not be touched
    await mkdir(canonWorkspacesDir, { recursive: true });
    const aFile = join(canonWorkspacesDir, "somefile.json");
    await writeFile(aFile, "{}");

    const result = await runJanitor(tmpDir);

    // The file is not a directory — should not be removed
    expect(existsSync(aFile)).toBe(true);
    expect(result.tasks.prune_husk_dirs.status).toBe("skipped");
  });
});
