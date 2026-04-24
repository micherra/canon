/**
 * Janitor service tests
 *
 * Uses real temp directories for I/O correctness (SQLite, worktree detection).
 * Mocks loadJanitorConfig, acquireJanitorLock, commitJanitorLock, releaseJanitorLock,
 * and getLastJanitorTimestamp via vitest module mocking.
 */

import Database from "better-sqlite3";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// --- module mocks ---

vi.mock("@shared/lib/config.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("@shared/lib/config.ts")>();
  return {
    ...original,
    loadJanitorConfig: vi.fn(),
  };
});

vi.mock("@shared/lib/janitor-lock.ts", () => ({
  acquireJanitorLock: vi.fn(),
  commitJanitorLock: vi.fn(),
  getLastJanitorTimestamp: vi.fn(),
  releaseJanitorLock: vi.fn(),
}));

// Import after mocks are set up
import { loadJanitorConfig } from "@shared/lib/config.ts";
import {
  acquireJanitorLock,
  commitJanitorLock,
  getLastJanitorTimestamp,
  releaseJanitorLock,
} from "@shared/lib/janitor-lock.ts";
import { runJanitor } from "../janitor.ts";

const mockLoadJanitorConfig = loadJanitorConfig as ReturnType<typeof vi.fn>;
const mockAcquireJanitorLock = acquireJanitorLock as ReturnType<typeof vi.fn>;
const mockCommitJanitorLock = commitJanitorLock as ReturnType<typeof vi.fn>;
const mockReleaseJanitorLock = releaseJanitorLock as ReturnType<typeof vi.fn>;
const mockGetLastJanitorTimestamp = getLastJanitorTimestamp as ReturnType<typeof vi.fn>;

let tmpDir: string;
let canonDir: string;
let worktreesDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "janitor-test-"));
  canonDir = join(tmpDir, ".canon");
  worktreesDir = join(canonDir, "worktrees");
  await mkdir(canonDir, { recursive: true });

  // Default: janitor enabled, no recent run, lock acquired
  mockLoadJanitorConfig.mockResolvedValue({ enabled: true, min_hours_between_runs: 1 });
  mockGetLastJanitorTimestamp.mockResolvedValue(null);
  mockAcquireJanitorLock.mockResolvedValue({ acquired: true, previousMtime: null });
  mockCommitJanitorLock.mockResolvedValue(undefined);
  mockReleaseJanitorLock.mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.clearAllMocks();
  await rm(tmpDir, { recursive: true });
});

// --- Gate checks ---

describe("gate checks", () => {
  test("returns gate_passed: false when config disabled", async () => {
    mockLoadJanitorConfig.mockResolvedValue({ enabled: false, min_hours_between_runs: 1 });

    const result = await runJanitor(tmpDir);

    expect(result.gate_passed).toBe(false);
    expect(result.reason).toBe("janitor disabled");
    expect(result.tasks).toEqual({});
    expect(result.needs_prune).toBe(false);
    expect(mockAcquireJanitorLock).not.toHaveBeenCalled();
  });

  test("returns gate_passed: false when time gate not met", async () => {
    // Last run was 30 minutes ago, min is 1 hour
    const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
    mockGetLastJanitorTimestamp.mockResolvedValue(thirtyMinutesAgo);
    mockLoadJanitorConfig.mockResolvedValue({ enabled: true, min_hours_between_runs: 1 });

    const result = await runJanitor(tmpDir);

    expect(result.gate_passed).toBe(false);
    expect(result.reason).toMatch(/^time gate:/);
    expect(result.reason).toContain("< 1h");
    expect(mockAcquireJanitorLock).not.toHaveBeenCalled();
  });

  test("returns gate_passed: false when lock not acquired", async () => {
    mockAcquireJanitorLock.mockResolvedValue({ acquired: false, reason: "already_locked" });

    const result = await runJanitor(tmpDir);

    expect(result.gate_passed).toBe(false);
    expect(result.reason).toBe("lock: already_locked");
    expect(result.tasks).toEqual({});
  });
});

// --- WAL checkpoint task ---

describe("wal_checkpoint task", () => {
  test("checkpoints WAL files that exist", async () => {
    // Create a real SQLite DB in WAL mode
    const dbPath = join(canonDir, "knowledge-graph.db");
    const db = new Database(dbPath);
    db.pragma("journal_mode=WAL");
    db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY)");
    db.close();

    // Verify WAL file was created
    const walPath = dbPath + "-wal";
    // Force WAL file to exist by writing something
    await writeFile(walPath, "");

    const result = await runJanitor(tmpDir);

    expect(result.gate_passed).toBe(true);
    expect(result.tasks["wal_checkpoint"]).toBeDefined();
    expect(result.tasks["wal_checkpoint"].status).toBe("success");
  });

  test("skips WAL checkpoint for databases without WAL files", async () => {
    // knowledge-graph.db does not exist → no checkpoint
    const result = await runJanitor(tmpDir);

    expect(result.gate_passed).toBe(true);
    expect(result.tasks["wal_checkpoint"]).toBeDefined();
    expect(result.tasks["wal_checkpoint"].status).toBe("success");
    // No error since skipping is expected behavior
  });

  test("reports error for corrupt/inaccessible database files", async () => {
    // Create a DB file that exists but has a WAL file too
    const dbPath = join(canonDir, "knowledge-graph.db");
    const walPath = dbPath + "-wal";
    // Write corrupt content to the DB
    await writeFile(dbPath, "this is not a valid sqlite database");
    await writeFile(walPath, "");

    const result = await runJanitor(tmpDir);

    expect(result.gate_passed).toBe(true);
    expect(result.tasks["wal_checkpoint"]).toBeDefined();
    expect(result.tasks["wal_checkpoint"].status).toBe("error");
    expect(result.tasks["wal_checkpoint"].detail).toBeDefined();
  });
});

// --- Prune detection ---

describe("prune detection", () => {
  test("sets needs_prune: true when worktrees directory is non-empty", async () => {
    await mkdir(worktreesDir, { recursive: true });
    await mkdir(join(worktreesDir, "some-worktree"));

    const result = await runJanitor(tmpDir);

    expect(result.needs_prune).toBe(true);
  });

  test("sets needs_prune: false when worktrees directory is empty", async () => {
    await mkdir(worktreesDir, { recursive: true });

    const result = await runJanitor(tmpDir);

    expect(result.needs_prune).toBe(false);
  });

  test("sets needs_prune: false when worktrees directory is missing", async () => {
    // worktreesDir does not exist

    const result = await runJanitor(tmpDir);

    expect(result.needs_prune).toBe(false);
  });
});

// --- Lock lifecycle ---

describe("lock lifecycle", () => {
  test("releases lock after successful completion", async () => {
    const result = await runJanitor(tmpDir);

    expect(result.gate_passed).toBe(true);
    expect(mockCommitJanitorLock).toHaveBeenCalledTimes(1);
    expect(mockReleaseJanitorLock).toHaveBeenCalledTimes(1);
  });

  test("releases lock even on unexpected error", async () => {
    // Force an error in the WAL checkpoint by making readdirSync throw
    const dbPath = join(canonDir, "knowledge-graph.db");
    const walPath = dbPath + "-wal";
    await writeFile(dbPath, "corrupt");
    await writeFile(walPath, "");

    // Even with DB error, lock should be released
    const result = await runJanitor(tmpDir);

    // The WAL task errors but lock is still released
    expect(mockReleaseJanitorLock).toHaveBeenCalledTimes(1);
    expect(result.gate_passed).toBe(true);
  });

  test("releases lock when unexpected top-level error occurs", async () => {
    // Make commitJanitorLock throw to simulate unexpected error after tasks
    mockCommitJanitorLock.mockRejectedValue(new Error("disk full"));

    const result = await runJanitor(tmpDir);

    // Should still release lock
    expect(mockReleaseJanitorLock).toHaveBeenCalledTimes(1);
    // Returns error result
    expect(result.tasks["unexpected_error"]).toBeDefined();
    expect(result.tasks["unexpected_error"].status).toBe("error");
  });
});
