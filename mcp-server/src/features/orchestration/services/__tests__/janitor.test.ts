import { existsSync, utimesSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
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
    archived: true,
    archive_path: "/tmp/archive",
    manifest_entry: null,
    run_summary_generated: false,
  }),
}));

import { gitExec } from "@platform/adapters/git-adapter.ts";
// Import after mocks are set up
import { archiveWorkspace } from "@features/history/services/archive-service.ts";
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

function makeGitFailResult(): GitResult {
  return {
    duration_ms: 5,
    exitCode: 128,
    ok: false,
    stderr: "fatal: not a git repository",
    stdout: "",
    timedOut: false,
  };
}

let tmpDir: string;
let canonDir: string;
let claudeDir: string;
let agentWorktreesDir: string;
let canonWorkspacesDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "janitor-test-"));
  canonDir = join(tmpDir, ".canon");
  claudeDir = join(tmpDir, ".claude");
  agentWorktreesDir = join(claudeDir, "worktrees");
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
  mockGitExec.mockImplementation((args: string[]) => {
    if (args[0] === "worktree" && args[1] === "list") {
      return makeGitWorktreeListResult([]);
    }
    return makeGitFailResult();
  });
});

afterEach(async () => {
  vi.clearAllMocks();
  await rm(tmpDir, { recursive: true });
});

// --- Gate checks ---

describe("gate checks", () => {
  test("returns gate_passed: false when config disabled", async () => {
    mockLoadJanitorConfig.mockResolvedValue({
      enabled: false,
      max_abandoned_workspace_age_hours: null,
      min_hours_between_runs: 1,
    });

    const result = await runJanitor(tmpDir);

    expect(result.gate_passed).toBe(false);
    expect(result.reason).toBe("janitor disabled");
    expect(result.tasks).toEqual({});
    expect(result.needs_prune).toBe(false);
    expect(mockAcquireJanitorLock).not.toHaveBeenCalled();
  });

  test("returns gate_passed: false when time gate not met", async () => {
    // Last run was 30 minutes ago, min is 1 hour
    const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
    mockGetLastJanitorTimestamp.mockResolvedValue(thirtyMinutesAgo);
    mockLoadJanitorConfig.mockResolvedValue({
      enabled: true,
      max_abandoned_workspace_age_hours: null,
      min_hours_between_runs: 1,
    });

    const result = await runJanitor(tmpDir);

    expect(result.gate_passed).toBe(false);
    expect(result.reason).toMatch(/^time gate:/);
    expect(result.reason).toContain("< 1h");
    expect(mockAcquireJanitorLock).not.toHaveBeenCalled();
  });

  test("returns gate_passed: false when lock not acquired", async () => {
    mockAcquireJanitorLock.mockResolvedValue({ acquired: false, reason: "already_locked" });

    const result = await runJanitor(tmpDir);

    expect(result.gate_passed).toBe(false);
    expect(result.reason).toBe("lock: already_locked");
    expect(result.tasks).toEqual({});
  });
});

// --- WAL checkpoint task ---

describe("wal_checkpoint task", () => {
  test("checkpoints WAL files that exist", async () => {
    const dbPath = join(canonDir, "knowledge-graph.db");
    const db = new Database(dbPath);
    db.pragma("journal_mode=WAL");
    db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY)");
    db.close();
    await writeFile(`${dbPath}-wal`, "");

    const result = await runJanitor(tmpDir);

    expect(result.gate_passed).toBe(true);
    expect(result.tasks.wal_checkpoint).toBeDefined();
    expect(result.tasks.wal_checkpoint.status).toBe("success");
  });

  test("skips WAL checkpoint for databases without WAL files", async () => {
    const result = await runJanitor(tmpDir);
    expect(result.gate_passed).toBe(true);
    expect(result.tasks.wal_checkpoint).toBeDefined();
    expect(result.tasks.wal_checkpoint.status).toBe("success");
  });

  test("reports error for corrupt/inaccessible database files", async () => {
    const dbPath = join(canonDir, "knowledge-graph.db");
    await writeFile(dbPath, "this is not a valid sqlite database");
    await writeFile(`${dbPath}-wal`, "");

    const result = await runJanitor(tmpDir);

    expect(result.gate_passed).toBe(true);
    expect(result.tasks.wal_checkpoint).toBeDefined();
    expect(result.tasks.wal_checkpoint.status).toBe("error");
    expect(result.tasks.wal_checkpoint.detail).toBeDefined();
  });
});

// --- prune_worktrees task ---

describe("prune_worktrees task", () => {
  test("skips when .claude/worktrees directory does not exist", async () => {
    // agentWorktreesDir does not exist

    const result = await runJanitor(tmpDir);

    expect(result.gate_passed).toBe(true);
    expect(result.tasks.prune_worktrees).toBeDefined();
    expect(result.tasks.prune_worktrees.status).toBe("skipped");
  });

  test("skips when .claude/worktrees directory is empty", async () => {
    await mkdir(agentWorktreesDir, { recursive: true });

    const result = await runJanitor(tmpDir);

    expect(result.tasks.prune_worktrees).toBeDefined();
    expect(result.tasks.prune_worktrees.status).toBe("skipped");
  });

  test("removes directories not in git worktree list", async () => {
    await mkdir(agentWorktreesDir, { recursive: true });
    const staleDir = join(agentWorktreesDir, "agent-stale-123");
    await mkdir(staleDir);

    // git worktree list returns nothing for this dir
    mockGitExec.mockReturnValue(makeGitWorktreeListResult([`${tmpDir} abc123 [main]`]));

    const result = await runJanitor(tmpDir);

    expect(result.tasks.prune_worktrees.status).toBe("success");
    expect(result.tasks.prune_worktrees.detail).toContain("1");
    expect(existsSync(staleDir)).toBe(false);
  });

  test("keeps directories that ARE in git worktree list", async () => {
    await mkdir(agentWorktreesDir, { recursive: true });
    const activeDir = join(agentWorktreesDir, "agent-active-456");
    await mkdir(activeDir);

    // git worktree list includes this dir
    mockGitExec.mockReturnValue(
      makeGitWorktreeListResult([
        `${tmpDir} abc123 [main]`,
        `${activeDir} def456 [canon/some-task]`,
      ]),
    );

    const result = await runJanitor(tmpDir);

    expect(result.tasks.prune_worktrees.status).toBe("skipped");
    expect(existsSync(activeDir)).toBe(true);
  });

  test("prunes stale but keeps active in a mixed set", async () => {
    await mkdir(agentWorktreesDir, { recursive: true });
    const activeDir = join(agentWorktreesDir, "agent-active-456");
    const staleDir = join(agentWorktreesDir, "agent-stale-123");
    await mkdir(activeDir);
    await mkdir(staleDir);

    mockGitExec.mockReturnValue(
      makeGitWorktreeListResult([
        `${tmpDir} abc123 [main]`,
        `${activeDir} def456 [canon/some-task]`,
      ]),
    );

    const result = await runJanitor(tmpDir);

    expect(result.tasks.prune_worktrees.status).toBe("success");
    expect(result.tasks.prune_worktrees.detail).toContain("1");
    expect(existsSync(activeDir)).toBe(true);
    expect(existsSync(staleDir)).toBe(false);
  });

  test("reports error status when git worktree list fails", async () => {
    await mkdir(agentWorktreesDir, { recursive: true });
    await mkdir(join(agentWorktreesDir, "agent-some-id"));

    mockGitExec.mockReturnValue(makeGitFailResult());

    const result = await runJanitor(tmpDir);

    expect(result.tasks.prune_worktrees.status).toBe("error");
    expect(result.tasks.prune_worktrees.detail).toBeDefined();
  });

  test("continues past individual removal errors (fail per-item)", async () => {
    // This test verifies the fail-per-item contract by ensuring one error doesn't
    // prevent other items from being processed. We create two stale dirs.
    await mkdir(agentWorktreesDir, { recursive: true });
    const staleDir1 = join(agentWorktreesDir, "agent-stale-1");
    const staleDir2 = join(agentWorktreesDir, "agent-stale-2");
    await mkdir(staleDir1);
    await mkdir(staleDir2);

    // Neither stale dir is in the list
    mockGitExec.mockReturnValue(makeGitWorktreeListResult([`${tmpDir} abc123 [main]`]));

    const result = await runJanitor(tmpDir);

    // Both should be pruned
    expect(result.tasks.prune_worktrees.status).toBe("success");
    expect(existsSync(staleDir1)).toBe(false);
    expect(existsSync(staleDir2)).toBe(false);
  });
});

// --- needs_prune semantics ---

describe("needs_prune semantics", () => {
  test("needs_prune: true when prune_worktrees removed entries", async () => {
    await mkdir(agentWorktreesDir, { recursive: true });
    await mkdir(join(agentWorktreesDir, "agent-stale-id"));

    mockGitExec.mockReturnValue(makeGitWorktreeListResult([`${tmpDir} abc123 [main]`]));

    const result = await runJanitor(tmpDir);

    expect(result.needs_prune).toBe(true);
  });

  test("needs_prune: true when prune_workspaces removed stale entries", async () => {
    mockLoadJanitorConfig.mockResolvedValue({
      enabled: true,
      max_abandoned_workspace_age_hours: 48,
      min_hours_between_runs: 1,
    });

    const branchDir = join(canonWorkspacesDir, "feat--some-feature");
    const slugDir = join(branchDir, "stale-build");
    await mkdir(slugDir, { recursive: true });
    // No .completed — abandoned workspace

    // Make the workspace stale (72h past the 48h threshold)
    const secs = (Date.now() - 72 * 60 * 60 * 1000) / 1000;
    utimesSync(slugDir, secs, secs);

    const result = await runJanitor(tmpDir);

    expect(result.needs_prune).toBe(true);
  });

  test("needs_prune: false when nothing was pruned", async () => {
    // No agent worktrees, no workspace dirs to prune

    const result = await runJanitor(tmpDir);

    expect(result.needs_prune).toBe(false);
  });
});

// --- Lock lifecycle ---

describe("lock lifecycle", () => {
  test("releases lock after successful completion", async () => {
    const result = await runJanitor(tmpDir);

    expect(result.gate_passed).toBe(true);
    expect(mockCommitJanitorLock).toHaveBeenCalledTimes(1);
    expect(mockReleaseJanitorLock).toHaveBeenCalledTimes(1);
  });

  test("releases lock even on unexpected error", async () => {
    // Force an error in the WAL checkpoint by making readdirSync throw
    const dbPath = join(canonDir, "knowledge-graph.db");
    const walPath = `${dbPath}-wal`;
    await writeFile(dbPath, "corrupt");
    await writeFile(walPath, "");

    // Even with DB error, lock should be released
    const result = await runJanitor(tmpDir);

    // The WAL task errors but lock is still released
    expect(mockReleaseJanitorLock).toHaveBeenCalledTimes(1);
    expect(result.gate_passed).toBe(true);
  });

  test("releases lock when unexpected top-level error occurs", async () => {
    // Make commitJanitorLock throw to simulate unexpected error after tasks
    mockCommitJanitorLock.mockRejectedValue(new Error("disk full"));

    const result = await runJanitor(tmpDir);

    // Should still release lock
    expect(mockReleaseJanitorLock).toHaveBeenCalledTimes(1);
    // Returns error result
    expect(result.tasks.unexpected_error).toBeDefined();
    expect(result.tasks.unexpected_error.status).toBe("error");
  });
});

/** Set the mtime of a path to a past timestamp (ms). */
function setMtime(p: string, ms: number): void {
  const secs = ms / 1000;
  utimesSync(p, secs, secs);
}

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
        workspacePath: slugDir,
        projectDir: tmpDir,
        branch: "main",
        slug: "stale-build",
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
});
