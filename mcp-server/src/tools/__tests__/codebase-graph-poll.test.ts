/**
 * Tests for codebase-graph-poll tool.
 * Uses mocked JobManager — synchronous DB reads only.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the job-manager module before importing the tool
vi.mock('../../jobs/job-manager.ts', () => {
  const mockManager = {
    submit: vi.fn(),
    poll: vi.fn(),
    cancel: vi.fn(),
    cleanup: vi.fn(),
  };
  return {
    JobManager: vi.fn().mockImplementation(() => mockManager),
    getJobManager: vi.fn().mockReturnValue(mockManager),
    _mockManager: mockManager,
  };
});

import { codebaseGraphPoll } from '../codebase-graph-poll.ts';
import * as jobManagerModule from '../../jobs/job-manager.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockManager = (jobManagerModule as any)._mockManager;

describe('codebaseGraphPoll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns running status for an active job', () => {
    mockManager.poll.mockReturnValue({
      ok: true,
      job_id: 'job-abc',
      status: 'running',
      progress: { phase: 'scanning', current: 10, total: 100 },
      started_at: '2026-04-03T10:00:00.000Z',
      completed_at: null,
      duration_ms: 5000,
      error: null,
    });

    const result = codebaseGraphPoll({ job_id: 'job-abc' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.job_id).toBe('job-abc');
      expect(result.status).toBe('running');
      expect(result.progress).toEqual({ phase: 'scanning', current: 10, total: 100 });
      expect(result.error).toBeNull();
    }
    expect(mockManager.poll).toHaveBeenCalledWith('job-abc');
  });

  it('returns complete status for a finished job', () => {
    mockManager.poll.mockReturnValue({
      ok: true,
      job_id: 'job-done',
      status: 'complete',
      progress: null,
      started_at: '2026-04-03T10:00:00.000Z',
      completed_at: '2026-04-03T10:01:30.000Z',
      duration_ms: 90000,
      error: null,
    });

    const result = codebaseGraphPoll({ job_id: 'job-done' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe('complete');
      expect(result.completed_at).toBe('2026-04-03T10:01:30.000Z');
      expect(result.duration_ms).toBe(90000);
    }
  });

  it('returns failed status for a failed job', () => {
    mockManager.poll.mockReturnValue({
      ok: true,
      job_id: 'job-fail',
      status: 'failed',
      progress: null,
      started_at: '2026-04-03T10:00:00.000Z',
      completed_at: '2026-04-03T10:00:05.000Z',
      duration_ms: 5000,
      error: 'Worker exited unexpectedly',
    });

    const result = codebaseGraphPoll({ job_id: 'job-fail' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe('failed');
      expect(result.error).toBe('Worker exited unexpectedly');
    }
  });

  it('returns INVALID_INPUT error for non-existent job_id', () => {
    mockManager.poll.mockReturnValue({
      ok: false,
      error_code: 'INVALID_INPUT',
      message: 'Job not found: nonexistent-id',
      recoverable: false,
    });

    const result = codebaseGraphPoll({ job_id: 'nonexistent-id' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('INVALID_INPUT');
      expect(result.message).toContain('nonexistent-id');
    }
  });

  it('returns timed_out status when job exceeded watchdog', () => {
    mockManager.poll.mockReturnValue({
      ok: true,
      job_id: 'job-timeout',
      status: 'timed_out',
      progress: null,
      started_at: '2026-04-03T10:00:00.000Z',
      completed_at: null,
      duration_ms: 300000,
      error: null,
    });

    const result = codebaseGraphPoll({ job_id: 'job-timeout' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe('timed_out');
    }
  });

  it('is synchronous — does not return a Promise', () => {
    mockManager.poll.mockReturnValue({
      ok: true,
      job_id: 'job-sync',
      status: 'complete',
      progress: null,
      started_at: '2026-04-03T10:00:00.000Z',
      completed_at: '2026-04-03T10:00:10.000Z',
      duration_ms: 10000,
      error: null,
    });

    const result = codebaseGraphPoll({ job_id: 'job-sync' });

    // Must not be a promise
    expect(result).not.toBeInstanceOf(Promise);
  });
});
