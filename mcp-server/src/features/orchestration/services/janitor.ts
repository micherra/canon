/**
 * Janitor service — background housekeeping orchestrator.
 *
 * Runs gate checks (cheapest-first), then executes tasks:
 *   - wal_checkpoint: flush WAL files for root-level Canon SQLite databases
 *   - prune_worktrees: remove orphaned agent isolation worktrees from .claude/worktrees/
 *   - prune_workspaces: remove abandoned workspace slugs by age (all branches)
 *   - prune_husk_dirs: remove empty top-level branch directories under .canon/workspaces/
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

import {
  existsSync,
  lstatSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { gitExec } from "@platform/adapters/git-adapter.ts";
import { archiveWorkspace } from "@platform/storage/archive/archive-service.ts";
import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import { CANON_DIR, CANON_FILES } from "@shared/constants.ts";
import { type JanitorConfig, loadJanitorConfig } from "@shared/lib/config.ts";
import {
  acquireJanitorLock,
  commitJanitorLock,
  getLastJanitorTimestamp,
  releaseJanitorLock,
} from "@shared/lib/janitor-lock.ts";
import Database from "better-sqlite3";
import { tryPersistDecisionsBeforeReap } from "./decision-persistence.ts";
import {
  buildPruneResult,
  listDir,
  pruneHuskDirsTask,
  pruneWorktreesTask,
} from "./janitor-prune.ts";

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

/**
 * True when the workspace's journal records a completed "ship" step.
 *
 * The step_id literal "ship" is intentional (finalize-04). A future rename of the
 * ship step would silently disable post-ship reclaim (orphans accumulate). This
 * function is exported so tests can pin the literal and catch any such rename.
 */
// canon:allow-unwired: pure ship-gate predicate exported for direct unit testing (janitor-ship-gate.test.ts); invoked internally at janitor.ts readShipComplete
export function isShipComplete(steps: ReadonlyArray<{ step_id: string; status: string }>): boolean {
  return steps.some((s) => s.step_id === "ship" && s.status === "completed");
}

/**
 * Read the workspace journal and check whether the ship step has completed.
 *
 * Reads journal.json LOCALLY (do NOT import readJournal from orchestration-journal.ts —
 * that would deepen the existing workspace-cleanup ↔ orchestration-journal cycle).
 * Fail-closed: absent/malformed journal or no completed ship step → returns false.
 */
function readShipComplete(slugPath: string): boolean {
  const p = join(slugPath, "journal.json");
  if (!existsSync(p)) return false; // fail-closed: no journal → not post-ship
  try {
    const j = JSON.parse(readFileSync(p, "utf-8")) as {
      steps?: { step_id: string; status: string }[];
    };
    return Array.isArray(j.steps) ? isShipComplete(j.steps) : false;
  } catch {
    return false; // malformed → fail-closed, skip candidate
  }
}

type PruneCandidate = { slugPath: string; branchEntry: string; slug: string; projectDir: string };

/**
 * Scan a branch directory for workspace slugs eligible for pruning.
 *
 * A slug is eligible when ALL conditions hold (AND, cheapest-first):
 *   1. No .lock file (not an active workspace)
 *   2. journal.json records a completed "ship" step (post-ship proof; fail-closed)
 *   3. mtime exceeds max_abandoned_workspace_age_hours (secondary age buffer)
 *
 * The ship-completed gate (condition 2) is the primary safety guard (finalize-04):
 * it prevents reaping in-flight builds that happen to be idle past the age threshold.
 * Age alone is NOT sufficient — see PROBE-FINDINGS Finding 6.
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

    // Gate 1: .lock present → active workspace, skip (unchanged)
    if (existsSync(join(slugPath, ".lock"))) continue;

    // Gate 2: ship-completed check (primary post-ship proof; fail-closed)
    // A workspace without a completed ship step is in-flight — never reap it.
    if (!readShipComplete(slugPath)) continue;

    // Gate 3: age check (secondary buffer — AND with gate 2, never sole key)
    let mtimeMs: number;
    try {
      mtimeMs = statSync(slugPath).mtimeMs;
    } catch {
      // Directory disappeared or is unreadable — skip this candidate
      continue;
    }
    if (ctx.now - mtimeMs < ctx.abandonedMaxAgeMs) continue;

    candidates.push({ branchEntry, projectDir: ctx.projectDir, slug, slugPath });
  }
  return candidates;
}

/**
 * Deregister a git worktree before deleting its directory.
 * Non-blocking: logs at WARN level on failure but never throws.
 */
function removeWorktreeRegistration(worktreeSubPath: string, candidate: PruneCandidate): void {
  try {
    const result = gitExec(
      ["worktree", "remove", "--force", worktreeSubPath],
      candidate.projectDir,
    );
    if (!result.ok) {
      console.warn(
        `[canon] janitor: git worktree remove failed for ${candidate.slug}:`,
        result.stderr.trim(),
      );
    }
  } catch (err: unknown) {
    console.warn(
      `[canon] janitor: git worktree remove threw for ${candidate.slug}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Guard 1 (deletion safety): explicitly unlink the node_modules symlink inside a
 * worktree before `git worktree remove`. Uses lstatSync (does not follow symlinks)
 * to confirm the path IS a symlink before unlinking — prevents accidental deletion
 * of the real main node_modules directory.
 * Best-effort — never throws.
 */
function unlinkWorktreeNodeModulesSymlink(worktreeSubPath: string): void {
  try {
    const nmLink = join(worktreeSubPath, "mcp-server", "node_modules");
    if (lstatSync(nmLink).isSymbolicLink()) unlinkSync(nmLink);
  } catch {
    // best-effort: link absent or not a symlink — nothing to unlink
  }
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
    unlinkWorktreeNodeModulesSymlink(worktreeSubPath); // Guard 1: unlink symlink before worktree remove
    removeWorktreeRegistration(worktreeSubPath, candidate);
  }

  try {
    const branchResult = gitExec(["branch", "-D", `canon/${candidate.slug}`], candidate.projectDir);
    if (!branchResult.ok) {
      console.warn(
        `[canon] janitor: git branch -D failed for ${candidate.slug}:`,
        branchResult.stderr.trim(),
      );
    }
  } catch (err: unknown) {
    console.warn(
      `[canon] janitor: git branch -D threw for ${candidate.slug}:`,
      err instanceof Error ? err.message : err,
    );
  }

  // Persist this slug's orchestrator_decision events into the durable
  // drift.db orchestrator_decisions table BEFORE rmSync destroys them
  // (ADR-0038). Order is load-bearing: persist (committed) THEN delete.
  // Fail-open — never blocks the reap.
  tryPersistWorkspaceDecisions(candidate);

  try {
    rmSync(slugPath, { force: true, recursive: true });
    // The workspace dir + its orchestration.db are now gone — tombstone the
    // registry row (status='reaped') rather than deleting it, so post_message/
    // tail_messages can return a truthful "reaped" rejection (decision
    // registry-store-location-02.md decision 3). Fail-open: never blocks reap.
    tryMarkWorkspaceReaped(candidate.projectDir, slugPath);
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`${branchEntry}/${slug}: ${message}`);
    return false;
  }
}

/**
 * Transition a workspace to `reaped` in the project-level active-workspaces
 * registry (drift.db). Fail-open — janitor is best-effort housekeeping and a
 * registry write must NEVER throw or block the reap.
 */
function tryMarkWorkspaceReaped(projectDir: string, slugPath: string): void {
  try {
    getDriftDb(projectDir).getActiveWorkspaces().markReaped(slugPath);
  } catch (err: unknown) {
    console.warn(
      `[canon] janitor: active-workspaces registry markReaped failed for ${slugPath}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Mirror a workspace's orchestrator_decision events into the durable
 * project-level orchestrator_decisions table (drift.db, ADR-0038), called
 * immediately before rmSync destroys its orchestration.db — the sole
 * destruction boundary. Fail-open — janitor is best-effort housekeeping and
 * a persist failure must NEVER throw or block the reap; `getDriftDb` is
 * guarded here (tryPersistDecisionsBeforeReap only guards the read/persist
 * calls it makes once it already has a DriftDb handle).
 */
function tryPersistWorkspaceDecisions(candidate: PruneCandidate): void {
  try {
    const orchestrationDbPath = join(candidate.slugPath, CANON_FILES.ORCHESTRATION_DB);
    tryPersistDecisionsBeforeReap(
      orchestrationDbPath,
      candidate.slug,
      getDriftDb(candidate.projectDir),
    );
  } catch (err: unknown) {
    console.warn(
      `[canon] janitor: decision persist setup failed for ${candidate.slug}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Remove a branch directory when it is now empty after slug pruning.
 *
 * Uses `rmdirSync` rather than `rmSync(recursive:true)` — the same atomic
 * primitive used by `pruneHuskDirsTask`. `rmdirSync` fails with ENOTEMPTY if
 * the directory is non-empty at the moment of the syscall, preventing a TOCTOU
 * race where a concurrent process creates a new slug between our emptiness check
 * and the deletion. The error lands in the existing best-effort warn path and
 * the branch directory is left intact for the next janitor run.
 */
function cleanupEmptyBranchDir(branchDir: string, prunedInBranch: number): void {
  if (prunedInBranch === 0) return;
  const remaining = listDir(branchDir);
  if (remaining !== null && remaining.length === 0) {
    try {
      rmdirSync(branchDir);
    } catch (err: unknown) {
      console.warn(
        "[canon] janitor: could not remove branch dir (non-empty or inaccessible):",
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/**
 * Execute all janitor tasks and release the lock.
 * Separated from gate-checking to keep runJanitor under complexity limits.
 */
async function runJanitorTasks(
  projectDir: string,
  canonDir: string,
  config: JanitorConfig,
): Promise<{ tasks: Record<string, JanitorTaskResult>; needs_prune: boolean }> {
  const tasks: Record<string, JanitorTaskResult> = {};

  try {
    tasks.wal_checkpoint = runWalCheckpointTask(canonDir);
    tasks.prune_worktrees = pruneWorktreesTask(projectDir);
    tasks.prune_workspaces = await pruneWorkspacesTask(projectDir, canonDir, config);
    tasks.prune_husk_dirs = pruneHuskDirsTask(canonDir);
    await commitJanitorLock(canonDir);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    tasks.unexpected_error = { detail: message, status: "error" };
  } finally {
    await releaseJanitorLock(canonDir);
  }

  const needs_prune =
    tasks.prune_worktrees?.status === "success" ||
    tasks.prune_workspaces?.status === "success" ||
    tasks.prune_husk_dirs?.status === "success";

  return { needs_prune, tasks };
}

/**
 * Run the janitor service.
 *
 * Gate check order (cheapest-first):
 *   1. Config enabled check
 *   2. Time gate (min_hours_between_runs)
 *   3. Lock acquisition
 *
 * When gate passes, runs WAL checkpoint, worktree prune, workspace prune, and husk-dir prune tasks.
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

  // Gate passed — run tasks (lock released inside runJanitorTasks)
  const { tasks, needs_prune } = await runJanitorTasks(projectDir, canonDir, config);
  return { gate_passed: true, needs_prune, tasks };
}
