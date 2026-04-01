/**
 * Tests for update-board.ts
 *
 * Covers:
 * - enter_state: persists state as in_progress in execution_states
 * - skip_state: marks state as skipped, adds to skipped array
 * - block: sets blocked info on execution row
 * - unblock: clears blocked, sets state to in_progress
 * - complete_flow: marks current state done, updates session status, records flow run
 * - set_wave_progress: updates wave/wave_total/wave_results on state
 * - set_metadata: merges metadata on execution row
 * - No board.json or .lock file created
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearStoreCache, getExecutionStore } from "../orchestration/execution-store.ts";
import type { BoardStateStatus } from "../orchestration/flow-schema.ts";

// Mock analytics so appendFlowRun doesn't need drift.db during most tests
vi.mock("../drift/analytics.ts", () => ({
  appendFlowRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../orchestration/event-bus-instance.ts", () => ({
  flowEventBus: {
    emit: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock("../orchestration/events.ts", () => ({
  createJsonlLogger: vi.fn(() => vi.fn().mockResolvedValue(undefined)),
}));

import { appendFlowRun } from "../drift/analytics.ts";
import { updateBoard } from "../tools/update-board.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "update-board-test-"));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Seed a workspace with a minimal execution row + state rows.
 */
function seedWorkspace(
  workspace: string,
  overrides: {
    currentState?: string;
    states?: Record<string, { status: string; entries: number }>;
    blocked?: { state: string; reason: string; since: string } | null;
  } = {},
) {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();
  store.initExecution({
    flow: "test-flow",
    task: "test task",
    entry: "research",
    current_state: overrides.currentState ?? "research",
    base_commit: "abc123",
    started: now,
    last_updated: now,
    branch: "feat/test",
    sanitized: "feat-test",
    created: now,
    tier: "medium",
    flow_name: "test-flow",
    slug: "test-slug",
  });

  const states = overrides.states ?? {
    research: { status: "pending", entries: 0 },
    implement: { status: "pending", entries: 0 },
    done: { status: "pending", entries: 0 },
  };
  for (const [stateId, state] of Object.entries(states)) {
    store.upsertState(stateId, { status: state.status as BoardStateStatus, entries: state.entries });
  }

  return store;
}

afterEach(() => {
  clearStoreCache();

  for (const d of tmpDirs) {
    rmSync(d, { recursive: true, force: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("updateBoard — enter_state", () => {
  it("sets state to in_progress with entries=1", async () => {
    const workspace = makeTmpDir();
    const store = seedWorkspace(workspace);

    const result = await updateBoard({
      workspace,
      action: "enter_state",
      state_id: "research",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.board.states["research"].status).toBe("in_progress");
    expect(result.board.states["research"].entries).toBe(1);

    // Verify persisted in SQLite
    const state = store.getState("research");
    expect(state?.status).toBe("in_progress");
    expect(state?.entries).toBe(1);
  });

  it("updates current_state in execution row", async () => {
    const workspace = makeTmpDir();
    const store = seedWorkspace(workspace, { currentState: "research" });

    await updateBoard({
      workspace,
      action: "enter_state",
      state_id: "implement",
    });

    const exec = store.getExecution();
    expect(exec?.current_state).toBe("implement");
  });

  it("does not create board.json or .lock file", async () => {
    const workspace = makeTmpDir();
    seedWorkspace(workspace);

    await updateBoard({
      workspace,
      action: "enter_state",
      state_id: "research",
    });

    expect(existsSync(join(workspace, "board.json"))).toBe(false);
    expect(existsSync(join(workspace, ".lock"))).toBe(false);
  });

  it("returns INVALID_INPUT when state_id is not provided", async () => {
    const workspace = makeTmpDir();
    seedWorkspace(workspace);

    const result = await updateBoard({
      workspace,
      action: "enter_state",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("requires state_id");
    }
  });

  it("returns ok: true on success", async () => {
    const workspace = makeTmpDir();
    seedWorkspace(workspace);

    const result = await updateBoard({
      workspace,
      action: "enter_state",
      state_id: "research",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.board).toBeDefined();
    }
  });
});

describe("updateBoard — skip_state", () => {
  it("sets state to skipped and adds to skipped array", async () => {
    const workspace = makeTmpDir();
    const store = seedWorkspace(workspace);

    const result = await updateBoard({
      workspace,
      action: "skip_state",
      state_id: "research",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.board.states["research"].status).toBe("skipped");
    expect(result.board.skipped).toContain("research");

    const state = store.getState("research");
    expect(state?.status).toBe("skipped");
  });

  it("advances current_state when next_state_id is provided", async () => {
    const workspace = makeTmpDir();
    const store = seedWorkspace(workspace, { currentState: "research" });

    const result = await updateBoard({
      workspace,
      action: "skip_state",
      state_id: "research",
      next_state_id: "implement",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.board.current_state).toBe("implement");
    const exec = store.getExecution();
    expect(exec?.current_state).toBe("implement");
  });
});

describe("updateBoard — block", () => {
  it("sets blocked on execution row", async () => {
    const workspace = makeTmpDir();
    const store = seedWorkspace(workspace);

    const result = await updateBoard({
      workspace,
      action: "block",
      state_id: "research",
      blocked_reason: "External API is down",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.board.blocked).toBeDefined();
    expect(result.board.blocked!.state).toBe("research");
    expect(result.board.blocked!.reason).toBe("External API is down");

    const exec = store.getExecution();
    expect(exec?.blocked).toBeDefined();
    expect(exec?.blocked?.reason).toBe("External API is down");
  });

  it("returns INVALID_INPUT when state_id is not provided", async () => {
    const workspace = makeTmpDir();
    seedWorkspace(workspace);

    const result = await updateBoard({
      workspace,
      action: "block",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("requires state_id");
    }
  });
});

describe("updateBoard — unblock", () => {
  it("clears blocked and sets state to in_progress", async () => {
    const workspace = makeTmpDir();
    const store = seedWorkspace(workspace, {
      states: {
        research: { status: "blocked", entries: 1 },
        done: { status: "pending", entries: 0 },
      },
    });
    store.updateExecution({
      blocked: { state: "research", reason: "API down", since: new Date().toISOString() },
    });

    const result = await updateBoard({
      workspace,
      action: "unblock",
      state_id: "research",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.board.blocked).toBeNull();
    expect(result.board.states["research"].status).toBe("in_progress");

    const exec = store.getExecution();
    expect(exec?.blocked).toBeNull();
  });
});

describe("updateBoard — complete_flow", () => {
  it("sets current state to done and updates session status to completed", async () => {
    const workspace = makeTmpDir();
    const store = seedWorkspace(workspace, {
      currentState: "done",
      states: {
        research: { status: "done", entries: 1 },
        done: { status: "in_progress", entries: 1 },
      },
    });

    const result = await updateBoard({
      workspace,
      action: "complete_flow",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.board.states["done"].status).toBe("done");
    expect(result.board.states["done"].completed_at).toBeDefined();
    expect(result.board.blocked).toBeNull();

    // Session status updated in execution row
    const session = store.getSession();
    expect(session?.status).toBe("completed");
    expect(session?.completed_at).toBeDefined();
  });

  it("calls appendFlowRun (best-effort analytics)", async () => {
    const workspace = makeTmpDir();
    seedWorkspace(workspace, {
      currentState: "done",
      states: { done: { status: "in_progress", entries: 1 } },
    });

    await updateBoard({
      workspace,
      action: "complete_flow",
    });

    expect(appendFlowRun).toHaveBeenCalled();
  });
});

describe("updateBoard — set_wave_progress", () => {
  it("persists wave, wave_total, and wave_results on state", async () => {
    const workspace = makeTmpDir();
    const store = seedWorkspace(workspace);

    const result = await updateBoard({
      workspace,
      action: "set_wave_progress",
      state_id: "research",
      wave_data: { wave: 1, wave_total: 3, tasks: ["task-01", "task-02"] },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.board.states["research"].wave).toBe(1);
    expect(result.board.states["research"].wave_total).toBe(3);
    expect(result.board.states["research"].wave_results?.["wave_1"]).toBeDefined();

    const state = store.getState("research");
    expect(state?.wave).toBe(1);
    expect(state?.wave_total).toBe(3);
    expect(state?.wave_results?.["wave_1"].tasks).toEqual(["task-01", "task-02"]);
  });

  it("returns INVALID_INPUT when wave_data is not provided", async () => {
    const workspace = makeTmpDir();
    seedWorkspace(workspace);

    const result = await updateBoard({
      workspace,
      action: "set_wave_progress",
      state_id: "research",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("requires wave_data");
    }
  });

  it("persists worktree_entries when provided in wave_data", async () => {
    const workspace = makeTmpDir();
    const store = seedWorkspace(workspace);

    const worktreeEntries = [
      { task_id: "rwf-01", worktree_path: "/tmp/worktrees/rwf-01", branch: "feat/rwf-01", status: "active" as const },
      { task_id: "rwf-02", worktree_path: "/tmp/worktrees/rwf-02", branch: "feat/rwf-02", status: "merged" as const },
    ];

    const result = await updateBoard({
      workspace,
      action: "set_wave_progress",
      state_id: "research",
      wave_data: {
        wave: 1,
        wave_total: 2,
        tasks: ["rwf-01", "rwf-02"],
        worktree_entries: worktreeEntries,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const waveResult = result.board.states["research"].wave_results?.["wave_1"];
    expect(waveResult).toBeDefined();
    expect(waveResult!.worktree_entries).toHaveLength(2);
    expect(waveResult!.worktree_entries![0].task_id).toBe("rwf-01");
    expect(waveResult!.worktree_entries![1].status).toBe("merged");

    // Also verify persisted to SQLite
    const state = store.getState("research");
    expect(state?.wave_results?.["wave_1"].worktree_entries).toHaveLength(2);
  });

  it("does NOT include worktree_entries when omitted — backward compat", async () => {
    const workspace = makeTmpDir();
    seedWorkspace(workspace);

    const result = await updateBoard({
      workspace,
      action: "set_wave_progress",
      state_id: "research",
      wave_data: { wave: 1, wave_total: 3, tasks: ["task-01", "task-02"] },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const waveResult = result.board.states["research"].wave_results?.["wave_1"];
    expect(waveResult).toBeDefined();
    expect(waveResult!.worktree_entries).toBeUndefined();
  });
});

describe("updateBoard — set_metadata", () => {
  it("merges metadata on execution row", async () => {
    const workspace = makeTmpDir();
    const store = seedWorkspace(workspace);

    const result = await updateBoard({
      workspace,
      action: "set_metadata",
      metadata: { foo: "bar", count: 42 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.board.metadata?.["foo"]).toBe("bar");
    expect(result.board.metadata?.["count"]).toBe(42);

    const exec = store.getExecution();
    expect(exec?.metadata?.["foo"]).toBe("bar");
  });

  it("merges with existing metadata", async () => {
    const workspace = makeTmpDir();
    const store = seedWorkspace(workspace);
    store.updateExecution({ metadata: { existing: "value" } });

    const result = await updateBoard({
      workspace,
      action: "set_metadata",
      metadata: { new_key: "new_value" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.board.metadata?.["existing"]).toBe("value");
    expect(result.board.metadata?.["new_key"]).toBe("new_value");
  });

  it("returns INVALID_INPUT when metadata is not provided", async () => {
    const workspace = makeTmpDir();
    seedWorkspace(workspace);

    const result = await updateBoard({
      workspace,
      action: "set_metadata",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("requires metadata");
    }
  });
});

describe("updateBoard — error returns", () => {
  it("returns WORKSPACE_NOT_FOUND when workspace has no execution", async () => {
    const workspace = makeTmpDir();
    // Do NOT seed — no execution store for this workspace

    const result = await updateBoard({
      workspace,
      action: "enter_state",
      state_id: "research",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
      expect(result.message).toContain(workspace);
    }
  });
});

describe("updateBoard — timestamp consistency (item #8)", () => {
  it("enter_state: execution last_updated matches board last_updated", async () => {
    const workspace = makeTmpDir();
    const store = seedWorkspace(workspace);

    const result = await updateBoard({
      workspace,
      action: "enter_state",
      state_id: "research",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const exec = store.getExecution();
    // The execution row's last_updated must equal the board's last_updated
    expect(exec?.last_updated).toBe(result.board.last_updated);
  });

  it("skip_state: execution last_updated matches board last_updated", async () => {
    const workspace = makeTmpDir();
    const store = seedWorkspace(workspace);

    const result = await updateBoard({
      workspace,
      action: "skip_state",
      state_id: "research",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const exec = store.getExecution();
    expect(exec?.last_updated).toBe(result.board.last_updated);
  });

  it("block: execution last_updated matches board last_updated", async () => {
    const workspace = makeTmpDir();
    const store = seedWorkspace(workspace);

    const result = await updateBoard({
      workspace,
      action: "block",
      state_id: "research",
      blocked_reason: "test",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const exec = store.getExecution();
    expect(exec?.last_updated).toBe(result.board.last_updated);
  });

  it("unblock: execution last_updated matches board last_updated", async () => {
    const workspace = makeTmpDir();
    const store = seedWorkspace(workspace, {
      states: {
        research: { status: "blocked", entries: 1 },
        done: { status: "pending", entries: 0 },
      },
    });
    store.updateExecution({
      blocked: { state: "research", reason: "test", since: new Date().toISOString() },
    });

    const result = await updateBoard({
      workspace,
      action: "unblock",
      state_id: "research",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const exec = store.getExecution();
    expect(exec?.last_updated).toBe(result.board.last_updated);
  });

  it("set_wave_progress: execution last_updated matches board last_updated", async () => {
    const workspace = makeTmpDir();
    const store = seedWorkspace(workspace);

    const result = await updateBoard({
      workspace,
      action: "set_wave_progress",
      state_id: "research",
      wave_data: { wave: 1, wave_total: 2, tasks: ["t1"] },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const exec = store.getExecution();
    expect(exec?.last_updated).toBe(result.board.last_updated);
  });

  it("set_metadata: execution last_updated matches board last_updated", async () => {
    const workspace = makeTmpDir();
    const store = seedWorkspace(workspace);

    const result = await updateBoard({
      workspace,
      action: "set_metadata",
      metadata: { key: "value" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const exec = store.getExecution();
    expect(exec?.last_updated).toBe(result.board.last_updated);
  });
});
