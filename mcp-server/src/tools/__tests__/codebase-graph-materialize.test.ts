/**
 * Tests for codebase-graph-materialize tool.
 * Uses mocked JobManager and DB reads.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CodebaseGraphOutput } from '../codebase-graph.ts';

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

// Mock the codebaseGraph function so materialize can call it
vi.mock('../codebase-graph.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../codebase-graph.ts')>();
  return {
    ...actual,
    codebaseGraph: vi.fn(),
  };
});

import { codebaseGraphMaterialize } from '../codebase-graph-materialize.ts';
import * as jobManagerModule from '../../jobs/job-manager.ts';
import * as codebaseGraphModule from '../codebase-graph.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockManager = (jobManagerModule as any)._mockManager;
const mockCodebaseGraph = vi.mocked(codebaseGraphModule.codebaseGraph);

const makeCompleteGraph = (): CodebaseGraphOutput => ({
  nodes: [
    {
      id: 'src/index.ts',
      layer: 'api',
      color: '#abc',
      extension: 'ts',
      violation_count: 0,
      top_violations: [],
      last_verdict: null,
      compliance_score: null,
      changed: false,
    },
  ],
  edges: [],
  layers: [{ name: 'api', color: '#abc', file_count: 1, index: 0 }],
  principles: {},
  insights: {
    overview: {
      total_files: 1,
      total_edges: 0,
      avg_dependencies_per_file: 0,
      layers: [{ name: 'api', file_count: 1 }],
    },
    layer_violations: [],
    circular_dependencies: [],
    most_connected: [],
    orphan_files: [],
  },
  generated_at: '2026-04-03T10:00:00.000Z',
});

describe('codebaseGraphMaterialize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns CompactGraphOutput for a complete job', async () => {
    mockManager.poll.mockReturnValue({
      ok: true,
      job_id: 'job-complete',
      status: 'complete',
      progress: null,
      started_at: '2026-04-03T10:00:00.000Z',
      completed_at: '2026-04-03T10:01:00.000Z',
      duration_ms: 60000,
      error: null,
    });

    mockCodebaseGraph.mockResolvedValue(makeCompleteGraph());

    const result = await codebaseGraphMaterialize(
      { job_id: 'job-complete' },
      '/fake/project',
      '/fake/plugin',
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.job_id).toBe('job-complete');
      expect(result._compact).toBe(true);
      expect(result.node_ids).toHaveLength(1);
      expect(result.node_ids[0]).toBe('src/index.ts');
      expect(result.nodes).toHaveLength(1);
      expect(result.edges).toHaveLength(0);
      expect(result.layers).toHaveLength(1);
    }
  });

  it('returns INVALID_INPUT error when job is not complete (running)', async () => {
    mockManager.poll.mockReturnValue({
      ok: true,
      job_id: 'job-running',
      status: 'running',
      progress: { phase: 'scanning', current: 5, total: 100 },
      started_at: '2026-04-03T10:00:00.000Z',
      completed_at: null,
      duration_ms: 1000,
      error: null,
    });

    const result = await codebaseGraphMaterialize(
      { job_id: 'job-running' },
      '/fake/project',
      '/fake/plugin',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('INVALID_INPUT');
      expect(result.message).toContain('not complete');
    }
    expect(mockCodebaseGraph).not.toHaveBeenCalled();
  });

  it('returns INVALID_INPUT error when job is failed', async () => {
    mockManager.poll.mockReturnValue({
      ok: true,
      job_id: 'job-failed',
      status: 'failed',
      progress: null,
      started_at: '2026-04-03T10:00:00.000Z',
      completed_at: '2026-04-03T10:00:05.000Z',
      duration_ms: 5000,
      error: 'Worker crashed',
    });

    const result = await codebaseGraphMaterialize(
      { job_id: 'job-failed' },
      '/fake/project',
      '/fake/plugin',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('INVALID_INPUT');
    }
  });

  it('propagates INVALID_INPUT from poll (non-existent job)', async () => {
    mockManager.poll.mockReturnValue({
      ok: false,
      error_code: 'INVALID_INPUT',
      message: 'Job not found: unknown-job',
      recoverable: false,
    });

    const result = await codebaseGraphMaterialize(
      { job_id: 'unknown-job' },
      '/fake/project',
      '/fake/plugin',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('INVALID_INPUT');
    }
  });

  it('passes diff_base and changed_files to codebaseGraph', async () => {
    mockManager.poll.mockReturnValue({
      ok: true,
      job_id: 'job-diff',
      status: 'complete',
      progress: null,
      started_at: '2026-04-03T10:00:00.000Z',
      completed_at: '2026-04-03T10:01:00.000Z',
      duration_ms: 60000,
      error: null,
    });

    mockCodebaseGraph.mockResolvedValue(makeCompleteGraph());

    await codebaseGraphMaterialize(
      {
        job_id: 'job-diff',
        diff_base: 'main',
        changed_files: ['src/index.ts'],
      },
      '/fake/project',
      '/fake/plugin',
    );

    expect(mockCodebaseGraph).toHaveBeenCalledWith(
      expect.objectContaining({
        diff_base: 'main',
        changed_files: ['src/index.ts'],
      }),
      '/fake/project',
      '/fake/plugin',
    );
  });

  it('returns UNEXPECTED error when codebaseGraph throws', async () => {
    mockManager.poll.mockReturnValue({
      ok: true,
      job_id: 'job-err',
      status: 'complete',
      progress: null,
      started_at: '2026-04-03T10:00:00.000Z',
      completed_at: '2026-04-03T10:01:00.000Z',
      duration_ms: 60000,
      error: null,
    });

    mockCodebaseGraph.mockRejectedValue(new Error('DB read failed'));

    const result = await codebaseGraphMaterialize(
      { job_id: 'job-err' },
      '/fake/project',
      '/fake/plugin',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('UNEXPECTED');
    }
  });
});
