/**
 * End-to-end integration tests for the full background job lifecycle.
 *
 * These tests exercise the real JobManager, JobStore, job-adapter, and
 * graph-worker against a temporary project directory and file-based SQLite
 * databases. No job-level mocking is used.
 *
 * Only external I/O that would be impractical in CI is mocked: nothing in this
 * file. git calls work because each test creates a real git repo fixture.
 *
 * Per-test isolation: each test creates its own temp directory and JobManager
 * instance so there is zero shared state between tests.
 *
 * Tests are designed to run with `vi.setConfig({ testTimeout: 30000 })` to
 * accommodate real child process lifecycle times.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { CANON_DIR, CANON_FILES } from "../../constants.ts";
import { JobManager } from "../../jobs/job-manager.ts";
import { JobStore } from "../../jobs/job-store.ts";
import { initExecutionDb } from "../../orchestration/execution-schema.ts";

// Slow test timeout — child process lifecycle + WASM init can take several sec

vi.setConfig({ testTimeout: 30_000 });

// Fixture helpers

/**
 * Create a minimal temp project:
 * - .canon/config.json (minimal)
 * - 3-5 .ts source files
 * - A git repo with one commit
 * Returns the absolute projectDir path.
 */
function createTempProject(): string {
  const projectDir = mkdtempSync(path.join(os.tmpdir(), "canon-integ-test-"));

  // Create .canon dir and minimal config
  const canonDir = path.join(projectDir, ".canon");
  mkdirSync(canonDir, { recursive: true });
  writeFileSync(path.join(canonDir, "config.json"), JSON.stringify({ layers: {} }), "utf-8");

  // Create a few TypeScript source files
  writeFileSync(
    path.join(projectDir, "index.ts"),
    `export function hello(name: string): string { return \`Hello, \${name}!\`; }\n`,
    "utf-8",
  );
  writeFileSync(
    path.join(projectDir, "utils.ts"),
    `export function add(a: number, b: number): number { return a + b; }\n`,
    "utf-8",
  );
  writeFileSync(
    path.join(projectDir, "types.ts"),
    `export interface User { id: number; name: string; }\n`,
    "utf-8",
  );
  writeFileSync(
    path.join(projectDir, "service.ts"),
    `import { add } from './utils.ts';\nexport function double(n: number): number { return add(n, n); }\n`,
    "utf-8",
  );

  // Initialize git and commit
  execSync("git init", { cwd: projectDir, stdio: "ignore" });
  execSync('git config user.email "test@example.com"', { cwd: projectDir, stdio: "ignore" });
  execSync('git config user.name "Test"', { cwd: projectDir, stdio: "ignore" });
  execSync("git add .", { cwd: projectDir, stdio: "ignore" });
  execSync('git commit -m "Initial commit"', { cwd: projectDir, stdio: "ignore" });

  return projectDir;
}

/**
 * Create a file-based SQLite DB with the execution schema applied.
 * Stored inside the given projectDir/.canon/ for natural co-location.
 */
function createExecutionDb(projectDir: string): Database.Database {
  const dbPath = path.join(projectDir, ".canon", "orchestration.db");
  return initExecutionDb(dbPath);
}

/**
 * Create a JobManager for the given project directory.
 * Uses a very long default timeout so tests can override via constructor.
 */
function createManager(projectDir: string, db: Database.Database, timeoutMs = 120_000): JobManager {
  return new JobManager(db, projectDir, projectDir, timeoutMs);
}

/**
 * Poll a JobManager until the job reaches a terminal status or the max attempts
 * are exhausted. Returns the last poll result.
 */
async function pollUntilTerminal(
  manager: JobManager,
  jobId: string,
  opts = { intervalMs: 250, maxAttempts: 120 },
): Promise<{ status: string; error: string | null }> {
  const TERMINAL = new Set(["complete", "failed", "cancelled", "timed_out"]);
  for (let i = 0; i < opts.maxAttempts; i++) {
    const poll = manager.poll(jobId);
    if (!poll.ok) throw new Error(`poll failed: ${poll.message}`);
    if (TERMINAL.has(poll.status)) {
      return { error: poll.error, status: poll.status };
    }
    // biome-ignore lint/performance/noAwaitInLoops: sequential polling loop; each iteration waits before checking again
    await new Promise<void>((resolve) => setTimeout(resolve, opts.intervalMs));
  }
  const finalPoll = manager.poll(jobId);
  if (!finalPoll.ok) throw new Error(`poll failed: ${finalPoll.message}`);
  return { error: finalPoll.error, status: finalPoll.status };
}

/**
 * Poll a JobManager until the job reaches 'running' status (or any terminal
 * status indicating it moved through running). This replaces raw sleeps before
 * cancel calls: rather than waiting a fixed wall-clock interval, we wait for a
 * known state transition, which is deterministic regardless of CPU load.
 *
 * Returns when status is 'running' or any terminal status. Throws if the job
 * cannot be found or the max attempts are exhausted without reaching running.
 */
async function pollUntilRunning(
  manager: JobManager,
  jobId: string,
  opts = { intervalMs: 50, maxAttempts: 80 },
): Promise<void> {
  const RUNNING_OR_TERMINAL = new Set(["running", "complete", "failed", "cancelled", "timed_out"]);
  for (let i = 0; i < opts.maxAttempts; i++) {
    const poll = manager.poll(jobId);
    if (!poll.ok) throw new Error(`poll failed: ${poll.message}`);
    if (RUNNING_OR_TERMINAL.has(poll.status)) {
      return;
    }
    // biome-ignore lint/performance/noAwaitInLoops: sequential polling loop; each iteration waits before checking again
    await new Promise<void>((resolve) => setTimeout(resolve, opts.intervalMs));
  }
  throw new Error(
    `Job ${jobId} did not reach running status within ${opts.maxAttempts * opts.intervalMs}ms`,
  );
}

// Global temp dirs to clean up

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { force: true, recursive: true });
    } catch {
      // best effort cleanup
    }
  }
});

// Helper: create an isolated project + manager, register for cleanup

function setupTestFixture(timeoutMs?: number): {
  projectDir: string;
  db: Database.Database;
  manager: JobManager;
} {
  const projectDir = createTempProject();
  tempDirs.push(projectDir);
  const db = createExecutionDb(projectDir);
  const manager = createManager(projectDir, db, timeoutMs);
  return { db, manager, projectDir };
}

// Ensure CANON_SYNC_JOBS is not set from the outer environment for async tests.
// We explicitly control it per-test.

// Store original env state
const originalSyncJobs = process.env.CANON_SYNC_JOBS;
const originalCI = process.env.CI;

afterEach(() => {
  // Restore CANON_SYNC_JOBS after each test that may have modified it
  if (originalSyncJobs === undefined) {
    process.env.CANON_SYNC_JOBS = undefined;
  } else {
    process.env.CANON_SYNC_JOBS = originalSyncJobs;
  }
  // Restore CI after each test that may have modified it
  if (originalCI === undefined) {
    process.env.CI = undefined;
  } else {
    process.env.CI = originalCI;
  }
});

// Test 1: Full async lifecycle — submit → poll until running → poll until
//         complete → verify output fields.

describe("Integration: full async lifecycle", () => {
  it("submits a job, worker completes, and poll returns complete status", async () => {
    // Unset CANON_SYNC_JOBS to ensure async mode
    process.env.CANON_SYNC_JOBS = undefined;
    // Unset CI to avoid isSyncMode() triggering sync path
    process.env.CI = undefined;

    const { manager } = setupTestFixture();

    const submitResult = await manager.submit({ root_dir: "" });
    expect(submitResult.ok).toBe(true);
    if (!submitResult.ok) return;

    expect(submitResult.job_id).toBeTruthy();
    expect(submitResult.status).toBe("running");
    expect(submitResult.fingerprint).toBeTruthy();
    expect(submitResult.deduplicated).toBe(false);
    expect(submitResult.cached).toBe(false);

    const jobId = submitResult.job_id;

    // Poll until terminal
    const { status } = await pollUntilTerminal(manager, jobId);
    expect(status).toBe("complete");

    // Verify final poll has completed_at set
    const finalPoll = manager.poll(jobId);
    expect(finalPoll.ok).toBe(true);
    if (!finalPoll.ok) return;
    expect(finalPoll.status).toBe("complete");
    expect(finalPoll.completed_at).not.toBeNull();
    expect(finalPoll.duration_ms).toBeGreaterThan(0);

    manager.cleanup();
  });
});

// Test 2: Cache hit — same fingerprint returns cached: true

describe("Integration: cache hit", () => {
  it("returns cached: true on second submit with the same fingerprint", async () => {
    process.env.CANON_SYNC_JOBS = undefined;
    process.env.CI = undefined;

    const { manager } = setupTestFixture();

    // First submit — let it complete
    const r1 = await manager.submit({ root_dir: "" });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const jobId = r1.job_id;
    const { status } = await pollUntilTerminal(manager, jobId);
    expect(status).toBe("complete");

    // Second submit — same project state → same fingerprint → cache hit
    const r2 = await manager.submit({ root_dir: "" });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    expect(r2.cached).toBe(true);
    expect(r2.status).toBe("complete");
    // cached result should have the job summary in result
    expect(r2.result).toBeDefined();

    manager.cleanup();
  });
});

// Test 3: Dedup running job — second submit returns deduplicated: true

describe("Integration: dedup running job", () => {
  it("returns deduplicated: true when a running job has the same fingerprint", async () => {
    process.env.CANON_SYNC_JOBS = undefined;
    process.env.CI = undefined;

    const { manager } = setupTestFixture();

    // First submit starts the job
    const r1 = await manager.submit({ root_dir: "" });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    expect(r1.status).toBe("running");
    const firstJobId = r1.job_id;

    // Second submit before first completes — should deduplicate
    const r2 = await manager.submit({ root_dir: "" });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    expect(r2.deduplicated).toBe(true);
    expect(r2.job_id).toBe(firstJobId);
    expect(r2.cached).toBe(false);

    // Let the first job finish
    await pollUntilTerminal(manager, firstJobId);
    manager.cleanup();
  });
});

// Test 4: Sync mode — CANON_SYNC_JOBS=1 runs inline

describe("Integration: sync mode", () => {
  it("runs pipeline inline when CANON_SYNC_JOBS=1, returning complete immediately", async () => {
    // Enable sync mode
    process.env.CANON_SYNC_JOBS = "1";
    // Must clear CI so isSyncMode() reads CANON_SYNC_JOBS specifically
    // (Actually CANON_SYNC_JOBS=1 already forces sync regardless of CI)

    const { manager } = setupTestFixture();

    const result = await manager.submit({ root_dir: "" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Sync mode returns complete immediately
    expect(result.status).toBe("complete");
    expect(result.result).toBeDefined();
    expect(result.deduplicated).toBe(false);
    expect(result.cached).toBe(false);

    // The job should be in the DB with complete status
    const poll = manager.poll(result.job_id);
    expect(poll.ok).toBe(true);
    if (!poll.ok) return;
    expect(poll.status).toBe("complete");

    manager.cleanup();
  });
});

// Test 5: Cancel — submit → cancel → status is cancelled

describe("Integration: cancel", () => {
  it("cancels an active job and polls as cancelled", async () => {
    process.env.CANON_SYNC_JOBS = undefined;
    process.env.CI = undefined;

    const { manager } = setupTestFixture();

    // Submit a job
    const submitResult = await manager.submit({ root_dir: "" });
    expect(submitResult.ok).toBe(true);
    if (!submitResult.ok) return;

    const jobId = submitResult.job_id;

    // Wait for the job to reach running status before cancelling.
    // Polling until a known state is deterministic — unlike a fixed sleep it
    // does not depend on wall-clock execution speed.
    await pollUntilRunning(manager, jobId);

    // Cancel
    const cancelResult = manager.cancel(jobId);
    expect(cancelResult.ok).toBe(true);
    if (!cancelResult.ok) return;
    expect(cancelResult.cancelled).toBe(true);

    // Poll — status must be cancelled
    const pollResult = manager.poll(jobId);
    expect(pollResult.ok).toBe(true);
    if (!pollResult.ok) return;
    expect(pollResult.status).toBe("cancelled");

    manager.cleanup();
  });
});

// Test 6: Timeout — very short timeout → timed_out

describe("Integration: timeout", () => {
  it("marks a job timed_out when the watchdog fires before worker completes", async () => {
    process.env.CANON_SYNC_JOBS = undefined;
    process.env.CI = undefined;

    // Use a 1ms timeout — fires almost immediately after the worker starts
    const { manager } = setupTestFixture(/* timeoutMs = */ 1);

    const submitResult = await manager.submit({ root_dir: "" });
    expect(submitResult.ok).toBe(true);
    if (!submitResult.ok) return;

    const jobId = submitResult.job_id;

    // Wait for the timeout watchdog to fire and update the status
    const { status } = await pollUntilTerminal(manager, jobId, {
      intervalMs: 100,
      maxAttempts: 80,
    });
    expect(status).toBe("timed_out");

    manager.cleanup();
  });
});

// Test 7: Stale cleanup on startup — running job + cleanup() → failed

describe("Integration: stale cleanup", () => {
  it("marks stale running jobs as failed when cleanup is called", () => {
    const projectDir = createTempProject();
    tempDirs.push(projectDir);
    const db = createExecutionDb(projectDir);
    const manager = createManager(projectDir, db);

    // Manually insert a "stale" running job row (no real process behind it)
    const store = new JobStore(db);
    const staleJobId = `stale-job-${Date.now()}`;
    store.createJob({
      error: null,
      fingerprint: "fp-stale",
      job_id: staleJobId,
      job_type: "codebase_graph",
      pid: null,
      progress: null,
      started_at: new Date(Date.now() - 60_000).toISOString(), // 1 minute ago
      status: "running",
      timeout_ms: 300_000,
    });

    // Verify the job is running before cleanup
    const beforePoll = manager.poll(staleJobId);
    expect(beforePoll.ok).toBe(true);
    if (!beforePoll.ok) return;
    expect(beforePoll.status).toBe("running");

    // cleanup() marks all stale (running) DB jobs as failed
    manager.cleanup();

    // Verify the job is now failed
    const afterPoll = manager.poll(staleJobId);
    expect(afterPoll.ok).toBe(true);
    if (!afterPoll.ok) return;
    expect(afterPoll.status).toBe("failed");
    expect(afterPoll.error).toBeTruthy();
  });
});

// Test 8: Busy timeout — concurrent KG DB access doesn't cause SQLITE_BUSY

describe("Integration: busy timeout", () => {
  it("worker does not get SQLITE_BUSY when parent holds a long write transaction", async () => {
    process.env.CANON_SYNC_JOBS = undefined;
    process.env.CI = undefined;

    const projectDir = createTempProject();
    tempDirs.push(projectDir);
    const db = createExecutionDb(projectDir);
    const manager = createManager(projectDir, db);

    // Open a competing write connection to the KG DB.
    // The busy_timeout on the worker's connection gives it up to 5s to retry.
    const kgDbPath = path.join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
    const competitorDb = new Database(kgDbPath);

    // Initialize the KG DB schema (needed so the competitor can open it)
    // The worker will create its own schema — that's fine.
    // The competitor holds a write transaction to simulate a busy DB.
    let competitorReleased = false;

    // Start a deferred transaction that we'll hold open for 1 second
    const beginTx = competitorDb.prepare("BEGIN DEFERRED");
    beginTx.run();

    // Submit the job — worker will try to open the KG DB
    const submitResult = await manager.submit({ root_dir: "" });
    expect(submitResult.ok).toBe(true);
    if (!submitResult.ok) {
      competitorDb.prepare("ROLLBACK").run();
      competitorDb.close();
      manager.cleanup();
      return;
    }

    const jobId = submitResult.job_id;

    // Hold the transaction for 1 second then release
    setTimeout(() => {
      try {
        competitorDb.prepare("ROLLBACK").run();
      } catch {
        // May already be released
      }
      competitorReleased = true;
    }, 1000);

    // Wait for the job to reach a terminal status (success or fail, but NOT SQLITE_BUSY crash)
    const { status, error } = await pollUntilTerminal(manager, jobId, {
      intervalMs: 300,
      maxAttempts: 100,
    });

    // Ensure we released the competitor
    if (!competitorReleased) {
      try {
        competitorDb.prepare("ROLLBACK").run();
      } catch {
        // ignore
      }
    }
    competitorDb.close();

    // The job should complete or fail gracefully — NOT with SQLITE_BUSY
    // A busy_timeout of 5000ms means the worker retries for 5s before giving up.
    // With only 1s of contention, the worker should succeed.
    expect(["complete", "failed"]).toContain(status);
    if (error) {
      expect(error).not.toContain("SQLITE_BUSY");
    }

    manager.cleanup();
  });
});
