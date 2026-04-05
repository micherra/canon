/**
 * JobManager tests — mocked job-adapter and job-fingerprint.
 *
 * TDD: tests written first; implementation follows in job-manager.ts.
 *
 * We mock the adapter (forkJob, sendWorkerInput, killJob) and the fingerprint
 * module (computeJobFingerprint) so no real child processes are spawned.
 */

import type { ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initExecutionDb } from "../../../orchestration/execution-schema.ts";

// Mocks — must be declared before importing the module under test.

// Mock job-fingerprint to avoid real git calls
vi.mock("../job-fingerprint.ts", () => ({
  computeJobFingerprint: vi.fn().mockResolvedValue("mock-fingerprint-abc123"),
}));

// Mock job-adapter to avoid real child process forking
vi.mock("../../adapters/job-adapter.ts", () => ({
  forkJob: vi.fn(),
  killJob: vi.fn(),
  sendWorkerInput: vi.fn(),
}));

// Mock env helper so we can control sync mode in tests
vi.mock("../../../shared/lib/env.ts", () => ({
  isSyncMode: vi.fn().mockReturnValue(false),
}));

// Mock runPipeline for sync mode tests
vi.mock("../../../graph/kg-pipeline.ts", () => ({
  runPipeline: vi.fn().mockResolvedValue({
    durationMs: 1000,
    edgesTotal: 300,
    entitiesTotal: 200,
    filesScanned: 42,
    filesUpdated: 10,
  }),
}));

import { forkJob, killJob, sendWorkerInput } from "../../adapters/job-adapter.ts";
import { runPipeline } from "../../../graph/kg-pipeline.ts";
// Import mocked modules AFTER vi.mock declarations
import { computeJobFingerprint } from "../job-fingerprint.ts";
import { isSyncMode } from "../../../shared/lib/env.ts";
import { _resetJobManagerSingleton, getOrCreateJobManager, JobManager } from "../job-manager.ts";

function makeDb() {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "job-manager-test-"));
  const dbPath = path.join(tmpDir, "orchestration.db");
  return initExecutionDb(dbPath);
}

/**
 * A fake ChildProcess-like object plus helpers to trigger IPC callbacks.
 * Rather than relying on EventEmitter (which forkJob wires internally in the
 * real implementation), we capture the callbacks passed to forkJob's options
 * and call them directly — this tests the JobManager's handler logic without
 * depending on the real fork/IPC wiring.
 */
type FakeChild = {
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
    kill: vi.fn().mockReturnValue(true),
    killed: false,
    onExit: undefined,
    onMessage: undefined,
    pid: 12345,
    send: vi.fn().mockReturnValue(true),
  };
  return child;
}

describe("JobManager", () => {
  let db: ReturnType<typeof makeDb>;
  let manager: JobManager;
  let fakeChild: ReturnType<typeof makeFakeChild>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeDb();
    manager = new JobManager(db, "/fake/project", "/fake/plugin");

    // Default: fingerprint resolves to 'mock-fingerprint-abc123'
    vi.mocked(computeJobFingerprint).mockResolvedValue("mock-fingerprint-abc123");
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

  // submit — happy path

  it("submit creates a job, forks a process, and returns running status", async () => {
    const result = await manager.submit({ root_dir: "/fake/project" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.job_id).toBeTruthy();
    expect(result.status).toBe("running");
    expect(result.fingerprint).toBe("mock-fingerprint-abc123");
    expect(result.deduplicated).toBe(false);
    expect(result.cached).toBe(false);
    expect(forkJob).toHaveBeenCalledOnce();
    expect(sendWorkerInput).toHaveBeenCalledOnce();
  });

  it("submit passes sourceDirs to computeJobFingerprint", async () => {
    await manager.submit({ root_dir: "/fake/project" }, ["src", "lib"]);
    expect(computeJobFingerprint).toHaveBeenCalledWith({
      projectDir: "/fake/project",
      sourceDirs: ["src", "lib"],
    });
  });

  // submit — deduplication

  it("submit with same fingerprint returns deduplicated: true", async () => {
    // First submit
    const r1 = await manager.submit({ root_dir: "/fake/project" });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    // Second submit with same fingerprint — should dedup
    const r2 = await manager.submit({ root_dir: "/fake/project" });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    expect(r2.deduplicated).toBe(true);
    expect(r2.job_id).toBe(r1.job_id);
    // forkJob called only once (for first submit)
    expect(forkJob).toHaveBeenCalledOnce();
  });

  // submit — cache hit

  // Comment #3: _forkJob forwards CodebaseGraphInput to worker

  it("submit forwards include_extensions and exclude_dirs to sendWorkerInput", async () => {
    await manager.submit({
      exclude_dirs: ["node_modules"],
      include_extensions: [".ts"],
      root_dir: "/fake/project",
    });
    expect(sendWorkerInput).toHaveBeenCalledOnce();
    const sentInput = vi.mocked(sendWorkerInput).mock.calls[0][1];
    expect(sentInput.include_extensions).toEqual([".ts"]);
    expect(sentInput.exclude_dirs).toEqual(["node_modules"]);
  });

  it("submit with cached fingerprint returns cached result", async () => {
    // Prime the cache by running once and completing
    const r1 = await manager.submit({ root_dir: "/fake/project" });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    // Simulate the worker completing
    fakeChild._simulateMessage({
      result: { filesScanned: 99 },
      type: "complete",
    });

    // Second submit — same fingerprint, should hit cache
    vi.mocked(forkJob).mockClear();
    const r2 = await manager.submit({ root_dir: "/fake/project" });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    expect(r2.cached).toBe(true);
    expect(r2.result).toEqual({ filesScanned: 99 });
    // Cache-hit must return a usable job_id (comment #1 fix)
    expect(r2.job_id).toBeTruthy();
    expect(r2.job_id).toMatch(/^[0-9a-f-]{36}$/);
    // No additional fork
    expect(forkJob).not.toHaveBeenCalled();
  });

  // submit — sync mode

  it("submit in sync mode runs runPipeline inline without forking", async () => {
    vi.mocked(isSyncMode).mockReturnValue(true);

    const result = await manager.submit({ root_dir: "/fake/project" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.status).toBe("complete");
    expect(result.result).toBeDefined();
    expect(forkJob).not.toHaveBeenCalled();
    expect(runPipeline).toHaveBeenCalledOnce();
  });

  it("submit in sync mode caches the result", async () => {
    vi.mocked(isSyncMode).mockReturnValue(true);

    await manager.submit({ root_dir: "/fake/project" });

    // Second submit — should hit cache
    vi.mocked(isSyncMode).mockReturnValue(false); // switch back to async
    vi.mocked(forkJob).mockClear();
    const r2 = await manager.submit({ root_dir: "/fake/project" });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    expect(r2.cached).toBe(true);
    expect(forkJob).not.toHaveBeenCalled();
  });

  // submit — fingerprint null (not a git repo)

  it("submit returns error when fingerprint cannot be computed", async () => {
    vi.mocked(computeJobFingerprint).mockResolvedValue(null);

    const result = await manager.submit({ root_dir: "/not-a-git-repo" });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error_code).toBe("INVALID_INPUT");
  });

  // poll

  it("poll returns correct status and progress for a running job", async () => {
    const submitResult = await manager.submit({ root_dir: "/fake/project" });
    expect(submitResult.ok).toBe(true);
    if (!submitResult.ok) return;

    const { job_id } = submitResult;
    const pollResult = manager.poll(job_id);
    expect(pollResult.ok).toBe(true);
    if (!pollResult.ok) return;

    expect(pollResult.job_id).toBe(job_id);
    expect(pollResult.status).toBe("running");
    expect(pollResult.started_at).toBeTruthy();
    expect(pollResult.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("poll returns progress parsed from JSON when available", async () => {
    const submitResult = await manager.submit({ root_dir: "/fake/project" });
    expect(submitResult.ok).toBe(true);
    if (!submitResult.ok) return;

    const { job_id } = submitResult;

    // Simulate progress message
    fakeChild._simulateMessage({ current: 3, phase: "scan", total: 10, type: "progress" });

    const pollResult = manager.poll(job_id);
    expect(pollResult.ok).toBe(true);
    if (!pollResult.ok) return;

    expect(pollResult.progress).not.toBeNull();
    expect(pollResult.progress!.phase).toBe("scan");
    expect(pollResult.progress!.current).toBe(3);
    expect(pollResult.progress!.total).toBe(10);
  });

  it("poll returns error for unknown job_id", () => {
    const result = manager.poll("nonexistent-job");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("INVALID_INPUT");
  });

  it("poll reflects complete status after worker completes", async () => {
    const submitResult = await manager.submit({ root_dir: "/fake/project" });
    expect(submitResult.ok).toBe(true);
    if (!submitResult.ok) return;

    const { job_id } = submitResult;

    // Simulate completion
    fakeChild._simulateMessage({ result: { filesScanned: 42 }, type: "complete" });

    const pollResult = manager.poll(job_id);
    expect(pollResult.ok).toBe(true);
    if (!pollResult.ok) return;

    expect(pollResult.status).toBe("complete");
    expect(pollResult.completed_at).not.toBeNull();
  });

  it("poll reflects failed status after worker errors", async () => {
    const submitResult = await manager.submit({ root_dir: "/fake/project" });
    expect(submitResult.ok).toBe(true);
    if (!submitResult.ok) return;

    const { job_id } = submitResult;

    // Simulate error
    fakeChild._simulateMessage({ message: "worker crashed", type: "error" });

    const pollResult = manager.poll(job_id);
    expect(pollResult.ok).toBe(true);
    if (!pollResult.ok) return;

    expect(pollResult.status).toBe("failed");
    expect(pollResult.error).toBe("worker crashed");
  });

  // cancel

  it("cancel kills the process and updates status to cancelled", async () => {
    const submitResult = await manager.submit({ root_dir: "/fake/project" });
    expect(submitResult.ok).toBe(true);
    if (!submitResult.ok) return;

    const { job_id } = submitResult;
    const cancelResult = manager.cancel(job_id);
    expect(cancelResult.ok).toBe(true);
    if (!cancelResult.ok) return;

    expect(cancelResult.cancelled).toBe(true);
    expect(killJob).toHaveBeenCalledOnce();
  });

  it("cancel returns error for unknown job_id", () => {
    const result = manager.cancel("nonexistent");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("INVALID_INPUT");
  });

  it("cancel returns cancelled: false for a non-active job", async () => {
    // Submit and immediately complete
    const submitResult = await manager.submit({ root_dir: "/fake/project" });
    expect(submitResult.ok).toBe(true);
    if (!submitResult.ok) return;

    const { job_id } = submitResult;
    fakeChild._simulateMessage({ result: {}, type: "complete" });

    // Now cancel — job exists but is not in activeJobs
    const cancelResult = manager.cancel(job_id);
    expect(cancelResult.ok).toBe(true);
    if (!cancelResult.ok) return;

    expect(cancelResult.cancelled).toBe(false);
  });

  // cleanup

  it("cleanup kills all active jobs and marks stale jobs failed", async () => {
    // Submit two jobs
    await manager.submit({ root_dir: "/fake/project" });

    // Assign different fingerprint for second job
    vi.mocked(computeJobFingerprint).mockResolvedValue("different-fingerprint");
    const fakeChild2 = makeFakeChild();
    vi.mocked(forkJob).mockImplementation((options) => {
      fakeChild2.onMessage = options.onMessage as (msg: unknown) => void;
      fakeChild2.onExit = options.onExit;
      return fakeChild2 as unknown as ChildProcess;
    });
    await manager.submit({ root_dir: "/fake/project" });

    manager.cleanup();

    // Both active processes should be killed
    expect(killJob).toHaveBeenCalledTimes(2);
  });

  // Timeout watchdog

  it("timeout watchdog marks job as timed_out after timeout expires", async () => {
    vi.useFakeTimers();

    // Use a very short timeout for testing
    const shortTimeoutManager = new JobManager(db, "/fake/project", "/fake/plugin", 100);

    const result = await shortTimeoutManager.submit({ root_dir: "/fake/project" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      vi.useRealTimers();
      return;
    }

    const { job_id } = result;

    // Advance time past the timeout
    await vi.advanceTimersByTimeAsync(200);

    expect(killJob).toHaveBeenCalledOnce();

    const pollResult = shortTimeoutManager.poll(job_id);
    expect(pollResult.ok).toBe(true);
    if (!pollResult.ok) {
      vi.useRealTimers();
      return;
    }

    expect(pollResult.status).toBe("timed_out");

    shortTimeoutManager.cleanup();
    vi.useRealTimers();
  });

  // IPC message routing — unexpected exit

  it("unexpected child exit sets status to failed when still running", async () => {
    const submitResult = await manager.submit({ root_dir: "/fake/project" });
    expect(submitResult.ok).toBe(true);
    if (!submitResult.ok) return;

    const { job_id } = submitResult;

    // Simulate unexpected exit (no complete/error message sent)
    fakeChild._simulateExit(1);

    const pollResult = manager.poll(job_id);
    expect(pollResult.ok).toBe(true);
    if (!pollResult.ok) return;

    expect(pollResult.status).toBe("failed");
  });

  it("expected exit after complete message does not overwrite status", async () => {
    const submitResult = await manager.submit({ root_dir: "/fake/project" });
    expect(submitResult.ok).toBe(true);
    if (!submitResult.ok) return;

    const { job_id } = submitResult;

    // Complete, then exit (normal sequence)
    fakeChild._simulateMessage({ result: {}, type: "complete" });
    fakeChild._simulateExit(0);

    const pollResult = manager.poll(job_id);
    expect(pollResult.ok).toBe(true);
    if (!pollResult.ok) return;

    expect(pollResult.status).toBe("complete");
  });
});

// getOrCreateJobManager — Comment #4 fixes

describe("getOrCreateJobManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetJobManagerSingleton();
  });

  afterEach(() => {
    _resetJobManagerSingleton();
  });

  it("creates a JobManager using orchestration.db path (not knowledge-graph.db)", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "getorcreate-test-"));
    // Create the .canon directory so initExecutionDb can write the DB
    const { mkdirSync } = await import("node:fs");
    mkdirSync(path.join(tmpDir, ".canon"), { recursive: true });

    // Should not throw — uses dynamic import of better-sqlite3 and orchestration.db
    const manager = await getOrCreateJobManager(tmpDir, "/fake/plugin");
    expect(manager).toBeInstanceOf(JobManager);
  });

  it("returns the same instance on second call (singleton)", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "getorcreate-singleton-"));
    const { mkdirSync } = await import("node:fs");
    mkdirSync(path.join(tmpDir, ".canon"), { recursive: true });

    const m1 = await getOrCreateJobManager(tmpDir, "/fake/plugin");
    const m2 = await getOrCreateJobManager(tmpDir, "/fake/plugin");
    expect(m1).toBe(m2);
  });
});
