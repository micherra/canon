/**
 * learn-gate — unit tests for the gate evaluation module (ADR-016).
 *
 * Tests cover all 5 gates in cheapest-first order:
 *   1. Config (enabled flag)
 *   2. Time gate (min_hours_since_last)
 *   3. Scan throttle (learn-throttle file mtime)
 *   4. Flow gate (countFlowRunsSince)
 *   5. Lock gate (acquireLearnLock)
 *
 * Mocking strategy:
 *   - vi.mock for config, learn-lock, drift-db, and node:fs/promises
 *   - Each test controls exactly the mock state needed for its scenario
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// --- Module mocks (hoisted before imports by Vitest) ---

vi.mock("@shared/lib/config.ts", () => ({
  loadLearnGateConfig: vi.fn(),
}));

vi.mock("@shared/lib/learn-lock.ts", () => ({
  acquireLearnLock: vi.fn(),
  getLastLearnTimestamp: vi.fn(),
}));

vi.mock("@platform/storage/drift/drift-db.ts", () => ({
  getDriftDb: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  stat: vi.fn(),
  writeFile: vi.fn(),
}));

// --- Import after mocks ---

import { stat, writeFile } from "node:fs/promises";
import { getDriftDb } from "@platform/storage/drift/drift-db.ts";
import { loadLearnGateConfig } from "@shared/lib/config.ts";
import { acquireLearnLock, getLastLearnTimestamp } from "@shared/lib/learn-lock.ts";
import { evaluateLearnGate } from "../learn-gate.ts";

import type { LearnGateConfig } from "@shared/lib/config.ts";

// Helper: build a minimal LearnGateConfig
const makeConfig = (overrides: Partial<LearnGateConfig> = {}): LearnGateConfig => ({
  enabled: true,
  min_flows_since_last: 5,
  min_hours_since_last: 48,
  lock_stale_after_hours: 1,
  ...overrides,
});

const PROJECT_DIR = "/fake/project";
const CANON_DIR = `${PROJECT_DIR}/.canon`;

// Default mock implementations
const mockDriftDb = { countFlowRunsSince: vi.fn().mockReturnValue(10) };

beforeEach(() => {
  vi.resetAllMocks();

  // Default happy-path mocks
  vi.mocked(loadLearnGateConfig).mockResolvedValue(makeConfig());
  vi.mocked(getLastLearnTimestamp).mockResolvedValue(null); // no prior learn
  vi.mocked(stat).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })); // no throttle file
  vi.mocked(getDriftDb).mockReturnValue(mockDriftDb as any);
  mockDriftDb.countFlowRunsSince.mockReturnValue(10); // enough flows
  vi.mocked(acquireLearnLock).mockResolvedValue({ acquired: true, previousMtime: null });
  vi.mocked(writeFile).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("evaluateLearnGate — gate 1: config enabled flag", () => {
  test("returns passed: false when enabled is false", async () => {
    vi.mocked(loadLearnGateConfig).mockResolvedValue(makeConfig({ enabled: false }));

    const result = await evaluateLearnGate(PROJECT_DIR);

    expect(result.passed).toBe(false);
    expect(result.reason).toBe("auto-learn disabled");
    // Should not proceed to check timestamps
    expect(getLastLearnTimestamp).not.toHaveBeenCalled();
  });
});

describe("evaluateLearnGate — gate 2: time gate", () => {
  test("returns passed: false when last learn was too recent", async () => {
    // 2 hours ago — less than 48h threshold
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    vi.mocked(getLastLearnTimestamp).mockResolvedValue(twoHoursAgo);

    const result = await evaluateLearnGate(PROJECT_DIR);

    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/^time gate: 2\.0h < 48h$/);
    // Should not reach scan throttle
    expect(stat).not.toHaveBeenCalled();
  });

  test("skips time gate when no previous learn run (lastLearnTs is null)", async () => {
    vi.mocked(getLastLearnTimestamp).mockResolvedValue(null);
    // With enough flows and no throttle, should pass all gates
    const result = await evaluateLearnGate(PROJECT_DIR);
    expect(result.passed).toBe(true);
  });
});

describe("evaluateLearnGate — gate 3: scan throttle", () => {
  test("returns passed: false when throttle file was touched recently", async () => {
    const recentMs = Date.now() - 5 * 60 * 1000; // 5 minutes ago (< 10 min throttle)
    vi.mocked(stat).mockResolvedValue({
      mtime: new Date(recentMs),
    } as any);

    const result = await evaluateLearnGate(PROJECT_DIR);

    expect(result.passed).toBe(false);
    expect(result.reason).toBe("scan throttle: checked recently");
    // Should not reach flow gate DB query
    expect(getDriftDb).not.toHaveBeenCalled();
  });

  test("proceeds past throttle gate when throttle file is old enough", async () => {
    const elevenMinsAgo = Date.now() - 11 * 60 * 1000; // 11 minutes ago (> 10 min throttle)
    vi.mocked(stat).mockResolvedValue({
      mtime: new Date(elevenMinsAgo),
    } as any);

    const result = await evaluateLearnGate(PROJECT_DIR);
    expect(result.passed).toBe(true);
  });

  test("proceeds when throttle file does not exist (ENOENT)", async () => {
    vi.mocked(stat).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    const result = await evaluateLearnGate(PROJECT_DIR);
    expect(result.passed).toBe(true);
  });

  test("returns passed: false for unexpected stat errors (fail-closed, never blocks)", async () => {
    // Gate evaluation must never block flow completion — non-ENOENT errors return passed: false
    // rather than rethrowing (contradicts the old rethrow behavior documented in the docstring).
    vi.mocked(stat).mockRejectedValue(Object.assign(new Error("EPERM"), { code: "EPERM" }));

    const result = await evaluateLearnGate(PROJECT_DIR);
    expect(result.passed).toBe(false);
    expect(result.reason).toBe("scan throttle: stat error");
  });
});

describe("evaluateLearnGate — gate 4: flow gate", () => {
  test("returns passed: false when flow count is insufficient", async () => {
    mockDriftDb.countFlowRunsSince.mockReturnValue(2); // < 5 threshold

    const result = await evaluateLearnGate(PROJECT_DIR);

    expect(result.passed).toBe(false);
    expect(result.reason).toBe("flow gate: 2 < 5");
  });

  test("writes throttle marker when flow gate fails", async () => {
    mockDriftDb.countFlowRunsSince.mockReturnValue(0);

    await evaluateLearnGate(PROJECT_DIR);

    expect(writeFile).toHaveBeenCalledWith(
      `${CANON_DIR}/learn-throttle`,
      "",
      { flag: "w" },
    );
  });

  test("proceeds when throttle marker write fails (best-effort)", async () => {
    mockDriftDb.countFlowRunsSince.mockReturnValue(0);
    vi.mocked(writeFile).mockRejectedValue(new Error("disk full"));

    // Should NOT throw — writeFile failure is best-effort
    const result = await evaluateLearnGate(PROJECT_DIR);
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/flow gate/);
  });

  test("uses epoch ISO when no prior learn run for flow query", async () => {
    vi.mocked(getLastLearnTimestamp).mockResolvedValue(null);
    mockDriftDb.countFlowRunsSince.mockReturnValue(10);

    await evaluateLearnGate(PROJECT_DIR);

    expect(mockDriftDb.countFlowRunsSince).toHaveBeenCalledWith("1970-01-01T00:00:00.000Z");
  });

  test("uses last learn ISO when prior learn run exists", async () => {
    const ts = new Date("2026-01-01T00:00:00.000Z").getTime();
    vi.mocked(getLastLearnTimestamp).mockResolvedValue(ts);
    // Time gate: make it 100h ago so time gate passes
    vi.mocked(loadLearnGateConfig).mockResolvedValue(makeConfig({ min_hours_since_last: 0 }));
    mockDriftDb.countFlowRunsSince.mockReturnValue(10);

    await evaluateLearnGate(PROJECT_DIR);

    expect(mockDriftDb.countFlowRunsSince).toHaveBeenCalledWith("2026-01-01T00:00:00.000Z");
  });
});

describe("evaluateLearnGate — gate 5: lock gate", () => {
  test("returns passed: false when lock cannot be acquired (already_locked)", async () => {
    vi.mocked(acquireLearnLock).mockResolvedValue({
      acquired: false,
      reason: "already_locked",
    });

    const result = await evaluateLearnGate(PROJECT_DIR);

    expect(result.passed).toBe(false);
    expect(result.reason).toBe("lock gate: already_locked");
  });

  test("returns passed: false when lock cannot be acquired (stale_reclaim_failed)", async () => {
    vi.mocked(acquireLearnLock).mockResolvedValue({
      acquired: false,
      reason: "stale_reclaim_failed",
    });

    const result = await evaluateLearnGate(PROJECT_DIR);

    expect(result.passed).toBe(false);
    expect(result.reason).toBe("lock gate: stale_reclaim_failed");
  });

  test("passes correct staleAfterMs to acquireLearnLock", async () => {
    vi.mocked(loadLearnGateConfig).mockResolvedValue(makeConfig({ lock_stale_after_hours: 2 }));

    await evaluateLearnGate(PROJECT_DIR);

    expect(acquireLearnLock).toHaveBeenCalledWith(
      CANON_DIR,
      2 * 60 * 60 * 1000, // 2 hours in ms
    );
  });
});

describe("evaluateLearnGate — all gates pass", () => {
  test("returns passed: true when all gates pass", async () => {
    const result = await evaluateLearnGate(PROJECT_DIR);

    expect(result.passed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test("gate evaluation completes in under 100ms", async () => {
    const start = Date.now();
    await evaluateLearnGate(PROJECT_DIR);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
  });
});

describe("evaluateLearnGate — best-effort error handling", () => {
  test("unexpected error in config load propagates (not swallowed)", async () => {
    vi.mocked(loadLearnGateConfig).mockRejectedValue(new Error("config read failed"));

    // The gate itself throws — it's up to buildDoneSummary to catch it
    await expect(evaluateLearnGate(PROJECT_DIR)).rejects.toThrow("config read failed");
  });
});
