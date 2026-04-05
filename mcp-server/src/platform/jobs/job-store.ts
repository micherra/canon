/**
 * JobStore — SQLite CRUD for jobs and job_cache tables.
 *
 * Accepts a Database handle (from initExecutionDb / better-sqlite3).
 * All methods use prepared statements cached as private class fields.
 * Single-row operations are auto-committed.
 * markStaleJobsFailed uses a single UPDATE with no explicit transaction needed.
 *
 * Design notes:
 * - No transactions for single-row ops (SQLite auto-commits each statement).
 * - Prepared statements are cached lazily on first use (Comment #12).
 * - getTimedOutJobs uses SQLite datetime arithmetic to avoid loading all jobs.
 * - updateJobStatus builds SQL dynamically based on optional fields — not cached.
 */

import type { Database, Statement } from "better-sqlite3";

export type JobStatus = "pending" | "running" | "complete" | "failed" | "cancelled" | "timed_out";

export type JobRow = {
  job_id: string;
  job_type: string;
  fingerprint: string;
  status: JobStatus;
  pid: number | null;
  progress: string | null; // JSON
  error: string | null;
  started_at: string;
  completed_at: string | null;
  timeout_ms: number;
};

export type JobCacheRow = {
  fingerprint: string;
  job_type: string;
  result_summary: string; // JSON
  cached_at: string;
  expires_at: string | null;
};

// JobStore

export class JobStore {
  constructor(private db: Database) {}

  // Cached prepared statements (Comment #12: lazily initialized on first use)

  private _createJobStmt?: Statement;
  private get createJobStmt(): Statement {
    if (!this._createJobStmt) {
      this._createJobStmt = this.db.prepare(`
      INSERT INTO jobs (job_id, job_type, fingerprint, status, pid, progress, error, started_at, completed_at, timeout_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `);
    }
    return this._createJobStmt;
  }

  private _getJobStmt?: Statement;
  private get getJobStmt(): Statement {
    if (!this._getJobStmt) {
      this._getJobStmt = this.db.prepare(`
      SELECT job_id, job_type, fingerprint, status, pid, progress, error,
             started_at, completed_at, timeout_ms
      FROM jobs
      WHERE job_id = ?
    `);
    }
    return this._getJobStmt;
  }

  private _getRunningJobByFingerprintStmt?: Statement;
  private get getRunningJobByFingerprintStmt(): Statement {
    if (!this._getRunningJobByFingerprintStmt) {
      this._getRunningJobByFingerprintStmt = this.db.prepare(`
      SELECT job_id, job_type, fingerprint, status, pid, progress, error,
             started_at, completed_at, timeout_ms
      FROM jobs
      WHERE fingerprint = ?
        AND status IN ('pending', 'running')
      ORDER BY started_at DESC
      LIMIT 1
    `);
    }
    return this._getRunningJobByFingerprintStmt;
  }

  private _updateJobProgressStmt?: Statement;
  private get updateJobProgressStmt(): Statement {
    if (!this._updateJobProgressStmt) {
      this._updateJobProgressStmt = this.db.prepare(
        `UPDATE jobs SET progress = ? WHERE job_id = ?`,
      );
    }
    return this._updateJobProgressStmt;
  }

  private _getCacheStmt?: Statement;
  private get getCacheStmt(): Statement {
    if (!this._getCacheStmt) {
      this._getCacheStmt = this.db.prepare(`
      SELECT fingerprint, job_type, result_summary, cached_at, expires_at
      FROM job_cache
      WHERE fingerprint = ?
        AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
    `);
    }
    return this._getCacheStmt;
  }

  private _setCacheStmt?: Statement;
  private get setCacheStmt(): Statement {
    if (!this._setCacheStmt) {
      this._setCacheStmt = this.db.prepare(`
      INSERT OR REPLACE INTO job_cache (fingerprint, job_type, result_summary, cached_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    }
    return this._setCacheStmt;
  }

  private _markStaleJobsFailedStmt?: Statement;
  private get markStaleJobsFailedStmt(): Statement {
    if (!this._markStaleJobsFailedStmt) {
      this._markStaleJobsFailedStmt = this.db.prepare(`
      UPDATE jobs
      SET status = 'failed', error = ?
      WHERE status IN ('pending', 'running')
    `);
    }
    return this._markStaleJobsFailedStmt;
  }

  private _getTimedOutJobsStmt?: Statement;
  private get getTimedOutJobsStmt(): Statement {
    if (!this._getTimedOutJobsStmt) {
      this._getTimedOutJobsStmt = this.db.prepare(`
      SELECT job_id, job_type, fingerprint, status, pid, progress, error,
             started_at, completed_at, timeout_ms
      FROM jobs
      WHERE status = 'running'
        AND datetime(started_at, '+' || (timeout_ms / 1000) || ' seconds') < datetime('now')
    `);
    }
    return this._getTimedOutJobsStmt;
  }

  // Public methods

  /**
   * Insert a new job row. started_at is required; completed_at defaults to NULL.
   */
  createJob(job: Omit<JobRow, "completed_at">): void {
    this.createJobStmt.run(
      job.job_id,
      job.job_type,
      job.fingerprint,
      job.status,
      job.pid,
      job.progress,
      job.error,
      job.started_at,
      job.timeout_ms,
    );
  }

  /**
   * Retrieve a job by ID. Returns null if not found.
   */
  getJob(jobId: string): JobRow | null {
    const row = this.getJobStmt.get(jobId) as JobRow | undefined;
    return row ?? null;
  }

  /**
   * Find an active (pending or running) job with a matching fingerprint.
   * Returns null if no such job exists.
   */
  getRunningJobByFingerprint(fingerprint: string): JobRow | null {
    const row = this.getRunningJobByFingerprintStmt.get(fingerprint) as JobRow | undefined;
    return row ?? null;
  }

  /**
   * Update a job's status plus optional fields (pid, error, completed_at).
   * Fields not provided in `extra` remain unchanged.
   *
   * Note: This method builds SQL dynamically based on provided fields, so
   * prepared statement caching is not applicable here.
   */
  updateJobStatus(
    jobId: string,
    status: JobStatus,
    extra?: { pid?: number; error?: string; completed_at?: string },
  ): void {
    // Build SET clause dynamically based on provided extra fields
    const sets: string[] = ["status = ?"];
    const params: unknown[] = [status];

    if (extra?.pid !== undefined) {
      sets.push("pid = ?");
      params.push(extra.pid);
    }
    if (extra?.error !== undefined) {
      sets.push("error = ?");
      params.push(extra.error);
    }
    if (extra?.completed_at !== undefined) {
      sets.push("completed_at = ?");
      params.push(extra.completed_at);
    }

    params.push(jobId);
    this.db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE job_id = ?`).run(...params);
  }

  /**
   * Update the progress JSON blob for a job (e.g., from IPC progress messages).
   */
  updateJobProgress(jobId: string, progress: string): void {
    this.updateJobProgressStmt.run(progress, jobId);
  }

  /**
   * Get a cache entry for the given fingerprint.
   * Returns null if not found or if the entry has expired.
   */
  getCache(fingerprint: string): JobCacheRow | null {
    const row = this.getCacheStmt.get(fingerprint) as JobCacheRow | undefined;
    return row ?? null;
  }

  /**
   * Insert or replace a cache entry. Uses INSERT OR REPLACE for idempotency.
   */
  setCache(entry: JobCacheRow): void {
    this.setCacheStmt.run(
      entry.fingerprint,
      entry.job_type,
      entry.result_summary,
      entry.cached_at,
      entry.expires_at,
    );
  }

  /**
   * Mark all pending/running jobs as failed with the given error message.
   * Returns the number of rows updated.
   *
   * Called on server startup to handle jobs from a crashed/restarted server.
   * Single UPDATE statement — no explicit transaction needed.
   */
  markStaleJobsFailed(errorMessage: string): number {
    const result = this.markStaleJobsFailedStmt.run(errorMessage);
    return result.changes;
  }

  /**
   * Return all running jobs that have exceeded their timeout_ms threshold.
   *
   * Uses SQLite datetime arithmetic:
   *   started_at (ISO-8601 text) + timeout_ms milliseconds < current time
   *
   * SQLite stores timestamps as ISO-8601 text and supports
   * datetime(started_at, '+N milliseconds') arithmetic for precision.
   */
  getTimedOutJobs(): JobRow[] {
    // SQLite supports '+N seconds' datetime modifiers (integer division converts ms → s).
    // We compute expiry = started_at + timeout_ms/1000 seconds and compare to 'now'.
    // Note: integer division in SQLite truncates fractional seconds, acceptable for
    // job timeout detection (sub-second precision is not required here).
    return this.getTimedOutJobsStmt.all() as JobRow[];
  }
}
