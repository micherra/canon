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

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Database } from 'better-sqlite3';

import { JobStore, type JobStatus } from './job-store.ts';
import { initExecutionDb } from '../orchestration/execution-schema.ts';
import { computeJobFingerprint } from './job-fingerprint.ts';
import { forkJob, sendWorkerInput, killJob, type JobMessage } from '../adapters/job-adapter.ts';
import { isSyncMode } from '../utils/env.ts';
import { runPipeline } from '../graph/kg-pipeline.ts';
import { toolOk, toolError, type ToolResult } from '../utils/tool-result.ts';
import { CANON_DIR, CANON_FILES, JOB_TIMEOUT_MS } from '../constants.ts';
import type { CodebaseGraphInput } from '../tools/codebase-graph.ts';

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

export interface SubmitResult {
  job_id: string;
  status: JobStatus;
  fingerprint: string;
  deduplicated: boolean;
  cached: boolean;
  result?: Record<string, unknown>;  // Present if cached or sync mode
  [key: string]: unknown;
}

export interface PollResult {
  job_id: string;
  status: JobStatus;
  progress: { phase: string; current: number; total: number } | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number;
  error: string | null;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Worker path — graph-worker.ts lives at src/workers/graph-worker.ts
// We resolve relative to this file so it works when bundled/run from dist/.
// ---------------------------------------------------------------------------

const WORKER_PATH = fileURLToPath(new URL('../workers/graph-worker.ts', import.meta.url));

// ---------------------------------------------------------------------------
// JobManager
// ---------------------------------------------------------------------------

export class JobManager {
  private store: JobStore;
  private activeJobs = new Map<string, ChildProcess>();
  private timeouts = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private db: Database,
    private projectDir: string,
    private pluginDir: string,
    private timeoutMs: number = JOB_TIMEOUT_MS,
  ) {
    this.store = new JobStore(db);
  }

  // -------------------------------------------------------------------------
  // submit
  // -------------------------------------------------------------------------

  /**
   * Submit a codebase graph job.
   *
   * Flow:
   * 1. Compute fingerprint — return INVALID_INPUT if null (not a git repo).
   * 2. Check cache — return cached result immediately if hit.
   * 3. Check for running job with same fingerprint — return deduplicated: true if found.
   * 4. If sync mode — run runPipeline inline, cache result, return complete.
   * 5. Otherwise — create job row, fork worker, wire IPC handlers, start watchdog.
   * 6. Return { job_id, status: 'running', ... }.
   */
  async submit(
    input: CodebaseGraphInput,
    sourceDirs?: string[],
  ): Promise<ToolResult<SubmitResult>> {
    // Step 1: compute fingerprint
    const fingerprint = await computeJobFingerprint({
      projectDir: this.projectDir,
      sourceDirs,
    });

    if (fingerprint === null) {
      return toolError(
        'INVALID_INPUT',
        'Cannot compute job fingerprint: project directory is not a git repository.',
      );
    }

    // Step 2: check cache
    const cached = this.store.getCache(fingerprint);
    if (cached) {
      return toolOk<SubmitResult>({
        job_id: randomUUID(),
        status: 'complete',
        fingerprint,
        deduplicated: false,
        cached: true,
        result: JSON.parse(cached.result_summary) as Record<string, unknown>,
      });
    }

    // Step 3: deduplication check
    const existing = this.store.getRunningJobByFingerprint(fingerprint);
    if (existing) {
      return toolOk<SubmitResult>({
        job_id: existing.job_id,
        status: existing.status,
        fingerprint,
        deduplicated: true,
        cached: false,
      });
    }

    // Step 4: sync mode
    if (isSyncMode()) {
      return this._runSync(fingerprint, sourceDirs);
    }

    // Step 5: fork and return running
    return this._forkJob(fingerprint, input, sourceDirs);
  }

  // -------------------------------------------------------------------------
  // poll
  // -------------------------------------------------------------------------

  /**
   * Poll the status of a job by ID.
   * Returns INVALID_INPUT if the job does not exist.
   */
  poll(jobId: string): ToolResult<PollResult> {
    const job = this.store.getJob(jobId);
    if (!job) {
      return toolError('INVALID_INPUT', `Job not found: ${jobId}`);
    }

    const startedAt = new Date(job.started_at).getTime();
    const completedAt = job.completed_at ? new Date(job.completed_at).getTime() : Date.now();
    const durationMs = completedAt - startedAt;

    let progress: PollResult['progress'] = null;
    if (job.progress) {
      try {
        const parsed = JSON.parse(job.progress) as { phase: string; current: number; total: number };
        progress = parsed;
      } catch {
        // Invalid JSON progress — ignore
      }
    }

    return toolOk<PollResult>({
      job_id: job.job_id,
      status: job.status,
      progress,
      started_at: job.started_at,
      completed_at: job.completed_at,
      duration_ms: durationMs,
      error: job.error,
    });
  }

  // -------------------------------------------------------------------------
  // cancel
  // -------------------------------------------------------------------------

  /**
   * Cancel an active job by ID.
   * Returns { cancelled: true } if the process was killed.
   * Returns { cancelled: false } if the job exists but is not active.
   * Returns INVALID_INPUT if the job does not exist.
   */
  cancel(jobId: string): ToolResult<{ cancelled: boolean }> {
    const job = this.store.getJob(jobId);
    if (!job) {
      return toolError('INVALID_INPUT', `Job not found: ${jobId}`);
    }

    const child = this.activeJobs.get(jobId);
    if (!child) {
      // Job exists but is no longer active (already complete/failed)
      return toolOk({ cancelled: false });
    }

    killJob(child);
    this._clearTimeout(jobId);
    this.activeJobs.delete(jobId);
    this.store.updateJobStatus(jobId, 'cancelled');

    return toolOk({ cancelled: true });
  }

  // -------------------------------------------------------------------------
  // cleanup
  // -------------------------------------------------------------------------

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
    this.store.markStaleJobsFailed('Server shutdown');
  }

  // -------------------------------------------------------------------------
  // Private — sync mode execution
  // -------------------------------------------------------------------------

  private async _runSync(
    fingerprint: string,
    sourceDirs?: string[],
  ): Promise<ToolResult<SubmitResult>> {
    const jobId = randomUUID();
    const startedAt = new Date().toISOString();
    const dbPath = path.join(this.projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);

    this.store.createJob({
      job_id: jobId,
      job_type: 'codebase_graph',
      fingerprint,
      status: 'running',
      pid: null,
      progress: null,
      error: null,
      started_at: startedAt,
      timeout_ms: this.timeoutMs,
    });

    try {
      const result = await runPipeline(this.projectDir, {
        dbPath,
        sourceDirs,
      });

      const completedAt = new Date().toISOString();
      this.store.updateJobStatus(jobId, 'complete', { completed_at: completedAt });
      this.store.setCache({
        fingerprint,
        job_type: 'codebase_graph',
        result_summary: JSON.stringify(result),
        cached_at: completedAt,
        expires_at: null,
      });

      return toolOk<SubmitResult>({
        job_id: jobId,
        status: 'complete',
        fingerprint,
        deduplicated: false,
        cached: false,
        result: result as unknown as Record<string, unknown>,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.store.updateJobStatus(jobId, 'failed', { error });
      return toolOk<SubmitResult>({
        job_id: jobId,
        status: 'failed',
        fingerprint,
        deduplicated: false,
        cached: false,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Private — fork job
  // -------------------------------------------------------------------------

  private _forkJob(
    fingerprint: string,
    input: CodebaseGraphInput,
    sourceDirs?: string[],
  ): ToolResult<SubmitResult> {
    const jobId = randomUUID();
    const startedAt = new Date().toISOString();
    const dbPath = path.join(this.projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);

    this.store.createJob({
      job_id: jobId,
      job_type: 'codebase_graph',
      fingerprint,
      status: 'pending',
      pid: null,
      progress: null,
      error: null,
      started_at: startedAt,
      timeout_ms: this.timeoutMs,
    });

    const child = forkJob({
      workerPath: WORKER_PATH,
      onMessage: (msg: JobMessage) => this._handleMessage(jobId, fingerprint, msg),
      onExit: (code, signal) => this._handleExit(jobId, code, signal),
    });

    // Track the process; update DB with PID
    this.activeJobs.set(jobId, child);
    this.store.updateJobStatus(jobId, 'running', { pid: child.pid ?? undefined });

    // Send start command to worker — forward all relevant CodebaseGraphInput fields
    sendWorkerInput(child, {
      type: 'start',
      projectDir: this.projectDir,
      dbPath,
      sourceDirs,
      include_extensions: input.include_extensions,
      exclude_dirs: input.exclude_dirs,
    });

    // Start timeout watchdog
    const timer = setTimeout(() => {
      this._handleTimeout(jobId);
    }, this.timeoutMs);
    this.timeouts.set(jobId, timer);

    return toolOk<SubmitResult>({
      job_id: jobId,
      status: 'running',
      fingerprint,
      deduplicated: false,
      cached: false,
    });
  }

  // -------------------------------------------------------------------------
  // Private — IPC handlers
  // -------------------------------------------------------------------------

  private _handleMessage(jobId: string, fingerprint: string, msg: JobMessage): void {
    if (msg.type === 'progress') {
      this.store.updateJobProgress(
        jobId,
        JSON.stringify({ phase: msg.phase, current: msg.current, total: msg.total }),
      );
    } else if (msg.type === 'complete') {
      const completedAt = new Date().toISOString();
      this.store.updateJobStatus(jobId, 'complete', { completed_at: completedAt });
      this.store.setCache({
        fingerprint,
        job_type: 'codebase_graph',
        result_summary: JSON.stringify(msg.result),
        cached_at: completedAt,
        expires_at: null,
      });
      this._clearTimeout(jobId);
      this.activeJobs.delete(jobId);
    } else if (msg.type === 'error') {
      this.store.updateJobStatus(jobId, 'failed', { error: msg.message });
      this._clearTimeout(jobId);
      this.activeJobs.delete(jobId);
    }
  }

  private _handleExit(
    jobId: string,
    _code: number | null,
    _signal: string | null,
  ): void {
    // If the job is still in activeJobs it exited unexpectedly (no complete/error message)
    if (this.activeJobs.has(jobId)) {
      const job = this.store.getJob(jobId);
      if (job && (job.status === 'running' || job.status === 'pending')) {
        this.store.updateJobStatus(jobId, 'failed', { error: 'Worker exited unexpectedly' });
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
    this.store.updateJobStatus(jobId, 'timed_out');
  }

  // -------------------------------------------------------------------------
  // Private — helpers
  // -------------------------------------------------------------------------

  private _clearTimeout(jobId: string): void {
    const timer = this.timeouts.get(jobId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timeouts.delete(jobId);
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton accessor
// ---------------------------------------------------------------------------

let _instance: JobManager | null = null;

/**
 * Get or create the singleton JobManager instance.
 * Returns null if called before initJobManager().
 */
export function getJobManager(): JobManager | null {
  return _instance;
}

/**
 * Initialize the singleton JobManager.
 * Must be called before getJobManager() or getOrCreateJobManager() can return an instance.
 */
export function initJobManager(
  db: Database,
  projectDir: string,
  pluginDir: string,
  timeoutMs?: number,
): JobManager {
  if (!_instance) {
    _instance = new JobManager(db, projectDir, pluginDir, timeoutMs);
  }
  return _instance;
}

/**
 * Get the singleton JobManager, creating it lazily.
 * Uses initExecutionDb to open orchestration.db (where jobs/job_cache tables live).
 * Suitable for use from tool handlers where the DB path is computed inside JobManager.
 *
 * NOTE: In production use, prefer calling initJobManager() at startup with the
 * shared DB so all tools share the same state.
 */
export async function getOrCreateJobManager(
  projectDir: string,
  pluginDir: string,
  timeoutMs?: number,
): Promise<JobManager> {
  if (!_instance) {
    const dbPath = path.join(projectDir, CANON_DIR, CANON_FILES.ORCHESTRATION_DB);
    const db = initExecutionDb(dbPath);
    _instance = new JobManager(db, projectDir, pluginDir, timeoutMs);
  }
  return _instance;
}

/** Reset the singleton (test only). */
export function _resetJobManagerSingleton(): void {
  _instance = null;
}
