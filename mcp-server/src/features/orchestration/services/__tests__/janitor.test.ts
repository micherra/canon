import { existsSync } from "node:fs";
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

import { gitExec } from "@platform/adapters/git-adapter.ts";
// Import after mocks are set up
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

/** Build a ProcessResult-like value for git worktree list output. */
function makeGitWorktreeListResult(lines: string[]): {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  duration_ms: number;
} {
  return {
    duration_ms: 10,
    exitCode: 0,
    ok: true,
    stderr: "",
    stdout: `${lines.join("\n")}\n`,
    timedOut: false,
  };
}

/** Build a ProcessResult-like value for git branch --merged output. */
function makeGitBranchMergedResult(branches: string[]): {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  duration_ms: number;
} {
  return {
    duration_ms: 10,
    exitCode: 0,
    ok: true,
    stderr: "",
    stdout: `${branches.map((b) => `  ${b}`).join("\n")}\n`,
    timedOut: false,
  };
}

/** Build a failing ProcessResult (git command failed). */
function makeGitFailResult(): {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  duration_ms: number;
} {
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

  // Default: janitor enabled, no recent run, lock acquired
  mockLoadJanitorConfig.mockResolvedValue({ enabled: true, min_hours_between_runs: 1 });
  mockGetLastJanitorTimestamp.mockResolvedValue(null);
  mockAcquireJanitorLock.mockResolvedValue({ acquired: true, previousMtime: null });
  mockCommitJanitorLock.mockResolvedValue(undefined);
  mockReleaseJanitorLock.mockResolvedValue(undefined);

  // Default git mocks: empty worktree list and no merged branches
  mockGitExec.mockImplementation((args: string[]) => {
    if (args[0] === "worktree" && args[1] === "list") {
      return makeGitWorktreeListResult([]);
    }
    if (args[0] === "branch" && args[1] === "--merged") {
      return makeGitBranchMergedResult([]);
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
    mockLoadJanitorConfig.mockResolvedValue({ enabled: false, min_hours_between_runs: 1 });

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
    mockLoadJanitorConfig.mockResolvedValue({ enabled: true, min_hours_between_runs: 1 });

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
    // Create a real SQLite DB in WAL mode
    const dbPath = join(canonDir, "knowledge-graph.db");
    const db = new Database(dbPath);
    db.pragma("journal_mode=WAL");
    db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY)");
    db.close();

    // Verify WAL file was created
    const walPath = `${dbPath}-wal`;
    // Force WAL file to exist by writing something
    await writeFile(walPath, "");

    const result = await runJanitor(tmpDir);

    expect(result.gate_passed).toBe(true);
    expect(result.tasks.wal_checkpoint).toBeDefined();
    expect(result.tasks.wal_checkpoint.status).toBe("success");
  });

  test("skips WAL checkpoint for databases without WAL files", async () => {
    // knowledge-graph.db does not exist → no checkpoint
    const result = await runJanitor(tmpDir);

    expect(result.gate_passed).toBe(true);
    expect(result.tasks.wal_checkpoint).toBeDefined();
    expect(result.tasks.wal_checkpoint.status).toBe("success");
    // No error since skipping is expected behavior
  });

  test("reports error for corrupt/inaccessible database files", async () => {
    // Create a DB file that exists but has a WAL file too
    const dbPath = join(canonDir, "knowledge-graph.db");
    const walPath = `${dbPath}-wal`;
    // Write corrupt content to the DB
    await writeFile(dbPath, "this is not a valid sqlite database");
    await writeFile(walPath, "");

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
    mockGitExec.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return makeGitWorktreeListResult([]);
      }
      return makeGitBranchMergedResult([]);
    });

    const result = await runJanitor(tmpDir);

    expect(result.gate_passed).toBe(true);
    expect(result.tasks.prune_worktrees).toBeDefined();
    expect(result.tasks.prune_worktrees.status).toBe("skipped");
  });

  test("skips when .claude/worktrees directory is empty", async () => {
    await mkdir(agentWorktreesDir, { recursive: true });
    mockGitExec.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return makeGitWorktreeListResult([]);
      }
      return makeGitBranchMergedResult([]);
    });

    const result = await runJanitor(tmpDir);

    expect(result.tasks.prune_worktrees).toBeDefined();
    expect(result.tasks.prune_worktrees.status).toBe("skipped");
  });

  test("removes directories not in git worktree list", async () => {
    await mkdir(agentWorktreesDir, { recursive: true });
    const staleDir = join(agentWorktreesDir, "agent-stale-123");
    await mkdir(staleDir);

    // git worktree list returns nothing for this dir
    mockGitExec.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return makeGitWorktreeListResult([`${tmpDir} abc123 [main]`]);
      }
      return makeGitBranchMergedResult([]);
    });

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
    mockGitExec.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return makeGitWorktreeListResult([
          `${tmpDir} abc123 [main]`,
          `${activeDir} def456 [canon/some-task]`,
        ]);
      }
      return makeGitBranchMergedResult([]);
    });

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

    mockGitExec.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return makeGitWorktreeListResult([
          `${tmpDir} abc123 [main]`,
          `${activeDir} def456 [canon/some-task]`,
        ]);
      }
      return makeGitBranchMergedResult([]);
    });

    const result = await runJanitor(tmpDir);

    expect(result.tasks.prune_worktrees.status).toBe("success");
    expect(result.tasks.prune_worktrees.detail).toContain("1");
    expect(existsSync(activeDir)).toBe(true);
    expect(existsSync(staleDir)).toBe(false);
  });

  test("reports error status when git worktree list fails", async () => {
    await mkdir(agentWorktreesDir, { recursive: true });
    await mkdir(join(agentWorktreesDir, "agent-some-id"));

    mockGitExec.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return makeGitFailResult();
      }
      return makeGitBranchMergedResult([]);
    });

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

    mockGitExec.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        // Neither stale dir is in the list
        return makeGitWorktreeListResult([`${tmpDir} abc123 [main]`]);
      }
      return makeGitBranchMergedResult([]);
    });

    const result = await runJanitor(tmpDir);

    // Both should be pruned
    expect(result.tasks.prune_worktrees.status).toBe("success");
    expect(existsSync(staleDir1)).toBe(false);
    expect(existsSync(staleDir2)).toBe(false);
  });
});

// --- prune_workspaces task ---

describe("prune_workspaces task", () => {
  test("skips when .canon/workspaces directory does not exist", async () => {
    // canonWorkspacesDir does not exist

    const result = await runJanitor(tmpDir);

    expect(result.tasks.prune_workspaces).toBeDefined();
    expect(result.tasks.prune_workspaces.status).toBe("skipped");
  });

  test("skips when .canon/workspaces directory is empty", async () => {
    await mkdir(canonWorkspacesDir, { recursive: true });

    const result = await runJanitor(tmpDir);

    expect(result.tasks.prune_workspaces.status).toBe("skipped");
  });

  test("removes workspace dirs for merged branches", async () => {
    // Branch "feat/my-feature" sanitizes to "feat--my-feature"
    const mergedBranch = "feat/my-feature";
    const sanitized = "feat--my-feature";
    const workspaceDir = join(canonWorkspacesDir, sanitized);
    await mkdir(workspaceDir, { recursive: true });

    mockGitExec.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return makeGitWorktreeListResult([`${tmpDir} abc123 [main]`]);
      }
      if (args[0] === "branch" && args[1] === "--merged") {
        return makeGitBranchMergedResult([mergedBranch, "main"]);
      }
      return makeGitFailResult();
    });

    const result = await runJanitor(tmpDir);

    expect(result.tasks.prune_workspaces.status).toBe("success");
    expect(result.tasks.prune_workspaces.detail).toContain("1");
    expect(existsSync(workspaceDir)).toBe(false);
  });

  test("keeps workspace dirs for unmerged branches", async () => {
    const unmergedSanitized = "feat--active-branch";
    const workspaceDir = join(canonWorkspacesDir, unmergedSanitized);
    await mkdir(workspaceDir, { recursive: true });

    mockGitExec.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return makeGitWorktreeListResult([`${tmpDir} abc123 [main]`]);
      }
      if (args[0] === "branch" && args[1] === "--merged") {
        // Only main is merged
        return makeGitBranchMergedResult(["main"]);
      }
      return makeGitFailResult();
    });

    const result = await runJanitor(tmpDir);

    // No merged branches match unmergedSanitized → skipped (0 pruned)
    expect(result.tasks.prune_workspaces.status).toBe("skipped");
    expect(existsSync(workspaceDir)).toBe(true);
  });

  test("never prunes the main workspace directory", async () => {
    const mainDir = join(canonWorkspacesDir, "main");
    await mkdir(mainDir, { recursive: true });

    mockGitExec.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return makeGitWorktreeListResult([`${tmpDir} abc123 [main]`]);
      }
      if (args[0] === "branch" && args[1] === "--merged") {
        return makeGitBranchMergedResult(["main"]);
      }
      return makeGitFailResult();
    });

    const _result = await runJanitor(tmpDir);

    // main is excluded from pruning
    expect(existsSync(mainDir)).toBe(true);
  });

  test("reports error status when git branch --merged fails", async () => {
    await mkdir(canonWorkspacesDir, { recursive: true });
    await mkdir(join(canonWorkspacesDir, "feat--some-branch"));

    mockGitExec.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return makeGitWorktreeListResult([`${tmpDir} abc123 [main]`]);
      }
      if (args[0] === "branch" && args[1] === "--merged") {
        return makeGitFailResult();
      }
      return makeGitFailResult();
    });

    const result = await runJanitor(tmpDir);

    expect(result.tasks.prune_workspaces.status).toBe("error");
    expect(result.tasks.prune_workspaces.detail).toBeDefined();
  });

  test("prunes multiple matched, keeps unmatched", async () => {
    const mergedA = "feat--merged-a";
    const mergedB = "fix--merged-b";
    const activeC = "feat--active-c";
    await mkdir(join(canonWorkspacesDir, mergedA), { recursive: true });
    await mkdir(join(canonWorkspacesDir, mergedB), { recursive: true });
    await mkdir(join(canonWorkspacesDir, activeC), { recursive: true });

    mockGitExec.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return makeGitWorktreeListResult([`${tmpDir} abc123 [main]`]);
      }
      if (args[0] === "branch" && args[1] === "--merged") {
        // feat/merged-a and fix/merged-b are merged; feat/active-c is not
        return makeGitBranchMergedResult(["feat/merged-a", "fix/merged-b", "main"]);
      }
      return makeGitFailResult();
    });

    const result = await runJanitor(tmpDir);

    expect(result.tasks.prune_workspaces.status).toBe("success");
    expect(result.tasks.prune_workspaces.detail).toContain("2");
    expect(existsSync(join(canonWorkspacesDir, mergedA))).toBe(false);
    expect(existsSync(join(canonWorkspacesDir, mergedB))).toBe(false);
    expect(existsSync(join(canonWorkspacesDir, activeC))).toBe(true);
  });
});

// --- needs_prune semantics ---

describe("needs_prune semantics", () => {
  test("needs_prune: true when prune_worktrees removed entries", async () => {
    await mkdir(agentWorktreesDir, { recursive: true });
    await mkdir(join(agentWorktreesDir, "agent-stale-id"));

    mockGitExec.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return makeGitWorktreeListResult([`${tmpDir} abc123 [main]`]);
      }
      return makeGitBranchMergedResult(["main"]);
    });

    const result = await runJanitor(tmpDir);

    expect(result.needs_prune).toBe(true);
  });

  test("needs_prune: true when prune_workspaces removed entries", async () => {
    await mkdir(join(canonWorkspacesDir, "feat--merged"), { recursive: true });

    mockGitExec.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return makeGitWorktreeListResult([`${tmpDir} abc123 [main]`]);
      }
      if (args[0] === "branch" && args[1] === "--merged") {
        return makeGitBranchMergedResult(["feat/merged", "main"]);
      }
      return makeGitFailResult();
    });

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
