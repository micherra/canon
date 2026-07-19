/**
 * registry-lifecycle.test.ts — the two-session integration test for the
 * project-level active-workspaces registry (Inc 0, sub-part B lifecycle wiring).
 *
 * Scenario (per the Inc 0 plan):
 *   session A init_workspace registers a `live` row
 *   -> session B list_active_workspaces discovers it (path/slug/status), no pasted path
 *   -> B post_message to A's workspace
 *   -> A tail_messages sees it incrementally, with peer_lock populated
 *   -> finalize_workspace transitions the row to finalized_on_disk (post still allowed)
 *   -> simulated reap (markReaped) -> post_message now rejected
 *
 * Also covers: registry writes are fail-open — a forced DAO throw at any of the
 * three lifecycle call sites (init/finalize/janitor) never breaks the underlying
 * build flow. And the real janitor reap path (not simulated) transitions the row
 * to 'reaped' after a successful rmSync.
 */

import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Wrap the real getDriftDb so most tests use real behavior, but individual
// fail-open tests can force a single throw via mockImplementationOnce.
vi.mock("@platform/storage/drift/drift-db-cache.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@platform/storage/drift/drift-db-cache.ts")>();
  return {
    ...original,
    getDriftDb: vi.fn(original.getDriftDb),
  };
});

vi.mock("@shared/lib/config.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("@shared/lib/config.ts")>();
  return {
    ...original,
    loadJanitorConfig: vi.fn(),
  };
});

vi.mock("@shared/lib/janitor-lock.ts", () => ({
  acquireJanitorLock: vi.fn().mockResolvedValue({ acquired: true, previousMtime: null }),
  commitJanitorLock: vi.fn().mockResolvedValue(undefined),
  getLastJanitorTimestamp: vi.fn().mockResolvedValue(null),
  releaseJanitorLock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@platform/adapters/git-adapter.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("@platform/adapters/git-adapter.ts")>();
  return {
    ...original,
    gitExec: vi.fn().mockReturnValue({
      duration_ms: 5,
      exitCode: 0,
      ok: true,
      stderr: "",
      stdout: "",
      timedOut: false,
    }),
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

import { clearStoreCache } from "@domains/workspaces/execution-store-cache.ts";
import { gitExec } from "@platform/adapters/git-adapter.ts";
import { archiveWorkspace } from "@platform/storage/archive/archive-service.ts";
import { evictDriftDbForScope, getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import { loadJanitorConfig } from "@shared/lib/config.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { initGitFixtureRepo } from "../../../tests/git-fixture.ts";
import { runJanitor } from "../services/janitor.ts";
import { acquireLock } from "../services/workspace-lock.ts";
import { initWorkspaceFlow } from "../tools/init-workspace.ts";
import { listActiveWorkspaces } from "../tools/list-active-workspaces.ts";
import { finalizeWorkspace, logStep } from "../tools/orchestration-journal.ts";
import { postMessage } from "../tools/post-message.ts";
import { tailMessages } from "../tools/tail-messages.ts";

const mockGetDriftDb = getDriftDb as unknown as ReturnType<typeof vi.fn>;
const mockLoadJanitorConfig = loadJanitorConfig as ReturnType<typeof vi.fn>;
const mockGitExec = gitExec as ReturnType<typeof vi.fn>;
const mockArchiveWorkspace = archiveWorkspace as ReturnType<typeof vi.fn>;

let tmpDirs: string[] = [];

function makeTmpProjectDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) {
    evictDriftDbForScope(dir);
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

const baseInput = {
  base_commit: "abc1234",
  branch: "test-branch",
  flow_name: "test-flow",
  task: "registry lifecycle test task",
  tier: "small" as const,
};

/** Seed a workspace with a single completed step + artifact so finalize marks it complete. */
async function seedCompletedJournal(workspace: string, projectDir: string): Promise<void> {
  const artifactPath = join(workspace, "plans", "DESIGN.md");
  await mkdir(join(workspace, "plans"), { recursive: true });
  writeFileSync(artifactPath, "# Design\n");
  await logStep({
    agent_id: "test-agent",
    artifacts_expected: ["plans/DESIGN.md"],
    status: "completed",
    step_id: "design",
    workspace,
    projectDir,
  });
}

describe("registry lifecycle — two-session integration", () => {
  it("init registers live -> discover -> chat -> finalize -> simulated reap -> rejected", async () => {
    const projectDir = makeTmpProjectDir("registry-lifecycle-proj-");
    const baseCommit = initGitFixtureRepo(projectDir);

    // Session A: init_workspace registers a live row.
    const initResult = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit, session_id: "session-A", job_id: "job-A" },
      projectDir,
      "/fake/plugin",
    );
    assertOk(initResult);
    expect(initResult.created).toBe(true);
    const workspace = initResult.workspace;

    const liveRow = getDriftDb(projectDir).getActiveWorkspaces().getByPath(workspace);
    expect(liveRow?.status).toBe("live");

    // Session B: discovers A's build via list_active_workspaces — no pasted path.
    const discovered = await listActiveWorkspaces({}, projectDir);
    expect(discovered.ok).toBe(true);
    if (!discovered.ok) return;
    expect(discovered.workspaces).toHaveLength(1);
    expect(discovered.workspaces[0].workspace_path).toBe(workspace);
    expect(discovered.workspaces[0].status).toBe("live");
    const discoveredPath = discovered.workspaces[0].workspace_path;

    // Session B posts to A's workspace using only the discovered path.
    const posted = await postMessage(
      { content: "hey A, session B here", sender: "session-B", workspace: discoveredPath },
      projectDir,
    );
    expect(posted.ok).toBe(true);

    // Session A holds the lock (already true post-init) and tails: sees the
    // message incrementally, with peer_lock populated.
    acquireLock(workspace, { job_id: "job-A", session_id: "session-A" });
    const tailed = await tailMessages({ workspace }, projectDir);
    expect(tailed.ok).toBe(true);
    if (!tailed.ok) return;
    expect(tailed.messages).toHaveLength(1);
    expect(tailed.messages[0].sender).toBe("session-B");
    expect(tailed.peer_lock).not.toBeNull();
    expect(tailed.peer_lock?.session_id).toBe("session-A");

    // finalize_workspace transitions the row to finalized_on_disk.
    await seedCompletedJournal(workspace, projectDir);
    const finalizeResult = await finalizeWorkspace({
      projectDir,
      session_id: "session-A",
      workspace,
    });
    expect(finalizeResult.ok).toBe(true);

    const finalizedRow = getDriftDb(projectDir).getActiveWorkspaces().getByPath(workspace);
    expect(finalizedRow?.status).toBe("finalized_on_disk");

    // Post still allowed after finalize (finalized_on_disk is a readable/writable state).
    const postedAfterFinalize = await postMessage(
      { content: "still here after finalize", sender: "session-B", workspace },
      projectDir,
    );
    expect(postedAfterFinalize.ok).toBe(true);

    // Simulated reap.
    getDriftDb(projectDir).getActiveWorkspaces().markReaped(workspace);

    const rejectedPost = await postMessage(
      { content: "too late", sender: "session-B", workspace },
      projectDir,
    );
    expect(rejectedPost.ok).toBe(false);
    if (!rejectedPost.ok) {
      expect(rejectedPost.error_code).toBe("WORKSPACE_NOT_FOUND");
    }
  });
});

describe("registry lifecycle — fail-open lifecycle writes", () => {
  it("init_workspace succeeds even when the registry register() throws", async () => {
    const projectDir = makeTmpProjectDir("registry-lifecycle-failopen-init-");
    const baseCommit = initGitFixtureRepo(projectDir);
    mockGetDriftDb.mockImplementationOnce(() => {
      throw new Error("simulated drift.db failure");
    });
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit, session_id: "session-A", job_id: "job-A" },
      projectDir,
      "/fake/plugin",
    );
    assertOk(result);

    expect(result.created).toBe(true);
    expect(result.workspace).toBeTruthy();
    expect(existsSync(result.workspace)).toBe(true);
    expect(consoleWarnSpy).toHaveBeenCalled();
    consoleWarnSpy.mockRestore();
  });

  it("finalize_workspace succeeds even when the registry markFinalized() throws", async () => {
    const projectDir = makeTmpProjectDir("registry-lifecycle-failopen-finalize-");
    const baseCommit = initGitFixtureRepo(projectDir);

    const initResult = await initWorkspaceFlow(
      { ...baseInput, base_commit: baseCommit, session_id: "session-A", job_id: "job-A" },
      projectDir,
      "/fake/plugin",
    );
    assertOk(initResult);
    const workspace = initResult.workspace;
    await seedCompletedJournal(workspace, projectDir);

    mockGetDriftDb.mockImplementationOnce(() => {
      throw new Error("simulated drift.db failure");
    });
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await finalizeWorkspace({
      projectDir,
      session_id: "session-A",
      workspace,
    });

    expect(result.ok).toBe(true);
    expect(consoleWarnSpy).toHaveBeenCalled();
    consoleWarnSpy.mockRestore();
  });
});

describe("registry lifecycle — real janitor reap wiring", () => {
  it("transitions the registry row to reaped after a successful janitor prune (rmSync)", async () => {
    const projectDir = makeTmpProjectDir("registry-lifecycle-janitor-");
    const canonWorkspacesDir = join(projectDir, ".canon", "workspaces");
    const branchDir = join(canonWorkspacesDir, "main");
    const slugDir = join(branchDir, "stale-build");
    await mkdir(slugDir, { recursive: true });
    await writeFile(
      join(slugDir, "journal.json"),
      JSON.stringify({
        steps: [{ status: "completed", step_id: "ship" }],
        version: 1,
        workspace: slugDir,
      }),
    );
    const secs = (Date.now() - 72 * 60 * 60 * 1000) / 1000;
    utimesSync(slugDir, secs, secs);

    getDriftDb(projectDir)
      .getActiveWorkspaces()
      .register({ slug: "stale-build", workspace_path: slugDir });

    mockLoadJanitorConfig.mockResolvedValue({
      enabled: true,
      max_abandoned_workspace_age_hours: 48,
      min_hours_between_runs: 1,
    });
    mockGitExec.mockReturnValue({
      duration_ms: 5,
      exitCode: 0,
      ok: true,
      stderr: "",
      stdout: "\n",
      timedOut: false,
    });

    const result = await runJanitor(projectDir);

    expect(result.tasks.prune_workspaces.status).toBe("success");
    expect(existsSync(slugDir)).toBe(false);
    expect(mockArchiveWorkspace).toHaveBeenCalled();

    const row = getDriftDb(projectDir).getActiveWorkspaces().getByPath(slugDir);
    expect(row?.status).toBe("reaped");
  });

  it("janitor prune still succeeds even when the registry markReaped() throws", async () => {
    const projectDir = makeTmpProjectDir("registry-lifecycle-janitor-failopen-");
    const canonWorkspacesDir = join(projectDir, ".canon", "workspaces");
    const branchDir = join(canonWorkspacesDir, "main");
    const slugDir = join(branchDir, "stale-build-2");
    await mkdir(slugDir, { recursive: true });
    await writeFile(
      join(slugDir, "journal.json"),
      JSON.stringify({
        steps: [{ status: "completed", step_id: "ship" }],
        version: 1,
        workspace: slugDir,
      }),
    );
    const secs = (Date.now() - 72 * 60 * 60 * 1000) / 1000;
    utimesSync(slugDir, secs, secs);

    mockLoadJanitorConfig.mockResolvedValue({
      enabled: true,
      max_abandoned_workspace_age_hours: 48,
      min_hours_between_runs: 1,
    });
    mockGitExec.mockReturnValue({
      duration_ms: 5,
      exitCode: 0,
      ok: true,
      stderr: "",
      stdout: "\n",
      timedOut: false,
    });
    mockGetDriftDb.mockImplementationOnce(() => {
      throw new Error("simulated drift.db failure");
    });
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await runJanitor(projectDir);

    expect(result.tasks.prune_workspaces.status).toBe("success");
    expect(existsSync(slugDir)).toBe(false);
    expect(consoleWarnSpy).toHaveBeenCalled();
    consoleWarnSpy.mockRestore();
  });
});
