/**
 * Janitor service — background housekeeping orchestrator.
 *
 * Runs gate checks (cheapest-first), then executes tasks:
 *   - wal_checkpoint: flush WAL files for root-level Canon SQLite databases
 *   - prune_worktrees: remove orphaned agent isolation worktrees from .claude/worktrees/
 *   - prune_workspaces: remove abandoned workspace slugs by age (all branches)
 *
 * Completed workspaces are archived and deleted immediately by finalize_workspace.
 * The janitor only handles abandoned workspaces (no .lock file, older than
 * max_abandoned_workspace_age_hours). When max_abandoned_workspace_age_hours is null,
 * the prune_workspaces task is skipped entirely.
 * Empty branch directories are cleaned up after their slugs are removed.
 *
 * Canon principles:
 *   - fail-closed-by-default: gate fails → don't run; lock not acquired → don't run
 *   - no-silent-failures: every task records its outcome with status and detail
 *   - define-errors-out-of-existence: no WAL file = skip; no DB = skip; missing dir = skip
 *   - subprocess-isolation: git commands via gitExec (spawnSync, shell never true)
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { archiveWorkspace } from "@features/history/services/archive-service.ts";
import { gitExec } from "@platform/adapters/git-adapter.ts";
import { CANON_DIR, CANON_FILES } from "@shared/constants.ts";
import { type JanitorConfig, loadJanitorConfig } from "@shared/lib/config.ts";
import {
  acquireJanitorLock,
  commitJanitorLock,
  getLastJanitorTimestamp,
  releaseJanitorLock,
} from "@shared/lib/janitor-lock.ts";
import Database from "better-sqlite3";

/** Outcome of a single janitor task. */
export type JanitorTaskResult = {
  status: "success" | "skipped" | "error";
  detail?: string;
};

/** Overall janitor run result. */
export type JanitorResult = {
  gate_passed: boolean;
  reason?: string;
  tasks: Record<string, JanitorTaskResult>;
  /** True when any prune task actually removed entries during this run. */
  needs_prune: boolean;
};

/**
 * SQLite databases to checkpoint at the root .canon level.
 * Do NOT include per-workspace databases.
 */
const ROOT_DB_KEYS = [
  CANON_FILES.KNOWLEDGE_DB,
  CANON_FILES.DRIFT_DB,
  CANON_FILES.ORCHESTRATION_DB,
] as const;

/**
 * Checkpoint a single SQLite database if its WAL file exists.
 * Opens the DB, runs PASSIVE checkpoint, closes in finally block.
 *
 * @returns JanitorTaskResult for this database checkpoint attempt
 */
function checkpointDb(dbPath: string): JanitorTaskResult {
  const walPath = `${dbPath}-wal`;
  if (!existsSync(walPath)) {
    return { detail: `no WAL file at ${walPath}`, status: "skipped" };
  }
  if (!existsSync(dbPath)) {
    return { detail: `database not found at ${dbPath}`, status: "skipped" };
  }

  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(dbPath, { readonly: false });
    db.pragma("wal_checkpoint(PASSIVE)");
    return { status: "success" };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { detail: message, status: "error" };
  } finally {
    try {
      db?.close();
    } catch {
      // Best-effort close
    }
  }
}

/**
 * Run the WAL checkpoint task across all root-level Canon databases.
 * Reports the worst outcome (error > skipped > success).
 */
function runWalCheckpointTask(canonDir: string): JanitorTaskResult {
  let hasError = false;
  let errorDetail: string | undefined;

  for (const dbKey of ROOT_DB_KEYS) {
    const dbPath = join(canonDir, dbKey);
    const result = checkpointDb(dbPath);
    if (result.status === "error") {
      hasError = true;
      errorDetail = result.detail;
    }
  }

  if (hasError) {
    return { detail: errorDetail, status: "error" };
  }
  return { status: "success" };
}

/**
 * Parse git worktree list output into a Set of absolute worktree paths.
 *
 * `git worktree list` outputs lines like:
 *   /path/to/worktree  <hash>  [branch]
 *   /path/to/worktree  <hash>  (detached HEAD)
 *
 * We extract only the first field (the path) from each line.
 */
function parseWorktreePaths(stdout: string): Set<string> {
  const paths = new Set<string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // First whitespace-delimited token is the path
    const spaceIdx = trimmed.search(/\s/);
    const worktreePath = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
    if (worktreePath) paths.add(worktreePath);
  }
  return paths;
}

/**
 * List directory entries under a given path.
 * Returns null when the directory does not exist or cannot be read.
 * Treats ENOENT as expected (returns null); re-throws unexpected errors.
 */
function listDir(dirPath: string): string[] | null {
  try {
    return readdirSync(dirPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function removeEntries(
  targetDir: string,
  shouldRemove: (entry: string, entryPath: string) => boolean,
): { pruned: number; errors: string[] } {
  const pruned = { errors: [] as string[], pruned: 0 };
  const entries = listDir(targetDir);
  if (entries === null) return pruned;

  for (const entry of entries) {
    const entryPath = join(targetDir, entry);
    if (!shouldRemove(entry, entryPath)) continue;
    try {
      rmSync(entryPath, { force: true, recursive: true });
      pruned.pruned++;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      pruned.errors.push(`${entry}: ${message}`);
    }
  }
  return pruned;
}

function buildPruneResult(
  pruned: number,
  errors: string[],
  noun: string,
  noneMessage: string,
): JanitorTaskResult {
  if (errors.length > 0 && pruned === 0) {
    return { detail: errors.join("; "), status: "error" };
  }
  if (pruned === 0) {
    return { detail: noneMessage, status: "skipped" };
  }
  const base = `pruned ${pruned} ${noun}`;
  return {
    detail: errors.length > 0 ? `${base}; errors: ${errors.join("; ")}` : base,
    status: "success",
  };
}

function pruneWorktreesTask(projectDir: string): JanitorTaskResult {
  const agentWorktreesDir = join(projectDir, ".claude", "worktrees");

  if (listDir(agentWorktreesDir) === null) {
    return { detail: "no agent worktrees directory or empty", status: "skipped" };
  }

  const listResult = gitExec(["worktree", "list"], projectDir);
  if (!listResult.ok) {
    return { detail: `git worktree list failed: ${listResult.stderr.trim()}`, status: "error" };
  }

  const validPaths = parseWorktreePaths(listResult.stdout);
  const { pruned, errors } = removeEntries(
    agentWorktreesDir,
    (_entry, entryPath) => !validPaths.has(entryPath),
  );

  return buildPruneResult(pruned, errors, "worktree(s)", "no orphaned agent worktrees found");
}

/**
 * Prune abandoned workspace slug directories across ALL branch directories (including `main`).
 *
 * Completed workspaces are archived and deleted immediately by finalize_workspace —
 * the janitor only handles abandoned workspaces (no .lock file).
 *
 * A workspace slug is pruned when:
 *   - It has no `.lock` file (not an active workspace)
 *   - `config.max_abandoned_workspace_age_hours` is not null AND mtime is older than that threshold
 *
 * When `max_abandoned_workspace_age_hours` is null, returns skipped immediately.
 * After pruning slugs, empty branch directories are removed too.
 * Archive is attempted best-effort before deletion.
 *
 * @returns JanitorTaskResult with count of pruned slugs in detail on success
 */
type PruneContext = {
  projectDir: string;
  abandonedMaxAgeMs: number;
  now: number;
};

async function pruneWorkspacesTask(
  projectDir: string,
  canonDir: string,
  config: JanitorConfig,
): Promise<JanitorTaskResult> {
  if (config.max_abandoned_workspace_age_hours === null) {
    return { detail: "max_abandoned_workspace_age_hours not configured", status: "skipped" };
  }

  const canonWorkspacesDir = join(canonDir, "workspaces");
  const branchEntries = listDir(canonWorkspacesDir);
  if (branchEntries === null) {
    return { detail: "no workspaces directory or empty", status: "skipped" };
  }

  const ctx: PruneContext = {
    abandonedMaxAgeMs: config.max_abandoned_workspace_age_hours * 60 * 60 * 1000,
    now: Date.now(),
    projectDir,
  };

  let pruned = 0;
  const errors: string[] = [];

  for (const branchEntry of branchEntries) {
    const branchDir = join(canonWorkspacesDir, branchEntry);
    const candidates = findPruneCandidates(branchDir, branchEntry, ctx);

    for (const candidate of candidates) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential archive-then-delete per slug is intentional — parallel would race on filesystem
      const removed = await archiveAndRemoveSlug(candidate, errors);
      if (removed) pruned++;
    }

    cleanupEmptyBranchDir(branchDir, candidates.length);
  }

  return buildPruneResult(
    pruned,
    errors,
    "workspace(s)",
    "no workspace slug directories eligible for pruning",
  );
}

type PruneCandidate = { slugPath: string; branchEntry: string; slug: string; projectDir: string };

/**
 * Scan a branch directory for workspace slugs eligible for pruning.
 * A slug is eligible when it has no .lock file and is older than the abandoned age threshold.
 */
function findPruneCandidates(
  branchDir: string,
  branchEntry: string,
  ctx: PruneContext,
): PruneCandidate[] {
  const slugEntries = listDir(branchDir);
  if (slugEntries === null) return [];

  const candidates: PruneCandidate[] = [];
  for (const slug of slugEntries) {
    const slugPath = join(branchDir, slug);
    if (existsSync(join(slugPath, ".lock"))) continue;

    let mtimeMs: number;
    try {
      mtimeMs = statSync(slugPath).mtimeMs;
    } catch {
      continue;
    }
    if (ctx.now - mtimeMs < ctx.abandonedMaxAgeMs) continue;

    candidates.push({ branchEntry, projectDir: ctx.projectDir, slug, slugPath });
  }
  return candidates;
}

/**
 * Archive a workspace slug (best-effort) and then remove it.
 * Returns true when the slug directory was successfully deleted.
 */
async function archiveAndRemoveSlug(candidate: PruneCandidate, errors: string[]): Promise<boolean> {
  const { slugPath, branchEntry, slug, projectDir } = candidate;

  try {
    await archiveWorkspace({ branch: branchEntry, projectDir, slug, workspacePath: slugPath });
  } catch (err: unknown) {
    console.warn(
      `[canon] janitor: archive failed for ${candidate.slug}:`,
      err instanceof Error ? err.message : err,
    );
  }

  // Remove the git worktree registration before deleting the directory.
  // If the worktree/ subdirectory exists, git tracks it — we must deregister
  // it first or git's internal metadata becomes stale. Failure is non-blocking:
  // rmSync will still clean up the files, and `git worktree prune` can clear
  // any remaining metadata.
  const worktreeSubPath = join(slugPath, "worktree");
  if (existsSync(worktreeSubPath)) {
    try {
      gitExec(["worktree", "remove", "--force", worktreeSubPath], projectDir);
    } catch {
      // Non-blocking — proceed to rmSync regardless
    }
  }

  try {
    rmSync(slugPath, { force: true, recursive: true });
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`${branchEntry}/${slug}: ${message}`);
    return false;
  }
}

/**
 * Remove a branch directory when it is now empty after slug pruning.
 */
function cleanupEmptyBranchDir(branchDir: string, prunedInBranch: number): void {
  if (prunedInBranch === 0) return;
  const remaining = listDir(branchDir);
  if (remaining !== null && remaining.length === 0) {
    try {
      rmSync(branchDir, { force: true, recursive: true });
    } catch (err: unknown) {
      console.warn(
        "[canon] janitor: failed to remove empty branch dir:",
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/**
 * Run the janitor service.
 *
 * Gate check order (cheapest-first):
 *   1. Config enabled check
 *   2. Time gate (min_hours_between_runs)
 *   3. Lock acquisition
 *
 * When gate passes, runs WAL checkpoint, worktree prune, and workspace prune tasks.
 * Always releases lock on exit, even on unexpected error.
 *
 * @param projectDir - Project root directory (contains .canon/ and .claude/)
 */
export async function runJanitor(projectDir: string): Promise<JanitorResult> {
  const canonDir = join(projectDir, CANON_DIR);

  // Gate 1: Config enabled check
  const config = await loadJanitorConfig(projectDir);
  if (!config.enabled) {
    return { gate_passed: false, needs_prune: false, reason: "janitor disabled", tasks: {} };
  }

  // Gate 2: Time gate
  const lastTs = await getLastJanitorTimestamp(canonDir);
  if (lastTs !== null) {
    const hoursSinceLast = (Date.now() - lastTs) / (1000 * 60 * 60);
    if (hoursSinceLast < config.min_hours_between_runs) {
      return {
        gate_passed: false,
        needs_prune: false,
        reason: `time gate: ${hoursSinceLast.toFixed(1)}h < ${config.min_hours_between_runs}h`,
        tasks: {},
      };
    }
  }

  // Gate 3: Lock acquisition
  // Lock staleness is a crash-recovery timeout, not a scheduling interval.
  // 5 minutes is generous for a janitor run that takes seconds.
  const LOCK_STALE_MS = 5 * 60 * 1000;
  const lockResult = await acquireJanitorLock(canonDir, LOCK_STALE_MS);
  if (!lockResult.acquired) {
    return {
      gate_passed: false,
      needs_prune: false,
      reason: `lock: ${lockResult.reason}`,
      tasks: {},
    };
  }

  // Gate passed — run tasks
  const tasks: Record<string, JanitorTaskResult> = {};

  try {
    // Task: WAL checkpoint
    tasks.wal_checkpoint = runWalCheckpointTask(canonDir);

    // Task: prune orphaned agent isolation worktrees
    tasks.prune_worktrees = pruneWorktreesTask(projectDir);

    // Task: prune workspace slugs by age + completion status (covers all branches, including main)
    tasks.prune_workspaces = await pruneWorkspacesTask(projectDir, canonDir, config);

    // Commit lock (update mtime = last successful run timestamp)
    await commitJanitorLock(canonDir);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    tasks.unexpected_error = { detail: message, status: "error" };
    // Fall through to lock release
  } finally {
    await releaseJanitorLock(canonDir);
  }

  // needs_prune is true when any prune task actually removed entries
  const needsPrune =
    tasks.prune_worktrees?.status === "success" || tasks.prune_workspaces?.status === "success";

  return {
    gate_passed: true,
    needs_prune: needsPrune,
    tasks,
  };
}
