/**
 * JobStore tests — in-memory SQLite with v7 migration applied.
 *
 * TDD: tests written first; implementation follows in job-store.ts.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { JobStore, type JobRow, type JobCacheRow } from '../job-store.ts';
import { initExecutionDb } from '../../orchestration/execution-schema.ts';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): Database.Database {
  // Use a temp file-based DB so initExecutionDb can apply migrations properly.
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'job-store-test-'));
  const dbPath = path.join(tmpDir, 'orchestration.db');
  return initExecutionDb(dbPath);
}

function makeJobRow(overrides?: Partial<Omit<JobRow, 'completed_at'>>): Omit<JobRow, 'completed_at'> {
  return {
    job_id: randomUUID(),
    job_type: 'codebase_graph',
    fingerprint: 'abc123',
    status: 'pending',
    pid: null,
    progress: null,
    error: null,
    started_at: new Date().toISOString(),
    timeout_ms: 300_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JobStore', () => {
  let db: Database.Database;
  let store: JobStore;

  beforeEach(() => {
    db = makeDb();
    store = new JobStore(db);
  });

  // -------------------------------------------------------------------------
  // createJob / getJob round-trip
  // -------------------------------------------------------------------------

  it('createJob + getJob round-trip returns the job row', () => {
    const job = makeJobRow({ job_id: 'job-1', fingerprint: 'fp1' });
    store.createJob(job);

    const result = store.getJob('job-1');
    expect(result).not.toBeNull();
    expect(result!.job_id).toBe('job-1');
    expect(result!.job_type).toBe('codebase_graph');
    expect(result!.fingerprint).toBe('fp1');
    expect(result!.status).toBe('pending');
    expect(result!.pid).toBeNull();
    expect(result!.progress).toBeNull();
    expect(result!.error).toBeNull();
    expect(result!.completed_at).toBeNull();
    expect(result!.timeout_ms).toBe(300_000);
  });

  it('getJob returns null for unknown job_id', () => {
    expect(store.getJob('nonexistent')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // getRunningJobByFingerprint
  // -------------------------------------------------------------------------

  it('getRunningJobByFingerprint returns pending job with matching fingerprint', () => {
    const job = makeJobRow({ fingerprint: 'fp-running', status: 'pending' });
    store.createJob(job);

    const result = store.getRunningJobByFingerprint('fp-running');
    expect(result).not.toBeNull();
    expect(result!.job_id).toBe(job.job_id);
  });

  it('getRunningJobByFingerprint returns running job with matching fingerprint', () => {
    const job = makeJobRow({ fingerprint: 'fp-running', status: 'pending' });
    store.createJob(job);
    store.updateJobStatus(job.job_id, 'running', { pid: 12345 });

    const result = store.getRunningJobByFingerprint('fp-running');
    expect(result).not.toBeNull();
    expect(result!.status).toBe('running');
  });

  it('getRunningJobByFingerprint returns null for completed job', () => {
    const job = makeJobRow({ fingerprint: 'fp-done', status: 'pending' });
    store.createJob(job);
    store.updateJobStatus(job.job_id, 'complete', { completed_at: new Date().toISOString() });

    expect(store.getRunningJobByFingerprint('fp-done')).toBeNull();
  });

  it('getRunningJobByFingerprint returns null for failed job', () => {
    const job = makeJobRow({ fingerprint: 'fp-failed', status: 'pending' });
    store.createJob(job);
    store.updateJobStatus(job.job_id, 'failed', { error: 'boom' });

    expect(store.getRunningJobByFingerprint('fp-failed')).toBeNull();
  });

  it('getRunningJobByFingerprint returns null when no job with that fingerprint', () => {
    expect(store.getRunningJobByFingerprint('unknown-fp')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // updateJobStatus
  // -------------------------------------------------------------------------

  it('updateJobStatus transitions status to running with pid', () => {
    const job = makeJobRow({ job_id: 'job-status-1' });
    store.createJob(job);
    store.updateJobStatus('job-status-1', 'running', { pid: 9999 });

    const result = store.getJob('job-status-1');
    expect(result!.status).toBe('running');
    expect(result!.pid).toBe(9999);
  });

  it('updateJobStatus transitions status to complete with completed_at', () => {
    const job = makeJobRow({ job_id: 'job-status-2' });
    store.createJob(job);
    const completedAt = new Date().toISOString();
    store.updateJobStatus('job-status-2', 'complete', { completed_at: completedAt });

    const result = store.getJob('job-status-2');
    expect(result!.status).toBe('complete');
    expect(result!.completed_at).toBe(completedAt);
  });

  it('updateJobStatus transitions status to failed with error', () => {
    const job = makeJobRow({ job_id: 'job-status-3' });
    store.createJob(job);
    store.updateJobStatus('job-status-3', 'failed', { error: 'something went wrong' });

    const result = store.getJob('job-status-3');
    expect(result!.status).toBe('failed');
    expect(result!.error).toBe('something went wrong');
  });

  it('updateJobStatus with no extra updates only status', () => {
    const job = makeJobRow({ job_id: 'job-status-4' });
    store.createJob(job);
    store.updateJobStatus('job-status-4', 'cancelled');

    const result = store.getJob('job-status-4');
    expect(result!.status).toBe('cancelled');
  });

  // -------------------------------------------------------------------------
  // updateJobProgress
  // -------------------------------------------------------------------------

  it('updateJobProgress stores JSON progress string', () => {
    const job = makeJobRow({ job_id: 'job-progress-1' });
    store.createJob(job);

    const progress = JSON.stringify({ phase: 'scan', current: 5, total: 20 });
    store.updateJobProgress('job-progress-1', progress);

    const result = store.getJob('job-progress-1');
    expect(result!.progress).toBe(progress);
    const parsed = JSON.parse(result!.progress!);
    expect(parsed.phase).toBe('scan');
    expect(parsed.current).toBe(5);
    expect(parsed.total).toBe(20);
  });

  it('updateJobProgress can be called multiple times and last value wins', () => {
    const job = makeJobRow({ job_id: 'job-progress-2' });
    store.createJob(job);

    store.updateJobProgress('job-progress-2', JSON.stringify({ phase: 'scan', current: 1, total: 10 }));
    store.updateJobProgress('job-progress-2', JSON.stringify({ phase: 'parse', current: 5, total: 10 }));

    const result = store.getJob('job-progress-2');
    const parsed = JSON.parse(result!.progress!);
    expect(parsed.phase).toBe('parse');
    expect(parsed.current).toBe(5);
  });

  // -------------------------------------------------------------------------
  // getCache / setCache
  // -------------------------------------------------------------------------

  it('setCache + getCache round-trip returns the cached entry', () => {
    const entry: JobCacheRow = {
      fingerprint: 'fp-cache-1',
      job_type: 'codebase_graph',
      result_summary: JSON.stringify({ filesScanned: 100 }),
      cached_at: new Date().toISOString(),
      expires_at: null,
    };
    store.setCache(entry);

    const result = store.getCache('fp-cache-1');
    expect(result).not.toBeNull();
    expect(result!.fingerprint).toBe('fp-cache-1');
    expect(result!.job_type).toBe('codebase_graph');
    expect(JSON.parse(result!.result_summary)).toEqual({ filesScanned: 100 });
    expect(result!.expires_at).toBeNull();
  });

  it('getCache returns null for unknown fingerprint', () => {
    expect(store.getCache('unknown-fp')).toBeNull();
  });

  it('getCache returns null when cache entry is expired', () => {
    const pastDate = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago
    const entry: JobCacheRow = {
      fingerprint: 'fp-expired',
      job_type: 'codebase_graph',
      result_summary: JSON.stringify({ filesScanned: 50 }),
      cached_at: new Date(Date.now() - 120_000).toISOString(),
      expires_at: pastDate,
    };
    store.setCache(entry);

    expect(store.getCache('fp-expired')).toBeNull();
  });

  it('getCache returns entry when expires_at is in the future', () => {
    const futureDate = new Date(Date.now() + 3_600_000).toISOString(); // 1 hour from now
    const entry: JobCacheRow = {
      fingerprint: 'fp-future',
      job_type: 'codebase_graph',
      result_summary: JSON.stringify({ filesScanned: 75 }),
      cached_at: new Date().toISOString(),
      expires_at: futureDate,
    };
    store.setCache(entry);

    const result = store.getCache('fp-future');
    expect(result).not.toBeNull();
    expect(result!.fingerprint).toBe('fp-future');
  });

  it('setCache uses INSERT OR REPLACE so re-inserting same fingerprint overwrites', () => {
    const entry1: JobCacheRow = {
      fingerprint: 'fp-replace',
      job_type: 'codebase_graph',
      result_summary: JSON.stringify({ filesScanned: 10 }),
      cached_at: new Date().toISOString(),
      expires_at: null,
    };
    store.setCache(entry1);

    const entry2: JobCacheRow = {
      fingerprint: 'fp-replace',
      job_type: 'codebase_graph',
      result_summary: JSON.stringify({ filesScanned: 99 }),
      cached_at: new Date().toISOString(),
      expires_at: null,
    };
    store.setCache(entry2);

    const result = store.getCache('fp-replace');
    expect(JSON.parse(result!.result_summary).filesScanned).toBe(99);
  });

  // -------------------------------------------------------------------------
  // markStaleJobsFailed
  // -------------------------------------------------------------------------

  it('markStaleJobsFailed updates all pending and running jobs to failed', () => {
    const j1 = makeJobRow({ job_id: 'stale-1', status: 'pending' });
    const j2 = makeJobRow({ job_id: 'stale-2', status: 'running', fingerprint: 'fp-stale-2' });
    const j3 = makeJobRow({ job_id: 'stale-3', status: 'complete', fingerprint: 'fp-stale-3' });
    store.createJob(j1);
    store.createJob(j2);
    store.createJob(j3);
    // manually transition j2 to running
    store.updateJobStatus('stale-2', 'running', { pid: 1111 });

    const count = store.markStaleJobsFailed('server restart');

    expect(count).toBe(2); // j1 and j2
    expect(store.getJob('stale-1')!.status).toBe('failed');
    expect(store.getJob('stale-1')!.error).toBe('server restart');
    expect(store.getJob('stale-2')!.status).toBe('failed');
    expect(store.getJob('stale-2')!.error).toBe('server restart');
    expect(store.getJob('stale-3')!.status).toBe('complete'); // untouched
  });

  it('markStaleJobsFailed returns 0 when no stale jobs', () => {
    const j = makeJobRow({ job_id: 'done-job', status: 'pending' });
    store.createJob(j);
    store.updateJobStatus('done-job', 'complete', { completed_at: new Date().toISOString() });

    expect(store.markStaleJobsFailed('restart')).toBe(0);
  });

  // -------------------------------------------------------------------------
  // getTimedOutJobs
  // -------------------------------------------------------------------------

  it('getTimedOutJobs returns jobs past their timeout', () => {
    // Create a job that started 10 minutes ago with a 5-minute timeout
    const oldStartedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const j1 = makeJobRow({
      job_id: 'timed-out-1',
      status: 'pending',
      timeout_ms: 300_000, // 5 min
      started_at: oldStartedAt,
    });
    store.createJob(j1);
    // Manually set to running
    store.updateJobStatus('timed-out-1', 'running', { pid: 2222 });

    const timedOut = store.getTimedOutJobs();
    const ids = timedOut.map((j) => j.job_id);
    expect(ids).toContain('timed-out-1');
  });

  it('getTimedOutJobs does not return jobs still within timeout', () => {
    // Started just now with a 5-minute timeout
    const j = makeJobRow({ job_id: 'fresh-job', status: 'pending', timeout_ms: 300_000 });
    store.createJob(j);
    store.updateJobStatus('fresh-job', 'running', { pid: 3333 });

    const timedOut = store.getTimedOutJobs();
    const ids = timedOut.map((j) => j.job_id);
    expect(ids).not.toContain('fresh-job');
  });

  it('getTimedOutJobs does not return completed or failed jobs', () => {
    const oldStartedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const j1 = makeJobRow({
      job_id: 'completed-old',
      status: 'pending',
      timeout_ms: 300_000,
      started_at: oldStartedAt,
    });
    store.createJob(j1);
    store.updateJobStatus('completed-old', 'complete', { completed_at: new Date().toISOString() });

    const timedOut = store.getTimedOutJobs();
    const ids = timedOut.map((j) => j.job_id);
    expect(ids).not.toContain('completed-old');
  });
});
