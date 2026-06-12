/**
 * Janitor service tests — cleanupEmptyBranchDir TOCTOU guard.
 *
 * Split from janitor-prune-workspaces.test.ts to keep each file under 600 lines.
 * Covers the rmdirSync-based atomic deletion: positive path (empty dir removed),
 * ENOTEMPTY-equivalent path (non-empty dir left intact via pre-check), and
 * catch-branch path (rmdirSync throws after emptiness check passes).
 */

import { existsSync, rmdirSync, utimesSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

// Partial mock of node:fs — preserves all real implementations; allows per-test
// vi.mocked(rmdirSync).mockImplementationOnce(...) to simulate catch-branch entry
// (e.g. EACCES) without chmod or subprocess tricks that are unreliable as root.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, rmdirSync: vi.fn(actual.rmdirSync) };
});

vi.mock("@platform/storage/archive/archive-service.ts", () => ({
  archiveWorkspace: vi.fn().mockResolvedValue({
    archive_path: "/tmp/archive",
    archived: true,
    manifest_entry: null,
    run_summary_generated: false,
  }),
}));

// Import after mocks are set up
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
  tmpDir = await mkdtemp(join(tmpdir(), "janitor-cleanup-test-"));
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
  // resetAllMocks clears both call records and custom mockImplementation overrides,
  // ensuring rmdirSync reverts to the real implementation between tests.
  vi.resetAllMocks();
  await rm(tmpDir, { recursive: true });
});

// --- cleanupEmptyBranchDir TOCTOU guard (rmdirSync = atomic ENOTEMPTY) ---

describe("cleanupEmptyBranchDir — TOCTOU guard via atomic rmdirSync", () => {
  const ABANDONED_AGE_HOURS = 48;
  const ABANDONED_AGE_MS = ABANDONED_AGE_HOURS * 60 * 60 * 1000;

  test("does not delete branch dir that is non-empty at deletion time, janitor does not crash", async () => {
    mockLoadJanitorConfig.mockResolvedValue({
      enabled: true,
      max_abandoned_workspace_age_hours: ABANDONED_AGE_HOURS,
      min_hours_between_runs: 1,
    });

    const branchDir = join(canonWorkspacesDir, "main");
    const staleSlug = join(branchDir, "stale-slug");
    await mkdir(staleSlug, { recursive: true });
    setMtime(staleSlug, Date.now() - (ABANDONED_AGE_MS + 1000));

    // new-slug is present alongside stale-slug: after stale-slug is pruned,
    // branchDir still has new-slug so rmdirSync must fail ENOTEMPTY and leave it.
    const newSlug = join(branchDir, "new-slug");
    await mkdir(newSlug, { recursive: true });
    setMtime(newSlug, Date.now() - 1 * 60 * 60 * 1000);

    const warnSpy = vi.spyOn(console, "warn");
    const result = await runJanitor(tmpDir);

    // remaining.length > 0 (new-slug still present) → rmdirSync is never called
    // → the catch branch is never reached → no warn should fire.
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();

    expect(existsSync(staleSlug)).toBe(false);
    expect(existsSync(branchDir)).toBe(true);
    expect(existsSync(newSlug)).toBe(true);
    expect(result.tasks.prune_workspaces.status).toBe("success");
  });

  test("deletes branch dir that becomes empty after all slugs are pruned (rmdirSync positive path)", async () => {
    mockLoadJanitorConfig.mockResolvedValue({
      enabled: true,
      max_abandoned_workspace_age_hours: ABANDONED_AGE_HOURS,
      min_hours_between_runs: 1,
    });

    const branchDir = join(canonWorkspacesDir, "feat--toctou-branch");
    const staleSlug = join(branchDir, "stale-slug-2");
    await mkdir(staleSlug, { recursive: true });
    setMtime(staleSlug, Date.now() - (ABANDONED_AGE_MS + 1000));

    const result = await runJanitor(tmpDir);

    expect(existsSync(staleSlug)).toBe(false);
    expect(existsSync(branchDir)).toBe(false);
    expect(result.tasks.prune_workspaces.status).toBe("success");
  });

  test("catch branch fires and janitor still succeeds when rmdirSync throws (EACCES proxy)", async () => {
    // This test exercises the catch block at cleanupEmptyBranchDir (janitor.ts:457-462).
    //
    // Scenario: only one stale slug in branchDir — so after prune, remaining.length === 0
    // and rmdirSync IS called. We mock rmdirSync to throw EACCES (simulating a race where
    // permissions changed, or a CI sandbox restriction). The janitor must:
    //   1. Fire console.warn with the updated wording
    //   2. Still report prune_workspaces status === "success" (best-effort, not a crash)
    //   3. Leave branchDir intact (rmdirSync never actually removed it)
    //
    // Using a mock-based forced throw rather than chmod to avoid root/CI unreliability.
    mockLoadJanitorConfig.mockResolvedValue({
      enabled: true,
      max_abandoned_workspace_age_hours: ABANDONED_AGE_HOURS,
      min_hours_between_runs: 1,
    });

    const branchDir = join(canonWorkspacesDir, "feat--eacces-branch");
    const staleSlug = join(branchDir, "only-stale-slug");
    await mkdir(staleSlug, { recursive: true });
    setMtime(staleSlug, Date.now() - (ABANDONED_AGE_MS + 1000));

    // Mock rmdirSync to throw EACCES on every call — both cleanupEmptyBranchDir
    // (called by prune_workspaces) AND pruneHuskDirsTask (which runs next and would
    // also see the empty branchDir) will fail. This ensures branchDir survives
    // as expected and no secondary cleanup removes it.
    vi.mocked(rmdirSync).mockImplementation(() => {
      const err = Object.assign(new Error("EACCES: permission denied, rmdir"), {
        code: "EACCES",
      });
      throw err;
    });

    const warnSpy = vi.spyOn(console, "warn");
    const result = await runJanitor(tmpDir);

    // Catch branch in cleanupEmptyBranchDir executed: warn must have fired with
    // the updated wording. (pruneHuskDirsTask also throws but logs to its own
    // errors array, not console.warn — only cleanupEmptyBranchDir uses console.warn.)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("could not remove branch dir (non-empty or inaccessible):"),
      expect.stringContaining("EACCES"),
    );
    warnSpy.mockRestore();

    // Janitor must not crash: still reports success (slug was pruned).
    expect(result.tasks.prune_workspaces.status).toBe("success");

    // branchDir survives because rmdirSync threw for both cleanup passes.
    expect(existsSync(branchDir)).toBe(true);
  });
});
