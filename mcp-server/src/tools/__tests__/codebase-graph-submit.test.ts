/**
 * Tests for codebase-graph-submit tool.
 * Uses mocked JobManager — no real DB or child processes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the job-manager module before importing the tool
vi.mock("../../jobs/job-manager.ts", () => {
  const mockManager = {
    cancel: vi.fn(),
    cleanup: vi.fn(),
    poll: vi.fn(),
    submit: vi.fn(),
  };
  return {
    _mockManager: mockManager,
    _resetJobManagerSingleton: vi.fn(),
    getJobManager: vi.fn().mockReturnValue(mockManager),
    getOrCreateJobManager: vi.fn().mockReturnValue(mockManager),
    initJobManager: vi.fn().mockReturnValue(mockManager),
    JobManager: vi.fn().mockImplementation(() => mockManager),
  };
});

// Mock deriveSourceDirsFromLayers to avoid fs reads
vi.mock("../../utils/config.ts", () => ({
  deriveSourceDirsFromLayers: vi.fn().mockResolvedValue(["src"]),
}));

// Mock initDatabase to avoid sqlite
vi.mock("../../graph/kg-schema.ts", () => ({
  initDatabase: vi.fn().mockReturnValue({
    close: vi.fn(),
    prepare: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([]) }),
  }),
}));

import * as jobManagerModule from "../../jobs/job-manager.ts";
import { codebaseGraphSubmit } from "../codebase-graph-submit.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockManager = (jobManagerModule as any)._mockManager;

describe("codebaseGraphSubmit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns job_id and running status when submit succeeds", async () => {
    mockManager.submit.mockResolvedValue({
      cached: false,
      deduplicated: false,
      fingerprint: "fp-abc",
      job_id: "test-job-123",
      ok: true,
      status: "running",
    });

    const result = await codebaseGraphSubmit(
      { source_dirs: ["src"] },
      "/fake/project",
      "/fake/plugin",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.job_id).toBe("test-job-123");
      expect(result.status).toBe("running");
      expect(result.deduplicated).toBe(false);
      expect(result.cached).toBe(false);
    }
    expect(mockManager.submit).toHaveBeenCalledTimes(1);
  });

  it("returns complete status in sync mode (cached result)", async () => {
    mockManager.submit.mockResolvedValue({
      cached: true,
      deduplicated: false,
      fingerprint: "fp-def",
      job_id: "sync-job-456",
      ok: true,
      result: { files: 10 },
      status: "complete",
    });

    const result = await codebaseGraphSubmit({}, "/fake/project", "/fake/plugin");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("complete");
      expect(result.cached).toBe(true);
      expect(result.result).toBeDefined();
    }
  });

  it("returns deduplicated=true when a running job exists for same fingerprint", async () => {
    mockManager.submit.mockResolvedValue({
      cached: false,
      deduplicated: true,
      fingerprint: "fp-ghi",
      job_id: "existing-job-789",
      ok: true,
      status: "running",
    });

    const result = await codebaseGraphSubmit(
      { source_dirs: ["src", "lib"] },
      "/fake/project",
      "/fake/plugin",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.deduplicated).toBe(true);
      expect(result.job_id).toBe("existing-job-789");
    }
  });

  it("propagates errors from JobManager.submit", async () => {
    mockManager.submit.mockResolvedValue({
      error_code: "INVALID_INPUT",
      message: "Cannot compute job fingerprint: project directory is not a git repository.",
      ok: false,
      recoverable: false,
    });

    const result = await codebaseGraphSubmit({}, "/not-a-git-repo", "/fake/plugin");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("passes sourceDirs derived from config when source_dirs is not provided", async () => {
    mockManager.submit.mockResolvedValue({
      cached: false,
      deduplicated: false,
      fingerprint: "fp-001",
      job_id: "job-001",
      ok: true,
      status: "running",
    });

    await codebaseGraphSubmit({}, "/fake/project", "/fake/plugin");

    // deriveSourceDirsFromLayers is mocked to return ['src']
    expect(mockManager.submit).toHaveBeenCalledWith(expect.anything(), ["src"]);
  });

  it("passes explicit source_dirs over config-derived dirs", async () => {
    mockManager.submit.mockResolvedValue({
      cached: false,
      deduplicated: false,
      fingerprint: "fp-002",
      job_id: "job-002",
      ok: true,
      status: "running",
    });

    await codebaseGraphSubmit({ source_dirs: ["custom/src"] }, "/fake/project", "/fake/plugin");

    expect(mockManager.submit).toHaveBeenCalledWith(expect.anything(), ["custom/src"]);
  });
});
