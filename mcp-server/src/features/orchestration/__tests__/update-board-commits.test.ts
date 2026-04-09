/**
 * Tests for ADR-019 commit aggregation in handleCompleteFlow.
 *
 * Covers:
 * - handleCompleteFlow aggregates commits from multiple execution states
 * - handleCompleteFlow stores diff_stat on flow run
 * - handleCompleteFlow succeeds when no commits exist (backward compat)
 * - handleCompleteFlow succeeds when git diff fails (best-effort)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store.ts";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock analytics so appendFlowRun doesn't need drift.db
vi.mock("@platform/storage/drift/analytics.ts", () => ({
  appendFlowRun: vi.fn().mockResolvedValue(undefined),
}));

// Mock getDriftDb so FTS indexing doesn't fail in test environment
vi.mock("@platform/storage/drift/drift-db.ts", () => ({
  getDriftDb: vi.fn().mockReturnValue({
    indexHistoryEntry: vi.fn(),
  }),
}));

// Mock gitExec for diff_stat capture
vi.mock("@platform/adapters/git-adapter.ts", () => ({
  gitExec: vi
    .fn()
    .mockReturnValue({ duration_ms: 0, exitCode: 1, ok: false, stderr: "", stdout: "", timedOut: false }),
}));

vi.mock("@domains/messages/event-bus-instance.ts", () => ({
  flowEventBus: {
    emit: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock("@domains/messages/events.ts", () => ({
  createJsonlLogger: vi.fn(() => vi.fn().mockResolvedValue(undefined)),
}));

import { appendFlowRun } from "@platform/storage/drift/analytics.ts";
import { getDriftDb } from "@platform/storage/drift/drift-db.ts";
import { gitExec } from "@platform/adapters/git-adapter.ts";
import type { FlowRunEntry } from "@platform/storage/drift/analytics.ts";
import { updateBoard } from "../tools/update-board.ts";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "update-board-commits-test-"));
  tmpDirs.push(dir);
  return dir;
}

function seedWorkspace(workspace: string, currentState = "implement") {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();
  store.initExecution({
    base_commit: "base-sha-abc",
    branch: "feat/test",
    created: now,
    current_state: currentState,
    entry: "research",
    flow: "test-flow",
    flow_name: "test-flow",
    last_updated: now,
    sanitized: "feat-test",
    slug: "test-slug",
    started: now,
    task: "build feature X",
    tier: "medium",
  });

  store.upsertState("research", { entries: 1, status: "done" });
  store.upsertState(currentState, { entries: 1, status: "in_progress" });
  return store;
}

afterEach(() => {
  clearStoreCache();
  for (const d of tmpDirs) {
    rmSync(d, { force: true, recursive: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

describe("updateBoard complete_flow — commit aggregation (ADR-019)", () => {
  it("aggregates commits from multiple execution states into flow run", async () => {
    const workspace = makeTmpDir();
    const store = seedWorkspace(workspace);

    // Seed commits on two states
    store.updateStateCommits("research", {
      files_changed: ["src/a.ts"],
      shas: ["sha-research-1", "sha-research-2"],
    });
    store.updateStateCommits("implement", {
      files_changed: ["src/b.ts"],
      shas: ["sha-implement-1"],
    });

    const result = await updateBoard({
      action: "complete_flow",
      workspace,
    });

    expect(result.ok).toBe(true);
    expect(appendFlowRun).toHaveBeenCalledOnce();

    const call = vi.mocked(appendFlowRun).mock.calls[0];
    const flowRun = call[1] as FlowRunEntry;

    expect(flowRun.commits).toBeDefined();
    expect(flowRun.commits).toContain("sha-research-1");
    expect(flowRun.commits).toContain("sha-research-2");
    expect(flowRun.commits).toContain("sha-implement-1");
    // Deduplication — 3 unique SHAs
    expect(flowRun.commits).toHaveLength(3);
  });

  it("succeeds when no commits exist in any state (backward compat)", async () => {
    const workspace = makeTmpDir();
    seedWorkspace(workspace);
    // No commits seeded on any state

    const result = await updateBoard({
      action: "complete_flow",
      workspace,
    });

    expect(result.ok).toBe(true);
    expect(appendFlowRun).toHaveBeenCalledOnce();

    const call = vi.mocked(appendFlowRun).mock.calls[0];
    const flowRun = call[1] as FlowRunEntry;

    // commits should be absent (not set to empty array)
    expect(flowRun.commits).toBeUndefined();
  });

  it("stores diff_stat on flow run when git diff succeeds", async () => {
    const workspace = makeTmpDir();
    seedWorkspace(workspace);

    // Make gitExec return successful diff output
    vi.mocked(gitExec).mockReturnValue({
      duration_ms: 5,
      exitCode: 0,
      ok: true,
      stderr: "",
      stdout:
        " src/a.ts | 10 ++++++++++\n src/b.ts | 5 +++++\n 2 files changed, 15 insertions(+)",
      timedOut: false,
    });

    const result = await updateBoard({
      action: "complete_flow",
      workspace,
    });

    expect(result.ok).toBe(true);
    const flowRun = vi.mocked(appendFlowRun).mock.calls[0]?.[1] as FlowRunEntry;
    expect(flowRun.diff_stat).toBeDefined();
    expect(flowRun.diff_stat).toContain("src/a.ts");
    expect(flowRun.diff_stat).toContain("2 files changed");
  });

  it("succeeds without diff_stat when git diff fails (best-effort)", async () => {
    const workspace = makeTmpDir();
    seedWorkspace(workspace);

    // gitExec returns failure (default mock already returns ok: false)
    vi.mocked(gitExec).mockReturnValue({
      duration_ms: 0,
      exitCode: 128,
      ok: false,
      stderr: "fatal: not a git repository",
      stdout: "",
      timedOut: false,
    });

    const result = await updateBoard({
      action: "complete_flow",
      workspace,
    });

    // complete_flow should still succeed even when diff_stat capture fails
    expect(result.ok).toBe(true);
    const flowRun = vi.mocked(appendFlowRun).mock.calls[0]?.[1] as FlowRunEntry;
    expect(flowRun.diff_stat).toBeUndefined();
  });

  it("deduplicates commits across states", async () => {
    const workspace = makeTmpDir();
    const store = seedWorkspace(workspace);

    // Same SHA appears in both states (e.g. two tasks pointing to same merge commit)
    const duplicateSha = "sha-duplicate-abc";
    store.updateStateCommits("research", {
      files_changed: [],
      shas: [duplicateSha],
    });
    store.updateStateCommits("implement", {
      files_changed: [],
      shas: [duplicateSha, "sha-unique-xyz"],
    });

    await updateBoard({ action: "complete_flow", workspace });

    const flowRun = vi.mocked(appendFlowRun).mock.calls[0]?.[1] as FlowRunEntry;
    // Set deduplication: duplicate SHA should appear only once
    const uniqueCommits = new Set(flowRun.commits ?? []);
    expect(uniqueCommits.size).toBe(flowRun.commits?.length);
    expect(uniqueCommits.has(duplicateSha)).toBe(true);
    expect(uniqueCommits.has("sha-unique-xyz")).toBe(true);
  });

  it("indexes flow run in FTS5 via getDriftDb.indexHistoryEntry", async () => {
    const workspace = makeTmpDir();
    seedWorkspace(workspace);

    await updateBoard({ action: "complete_flow", workspace });

    expect(getDriftDb).toHaveBeenCalled();
    const mockDb = vi.mocked(getDriftDb).mock.results[0]?.value as {
      indexHistoryEntry: ReturnType<typeof vi.fn>;
    };
    expect(mockDb.indexHistoryEntry).toHaveBeenCalledWith(
      "flow_run",
      expect.stringMatching(/^run_/),
      expect.any(String),
    );
  });
});
