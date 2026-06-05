/**
 * JobManager per-project map characterization tests (sug_JJJJ1 / sug_UUUU5).
 *
 * Split into a sibling file (not a barrel — sug_UUUU2) to keep
 * job-manager.test.ts under the noExcessiveLinesPerFile cap.
 *
 * Proves the session-isolation invariants of the per-project Map that replaced
 * the module-level singleton:
 *   - distinct projectDirs -> distinct managers (cross-project leak closed);
 *   - same projectDir -> identical manager (the stdio single-scope no-op);
 *   - getJobManager is a non-creating, resolved-path-keyed lookup;
 *   - reset / cleanupAll iterate every per-project manager.
 *
 * Mocks the job-adapter, fingerprint, env, and pipeline modules so no real
 * child processes are spawned and no git calls are made (mirrors
 * job-manager.test.ts).
 */

import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocks — must be declared before importing the module under test.

vi.mock("../job-fingerprint.ts", () => ({
  computeJobFingerprint: vi.fn().mockResolvedValue("mock-fingerprint-abc123"),
}));

vi.mock("@platform/adapters/job-adapter.ts", () => ({
  forkJob: vi.fn(),
  killJob: vi.fn(),
  sendWorkerInput: vi.fn(),
}));

vi.mock("@shared/lib/env.ts", () => ({
  isSyncMode: vi.fn().mockReturnValue(false),
}));

vi.mock("@graph/kg-pipeline.ts", () => ({
  runPipeline: vi.fn().mockResolvedValue({
    durationMs: 1000,
    edgesTotal: 300,
    entitiesTotal: 200,
    filesScanned: 42,
    filesUpdated: 10,
  }),
}));

import {
  _resetJobManagerSingleton,
  cleanupAllJobManagers,
  getJobManager,
  getOrCreateJobManager,
  JobManager,
} from "../job-manager.ts";

async function makeScopeDir(prefix: string): Promise<string> {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  const { mkdirSync } = await import("node:fs");
  mkdirSync(path.join(tmpDir, ".canon"), { recursive: true });
  return tmpDir;
}

describe("JobManager per-project map", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetJobManagerSingleton();
  });

  afterEach(() => {
    _resetJobManagerSingleton();
  });

  it("distinct project dirs yield distinct JobManager instances (cross-project leak closed)", async () => {
    const dirA = await makeScopeDir("jm-map-a-");
    const dirB = await makeScopeDir("jm-map-b-");

    const mA = await getOrCreateJobManager(dirA, "/fake/plugin");
    const mB = await getOrCreateJobManager(dirB, "/fake/plugin");

    expect(mA).not.toBe(mB);
  });

  it("same project dir yields the identical instance (stdio single-scope no-op invariant)", async () => {
    const dir = await makeScopeDir("jm-map-same-");

    const m1 = await getOrCreateJobManager(dir, "/fake/plugin");
    const m2 = await getOrCreateJobManager(dir, "/fake/plugin");

    expect(m1).toBe(m2);
  });

  it("getJobManager returns undefined before create and the same instance after create", async () => {
    const dir = await makeScopeDir("jm-map-lookup-");

    expect(getJobManager(dir)).toBeUndefined();

    const created = await getOrCreateJobManager(dir, "/fake/plugin");
    expect(getJobManager(dir)).toBe(created);
  });

  it("getJobManager keys by resolved path (non-canonical input resolves to the same instance)", async () => {
    const dir = await makeScopeDir("jm-map-resolve-");

    const created = await getOrCreateJobManager(dir, "/fake/plugin");
    // A non-normalized variant of the same dir must resolve to the same key.
    expect(getJobManager(path.join(dir, ".", "."))).toBe(created);
  });

  it("_resetJobManagerSingleton clears the map (lookup undefined afterward)", async () => {
    const dir = await makeScopeDir("jm-map-reset-");

    await getOrCreateJobManager(dir, "/fake/plugin");
    expect(getJobManager(dir)).toBeInstanceOf(JobManager);

    _resetJobManagerSingleton();
    expect(getJobManager(dir)).toBeUndefined();
  });

  it("cleanupAllJobManagers cleans every per-project manager without throwing", async () => {
    const dirA = await makeScopeDir("jm-map-cleanup-a-");
    const dirB = await makeScopeDir("jm-map-cleanup-b-");

    const mA = await getOrCreateJobManager(dirA, "/fake/plugin");
    const mB = await getOrCreateJobManager(dirB, "/fake/plugin");
    const spyA = vi.spyOn(mA, "cleanup");
    const spyB = vi.spyOn(mB, "cleanup");

    expect(() => cleanupAllJobManagers()).not.toThrow();
    expect(spyA).toHaveBeenCalledTimes(1);
    expect(spyB).toHaveBeenCalledTimes(1);
  });
});
