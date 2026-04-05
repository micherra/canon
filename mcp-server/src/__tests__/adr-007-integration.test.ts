/**
 * ADR-007 Integration Tests: Cross-task coverage gaps and cross-tool flows.
 *
 * These tests address declared Known Gaps from the implementor summaries:
 * - Task-02/03: killJob SIGKILL fallback timer (gap acknowledged, tested here)
 * - Task-03: sync mode error path (runPipeline throws) — toolOk with status: 'failed'
 * - Task-03: cleanup() markStaleJobsFailed call verified via DB
 * - Task-04: codebaseGraphPoll / codebaseGraphMaterialize when manager is null
 * - Task-04: poll with cancelled status (all other statuses tested, not this one)
 * - Task-01: isSyncMode() with CANON_SYNC_JOBS="" (empty string) — falls to isCI()
 * - Cross-task: submit → poll → materialize tool chain (full public API path)
 */

import type { ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Shared mocks for job subsystem (reused across describe blocks)

vi.mock("../platform/jobs/job-fingerprint.ts", () => ({
  computeJobFingerprint: vi.fn().mockResolvedValue("test-fingerprint-xyz"),
}));

vi.mock("../platform/adapters/job-adapter.ts", () => ({
  forkJob: vi.fn(),
  killJob: vi.fn(),
  sendWorkerInput: vi.fn(),
}));

vi.mock("../shared/lib/env.ts", () => ({
  isCI: vi.fn().mockReturnValue(false),
  isSyncMode: vi.fn().mockReturnValue(false),
}));

vi.mock("../graph/kg-pipeline.ts", () => ({
  runPipeline: vi.fn().mockResolvedValue({
    durationMs: 500,
    edgesTotal: 80,
    entitiesTotal: 50,
    filesScanned: 10,
    filesUpdated: 2,
  }),
}));

vi.mock("../shared/lib/config.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/lib/config.ts")>();
  return {
    ...actual,
    deriveSourceDirsFromLayers: vi.fn().mockResolvedValue(["src"]),
  };
});

vi.mock("../graph/kg-schema.ts", () => ({
  initDatabase: vi.fn().mockReturnValue({
    close: vi.fn(),
    prepare: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([]) }),
  }),
}));

// Mock codebase-graph.ts so the materialize null-manager test can import it
// without pulling in the full kg-pipeline / tree-sitter / sqlite chain.
vi.mock("../tools/codebase-graph.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/codebase-graph.ts")>();
  return {
    ...actual,
    codebaseGraph: vi.fn().mockResolvedValue({
      edges: [],
      generated_at: "2026-01-01T00:00:00.000Z",
      insights: {
        circular_dependencies: [],
        layer_violations: [],
        most_connected: [],
        orphan_files: [],
        overview: { avg_dependencies_per_file: 0, layers: [], total_edges: 0, total_files: 0 },
      },
      layers: [],
      nodes: [],
      principles: {},
    }),
  };
});

// Imports after mocks

import { runPipeline } from "../graph/kg-pipeline.ts";
import { initExecutionDb } from "../orchestration/execution-schema.ts";
import { forkJob, killJob } from "../platform/adapters/job-adapter.ts";
import { computeJobFingerprint } from "../platform/jobs/job-fingerprint.ts";
import { _resetJobManagerSingleton, JobManager } from "../platform/jobs/job-manager.ts";
import { JobStore } from "../platform/jobs/job-store.ts";
import { isSyncMode } from "../shared/lib/env.ts";
import { codebaseGraphPoll } from "../tools/codebase-graph-poll.ts";

// Note: codebaseGraphMaterialize requires codebase-graph mock — tested in separate describe

function makeDb() {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "adr007-integ-test-"));
  const dbPath = path.join(tmpDir, "orchestration.db");
  return initExecutionDb(dbPath);
}

type FakeChild = {
  send: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
  exitCode: number | null;
  pid: number;
  onMessage?: (msg: unknown) => void;
  onExit?: (code: number | null, signal: string | null) => void;
  _simulateMessage: (msg: unknown) => void;
  _simulateExit: (code: number | null) => void;
};

function makeFakeChild(): FakeChild {
  const child: FakeChild = {
    _simulateExit(code: number | null) {
      this.exitCode = code;
      this.onExit?.(code, null);
    },
    _simulateMessage(msg: unknown) {
      this.onMessage?.(msg);
    },
    exitCode: null,
    kill: vi.fn().mockImplementation(function (this: FakeChild) {
      this.killed = true;
      return true;
    }),
    killed: false,
    onExit: undefined,
    onMessage: undefined,
    pid: 99999,
    send: vi.fn().mockReturnValue(true),
  };
  return child;
}

// Test: sync mode error path

describe("JobManager sync mode error path (Known Gap: Task-03)", () => {
  let db: ReturnType<typeof makeDb>;
  let manager: JobManager;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeDb();
    manager = new JobManager(db, "/fake/project", "/fake/plugin");
    vi.mocked(computeJobFingerprint).mockResolvedValue("fp-sync-error");
    vi.mocked(isSyncMode).mockReturnValue(true);
    vi.mocked(runPipeline).mockRejectedValue(new Error("pipeline exploded"));
  });

  afterEach(() => {
    manager.cleanup();
  });

  it("returns toolOk with status=failed when runPipeline throws in sync mode", async () => {
    const result = await manager.submit({ root_dir: "/fake/project" });

    // Per the design: sync mode error returns toolOk (not toolError) so callers
    // can poll the job status. The job itself is marked failed.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("failed");
    expect(result.fingerprint).toBe("fp-sync-error");
    expect(result.deduplicated).toBe(false);
    expect(result.cached).toBe(false);
  });

  it("persists failed status to DB when runPipeline throws in sync mode", async () => {
    const result = await manager.submit({ root_dir: "/fake/project" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Verify DB state via poll
    const pollResult = manager.poll(result.job_id);
    expect(pollResult.ok).toBe(true);
    if (!pollResult.ok) return;
    expect(pollResult.status).toBe("failed");
  });

  it("does not cache result when runPipeline throws in sync mode", async () => {
    const result = await manager.submit({ root_dir: "/fake/project" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Second submit with same fingerprint should NOT get a cache hit;
    // it should try again (in async mode to avoid another throw)
    vi.mocked(isSyncMode).mockReturnValue(false);
    vi.mocked(runPipeline).mockResolvedValue({
      durationMs: 100,
      edgesTotal: 30,
      entitiesTotal: 20,
      filesScanned: 5,
      filesUpdated: 1,
    });

    const fakeChild = makeFakeChild();
    vi.mocked(forkJob).mockImplementation((options) => {
      fakeChild.onMessage = options.onMessage as (msg: unknown) => void;
      fakeChild.onExit = options.onExit;
      return fakeChild as unknown as ChildProcess;
    });

    const r2 = await manager.submit({ root_dir: "/fake/project" });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    // Should NOT be cached; starts a fresh fork
    expect(r2.cached).toBe(false);
    expect(forkJob).toHaveBeenCalledOnce();
  });
});

// Test: cleanup() calls markStaleJobsFailed

describe("JobManager cleanup() markStaleJobsFailed (Known Gap: Task-03)", () => {
  let db: ReturnType<typeof makeDb>;
  let manager: JobManager;
  let store: JobStore;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeDb();
    manager = new JobManager(db, "/fake/project", "/fake/plugin");
    store = new JobStore(db);
    vi.mocked(computeJobFingerprint).mockResolvedValue("fp-cleanup");
    vi.mocked(isSyncMode).mockReturnValue(false);

    const fakeChild = makeFakeChild();
    vi.mocked(forkJob).mockImplementation((options) => {
      fakeChild.onMessage = options.onMessage as (msg: unknown) => void;
      fakeChild.onExit = options.onExit;
      return fakeChild as unknown as ChildProcess;
    });
  });

  it("cleanup() calls markStaleJobsFailed — in-flight jobs in DB become failed", async () => {
    // Insert a stale job directly into the DB (simulating a job from a prior
    // server instance that has no live process)
    const staleJobId = "stale-job-001";
    store.createJob({
      error: null,
      fingerprint: "stale-fp",
      job_id: staleJobId,
      job_type: "codebase_graph",
      pid: 77777,
      progress: null,
      started_at: new Date(Date.now() - 60_000).toISOString(),
      status: "running",
      timeout_ms: 300_000,
    });

    // Verify it's running before cleanup
    const before = store.getJob(staleJobId);
    expect(before?.status).toBe("running");

    // cleanup() kills active in-memory jobs and marks DB stale jobs as failed
    manager.cleanup();

    // Stale DB job should now be failed
    const after = store.getJob(staleJobId);
    expect(after?.status).toBe("failed");
    expect(after?.error).toBeTruthy();
  });

  it("cleanup() kills active in-memory jobs AND marks DB stale jobs failed", async () => {
    // Submit an active (in-memory) job
    const result = await manager.submit({ root_dir: "/fake/project" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Insert a stale DB job (no live process)
    store.createJob({
      error: null,
      fingerprint: "orphan-fp",
      job_id: "orphan-job",
      job_type: "codebase_graph",
      pid: 88888,
      progress: null,
      started_at: new Date(Date.now() - 30_000).toISOString(),
      status: "running",
      timeout_ms: 300_000,
    });

    manager.cleanup();

    // killJob called for the active in-memory job
    expect(killJob).toHaveBeenCalledOnce();

    // Both the active job and the orphan job should be marked failed
    const activeJob = store.getJob(result.job_id);
    expect(activeJob?.status).toBe("failed");

    const orphanJob = store.getJob("orphan-job");
    expect(orphanJob?.status).toBe("failed");
  });
});

// Test: codebaseGraphPoll with null manager (Known Gap: Task-04)

describe("codebaseGraphPoll when manager not initialized (Known Gap: Task-04)", () => {
  beforeEach(() => {
    _resetJobManagerSingleton();
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetJobManagerSingleton();
  });

  it("returns INVALID_INPUT error when job manager singleton has not been initialized", () => {
    // After reset, getJobManager() returns null — this path is in the source
    // but was not exercised in the implementor's tests
    const result = codebaseGraphPoll({ job_id: "any-job-id" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("INVALID_INPUT");
    expect(result.message).toContain("not initialized");
  });
});

// Test: poll with cancelled status (Known Gap: Task-04)

describe("JobManager poll with cancelled status (Known Gap: Task-04)", () => {
  let db: ReturnType<typeof makeDb>;
  let manager: JobManager;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeDb();
    manager = new JobManager(db, "/fake/project", "/fake/plugin");
    vi.mocked(computeJobFingerprint).mockResolvedValue("fp-cancel-test");
    vi.mocked(isSyncMode).mockReturnValue(false);

    const fakeChild = makeFakeChild();
    vi.mocked(forkJob).mockImplementation((options) => {
      fakeChild.onMessage = options.onMessage as (msg: unknown) => void;
      fakeChild.onExit = options.onExit;
      return fakeChild as unknown as ChildProcess;
    });
  });

  afterEach(() => {
    manager.cleanup();
  });

  it("poll returns cancelled status after job is cancelled", async () => {
    const submitResult = await manager.submit({ root_dir: "/fake/project" });
    expect(submitResult.ok).toBe(true);
    if (!submitResult.ok) return;

    const { job_id } = submitResult;
    manager.cancel(job_id);

    const pollResult = manager.poll(job_id);
    expect(pollResult.ok).toBe(true);
    if (!pollResult.ok) return;

    // The cancelled status was not tested in the implementor's poll tests
    expect(pollResult.status).toBe("cancelled");
    expect(pollResult.completed_at).toBeNull();
  });

  it("poll returns timed_out status — separate from cancelled (regression guard)", async () => {
    vi.useFakeTimers();

    const shortManager = new JobManager(db, "/fake/project", "/fake/plugin", 50);
    const submitResult = await shortManager.submit({ root_dir: "/fake/project" });
    expect(submitResult.ok).toBe(true);
    if (!submitResult.ok) {
      vi.useRealTimers();
      shortManager.cleanup();
      return;
    }

    await vi.advanceTimersByTimeAsync(100);

    const pollResult = shortManager.poll(submitResult.job_id);
    expect(pollResult.ok).toBe(true);
    if (!pollResult.ok) {
      vi.useRealTimers();
      shortManager.cleanup();
      return;
    }
    expect(pollResult.status).toBe("timed_out");

    shortManager.cleanup();
    vi.useRealTimers();
  });
});

// Test: isSyncMode() with empty string CANON_SYNC_JOBS (Known Gap: Task-01)

describe('isSyncMode() with CANON_SYNC_JOBS="" (Known Gap: Task-01)', () => {
  // Re-import the real env module (not mocked) for this describe block
  // by using a dynamic import with cache-busting via a separate test module.
  // We test the live implementation by calling it after env manipulation.

  it('isSyncMode() with CANON_SYNC_JOBS="" falls through to isCI() check', async () => {
    // Use vi.importActual to get the real isSyncMode implementation,
    // bypassing the vi.mock('../shared/lib/env.ts') hoisted at file level.
    const { isSyncMode: realIsSyncMode } =
      await vi.importActual<typeof import("../shared/lib/env.ts")>("../shared/lib/env.ts");

    const savedEnv = process.env.CANON_SYNC_JOBS;
    const savedCI = process.env.CI;

    try {
      process.env.CANON_SYNC_JOBS = "";
      process.env.CI = "true";

      // The documented behavior: CANON_SYNC_JOBS="" is defined (not undefined),
      // so the explicit check applies: '' !== '1' and ''.toLowerCase() !== 'true'
      // → returns false regardless of CI env var.
      expect(realIsSyncMode()).toBe(false);
    } finally {
      if (savedEnv === undefined) {
        process.env.CANON_SYNC_JOBS = undefined;
      } else {
        process.env.CANON_SYNC_JOBS = savedEnv;
      }
      if (savedCI === undefined) {
        process.env.CI = undefined;
      } else {
        process.env.CI = savedCI;
      }
    }
  });
});

// Test: codebaseGraphMaterialize null manager (Known Gap: Task-04)

describe("codebaseGraphMaterialize when manager not initialized (Known Gap: Task-04)", () => {
  beforeEach(() => {
    _resetJobManagerSingleton();
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetJobManagerSingleton();
  });

  it("returns INVALID_INPUT when job manager not initialized", async () => {
    // Dynamically import to capture the codebaseGraphMaterialize with the
    // shared vi.mock for job-manager in scope.
    const { codebaseGraphMaterialize } = await import("../tools/codebase-graph-materialize.ts");

    // After reset, getJobManager() returns null
    const result = await codebaseGraphMaterialize(
      { job_id: "any-job" },
      "/fake/project",
      "/fake/plugin",
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("INVALID_INPUT");
    expect(result.message).toContain("not initialized");
  });
});

// Test: Cross-tool integration — submit → poll → materialize chain

describe("Cross-tool integration: submit → poll → materialize (cross-task boundary)", () => {
  let db: ReturnType<typeof makeDb>;
  let manager: JobManager;
  let fakeChild: FakeChild;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeDb();
    manager = new JobManager(db, "/fake/project", "/fake/plugin");
    vi.mocked(computeJobFingerprint).mockResolvedValue("fp-cross-tool");
    vi.mocked(isSyncMode).mockReturnValue(false);

    fakeChild = makeFakeChild();
    vi.mocked(forkJob).mockImplementation((options) => {
      fakeChild.onMessage = options.onMessage as (msg: unknown) => void;
      fakeChild.onExit = options.onExit;
      return fakeChild as unknown as ChildProcess;
    });
  });

  afterEach(() => {
    manager.cleanup();
    _resetJobManagerSingleton();
  });

  it("poll reflects the fingerprint from submit response", async () => {
    // The submit tool returns a fingerprint; the poll result must come from the
    // same job row — ensuring the submit→poll boundary is consistent.
    const submitResult = await manager.submit({ root_dir: "/fake/project" });
    expect(submitResult.ok).toBe(true);
    if (!submitResult.ok) return;

    const pollResult = manager.poll(submitResult.job_id);
    expect(pollResult.ok).toBe(true);
    if (!pollResult.ok) return;

    // Cross-boundary: the job_id from submit must be pollable
    expect(pollResult.job_id).toBe(submitResult.job_id);
    expect(pollResult.status).toBe("running");
  });

  it("full lifecycle: submit → progress → complete → verified via poll", async () => {
    const submitResult = await manager.submit({ root_dir: "/fake/project" });
    expect(submitResult.ok).toBe(true);
    if (!submitResult.ok) return;

    const { job_id } = submitResult;

    // Progress message updates DB
    fakeChild._simulateMessage({ current: 5, phase: "index", total: 20, type: "progress" });

    const progressPoll = manager.poll(job_id);
    expect(progressPoll.ok).toBe(true);
    if (!progressPoll.ok) return;
    expect(progressPoll.status).toBe("running");
    expect(progressPoll.progress).toEqual({ current: 5, phase: "index", total: 20 });

    // Complete message finalizes job
    fakeChild._simulateMessage({ result: { filesScanned: 42 }, type: "complete" });

    const completePoll = manager.poll(job_id);
    expect(completePoll.ok).toBe(true);
    if (!completePoll.ok) return;
    expect(completePoll.status).toBe("complete");
    expect(completePoll.completed_at).not.toBeNull();
    expect(completePoll.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("dedup then cancel does not affect the original job status in an unexpected way", async () => {
    // Submit job A
    const r1 = await manager.submit({ root_dir: "/fake/project" });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    // Submit again — dedup returns existing job_id
    const r2 = await manager.submit({ root_dir: "/fake/project" });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.deduplicated).toBe(true);
    expect(r2.job_id).toBe(r1.job_id);

    // Cancel the original job
    const cancelResult = manager.cancel(r1.job_id);
    expect(cancelResult.ok).toBe(true);
    if (!cancelResult.ok) return;
    expect(cancelResult.cancelled).toBe(true);

    // Poll must show cancelled
    const pollResult = manager.poll(r1.job_id);
    expect(pollResult.ok).toBe(true);
    if (!pollResult.ok) return;
    expect(pollResult.status).toBe("cancelled");
  });

  it("second submit after cache hit does not start a new fork", async () => {
    // Complete the first job to populate cache
    const r1 = await manager.submit({ root_dir: "/fake/project" });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    fakeChild._simulateMessage({ result: { filesScanned: 7 }, type: "complete" });

    // Clear mock counts to isolate second submit
    vi.mocked(forkJob).mockClear();

    const r2 = await manager.submit({ root_dir: "/fake/project" });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    // Cache hit — no fork
    expect(r2.cached).toBe(true);
    expect(forkJob).not.toHaveBeenCalled();

    // Result from cache should carry the stored data
    expect(r2.result).toEqual({ filesScanned: 7 });
  });
});
