/**
 * Janitor service — background housekeeping orchestrator.
 *
 * Runs gate checks (cheapest-first), then executes tasks:
 *   - wal_checkpoint: flush WAL files for root-level Canon SQLite databases
 *   - prune_worktrees: remove orphaned agent isolation worktrees from .claude/worktrees/
 *   - prune_workspaces: remove workspace dirs for merged branches from .canon/workspaces/
 *
 * Canon principles:
 *   - fail-closed-by-default: gate fails → don't run; lock not acquired → don't run
 *   - no-silent-failures: every task records its outcome with status and detail
 *   - define-errors-out-of-existence: no WAL file = skip; no DB = skip; missing dir = skip
 *   - subprocess-isolation: git commands via gitExec (spawnSync, shell never true)
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gitExec } from "@platform/adapters/git-adapter.ts";
import { CANON_DIR, CANON_FILES } from "@shared/constants.ts";
import { loadJanitorConfig } from "@shared/lib/config.ts";
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
  /** True when either prune task actually removed entries during this run. */
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
 * Parse `git branch --merged` output into a Set of branch names (trimmed, no leading spaces).
 */
function parseMergedBranches(stdout: string): Set<string> {
  const branches = new Set<string>();
  for (const line of stdout.split("\n")) {
    // Strip leading markers: "* " (current), "+ " (worktree), or "  " (plain)
    const trimmed = line.replace(/^[*+]?\s+/, "").trim();
    if (trimmed) branches.add(trimmed);
  }
  return branches;
}

/**
 * Sanitize a branch name the same way workspace directories are named.
 * Mirrors sanitizeBranch() from @domains/workspaces/workspace.ts.
 *
 * Replaces `/` with `--`, spaces with `-`, strips non-alphanumeric/hyphen chars,
 * lowercases, and truncates to 80 characters.
 */
function sanitizeBranchForComparison(branch: string): string {
  return branch
    .replace(/\//g, "--")
    .replace(/\s/g, "-")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .toLowerCase()
    .slice(0, 80);
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
 * Prune workspace directories for merged branches from {projectDir}/.canon/workspaces/.
 *
 * A workspace directory is a candidate for pruning when its name matches the
 * sanitized form of a merged branch name. The "main" workspace is always kept.
 *
 * Path safety: only paths strictly under canonWorkspacesDir are removed.
 *
 * @returns JanitorTaskResult with pruned count in detail on success
 */
function pruneWorkspacesTask(projectDir: string, canonDir: string): JanitorTaskResult {
  const canonWorkspacesDir = join(canonDir, "workspaces");

  if (listDir(canonWorkspacesDir) === null) {
    return { detail: "no workspaces directory or empty", status: "skipped" };
  }

  const branchResult = gitExec(["branch", "--merged", "main"], projectDir);
  if (!branchResult.ok) {
    return { detail: `git branch --merged failed: ${branchResult.stderr.trim()}`, status: "error" };
  }

  const sanitizedMerged = new Set<string>();
  for (const branch of parseMergedBranches(branchResult.stdout)) {
    const s = sanitizeBranchForComparison(branch);
    if (s !== "main") sanitizedMerged.add(s);
  }

  const { pruned, errors } = removeEntries(
    canonWorkspacesDir,
    (entry) => entry !== "main" && sanitizedMerged.has(entry),
  );

  return buildPruneResult(
    pruned,
    errors,
    "workspace(s)",
    "no merged-branch workspace directories found",
  );
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

    // Task: prune workspace dirs for merged branches
    tasks.prune_workspaces = pruneWorkspacesTask(projectDir, canonDir);

    // Commit lock (update mtime = last successful run timestamp)
    await commitJanitorLock(canonDir);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    tasks.unexpected_error = { detail: message, status: "error" };
    // Fall through to lock release
  } finally {
    await releaseJanitorLock(canonDir);
  }

  // needs_prune is true when either prune task actually removed entries
  const needsPrune =
    tasks.prune_worktrees?.status === "success" || tasks.prune_workspaces?.status === "success";

  return {
    gate_passed: true,
    needs_prune: needsPrune,
    tasks,
  };
}
