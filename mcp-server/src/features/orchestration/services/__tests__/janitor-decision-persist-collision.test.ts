/**
 * Janitor reap-time decision-persist tests — branch-qualified source identity.
 *
 * `checkSlugCollision`-style slug generation is branch-scoped, so two
 * DIFFERENT branches running the same task can legitimately produce the SAME
 * generated slug. Before this fix, the reap-time persist wrote the bare slug
 * as `source_slug`, and event ids restart at 1 in every fresh orchestration.db
 * — so the second same-slug workspace reaped would collide with the first on
 * the `orchestrator_decisions` UNIQUE(source_slug, source_event_id) constraint
 * and its decisions would be silently dropped by INSERT OR IGNORE.
 *
 * Split from janitor-prune-workspaces.test.ts to keep files under 600 lines.
 */

import { utimesSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// --- module mocks (mirrors janitor-prune-workspaces.test.ts) ---

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
const mockGitExec = gitExec as ReturnType<typeof vi.fn>;

function makeGitWorktreeListResult() {
  return { duration_ms: 10, exitCode: 0, ok: true, stderr: "", stdout: "\n", timedOut: false };
}

function setMtime(p: string, ms: number): void {
  const secs = ms / 1000;
  utimesSync(p, secs, secs);
}

async function writeJournal(
  slugPath: string,
  steps: Array<{ step_id: string; status: string }>,
): Promise<void> {
  await writeFile(
    join(slugPath, "journal.json"),
    JSON.stringify({ version: 1, workspace: slugPath, steps }),
  );
}

/** Seed a workspace slug dir with a single orchestrator_decision event at event_id 1. */
async function seedReapableWorkspace(
  slugDir: string,
  summary: string,
  ageMs: number,
): Promise<void> {
  await mkdir(slugDir, { recursive: true });
  await writeJournal(slugDir, [{ step_id: "ship", status: "completed" }]);
  const store = getExecutionStore(slugDir);
  store.appendEvent("orchestrator_decision", {
    decision_type: "scope_cut",
    summary,
    timestamp: new Date().toISOString(),
  });
  setMtime(slugDir, Date.now() - ageMs);
}

let tmpDir: string;
let canonWorkspacesDir: string;

const ABANDONED_AGE_HOURS = 48;
const ABANDONED_AGE_MS = ABANDONED_AGE_HOURS * 60 * 60 * 1000;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "janitor-decision-collision-"));
  const canonDir = join(tmpDir, ".canon");
  canonWorkspacesDir = join(canonDir, "workspaces");
  await mkdir(canonDir, { recursive: true });

  mockLoadJanitorConfig.mockResolvedValue({
    enabled: true,
    max_abandoned_workspace_age_hours: ABANDONED_AGE_HOURS,
    min_hours_between_runs: 1,
  });
  mockGetLastJanitorTimestamp.mockResolvedValue(null);
  mockAcquireJanitorLock.mockResolvedValue({ acquired: true, previousMtime: null });
  mockCommitJanitorLock.mockResolvedValue(undefined);
  mockReleaseJanitorLock.mockResolvedValue(undefined);
  mockGitExec.mockReturnValue(makeGitWorktreeListResult());
});

afterEach(async () => {
  vi.clearAllMocks();
  await rm(tmpDir, { recursive: true });
});

describe("janitor reap-time decision persist — cross-branch slug collision", () => {
  test("persists BOTH workspaces' decisions when two different branches reap the same slug", async () => {
    const branchA = join(canonWorkspacesDir, "main");
    const branchB = join(canonWorkspacesDir, "feat--other");
    const slugA = join(branchA, "same-slug");
    const slugB = join(branchB, "same-slug");

    await seedReapableWorkspace(slugA, "Decision from main", ABANDONED_AGE_MS + 1000);
    await seedReapableWorkspace(slugB, "Decision from feat--other", ABANDONED_AGE_MS + 1000);

    const result = await runJanitor(tmpDir);

    expect(result.tasks.prune_workspaces.status).toBe("success");
    expect(result.tasks.prune_workspaces.detail).toContain("2");

    const persisted = getDriftDb(tmpDir).getOrchestratorDecisions().getAll();
    const summaries = persisted.map((p) => p.summary);
    expect(summaries).toContain("Decision from main");
    expect(summaries).toContain("Decision from feat--other");
    expect(persisted).toHaveLength(2);
  });
});
