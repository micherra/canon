/**
 * learn-gate-integration.test.ts — Cross-module integration tests for evaluateLearnGate.
 *
 * Tests the wiring across module boundaries:
 *   learn-gate.ts → config.ts (loadLearnGateConfig)
 *   learn-gate.ts → learn-lock.ts (acquireLearnLock, getLastLearnTimestamp)
 *   learn-gate.ts → drift-db.ts (getDriftDb → countFlowRunsSince)
 *
 * Unlike learn-gate.test.ts (which mocks all dependencies), this file uses REAL
 * implementations backed by temp directories — exercising the actual cross-module
 * wiring that unit tests cannot verify.
 *
 * This file has NO vi.mock() calls so none of the module boundaries are mocked.
 *
 * Canon principles:
 *   - toolresult-contract: evaluateLearnGate returns LearnGateResult, never throws
 *     for gate failures
 *   - define-errors-out-of-existence: absent config → defaults; missing lock → no prior run
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateLearnGate } from "../learn-gate.ts";

let tmpDirs: string[] = [];

function makeTmpProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "learn-gate-integ-test-"));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Write a minimal config.json that bypasses the time gate and flow gate,
 * so tests can focus on specific gate behavior.
 */
function writePassingConfig(
  canonDir: string,
  overrides: Record<string, unknown> = {},
): void {
  const config = {
    learn_gate: {
      enabled: true,
      min_flows_since_last: 1, // min valid value per schema (>= 1)
      min_hours_since_last: 0, // skip time gate
      lock_stale_after_hours: 1,
      ...overrides,
    },
  };
  writeFileSync(join(canonDir, "config.json"), JSON.stringify(config));
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
});

// ── Gate 1 + config integration ───────────────────────────────────────────────

describe("learn-gate integration: config gate", () => {
  it("returns passed:false when config.json has enabled:false", async () => {
    // Cross-module: evaluateLearnGate → loadLearnGateConfig → reads real config.json
    const projectDir = makeTmpProjectDir();
    const canonDir = join(projectDir, ".canon");
    mkdirSync(canonDir, { recursive: true });

    writeFileSync(
      join(canonDir, "config.json"),
      JSON.stringify({ learn_gate: { enabled: false } }),
    );

    const result = await evaluateLearnGate(projectDir);

    expect(result.passed).toBe(false);
    expect(result.reason).toBe("auto-learn disabled");
  });

  it("uses defaults (enabled:true) when no config.json exists", async () => {
    // define-errors-out-of-existence: missing config = use defaults (enabled)
    // With no config, gate 1 passes, but gate 4 (flow count) will fail since drift.db
    // is empty. We just verify we proceed past gate 1.
    const projectDir = makeTmpProjectDir();
    const canonDir = join(projectDir, ".canon");
    mkdirSync(canonDir, { recursive: true });
    // No config.json — defaults apply: enabled=true, min_flows=5

    const result = await evaluateLearnGate(projectDir);

    // Gate 4 will fail (0 flow runs < 5 default min), but the reason shows
    // we passed gate 1 (would be "auto-learn disabled" otherwise)
    expect(result.passed).toBe(false);
    expect(result.reason).not.toBe("auto-learn disabled");
    expect(result.reason).toMatch(/flow gate|scan throttle|time gate|lock gate/);
  });
});

// ── Gate 2 + learn-lock integration ──────────────────────────────────────────

describe("learn-gate integration: time gate → learn-lock cross-module", () => {
  it("blocks at time gate when lock mtime shows recent learn run", async () => {
    // Cross-module: evaluateLearnGate → getLastLearnTimestamp → reads real lock file
    const projectDir = makeTmpProjectDir();
    const canonDir = join(projectDir, ".canon");
    mkdirSync(canonDir, { recursive: true });

    // Config: 48h min threshold
    writePassingConfig(canonDir, { min_hours_since_last: 48 });

    // Create a lock file with mtime = 2 hours ago (within 48h threshold)
    const lockPath = join(canonDir, "learn.lock");
    writeFileSync(lockPath, String(process.pid));
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(lockPath, new Date(), twoHoursAgo);

    const result = await evaluateLearnGate(projectDir);

    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/^time gate: 2\.\d+h < 48h$/);
  });

  it("skips time gate when no lock file exists (no prior run)", async () => {
    // define-errors-out-of-existence: no lock file = no prior run = skip time gate
    const projectDir = makeTmpProjectDir();
    const canonDir = join(projectDir, ".canon");
    mkdirSync(canonDir, { recursive: true });

    // Config that allows proceeding past time gate (no lock = skip)
    // Flow gate will fail (empty drift.db), but we pass time gate
    writePassingConfig(canonDir, { min_hours_since_last: 48 });
    // No lock file — getLastLearnTimestamp returns null

    const result = await evaluateLearnGate(projectDir);

    // Should not fail at time gate
    expect(result.reason).not.toMatch(/time gate/);
  });
});

// ── Gate 4 + drift-db integration ────────────────────────────────────────────

describe("learn-gate integration: flow gate → drift-db cross-module", () => {
  it("blocks at flow gate when drift.db is empty (0 flow runs < min_flows)", async () => {
    // Cross-module: evaluateLearnGate → getDriftDb → countFlowRunsSince
    // An empty drift.db returns 0 which fails the min_flows_since_last gate
    const projectDir = makeTmpProjectDir();
    const canonDir = join(projectDir, ".canon");
    mkdirSync(canonDir, { recursive: true });

    // Config with min_flows=3, no time gate
    writePassingConfig(canonDir, {
      min_flows_since_last: 3,
      min_hours_since_last: 0,
    });

    // Initialize drift.db by calling getDriftDb (evaluateLearnGate also calls it,
    // but we do it here to verify the DB is created before the gate runs)
    const { getDriftDb } = await import("@platform/storage/drift/drift-db.ts");
    getDriftDb(projectDir); // creates empty drift.db

    const result = await evaluateLearnGate(projectDir);

    expect(result.passed).toBe(false);
    expect(result.reason).toBe("flow gate: 0 < 3");
  });

  it("passes flow gate when drift.db has enough flow runs", async () => {
    // Cross-module: evaluateLearnGate → getDriftDb → countFlowRunsSince with real data
    const projectDir = makeTmpProjectDir();
    const canonDir = join(projectDir, ".canon");
    mkdirSync(canonDir, { recursive: true });

    // Config: min_flows=2, no time gate, stale lock after 1h
    writePassingConfig(canonDir, {
      min_flows_since_last: 2,
      min_hours_since_last: 0,
      lock_stale_after_hours: 1,
    });

    // Seed drift.db with enough flow runs
    const { getDriftDb } = await import("@platform/storage/drift/drift-db.ts");
    const driftDb = getDriftDb(projectDir);
    const baseRun = {
      completed: new Date().toISOString(),
      flow: "fast-path",
      gate_pass_rate: undefined,
      postcondition_pass_rate: undefined,
      skipped_states: [],
      started: new Date(Date.now() - 60000).toISOString(),
      state_durations: {},
      state_iterations: {},
      task: "fix bug",
      tier: "small",
      total_duration_ms: 60000,
      total_files_changed: undefined,
      total_spawns: 2,
      total_test_results: undefined,
      total_violations: undefined,
    };
    driftDb.appendFlowRun({ ...baseRun, run_id: "run-01" });
    driftDb.appendFlowRun({ ...baseRun, run_id: "run-02" });
    // 2 runs >= min_flows_since_last (2), flow gate passes

    const result = await evaluateLearnGate(projectDir);

    // Gate 5 (lock) runs next — no existing lock, so it succeeds
    expect(result.passed).toBe(true);
    // Lock was acquired — clean up
    const { releaseLearnLock } = await import("@shared/lib/learn-lock.ts");
    await releaseLearnLock(canonDir);
  });
});

// ── Gate 5 + learn-lock stale reclaim integration ────────────────────────────

describe("learn-gate integration: lock gate → learn-lock stale reclaim", () => {
  it("passes all gates and acquires stale lock when all conditions are met", async () => {
    // End-to-end integration: all 5 gates run with real modules
    // This is the primary declared gap from adr016-02 (cross-module, real drift.db)
    const projectDir = makeTmpProjectDir();
    const canonDir = join(projectDir, ".canon");
    mkdirSync(canonDir, { recursive: true });

    // Config: min_flows=1, no time gate, stale after 1h
    writePassingConfig(canonDir, {
      min_flows_since_last: 1,
      min_hours_since_last: 0,
      lock_stale_after_hours: 1,
    });

    // Seed drift.db with 1 flow run (meets min_flows=1)
    const { getDriftDb } = await import("@platform/storage/drift/drift-db.ts");
    const driftDb = getDriftDb(projectDir);
    driftDb.appendFlowRun({
      completed: new Date().toISOString(),
      flow: "fast-path",
      gate_pass_rate: undefined,
      postcondition_pass_rate: undefined,
      run_id: "run-01",
      skipped_states: [],
      started: new Date(Date.now() - 60000).toISOString(),
      state_durations: {},
      state_iterations: {},
      task: "fix bug",
      tier: "small",
      total_duration_ms: 60000,
      total_files_changed: undefined,
      total_spawns: 2,
      total_test_results: undefined,
      total_violations: undefined,
    });

    // Write a stale lock (2h old, stale threshold = 1h)
    const lockPath = join(canonDir, "learn.lock");
    writeFileSync(lockPath, "99999"); // stale PID
    const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(lockPath, new Date(), staleTime);

    const result = await evaluateLearnGate(projectDir);

    // All 5 gates pass — stale lock is reclaimed
    expect(result.passed).toBe(true);
    expect(result.reason).toBeUndefined();

    // Verify the lock was actually acquired (our PID written)
    const { readFile } = await import("node:fs/promises");
    const lockContent = await readFile(lockPath, "utf-8");
    expect(lockContent).toBe(String(process.pid));

    // Clean up
    const { releaseLearnLock } = await import("@shared/lib/learn-lock.ts");
    await releaseLearnLock(canonDir);
  });

  it("returns passed:false when lock is held by another process (non-stale)", async () => {
    // Cross-module: evaluateLearnGate → acquireLearnLock → already_locked
    const projectDir = makeTmpProjectDir();
    const canonDir = join(projectDir, ".canon");
    mkdirSync(canonDir, { recursive: true });

    writePassingConfig(canonDir, {
      min_flows_since_last: 1,
      // Set min_hours to a large value so we can write a lock with mtime=5min ago
      // and still pass the time gate (5min ago is fine for 0h threshold, but we need
      // a non-zero number to prevent floating-point sign flip). Instead: no lock file
      // for time gate purposes — we use null lastLearnTs by not pre-writing the lock,
      // then create it fresh right before calling evaluateLearnGate.
      // Actually simpler: create the lock with mtime 5 minutes ago (past the 0h gate)
      min_hours_since_last: 0,
      lock_stale_after_hours: 1,
    });

    const { getDriftDb } = await import("@platform/storage/drift/drift-db.ts");
    const driftDb = getDriftDb(projectDir);
    driftDb.appendFlowRun({
      completed: new Date().toISOString(),
      flow: "fast-path",
      gate_pass_rate: undefined,
      postcondition_pass_rate: undefined,
      run_id: "run-01",
      skipped_states: [],
      started: new Date(Date.now() - 60000).toISOString(),
      state_durations: {},
      state_iterations: {},
      task: "fix bug",
      tier: "small",
      total_duration_ms: 60000,
      total_files_changed: undefined,
      total_spawns: 1,
      total_test_results: undefined,
      total_violations: undefined,
    });

    // Write a FRESH lock (not stale) — simulates another learner running
    // Set mtime 5 minutes ago so (a) time gate passes (0 < 0h is always false so
    // no lock = skip, and 5min → ~0.08h which is >= 0h so time gate passes),
    // and (b) the lock is not stale (5min < 1h stale threshold).
    const lockPath = join(canonDir, "learn.lock");
    writeFileSync(lockPath, "99999");
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    await utimes(lockPath, new Date(), fiveMinAgo);
    // 5min ago → 0.08h, min_hours_since_last=0 → 0.08 >= 0 → time gate passes
    // 5min → stale check: 5min < 60min (lock_stale_after_hours=1h) → NOT stale

    const result = await evaluateLearnGate(projectDir);

    expect(result.passed).toBe(false);
    expect(result.reason).toBe("lock gate: already_locked");
  });
});
