/**
 * JobManager — orchestration layer combining JobStore, job-adapter, and job-fingerprint.
 *
 * Public API: submit, poll, cancel, cleanup.
 * Hides IPC, caching, fingerprinting, and process tracking behind 4 methods (deep module).
 *
 * Design notes:
 * - submit() deduplicates by fingerprint before forking.
 * - submit() checks the cache before dedup check.
 * - Sync mode (isSyncMode()) bypasses child process; runs runPipeline inline.
 * - IPC handlers update DB via JobStore on progress/complete/error messages.
 * - Timeout watchdog: setTimeout per job that calls killJob and sets status.
 * - cleanup() kills all active jobs and marks DB stale jobs as failed.
 */

import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initExecutionDb } from "@domains/workspaces/execution-schema.ts";
import type { CodebaseGraphInput } from "@features/knowledge-graph/tools/codebase-graph.ts";
import { runPipeline } from "@graph/kg-pipeline.ts";
import {
  forkJob,
  type JobMessage,
  killJob,
  sendWorkerInput,
} from "@platform/adapters/job-adapter.ts";
import { CANON_DIR, CANON_FILES, JOB_TIMEOUT_MS } from "@shared/constants.ts";
import { isSyncMode } from "@shared/lib/env.ts";
import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";
import type { Database } from "better-sqlite3";
import { computeJobFingerprint } from "./job-fingerprint.ts";
import { type JobStatus, JobStore } from "./job-store.ts";

// Public result types

export type SubmitResult = {
  job_id: string;
  status: JobStatus;
  fingerprint: string;
  deduplicated: boolean;
  cached: boolean;
  result?: Record<string, unknown>; // Present if cached or sync mode
  [key: string]: unknown;
};

export type PollResult = {
  job_id: string;
  status: JobStatus;
  progress: { phase: string; current: number; total: number } | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number;
  error: string | null;
  [key: string]: unknown;
};

// Worker path and working directory.
//
// graph-worker.ts lives at src/platform/workers/graph-worker.ts.
// jobs/ and workers/ are sibling directories under platform/, so the relative
// path from platform/jobs/ to platform/workers/ is ../workers/.
// We resolve relative to this file so it works when bundled/run from dist/.
//
// WORKER_CWD is the mcp-server/ root — the directory that contains
// node_modules. The forked child process must inherit this as its cwd so that
// `--import tsx` (and any other packages the worker imports) can be resolved
// regardless of what directory the parent process is running from.

const GRAPH_WORKER_URL = new URL("../workers/graph-worker.ts", import.meta.url);
const WORKER_PATH = fileURLToPath(GRAPH_WORKER_URL);
// job-manager.ts is at src/platform/jobs/, so ../../../ resolves to mcp-server/
const WORKER_CWD = fileURLToPath(new URL("../../../", import.meta.url));

// JobManager

export class JobManager {
  private store: JobStore;
  private activeJobs = new Map<string, ChildProcess>();
  private timeouts = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    db: Database,
    private projectDir: string,
    _pluginDir: string,
    private timeoutMs: number = JOB_TIMEOUT_MS,
  ) {
    this.store = new JobStore(db);
  }

  // submit

  /**
   * Submit a codebase graph job.
   *
   * Flow:
   * 1. Compute fingerprint — return INVALID_INPUT if null (not a git repo).
   * 2. Check cache — return cached result immediately if hit (skipped when force=true).
   * 3. Check for running job with same fingerprint — return deduplicated: true if found.
   * 4. If sync mode — run runPipeline inline, cache result, return complete.
   * 5. Otherwise — create job row, fork worker, wire IPC handlers, start watchdog.
   * 6. Return { job_id, status: 'running', ... }.
   */
  async submit(
    input: CodebaseGraphInput,
    sourceDirs?: string[],
    force?: boolean,
  ): Promise<ToolResult<SubmitResult>> {
    // Step 1: compute fingerprint
    const fingerprint = await computeJobFingerprint({
      projectDir: this.projectDir,
      sourceDirs,
    });

    if (fingerprint === null) {
      return toolError(
        "INVALID_INPUT",
        "Cannot compute job fingerprint: project directory is not a git repository.",
      );
    }

    // Step 2: check cache (skipped when force=true)
    if (!force) {
      const cached = this.store.getCache(fingerprint);
      if (cached) {
        return toolOk<SubmitResult>({
          cached: true,
          deduplicated: false,
          fingerprint,
          job_id: randomUUID(),
          result: JSON.parse(cached.result_summary) as Record<string, unknown>,
          status: "complete",
        });
      }
    }

    // Step 3: deduplication check
    const existing = this.store.getRunningJobByFingerprint(fingerprint);
    if (existing) {
      return toolOk<SubmitResult>({
        cached: false,
        deduplicated: true,
        fingerprint,
        job_id: existing.job_id,
        status: existing.status,
      });
    }

    // Step 4: sync mode
    if (isSyncMode()) {
      return this._runSync(fingerprint, sourceDirs);
    }

    // Step 5: fork and return running
    return this._forkJob(fingerprint, input, sourceDirs);
  }

  // poll

  /**
   * Poll the status of a job by ID.
   * Returns INVALID_INPUT if the job does not exist.
   */
  poll(jobId: string): ToolResult<PollResult> {
    const job = this.store.getJob(jobId);
    if (!job) {
      return toolError("INVALID_INPUT", `Job not found: ${jobId}`);
    }

    const startedAt = new Date(job.started_at).getTime();
    const completedAt = job.completed_at ? new Date(job.completed_at).getTime() : Date.now();
    const durationMs = completedAt - startedAt;

    let progress: PollResult["progress"] = null;
    if (job.progress) {
      try {
        const parsed = JSON.parse(job.progress) as {
          phase: string;
          current: number;
          total: number;
        };
        progress = parsed;
      } catch {
        // Invalid JSON progress — ignore
      }
    }

    return toolOk<PollResult>({
      completed_at: job.completed_at,
      duration_ms: durationMs,
      error: job.error,
      job_id: job.job_id,
      progress,
      started_at: job.started_at,
      status: job.status,
    });
  }

  // cancel

  /**
   * Cancel an active job by ID.
   * Returns { cancelled: true } if the process was killed.
   * Returns { cancelled: false } if the job exists but is not active.
   * Returns INVALID_INPUT if the job does not exist.
   */
  cancel(jobId: string): ToolResult<{ cancelled: boolean }> {
    const job = this.store.getJob(jobId);
    if (!job) {
      return toolError("INVALID_INPUT", `Job not found: ${jobId}`);
    }

    const child = this.activeJobs.get(jobId);
    if (!child) {
      // Job exists but is no longer active (already complete/failed)
      return toolOk({ cancelled: false });
    }

    killJob(child);
    this._clearTimeout(jobId);
    this.activeJobs.delete(jobId);
    this.store.updateJobStatus(jobId, "cancelled");

    return toolOk({ cancelled: true });
  }

  // cleanup

  /**
   * Kill all active jobs and mark any remaining stale DB jobs as failed.
   * Called on server shutdown / signal handler.
   */
  cleanup(): void {
    for (const [jobId, child] of this.activeJobs) {
      killJob(child);
      this._clearTimeout(jobId);
    }
    this.activeJobs.clear();
    this.timeouts.clear();
    this.store.markStaleJobsFailed("Server shutdown");
  }

  // Private — sync mode execution

  private async _runSync(
    fingerprint: string,
    sourceDirs?: string[],
  ): Promise<ToolResult<SubmitResult>> {
    const jobId = randomUUID();
    const startedAt = new Date().toISOString();
    const dbPath = path.join(this.projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);

    this.store.createJob({
      error: null,
      fingerprint,
      job_id: jobId,
      job_type: "codebase_graph",
      pid: null,
      progress: null,
      started_at: startedAt,
      status: "running",
      timeout_ms: this.timeoutMs,
    });

    try {
      const result = await runPipeline(this.projectDir, {
        dbPath,
        sourceDirs,
      });

      const completedAt = new Date().toISOString();
      this.store.updateJobStatus(jobId, "complete", { completed_at: completedAt });
      this.store.setCache({
        cached_at: completedAt,
        expires_at: null,
        fingerprint,
        job_type: "codebase_graph",
        result_summary: JSON.stringify(result),
      });

      return toolOk<SubmitResult>({
        cached: false,
        deduplicated: false,
        fingerprint,
        job_id: jobId,
        result: result as unknown as Record<string, unknown>,
        status: "complete",
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.store.updateJobStatus(jobId, "failed", { error });
      return toolOk<SubmitResult>({
        cached: false,
        deduplicated: false,
        fingerprint,
        job_id: jobId,
        status: "failed",
      });
    }
  }

  // Private — fork job

  private _forkJob(
    fingerprint: string,
    input: CodebaseGraphInput,
    sourceDirs?: string[],
  ): ToolResult<SubmitResult> {
    const jobId = randomUUID();
    const startedAt = new Date().toISOString();
    const dbPath = path.join(this.projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);

    this.store.createJob({
      error: null,
      fingerprint,
      job_id: jobId,
      job_type: "codebase_graph",
      pid: null,
      progress: null,
      started_at: startedAt,
      status: "pending",
      timeout_ms: this.timeoutMs,
    });

    const child = forkJob({
      cwd: WORKER_CWD,
      onExit: (code, signal) => this._handleExit(jobId, code, signal),
      onMessage: (msg: JobMessage) => this._handleMessage(jobId, fingerprint, msg),
      workerPath: WORKER_PATH,
    });

    // Track the process; update DB with PID
    this.activeJobs.set(jobId, child);
    this.store.updateJobStatus(jobId, "running", { pid: child.pid ?? undefined });

    // Send start command to worker — forward all relevant CodebaseGraphInput fields
    sendWorkerInput(child, {
      dbPath,
      exclude_dirs: input.exclude_dirs,
      include_extensions: input.include_extensions,
      projectDir: this.projectDir,
      sourceDirs,
      type: "start",
    });

    // Start timeout watchdog
    const timer = setTimeout(() => {
      this._handleTimeout(jobId);
    }, this.timeoutMs);
    this.timeouts.set(jobId, timer);

    return toolOk<SubmitResult>({
      cached: false,
      deduplicated: false,
      fingerprint,
      job_id: jobId,
      status: "running",
    });
  }

  // Private — IPC handlers

  private _handleMessage(jobId: string, fingerprint: string, msg: JobMessage): void {
    if (msg.type === "progress") {
      this.store.updateJobProgress(
        jobId,
        JSON.stringify({ current: msg.current, phase: msg.phase, total: msg.total }),
      );
    } else if (msg.type === "complete") {
      const completedAt = new Date().toISOString();
      this.store.updateJobStatus(jobId, "complete", { completed_at: completedAt });
      this.store.setCache({
        cached_at: completedAt,
        expires_at: null,
        fingerprint,
        job_type: "codebase_graph",
        result_summary: JSON.stringify(msg.result),
      });
      this._clearTimeout(jobId);
      this.activeJobs.delete(jobId);
    } else if (msg.type === "error") {
      this.store.updateJobStatus(jobId, "failed", { error: msg.message });
      this._clearTimeout(jobId);
      this.activeJobs.delete(jobId);
    }
  }

  private _handleExit(jobId: string, _code: number | null, _signal: string | null): void {
    // If the job is still in activeJobs it exited unexpectedly (no complete/error message)
    if (this.activeJobs.has(jobId)) {
      const job = this.store.getJob(jobId);
      if (job && (job.status === "running" || job.status === "pending")) {
        this.store.updateJobStatus(jobId, "failed", { error: "Worker exited unexpectedly" });
      }
      this._clearTimeout(jobId);
      this.activeJobs.delete(jobId);
    }
  }

  private _handleTimeout(jobId: string): void {
    const child = this.activeJobs.get(jobId);
    if (child) {
      killJob(child);
      this.activeJobs.delete(jobId);
    }
    this.timeouts.delete(jobId);
    this.store.updateJobStatus(jobId, "timed_out");
  }

  // Private — helpers

  private _clearTimeout(jobId: string): void {
    const timer = this.timeouts.get(jobId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timeouts.delete(jobId);
    }
  }
}

// Per-project accessor (keyed by resolved projectDir — the session-isolation
// half that pairs with resolveScope. Under stdio there is exactly one scope, so
// this resolves to today's single-instance behavior; under a future multi-tenant
// HTTP daemon each project scope gets its own manager wired to its own DB.)

const jobManagers = new Map<string, JobManager>();

/**
 * Return the JobManager for the given project scope, or `undefined` if none
 * exists yet. Non-creating lookup — creation is reserved to getOrCreateJobManager.
 * Requires an explicit projectDir (fail-closed: no zero-arg form that could
 * return a wrong-scope manager).
 */
export function getJobManager(projectDir: string): JobManager | undefined {
  return jobManagers.get(path.resolve(projectDir));
}

/**
 * Get or create the JobManager for a project scope.
 * Uses initExecutionDb to open orchestration.db (where jobs/job_cache tables live).
 * Suitable for use from tool handlers where the DB path is computed inside JobManager.
 */
export async function getOrCreateJobManager(
  projectDir: string,
  pluginDir: string,
  timeoutMs?: number,
): Promise<JobManager> {
  const key = path.resolve(projectDir);
  const existing = jobManagers.get(key);
  if (existing) return existing;
  const dbPath = path.join(projectDir, CANON_DIR, CANON_FILES.ORCHESTRATION_DB);
  const db = initExecutionDb(dbPath);
  const manager = new JobManager(db, projectDir, pluginDir, timeoutMs);
  jobManagers.set(key, manager);
  return manager;
}

/**
 * Cleanup every per-project JobManager (kill active jobs, mark stale DB jobs
 * failed). For process shutdown — signal handlers have no per-request scope, so
 * they iterate all managers. Correct for stdio's single entry; forward-compatible
 * for HTTP shutdown.
 */
export function cleanupAllJobManagers(): void {
  for (const manager of jobManagers.values()) {
    try {
      manager.cleanup();
    } catch {
      // Best-effort shutdown — one failing manager must not block the others.
    }
  }
}

/**
 * Evict the JobManager for a single project scope (HTTP session teardown path).
 * Cleanup the manager's active jobs then remove from the map.
 * Keeps the jobManagers map private — callers must not reach into the map directly.
 * No-op when no manager exists for this scope.
 */
export function evictJobManagerForScope(projectDir: string): void {
  const key = path.resolve(projectDir);
  const manager = jobManagers.get(key);
  if (!manager) return;
  try {
    manager.cleanup();
  } finally {
    jobManagers.delete(key);
  }
}

/** Reset all per-project JobManagers (test only). */
export function _resetJobManagerSingleton(): void {
  for (const manager of jobManagers.values()) {
    try {
      manager.cleanup();
    } catch {
      // ignore — test reset is best-effort
    }
  }
  jobManagers.clear();
}
