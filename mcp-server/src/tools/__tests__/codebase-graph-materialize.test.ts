/**
 * Tests for codebase-graph-materialize tool.
 * Uses mocked JobManager and DB reads.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodebaseGraphOutput } from "../codebase-graph.ts";

// Mock the job-manager module before importing the tool
vi.mock("../../platform/jobs/job-manager.ts", () => {
  const mockManager = {
    cancel: vi.fn(),
    cleanup: vi.fn(),
    poll: vi.fn(),
    submit: vi.fn(),
  };
  return {
    _mockManager: mockManager,
    getJobManager: vi.fn().mockReturnValue(mockManager),
    JobManager: vi.fn().mockImplementation(() => mockManager),
  };
});

// Mock readGraphFromDb (and compactGraph) so materialize doesn't hit real DB.
// Comment #10: materialize now calls readGraphFromDb instead of codebaseGraph.
vi.mock("../codebase-graph.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../codebase-graph.ts")>();
  return {
    ...actual,
    // Keep codebaseGraph so TypeScript compile succeeds, but it should NOT be called
    codebaseGraph: vi
      .fn()
      .mockRejectedValue(new Error("codebaseGraph must not be called from materialize")),
    readGraphFromDb: vi.fn(),
  };
});

import * as jobManagerModule from "../../platform/jobs/job-manager.ts";
import * as codebaseGraphModule from "../codebase-graph.ts";
import { codebaseGraphMaterialize } from "../codebase-graph-materialize.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockManager = (jobManagerModule as any)._mockManager;
const mockReadGraphFromDb = vi.mocked(codebaseGraphModule.readGraphFromDb);

const makeCompleteGraph = (): CodebaseGraphOutput => ({
  edges: [],
  generated_at: "2026-04-03T10:00:00.000Z",
  insights: {
    circular_dependencies: [],
    layer_violations: [],
    most_connected: [],
    orphan_files: [],
    overview: {
      avg_dependencies_per_file: 0,
      layers: [{ file_count: 1, name: "api" }],
      total_edges: 0,
      total_files: 1,
    },
  },
  layers: [{ color: "#abc", file_count: 1, index: 0, name: "api" }],
  nodes: [
    {
      changed: false,
      color: "#abc",
      compliance_score: null,
      extension: "ts",
      id: "src/index.ts",
      last_verdict: null,
      layer: "api",
      top_violations: [],
      violation_count: 0,
    },
  ],
  principles: {},
});

describe("codebaseGraphMaterialize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns CompactGraphOutput for a complete job", async () => {
    mockManager.poll.mockReturnValue({
      completed_at: "2026-04-03T10:01:00.000Z",
      duration_ms: 60000,
      error: null,
      job_id: "job-complete",
      ok: true,
      progress: null,
      started_at: "2026-04-03T10:00:00.000Z",
      status: "complete",
    });

    mockReadGraphFromDb.mockResolvedValue(makeCompleteGraph());

    const result = await codebaseGraphMaterialize(
      { job_id: "job-complete" },
      "/fake/project",
      "/fake/plugin",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.job_id).toBe("job-complete");
      expect(result._compact).toBe(true);
      expect(result.node_ids).toHaveLength(1);
      expect(result.node_ids[0]).toBe("src/index.ts");
      expect(result.nodes).toHaveLength(1);
      expect(result.edges).toHaveLength(0);
      expect(result.layers).toHaveLength(1);
    }
  });

  it("calls readGraphFromDb, not codebaseGraph (Comment #10)", async () => {
    // Ensures materialize uses the read-only path, not the pipeline-running path.
    mockManager.poll.mockReturnValue({
      completed_at: "2026-04-03T10:01:00.000Z",
      duration_ms: 60000,
      error: null,
      job_id: "job-no-pipeline",
      ok: true,
      progress: null,
      started_at: "2026-04-03T10:00:00.000Z",
      status: "complete",
    });

    mockReadGraphFromDb.mockResolvedValue(makeCompleteGraph());

    const result = await codebaseGraphMaterialize(
      { job_id: "job-no-pipeline" },
      "/fake/project",
      "/fake/plugin",
    );

    expect(result.ok).toBe(true);
    // readGraphFromDb was called
    expect(mockReadGraphFromDb).toHaveBeenCalledTimes(1);
    // codebaseGraph was NOT called (it would throw if it were)
    expect(codebaseGraphModule.codebaseGraph).not.toHaveBeenCalled();
  });

  it("returns INVALID_INPUT error when job is not complete (running)", async () => {
    mockManager.poll.mockReturnValue({
      completed_at: null,
      duration_ms: 1000,
      error: null,
      job_id: "job-running",
      ok: true,
      progress: { current: 5, phase: "scanning", total: 100 },
      started_at: "2026-04-03T10:00:00.000Z",
      status: "running",
    });

    const result = await codebaseGraphMaterialize(
      { job_id: "job-running" },
      "/fake/project",
      "/fake/plugin",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("not complete");
    }
    expect(mockReadGraphFromDb).not.toHaveBeenCalled();
  });

  it("returns INVALID_INPUT error when job is failed", async () => {
    mockManager.poll.mockReturnValue({
      completed_at: "2026-04-03T10:00:05.000Z",
      duration_ms: 5000,
      error: "Worker crashed",
      job_id: "job-failed",
      ok: true,
      progress: null,
      started_at: "2026-04-03T10:00:00.000Z",
      status: "failed",
    });

    const result = await codebaseGraphMaterialize(
      { job_id: "job-failed" },
      "/fake/project",
      "/fake/plugin",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("propagates INVALID_INPUT from poll (non-existent job)", async () => {
    mockManager.poll.mockReturnValue({
      error_code: "INVALID_INPUT",
      message: "Job not found: unknown-job",
      ok: false,
      recoverable: false,
    });

    const result = await codebaseGraphMaterialize(
      { job_id: "unknown-job" },
      "/fake/project",
      "/fake/plugin",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("passes diff_base and changed_files to readGraphFromDb", async () => {
    mockManager.poll.mockReturnValue({
      completed_at: "2026-04-03T10:01:00.000Z",
      duration_ms: 60000,
      error: null,
      job_id: "job-diff",
      ok: true,
      progress: null,
      started_at: "2026-04-03T10:00:00.000Z",
      status: "complete",
    });

    mockReadGraphFromDb.mockResolvedValue(makeCompleteGraph());

    await codebaseGraphMaterialize(
      {
        changed_files: ["src/index.ts"],
        diff_base: "main",
        job_id: "job-diff",
      },
      "/fake/project",
      "/fake/plugin",
    );

    expect(mockReadGraphFromDb).toHaveBeenCalledWith(
      expect.objectContaining({
        changed_files: ["src/index.ts"],
        diff_base: "main",
      }),
      "/fake/project",
      "/fake/plugin",
    );
  });

  it("returns UNEXPECTED error when readGraphFromDb throws", async () => {
    mockManager.poll.mockReturnValue({
      completed_at: "2026-04-03T10:01:00.000Z",
      duration_ms: 60000,
      error: null,
      job_id: "job-err",
      ok: true,
      progress: null,
      started_at: "2026-04-03T10:00:00.000Z",
      status: "complete",
    });

    mockReadGraphFromDb.mockRejectedValue(new Error("DB read failed"));

    const result = await codebaseGraphMaterialize(
      { job_id: "job-err" },
      "/fake/project",
      "/fake/plugin",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("UNEXPECTED");
    }
  });
});
