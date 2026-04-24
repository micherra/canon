/**
 * Janitor service — background housekeeping orchestrator.
 *
 * Runs gate checks (cheapest-first), then executes tasks:
 *   - wal_checkpoint: flush WAL files for root-level Canon SQLite databases
 *
 * After tasks complete, detects whether worktree pruning is needed.
 *
 * Canon principles:
 *   - fail-closed-by-default: gate fails → don't run; lock not acquired → don't run
 *   - no-silent-failures: every task records its outcome with status and detail
 *   - define-errors-out-of-existence: no WAL file = skip; no DB = skip; missing dir = false
 *   - subprocess-isolation: SQLite via better-sqlite3 in-process; no shell commands
 */

import Database from "better-sqlite3";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CANON_DIR, CANON_FILES } from "@shared/constants.ts";
import {
  acquireJanitorLock,
  commitJanitorLock,
  getLastJanitorTimestamp,
  releaseJanitorLock,
} from "@shared/lib/janitor-lock.ts";
import { loadJanitorConfig } from "@shared/lib/config.ts";

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
  const walPath = dbPath + "-wal";
  if (!existsSync(walPath)) {
    return { status: "skipped", detail: `no WAL file at ${walPath}` };
  }
  if (!existsSync(dbPath)) {
    return { status: "skipped", detail: `database not found at ${dbPath}` };
  }

  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(dbPath, { readonly: false });
    db.pragma("wal_checkpoint(PASSIVE)");
    return { status: "success" };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: "error", detail: message };
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
  let allSkipped = true;

  for (const dbKey of ROOT_DB_KEYS) {
    const dbPath = join(canonDir, dbKey);
    const result = checkpointDb(dbPath);
    if (result.status === "error") {
      hasError = true;
      errorDetail = result.detail;
    }
    if (result.status !== "skipped") {
      allSkipped = false;
    }
  }

  if (hasError) {
    return { status: "error", detail: errorDetail };
  }
  return { status: "success" };
}

/**
 * Detect whether the .canon/worktrees directory has any entries.
 * Returns false if the directory does not exist or is empty.
 */
function detectNeedsPrune(canonDir: string): boolean {
  const worktreesDir = join(canonDir, "worktrees");
  try {
    const entries = readdirSync(worktreesDir);
    return entries.length > 0;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    // On unexpected errors, assume no prune needed (fail-closed)
    return false;
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
 * When gate passes, runs WAL checkpoint task and detects prune need.
 * Always releases lock on exit, even on unexpected error.
 *
 * @param projectDir - Project root directory (contains .canon/)
 */
export async function runJanitor(projectDir: string): Promise<JanitorResult> {
  const canonDir = join(projectDir, CANON_DIR);

  // Gate 1: Config enabled check
  const config = await loadJanitorConfig(projectDir);
  if (!config.enabled) {
    return { gate_passed: false, reason: "janitor disabled", tasks: {}, needs_prune: false };
  }

  // Gate 2: Time gate
  const lastTs = await getLastJanitorTimestamp(canonDir);
  if (lastTs !== null) {
    const hoursSinceLast = (Date.now() - lastTs) / (1000 * 60 * 60);
    if (hoursSinceLast < config.min_hours_between_runs) {
      return {
        gate_passed: false,
        reason: `time gate: ${hoursSinceLast.toFixed(1)}h < ${config.min_hours_between_runs}h`,
        tasks: {},
        needs_prune: false,
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
      reason: `lock: ${lockResult.reason}`,
      tasks: {},
      needs_prune: false,
    };
  }

  // Gate passed — run tasks
  const tasks: Record<string, JanitorTaskResult> = {};
  let needsPrune = false;

  try {
    // Task: WAL checkpoint
    tasks["wal_checkpoint"] = runWalCheckpointTask(canonDir);

    // Prune detection
    needsPrune = detectNeedsPrune(canonDir);

    // Commit lock (update mtime = last successful run timestamp)
    await commitJanitorLock(canonDir);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    tasks["unexpected_error"] = { status: "error", detail: message };
    // Fall through to lock release
  } finally {
    await releaseJanitorLock(canonDir);
  }

  return {
    gate_passed: true,
    tasks,
    needs_prune: needsPrune,
  };
}
