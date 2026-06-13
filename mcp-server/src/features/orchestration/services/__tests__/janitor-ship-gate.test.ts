/**
 * Janitor service tests — isShipComplete helper + reclaim-gate integration.
 *
 * Split from janitor-prune-workspaces.test.ts to keep each file under 600 lines.
 * Covers the ship-gate logic added by finalize-fix-03:
 *   - isShipComplete() pure helper
 *   - reclaim-gate: workspace is reaped only after a completed ship step
 */

import { existsSync, utimesSync } from "node:fs";
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

vi.mock("@platform/adapters/git-adapter.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("@platform/adapters/git-adapter.ts")>();
  return {
    ...original,
    gitExec: vi.fn(),
  };
});

vi.mock("@platform/storage/archive/archive-service.ts", () => ({
  archiveWorkspace: vi.fn().mockResolvedValue({
    archive_path: "/tmp/archive",
    archived: true,
    manifest_entry: null,
    run_summary_generated: false,
  }),
}));

import { gitExec } from "@platform/adapters/git-adapter.ts";
// Import after mocks are set up
import { loadJanitorConfig } from "@shared/lib/config.ts";
import {
  acquireJanitorLock,
  commitJanitorLock,
  getLastJanitorTimestamp,
  releaseJanitorLock,
} from "@shared/lib/janitor-lock.ts";
import { isShipComplete, runJanitor } from "../janitor.ts";

const mockLoadJanitorConfig = loadJanitorConfig as ReturnType<typeof vi.fn>;
const mockAcquireJanitorLock = acquireJanitorLock as ReturnType<typeof vi.fn>;
const mockCommitJanitorLock = commitJanitorLock as ReturnType<typeof vi.fn>;
const mockReleaseJanitorLock = releaseJanitorLock as ReturnType<typeof vi.fn>;
const mockGetLastJanitorTimestamp = getLastJanitorTimestamp as ReturnType<typeof vi.fn>;
const mockGitExec = gitExec as ReturnType<typeof vi.fn>;

type GitResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  duration_ms: number;
};

function makeGitWorktreeListResult(lines: string[]): GitResult {
  return {
    duration_ms: 10,
    exitCode: 0,
    ok: true,
    stderr: "",
    stdout: `${lines.join("\n")}\n`,
    timedOut: false,
  };
}

/** Set the mtime of a path to a past timestamp (ms). */
function setMtime(p: string, ms: number): void {
  const secs = ms / 1000;
  utimesSync(p, secs, secs);
}

/** Create a journal.json at slugPath with the given steps (for ship-gate testing). */
async function writeJournal(
  slugPath: string,
  steps: Array<{ step_id: string; status: string }>,
): Promise<void> {
  await writeFile(
    join(slugPath, "journal.json"),
    JSON.stringify({ version: 1, workspace: slugPath, steps }),
  );
}

let tmpDir: string;
let canonDir: string;
let canonWorkspacesDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "janitor-ship-gate-test-"));
  canonDir = join(tmpDir, ".canon");
  canonWorkspacesDir = join(canonDir, "workspaces");
  await mkdir(canonDir, { recursive: true });

  mockLoadJanitorConfig.mockResolvedValue({
    enabled: true,
    max_abandoned_workspace_age_hours: null,
    min_hours_between_runs: 1,
  });
  mockGetLastJanitorTimestamp.mockResolvedValue(null);
  mockAcquireJanitorLock.mockResolvedValue({ acquired: true, previousMtime: null });
  mockCommitJanitorLock.mockResolvedValue(undefined);
  mockReleaseJanitorLock.mockResolvedValue(undefined);
  mockGitExec.mockReturnValue(makeGitWorktreeListResult([]));
});

afterEach(async () => {
  vi.clearAllMocks();
  await rm(tmpDir, { recursive: true });
});

// ─── isShipComplete — pure helper unit tests ─────────────────────────────────

describe("isShipComplete", () => {
  test("returns true when steps contain a completed ship step", () => {
    const steps = [
      { step_id: "implement", status: "completed" },
      { step_id: "ship", status: "completed" }, // finalize-04: literal "ship" pinned here
    ];
    expect(isShipComplete(steps)).toBe(true);
  });

  test("returns false when ship step is present but not completed (started)", () => {
    const steps = [
      { step_id: "implement", status: "completed" },
      { step_id: "ship", status: "started" },
    ];
    expect(isShipComplete(steps)).toBe(false);
  });

  test("returns false when ship step is absent", () => {
    const steps = [
      { step_id: "implement", status: "completed" },
      { step_id: "review", status: "completed" },
    ];
    expect(isShipComplete(steps)).toBe(false);
  });

  test("returns false for empty steps array", () => {
    expect(isShipComplete([])).toBe(false);
  });
});

// ─── Reclaim-gate: ship-completed journal signal (finalize-04) ───────────────
//
// A workspace is reclaim-eligible ONLY when:
//   (1) No .lock file (unchanged)
//   (2) journal.json has a completed "ship" step (new ship-gate)
//   (3) mtime > max_abandoned_workspace_age_hours (secondary buffer)
//
// Test (b) MUST fail if the ship-gate is removed (i.e. reverting to age-only).

const SHIP_GATE_AGE_HOURS = 24;

describe("reclaim-gate: ship-completed journal signal", () => {
  const configWithAge = {
    enabled: true,
    max_abandoned_workspace_age_hours: SHIP_GATE_AGE_HOURS,
    min_hours_between_runs: 1,
  };

  beforeEach(() => {
    mockLoadJanitorConfig.mockResolvedValue(configWithAge);
  });

  // (a) shipped + old + unlocked → REAPED
  test("(a) shipped + old + unlocked: workspace is reaped", async () => {
    const branchDir = join(canonWorkspacesDir, "main");
    const slugDir = join(branchDir, "shipped-old-build");
    await mkdir(slugDir, { recursive: true });

    // Journal has a completed ship step
    await writeJournal(slugDir, [
      { step_id: "implement", status: "completed" },
      { step_id: "ship", status: "completed" },
    ]);

    // Set mtime well past the age threshold (48h > 24h)
    setMtime(slugDir, Date.now() - 48 * 60 * 60 * 1000);

    const result = await runJanitor(tmpDir);

    expect(result.tasks.prune_workspaces.status).toBe("success");
    expect(existsSync(slugDir)).toBe(false);
  });

  // (b) in-flight (no completed ship step) + old → NOT reaped
  // CRITICAL: this test MUST fail if the ship-gate is removed (age-only reaping)
  test("(b) in-flight (no completed ship step) + old: workspace is NOT reaped", async () => {
    const branchDir = join(canonWorkspacesDir, "main");
    const slugDir = join(branchDir, "inflight-old-build");
    await mkdir(slugDir, { recursive: true });

    // Journal has implement completed but NO completed ship step
    await writeJournal(slugDir, [
      { step_id: "implement", status: "completed" },
      { step_id: "ship", status: "started" }, // ship not completed → in-flight
    ]);

    // Set mtime well past the age threshold (48h > 24h)
    setMtime(slugDir, Date.now() - 48 * 60 * 60 * 1000);

    const result = await runJanitor(tmpDir);

    // Must NOT be reaped — ship-gate protects in-flight builds
    expect(result.tasks.prune_workspaces.status).toBe("skipped");
    expect(existsSync(slugDir)).toBe(true);
  });

  // (c) shipped + locked → NOT reaped (.lock check unchanged)
  test("(c) shipped + locked: workspace is NOT reaped", async () => {
    const branchDir = join(canonWorkspacesDir, "main");
    const slugDir = join(branchDir, "shipped-locked-build");
    await mkdir(slugDir, { recursive: true });
    await writeFile(join(slugDir, ".lock"), "pid=9999");

    await writeJournal(slugDir, [{ step_id: "ship", status: "completed" }]);
    setMtime(slugDir, Date.now() - 48 * 60 * 60 * 1000);

    const result = await runJanitor(tmpDir);

    expect(result.tasks.prune_workspaces.status).toBe("skipped");
    expect(existsSync(slugDir)).toBe(true);
  });

  // (d) shipped + recent (under age threshold) → NOT reaped (age buffer holds)
  test("(d) shipped + recent: workspace is NOT reaped (age buffer)", async () => {
    const branchDir = join(canonWorkspacesDir, "main");
    const slugDir = join(branchDir, "shipped-recent-build");
    await mkdir(slugDir, { recursive: true });

    await writeJournal(slugDir, [{ step_id: "ship", status: "completed" }]);

    // Set mtime to only 1h ago (well under 24h threshold)
    setMtime(slugDir, Date.now() - 1 * 60 * 60 * 1000);

    const result = await runJanitor(tmpDir);

    expect(result.tasks.prune_workspaces.status).toBe("skipped");
    expect(existsSync(slugDir)).toBe(true);
  });

  // Fail-closed: no journal → not reaped
  test("absent journal → fail-closed (not reaped)", async () => {
    const branchDir = join(canonWorkspacesDir, "main");
    const slugDir = join(branchDir, "no-journal-build");
    await mkdir(slugDir, { recursive: true });
    // No journal.json written

    setMtime(slugDir, Date.now() - 48 * 60 * 60 * 1000);

    const result = await runJanitor(tmpDir);

    expect(result.tasks.prune_workspaces.status).toBe("skipped");
    expect(existsSync(slugDir)).toBe(true);
  });
});
