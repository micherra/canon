import { existsSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { archiveWorkspace } from "@platform/storage/archive/archive-service.ts";
import { gitDiff, gitExec } from "@platform/adapters/git-adapter.ts";
import { appendFlowRun, type FlowRunEntry } from "@platform/storage/drift/analytics.ts";
import { releaseClaims } from "@shared/lib/file-claims.ts";
import { generateId } from "@shared/lib/id.ts";
import type { ProcessResult } from "@shared/lib/tool-result.ts";
import type { JournalStep } from "../tools/orchestration-journal.ts";
import { computeFlowOutcome } from "../tools/orchestration-journal.ts";

/** Optional diff-size fields for a FlowRunEntry. Both absent = "could not measure". */
export type DiffStatFields = {
  diff_stat?: string;
  total_files_changed?: number;
};

/**
 * Parse `git diff --shortstat` output (e.g. "12 files changed, 340 insertions(+), 25 deletions(-)").
 * Empty output means an empty diff — a measured zero, not missing data.
 * Unparsable non-empty output returns {} (fields absent).
 */
export function parseShortstat(stdout: string): DiffStatFields {
  const line = stdout.trim();
  if (line === "") return { total_files_changed: 0 };
  const match = line.match(/^(\d+) files? changed/);
  if (!match) return {};
  return { diff_stat: line, total_files_changed: parseInt(match[1], 10) };
}

type GitDiffFn = typeof gitDiff;

/**
 * Seam type for `git ls-files --others --exclude-standard`.
 * Returns a ProcessResult whose stdout is a newline-separated list of untracked paths.
 */
type GitLsFilesFn = (cwd: string) => ProcessResult;

/** Git seams bundled for test injection. Both have production defaults. */
export type DiffStatSeams = {
  gitDiffFn?: GitDiffFn;
  gitLsFilesFn?: GitLsFilesFn;
};

/**
 * Default implementation of the ls-files seam.
 * Lists untracked, non-ignored files relative to the given directory.
 */
function defaultGitLsFiles(cwd: string): ProcessResult {
  return gitExec(["ls-files", "--others", "--exclude-standard"], cwd);
}

/** Count non-empty lines in ls-files output (each line is one untracked path). */
function countUntrackedFiles(stdout: string): number {
  return stdout.split("\n").filter((line) => line.trim() !== "").length;
}

/**
 * Merge tracked diff stats with untracked file count.
 *
 * Format of diff_stat when untracked files present:
 *   "3 files changed, 50 insertions(+), 5 deletions(-), 2 untracked"
 * Edge case: measured-zero tracked diff + untracked → "2 untracked"
 */
function mergeUntrackedIntoStats(tracked: DiffStatFields, untrackedCount: number): DiffStatFields {
  if (untrackedCount === 0) return tracked;
  const trackedCount = tracked.total_files_changed ?? 0;
  const totalFiles = trackedCount + untrackedCount;
  const suffix = `, ${untrackedCount} untracked`;
  if (tracked.diff_stat) {
    return { diff_stat: tracked.diff_stat + suffix, total_files_changed: totalFiles };
  }
  return { diff_stat: `${untrackedCount} untracked`, total_files_changed: totalFiles };
}

/**
 * Attempt to count untracked files in the worktree. Best-effort — never throws.
 * Returns 0 and warns on failure so the caller can keep the tracked-diff result.
 */
function tryCountUntrackedFiles(worktree: string, lsFilesFn: GitLsFilesFn): number {
  try {
    const lsResult = lsFilesFn(worktree);
    if (!lsResult.ok) {
      console.warn(
        "[canon] finalizeWorkspace: untracked-files listing failed:",
        lsResult.stderr.trim(),
      );
      return 0;
    }
    return countUntrackedFiles(lsResult.stdout);
  } catch (lsErr: unknown) {
    console.warn(
      "[canon] finalizeWorkspace: untracked-files listing threw:",
      lsErr instanceof Error ? lsErr.message : lsErr,
    );
    return 0;
  }
}

/**
 * Compute whole-build diff stats for the build worktree relative to base_commit.
 *
 * Uses `git diff --shortstat ${baseCommit}` (single-rev form) so that staged,
 * unstaged, and committed changes relative to the base are all captured — not
 * just the committed HEAD range.
 *
 * Additionally accounts for untracked files via `git ls-files --others`:
 *  - `total_files_changed` = tracked-changes count + untracked count.
 *  - When untracked files exist, `diff_stat` is amended with ", N untracked".
 *  - If the untracked listing fails, the tracked-diff result is kept as-is
 *    (best-effort — partial data beats none).
 *
 * Best-effort — never throws. Returns {} when the data is unobtainable
 * (no board/base_commit, worktree missing, git failure).
 */
export function tryComputeDiffStats(
  workspace: string,
  gitDiffFn: GitDiffFn = gitDiff,
  gitLsFilesFn: GitLsFilesFn = defaultGitLsFiles,
): DiffStatFields {
  try {
    const store = getExecutionStore(workspace);
    const baseCommit = store.getBoard()?.base_commit;
    const worktree = store.getSession()?.worktree_path ?? join(workspace, "worktree");
    if (!baseCommit || !existsSync(worktree)) return {};

    // Single-rev diff: compares base_commit against the working tree (staged + unstaged + committed)
    const result = gitDiffFn(["--shortstat", baseCommit], worktree);
    if (!result.ok) {
      console.warn("[canon] finalizeWorkspace: diff shortstat failed:", result.stderr.trim());
      return {};
    }
    const tracked = parseShortstat(result.stdout);
    const untrackedCount = tryCountUntrackedFiles(worktree, gitLsFilesFn);
    return mergeUntrackedIntoStats(tracked, untrackedCount);
  } catch (err: unknown) {
    // best-effort: diff stats are advisory metadata — never block finalize
    console.warn(
      "[canon] finalizeWorkspace: failed to compute diff stats:",
      err instanceof Error ? err.message : err,
    );
    return {};
  }
}

/** Best-effort branch delete after worktree removal. Never throws. */
function tryDeleteBranch(slug: string, projectDir: string): void {
  try {
    const r = gitExec(["branch", "-D", `canon/${slug}`], projectDir);
    if (!r.ok) console.warn(`[canon] branch -D failed for ${slug}:`, r.stderr.trim());
  } catch (err: unknown) {
    console.warn(`[canon] branch -D threw for ${slug}:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Deregister the worktree at `{workspace}/worktree` from git before deletion.
 * Best-effort — never throws. Warns on failure so the caller can still proceed.
 */
function tryDeregisterWorktree(workspace: string, slug: string, projectDir: string): void {
  const worktreeSubPath = join(workspace, "worktree");
  if (!existsSync(worktreeSubPath)) return;
  try {
    const result = gitExec(["worktree", "remove", "--force", worktreeSubPath], projectDir);
    if (!result.ok) {
      console.warn(
        `[canon] archiveAndDeleteWorkspace: git worktree remove failed for ${basename(workspace)}:`,
        result.stderr.trim(),
      );
    } else {
      tryDeleteBranch(slug, projectDir);
    }
  } catch (err: unknown) {
    console.warn(
      `[canon] archiveAndDeleteWorkspace: git worktree remove threw for ${basename(workspace)}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

export async function archiveAndDeleteWorkspace(
  workspace: string,
  projectDir: string,
): Promise<{ archived: boolean; deleted: boolean }> {
  const session = getExecutionStore(workspace).getSession();
  const slug = session?.slug ?? basename(workspace);

  let archived = false;
  try {
    const branch = session?.branch ?? "unknown";
    await archiveWorkspace({
      branch,
      projectDir,
      slug,
      workspacePath: workspace,
    });
    archived = true;
  } catch (err: unknown) {
    console.warn("[canon] workspace archive failed:", err instanceof Error ? err.message : err);
  }

  let deleted = false;
  try {
    tryDeregisterWorktree(workspace, slug, projectDir);
    rmSync(workspace, { force: true, recursive: true });
    deleted = true;
  } catch (err: unknown) {
    console.warn("[canon] workspace deletion failed:", err instanceof Error ? err.message : err);
  }

  return { archived, deleted };
}

/**
 * Release file claims for this workspace's slug. Best-effort — never throws.
 * Returns true when claims were released successfully, false when skipped or failed.
 */
export async function tryReleaseClaims(workspace: string, projectDir: string): Promise<boolean> {
  try {
    const session = getExecutionStore(workspace).getSession();
    if (!session) return false;
    releaseClaims(projectDir, session.slug);
    return true;
  } catch (err: unknown) {
    console.warn(
      "[canon] finalizeWorkspace: failed to release file claims:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Build a minimal FlowRunEntry from journal step timestamps and append to drift analytics.
 * Best-effort — never throws. Returns true when analytics were recorded, false otherwise.
 *
 * The optional `seams` parameter allows injecting git functions for testing.
 */
export async function tryAppendAnalytics(
  workspace: string,
  steps: readonly JournalStep[],
  projectDir: string,
  seams: DiffStatSeams = {},
): Promise<boolean> {
  try {
    const session = getExecutionStore(workspace).getSession();
    const now = new Date().toISOString();
    const flowOutcome = computeFlowOutcome(steps);
    const flowRun: FlowRunEntry = {
      completed: now,
      flow: session?.slug ?? basename(workspace),
      run_id: generateId("run"),
      skipped_states: steps.filter((s) => s.status === "skipped").map((s) => s.step_id),
      started: steps.find((s) => s.started_at)?.started_at ?? now,
      state_durations: {},
      state_iterations: {},
      task: session?.slug ?? basename(workspace),
      tier: "unknown",
      total_duration_ms: flowOutcome.total_duration_ms ?? 0,
      total_spawns: 0,
      ...tryComputeDiffStats(workspace, seams.gitDiffFn, seams.gitLsFilesFn),
    };
    await appendFlowRun(projectDir, flowRun);
    return true;
  } catch (err: unknown) {
    console.warn(
      "[canon] finalizeWorkspace: failed to append flow analytics:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Run the janitor for background housekeeping. Best-effort — never throws.
 */
export async function tryRunJanitor(projectDir: string): Promise<void> {
  try {
    const { runJanitor } = await import("../services/janitor.ts");
    await runJanitor(projectDir);
  } catch (err: unknown) {
    console.warn(
      "[canon] finalizeWorkspace: janitor run failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
