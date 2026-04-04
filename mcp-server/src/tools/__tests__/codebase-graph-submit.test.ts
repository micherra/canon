/**
 * Tests for codebase-graph-submit tool.
 * Uses mocked JobManager — no real DB or child processes.
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
    getOrCreateJobManager: vi.fn().mockReturnValue(mockManager),
    initJobManager: vi.fn().mockReturnValue(mockManager),
    _resetJobManagerSingleton: vi.fn(),
    _mockManager: mockManager,
  };
});

// Mock deriveSourceDirsFromLayers to avoid fs reads
vi.mock('../../utils/config.ts', () => ({
  deriveSourceDirsFromLayers: vi.fn().mockResolvedValue(['src']),
}));

// Mock initDatabase to avoid sqlite
vi.mock('../../graph/kg-schema.ts', () => ({
  initDatabase: vi.fn().mockReturnValue({
    close: vi.fn(),
    prepare: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([]) }),
  }),
}));

import { codebaseGraphSubmit } from '../codebase-graph-submit.ts';
import * as jobManagerModule from '../../jobs/job-manager.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockManager = (jobManagerModule as any)._mockManager;

describe('codebaseGraphSubmit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns job_id and running status when submit succeeds', async () => {
    mockManager.submit.mockResolvedValue({
      ok: true,
      job_id: 'test-job-123',
      status: 'running',
      fingerprint: 'fp-abc',
      deduplicated: false,
      cached: false,
    });

    const result = await codebaseGraphSubmit(
      { source_dirs: ['src'] },
      '/fake/project',
      '/fake/plugin',
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.job_id).toBe('test-job-123');
      expect(result.status).toBe('running');
      expect(result.deduplicated).toBe(false);
      expect(result.cached).toBe(false);
    }
    expect(mockManager.submit).toHaveBeenCalledTimes(1);
  });

  it('returns complete status in sync mode (cached result)', async () => {
    mockManager.submit.mockResolvedValue({
      ok: true,
      job_id: 'sync-job-456',
      status: 'complete',
      fingerprint: 'fp-def',
      deduplicated: false,
      cached: true,
      result: { files: 10 },
    });

    const result = await codebaseGraphSubmit(
      {},
      '/fake/project',
      '/fake/plugin',
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe('complete');
      expect(result.cached).toBe(true);
      expect(result.result).toBeDefined();
    }
  });

  it('returns deduplicated=true when a running job exists for same fingerprint', async () => {
    mockManager.submit.mockResolvedValue({
      ok: true,
      job_id: 'existing-job-789',
      status: 'running',
      fingerprint: 'fp-ghi',
      deduplicated: true,
      cached: false,
    });

    const result = await codebaseGraphSubmit(
      { source_dirs: ['src', 'lib'] },
      '/fake/project',
      '/fake/plugin',
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.deduplicated).toBe(true);
      expect(result.job_id).toBe('existing-job-789');
    }
  });

  it('propagates errors from JobManager.submit', async () => {
    mockManager.submit.mockResolvedValue({
      ok: false,
      error_code: 'INVALID_INPUT',
      message: 'Cannot compute job fingerprint: project directory is not a git repository.',
      recoverable: false,
    });

    const result = await codebaseGraphSubmit(
      {},
      '/not-a-git-repo',
      '/fake/plugin',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('INVALID_INPUT');
    }
  });

  it('passes sourceDirs derived from config when source_dirs is not provided', async () => {
    mockManager.submit.mockResolvedValue({
      ok: true,
      job_id: 'job-001',
      status: 'running',
      fingerprint: 'fp-001',
      deduplicated: false,
      cached: false,
    });

    await codebaseGraphSubmit({}, '/fake/project', '/fake/plugin');

    // deriveSourceDirsFromLayers is mocked to return ['src']
    expect(mockManager.submit).toHaveBeenCalledWith(
      expect.anything(),
      ['src'],
    );
  });

  it('passes explicit source_dirs over config-derived dirs', async () => {
    mockManager.submit.mockResolvedValue({
      ok: true,
      job_id: 'job-002',
      status: 'running',
      fingerprint: 'fp-002',
      deduplicated: false,
      cached: false,
    });

    await codebaseGraphSubmit(
      { source_dirs: ['custom/src'] },
      '/fake/project',
      '/fake/plugin',
    );

    expect(mockManager.submit).toHaveBeenCalledWith(
      expect.anything(),
      ['custom/src'],
    );
  });
});
