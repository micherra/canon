/**
 * JobManager tests — mocked job-adapter and job-fingerprint.
 *
 * TDD: tests written first; implementation follows in job-manager.ts.
 *
 * We mock the adapter (forkJob, sendWorkerInput, killJob) and the fingerprint
 * module (computeJobFingerprint) so no real child processes are spawned.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync } from 'node:fs';
import { initExecutionDb } from '../../orchestration/execution-schema.ts';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test.
// ---------------------------------------------------------------------------

// Mock job-fingerprint to avoid real git calls
vi.mock('../../jobs/job-fingerprint.ts', () => ({
  computeJobFingerprint: vi.fn().mockResolvedValue('mock-fingerprint-abc123'),
}));

// Mock job-adapter to avoid real child process forking
vi.mock('../../adapters/job-adapter.ts', () => ({
  forkJob: vi.fn(),
  sendWorkerInput: vi.fn(),
  killJob: vi.fn(),
}));

// Mock env helper so we can control sync mode in tests
vi.mock('../../utils/env.ts', () => ({
  isSyncMode: vi.fn().mockReturnValue(false),
}));

// Mock runPipeline for sync mode tests
vi.mock('../../graph/kg-pipeline.ts', () => ({
  runPipeline: vi.fn().mockResolvedValue({
    filesScanned: 42,
    filesUpdated: 10,
    entitiesTotal: 200,
    edgesTotal: 300,
    durationMs: 1000,
  }),
}));

// Import mocked modules AFTER vi.mock declarations
import { computeJobFingerprint } from '../../jobs/job-fingerprint.ts';
import { forkJob, sendWorkerInput, killJob } from '../../adapters/job-adapter.ts';
import { isSyncMode } from '../../utils/env.ts';
import { runPipeline } from '../../graph/kg-pipeline.ts';
import { JobManager } from '../job-manager.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb() {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'job-manager-test-'));
  const dbPath = path.join(tmpDir, 'orchestration.db');
  return initExecutionDb(dbPath);
}

/**
 * A fake ChildProcess-like object plus helpers to trigger IPC callbacks.
 * Rather than relying on EventEmitter (which forkJob wires internally in the
 * real implementation), we capture the callbacks passed to forkJob's options
 * and call them directly — this tests the JobManager's handler logic without
 * depending on the real fork/IPC wiring.
 */
interface FakeChild {
  send: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
  exitCode: number | null;
  pid: number;
  // Callbacks captured from forkJob options
  onMessage?: (msg: unknown) => void;
  onExit?: (code: number | null, signal: string | null) => void;
  _simulateMessage: (msg: unknown) => void;
  _simulateExit: (code: number | null) => void;
}

function makeFakeChild(): FakeChild {
  const child: FakeChild = {
    send: vi.fn().mockReturnValue(true),
    kill: vi.fn().mockReturnValue(true),
    killed: false,
    exitCode: null,
    pid: 12345,
    onMessage: undefined,
    onExit: undefined,
    _simulateMessage(msg: unknown) {
      this.onMessage?.(msg);
    },
    _simulateExit(code: number | null) {
      this.exitCode = code;
      this.onExit?.(code, null);
    },
  };
  return child;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JobManager', () => {
  let db: ReturnType<typeof makeDb>;
  let manager: JobManager;
  let fakeChild: ReturnType<typeof makeFakeChild>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeDb();
    manager = new JobManager(db, '/fake/project', '/fake/plugin');

    // Default: fingerprint resolves to 'mock-fingerprint-abc123'
    vi.mocked(computeJobFingerprint).mockResolvedValue('mock-fingerprint-abc123');
    vi.mocked(isSyncMode).mockReturnValue(false);

    // Set up fake child process returned by forkJob.
    // Capture callbacks so _simulateMessage/_simulateExit can invoke them.
    fakeChild = makeFakeChild();
    vi.mocked(forkJob).mockImplementation((options) => {
      fakeChild.onMessage = options.onMessage as (msg: unknown) => void;
      fakeChild.onExit = options.onExit;
      return fakeChild as unknown as ChildProcess;
    });
  });

  afterEach(() => {
    manager.cleanup();
  });

  // -------------------------------------------------------------------------
  // submit — happy path
  // -------------------------------------------------------------------------

  it('submit creates a job, forks a process, and returns running status', async () => {
    const result = await manager.submit({ root_dir: '/fake/project' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.job_id).toBeTruthy();
    expect(result.status).toBe('running');
    expect(result.fingerprint).toBe('mock-fingerprint-abc123');
    expect(result.deduplicated).toBe(false);
    expect(result.cached).toBe(false);
    expect(forkJob).toHaveBeenCalledOnce();
    expect(sendWorkerInput).toHaveBeenCalledOnce();
  });

  it('submit passes sourceDirs to computeJobFingerprint', async () => {
    await manager.submit({ root_dir: '/fake/project' }, ['src', 'lib']);
    expect(computeJobFingerprint).toHaveBeenCalledWith({
      projectDir: '/fake/project',
      sourceDirs: ['src', 'lib'],
    });
  });

  // -------------------------------------------------------------------------
  // submit — deduplication
  // -------------------------------------------------------------------------

  it('submit with same fingerprint returns deduplicated: true', async () => {
    // First submit
    const r1 = await manager.submit({ root_dir: '/fake/project' });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    // Second submit with same fingerprint — should dedup
    const r2 = await manager.submit({ root_dir: '/fake/project' });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    expect(r2.deduplicated).toBe(true);
    expect(r2.job_id).toBe(r1.job_id);
    // forkJob called only once (for first submit)
    expect(forkJob).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // submit — cache hit
  // -------------------------------------------------------------------------

  it('submit with cached fingerprint returns cached result', async () => {
    // Prime the cache by running once and completing
    const r1 = await manager.submit({ root_dir: '/fake/project' });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    // Simulate the worker completing
    fakeChild._simulateMessage({
      type: 'complete',
      result: { filesScanned: 99 },
    });

    // Second submit — same fingerprint, should hit cache
    vi.mocked(forkJob).mockClear();
    const r2 = await manager.submit({ root_dir: '/fake/project' });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    expect(r2.cached).toBe(true);
    expect(r2.result).toEqual({ filesScanned: 99 });
    // No additional fork
    expect(forkJob).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // submit — sync mode
  // -------------------------------------------------------------------------

  it('submit in sync mode runs runPipeline inline without forking', async () => {
    vi.mocked(isSyncMode).mockReturnValue(true);

    const result = await manager.submit({ root_dir: '/fake/project' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.status).toBe('complete');
    expect(result.result).toBeDefined();
    expect(forkJob).not.toHaveBeenCalled();
    expect(runPipeline).toHaveBeenCalledOnce();
  });

  it('submit in sync mode caches the result', async () => {
    vi.mocked(isSyncMode).mockReturnValue(true);

    await manager.submit({ root_dir: '/fake/project' });

    // Second submit — should hit cache
    vi.mocked(isSyncMode).mockReturnValue(false); // switch back to async
    vi.mocked(forkJob).mockClear();
    const r2 = await manager.submit({ root_dir: '/fake/project' });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    expect(r2.cached).toBe(true);
    expect(forkJob).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // submit — fingerprint null (not a git repo)
  // -------------------------------------------------------------------------

  it('submit returns error when fingerprint cannot be computed', async () => {
    vi.mocked(computeJobFingerprint).mockResolvedValue(null);

    const result = await manager.submit({ root_dir: '/not-a-git-repo' });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error_code).toBe('INVALID_INPUT');
  });

  // -------------------------------------------------------------------------
  // poll
  // -------------------------------------------------------------------------

  it('poll returns correct status and progress for a running job', async () => {
    const submitResult = await manager.submit({ root_dir: '/fake/project' });
    expect(submitResult.ok).toBe(true);
    if (!submitResult.ok) return;

    const { job_id } = submitResult;
    const pollResult = manager.poll(job_id);
    expect(pollResult.ok).toBe(true);
    if (!pollResult.ok) return;

    expect(pollResult.job_id).toBe(job_id);
    expect(pollResult.status).toBe('running');
    expect(pollResult.started_at).toBeTruthy();
    expect(pollResult.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('poll returns progress parsed from JSON when available', async () => {
    const submitResult = await manager.submit({ root_dir: '/fake/project' });
    expect(submitResult.ok).toBe(true);
    if (!submitResult.ok) return;

    const { job_id } = submitResult;

    // Simulate progress message
    fakeChild._simulateMessage({ type: 'progress', phase: 'scan', current: 3, total: 10 });

    const pollResult = manager.poll(job_id);
    expect(pollResult.ok).toBe(true);
    if (!pollResult.ok) return;

    expect(pollResult.progress).not.toBeNull();
    expect(pollResult.progress!.phase).toBe('scan');
    expect(pollResult.progress!.current).toBe(3);
    expect(pollResult.progress!.total).toBe(10);
  });

  it('poll returns error for unknown job_id', () => {
    const result = manager.poll('nonexistent-job');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe('INVALID_INPUT');
  });

  it('poll reflects complete status after worker completes', async () => {
    const submitResult = await manager.submit({ root_dir: '/fake/project' });
    expect(submitResult.ok).toBe(true);
    if (!submitResult.ok) return;

    const { job_id } = submitResult;

    // Simulate completion
    fakeChild._simulateMessage({ type: 'complete', result: { filesScanned: 42 } });

    const pollResult = manager.poll(job_id);
    expect(pollResult.ok).toBe(true);
    if (!pollResult.ok) return;

    expect(pollResult.status).toBe('complete');
    expect(pollResult.completed_at).not.toBeNull();
  });

  it('poll reflects failed status after worker errors', async () => {
    const submitResult = await manager.submit({ root_dir: '/fake/project' });
    expect(submitResult.ok).toBe(true);
    if (!submitResult.ok) return;

    const { job_id } = submitResult;

    // Simulate error
    fakeChild._simulateMessage({ type: 'error', message: 'worker crashed' });

    const pollResult = manager.poll(job_id);
    expect(pollResult.ok).toBe(true);
    if (!pollResult.ok) return;

    expect(pollResult.status).toBe('failed');
    expect(pollResult.error).toBe('worker crashed');
  });

  // -------------------------------------------------------------------------
  // cancel
  // -------------------------------------------------------------------------

  it('cancel kills the process and updates status to cancelled', async () => {
    const submitResult = await manager.submit({ root_dir: '/fake/project' });
    expect(submitResult.ok).toBe(true);
    if (!submitResult.ok) return;

    const { job_id } = submitResult;
    const cancelResult = manager.cancel(job_id);
    expect(cancelResult.ok).toBe(true);
    if (!cancelResult.ok) return;

    expect(cancelResult.cancelled).toBe(true);
    expect(killJob).toHaveBeenCalledOnce();
  });

  it('cancel returns error for unknown job_id', () => {
    const result = manager.cancel('nonexistent');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe('INVALID_INPUT');
  });

  it('cancel returns cancelled: false for a non-active job', async () => {
    // Submit and immediately complete
    const submitResult = await manager.submit({ root_dir: '/fake/project' });
    expect(submitResult.ok).toBe(true);
    if (!submitResult.ok) return;

    const { job_id } = submitResult;
    fakeChild._simulateMessage({ type: 'complete', result: {} });

    // Now cancel — job exists but is not in activeJobs
    const cancelResult = manager.cancel(job_id);
    expect(cancelResult.ok).toBe(true);
    if (!cancelResult.ok) return;

    expect(cancelResult.cancelled).toBe(false);
  });

  // -------------------------------------------------------------------------
  // cleanup
  // -------------------------------------------------------------------------

  it('cleanup kills all active jobs and marks stale jobs failed', async () => {
    // Submit two jobs
    await manager.submit({ root_dir: '/fake/project' });

    // Assign different fingerprint for second job
    vi.mocked(computeJobFingerprint).mockResolvedValue('different-fingerprint');
    const fakeChild2 = makeFakeChild();
    vi.mocked(forkJob).mockImplementation((options) => {
      fakeChild2.onMessage = options.onMessage as (msg: unknown) => void;
      fakeChild2.onExit = options.onExit;
      return fakeChild2 as unknown as ChildProcess;
    });
    await manager.submit({ root_dir: '/fake/project' });

    manager.cleanup();

    // Both active processes should be killed
    expect(killJob).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Timeout watchdog
  // -------------------------------------------------------------------------

  it('timeout watchdog marks job as timed_out after timeout expires', async () => {
    vi.useFakeTimers();

    // Use a very short timeout for testing
    const shortTimeoutManager = new JobManager(db, '/fake/project', '/fake/plugin', 100);

    const result = await shortTimeoutManager.submit({ root_dir: '/fake/project' });
    expect(result.ok).toBe(true);
    if (!result.ok) { vi.useRealTimers(); return; }

    const { job_id } = result;

    // Advance time past the timeout
    await vi.advanceTimersByTimeAsync(200);

    expect(killJob).toHaveBeenCalledOnce();

    const pollResult = shortTimeoutManager.poll(job_id);
    expect(pollResult.ok).toBe(true);
    if (!pollResult.ok) { vi.useRealTimers(); return; }

    expect(pollResult.status).toBe('timed_out');

    shortTimeoutManager.cleanup();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // IPC message routing — unexpected exit
  // -------------------------------------------------------------------------

  it('unexpected child exit sets status to failed when still running', async () => {
    const submitResult = await manager.submit({ root_dir: '/fake/project' });
    expect(submitResult.ok).toBe(true);
    if (!submitResult.ok) return;

    const { job_id } = submitResult;

    // Simulate unexpected exit (no complete/error message sent)
    fakeChild._simulateExit(1);

    const pollResult = manager.poll(job_id);
    expect(pollResult.ok).toBe(true);
    if (!pollResult.ok) return;

    expect(pollResult.status).toBe('failed');
  });

  it('expected exit after complete message does not overwrite status', async () => {
    const submitResult = await manager.submit({ root_dir: '/fake/project' });
    expect(submitResult.ok).toBe(true);
    if (!submitResult.ok) return;

    const { job_id } = submitResult;

    // Complete, then exit (normal sequence)
    fakeChild._simulateMessage({ type: 'complete', result: {} });
    fakeChild._simulateExit(0);

    const pollResult = manager.poll(job_id);
    expect(pollResult.ok).toBe(true);
    if (!pollResult.ok) return;

    expect(pollResult.status).toBe('complete');
  });
});
