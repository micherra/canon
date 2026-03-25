/**
 * Refactoring verification tests — coverage gaps for the following fixes:
 *
 * 1. flow-parser.ts — path traversal validation on flow name
 * 2. wave-variables.ts — cwd passed to git spawnSync
 * 3. update-board.ts — once() listener cleanup (no leak)
 * 4. report-result.ts — once() listener cleanup on enter_state sub-event
 *
 * These tests verify the contract of the refactoring without coupling
 * to internal implementation details.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Hoist spawnSync mock so vitest can use it before module imports
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({
    status: 0,
    stdout: "",
    stderr: "",
    pid: 1,
    output: [],
    signal: null,
    error: undefined,
  })),
}));

import { spawnSync } from "node:child_process";
import { loadAndResolveFlow } from "../orchestration/flow-parser.ts";
import { resolveWaveVariables } from "../orchestration/wave-variables.ts";
import { updateBoard } from "../tools/update-board.ts";
import { reportResult } from "../tools/report-result.ts";
import { flowEventBus } from "../orchestration/event-bus-instance.ts";
import { writeBoard, initBoard } from "../orchestration/board.ts";
import { mkdir, writeFile } from "node:fs/promises";
import type { ResolvedFlow } from "../orchestration/flow-schema.ts";

const mockSpawnSync = vi.mocked(spawnSync);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "refactor-verify-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
  flowEventBus.removeAllListeners();
  vi.clearAllMocks();
});

function makeMinimalFlow(overrides?: Partial<ResolvedFlow>): ResolvedFlow {
  return {
    name: "test-flow",
    description: "A test flow",
    entry: "build",
    spawn_instructions: {},
    states: {
      build: {
        type: "single",
        transitions: { done: "ship" },
      },
      ship: { type: "terminal" },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fix 4: flow-parser.ts — path traversal validation on flow name
// ---------------------------------------------------------------------------

describe("loadAndResolveFlow — flow name path traversal validation", () => {
  it("rejects flow names containing path separators (forward slash)", async () => {
    await expect(
      loadAndResolveFlow("/some/dir", "../../etc/passwd"),
    ).rejects.toThrow(/invalid flow name/i);
  });

  it("rejects flow names containing path separators (back slash)", async () => {
    await expect(
      loadAndResolveFlow("/some/dir", "..\\..\\secret"),
    ).rejects.toThrow(/invalid flow name/i);
  });

  it("rejects flow names with spaces", async () => {
    await expect(
      loadAndResolveFlow("/some/dir", "my flow"),
    ).rejects.toThrow(/invalid flow name/i);
  });

  it("rejects flow names with dot extensions that could traverse", async () => {
    await expect(
      loadAndResolveFlow("/some/dir", "flow.md"),
    ).rejects.toThrow(/invalid flow name/i);
  });

  it("accepts valid alphanumeric flow names with hyphens and underscores", async () => {
    // Validation passes — the error will be a file-not-found, not a validation error.
    // We confirm the error is NOT "invalid flow name".
    const err = await loadAndResolveFlow("/nonexistent/dir", "review-only").catch(
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    // The error should be about file reading, not the name validation
    expect((err as Error).message).not.toMatch(/invalid flow name/i);
  });

  it("accepts flow names with underscores", async () => {
    const err = await loadAndResolveFlow("/nonexistent/dir", "deep_build").catch(
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/invalid flow name/i);
  });
});

// ---------------------------------------------------------------------------
// Fix 3: wave-variables.ts — cwd passed to git spawnSync call
// ---------------------------------------------------------------------------

describe("resolveWaveVariables — cwd is passed to git spawnSync", () => {
  it("passes projectDir as cwd to spawnSync for wave_diff", async () => {
    const tmpDir = makeTmpDir();
    const plansDir = join(tmpDir, "plans", "my-slug");
    await mkdir(plansDir, { recursive: true });

    // Write a minimal INDEX.md so readWavePlans does not short-circuit
    await writeFile(
      join(plansDir, "INDEX.md"),
      "## Plan Index\n\n| Task | Wave | Depends on | Files | Principles |\n|------|------|------------|-------|------------|\n| t-01 | 1 | -- | file.ts | some-principle |\n",
    );

    const customProjectDir = "/custom/project/root";

    await resolveWaveVariables(tmpDir, 1, "my-slug", 1, customProjectDir);

    // Verify spawnSync was called with the correct cwd
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "git",
      ["diff", "HEAD~1"],
      expect.objectContaining({ cwd: customProjectDir }),
    );
  });

  it("uses process.cwd() as fallback cwd when projectDir is not provided", async () => {
    const tmpDir = makeTmpDir();
    const plansDir = join(tmpDir, "plans", "my-slug");
    await mkdir(plansDir, { recursive: true });

    await writeFile(
      join(plansDir, "INDEX.md"),
      "## Plan Index\n\n| Task | Wave | Depends on | Files | Principles |\n|------|------|------------|-------|------------|\n| t-01 | 1 | -- | file.ts | some-principle |\n",
    );

    // No projectDir passed → should fall back to process.cwd() or CANON_PROJECT_DIR
    const originalEnv = process.env.CANON_PROJECT_DIR;
    delete process.env.CANON_PROJECT_DIR;

    await resolveWaveVariables(tmpDir, 1, "my-slug", 1);

    expect(mockSpawnSync).toHaveBeenCalledWith(
      "git",
      ["diff", "HEAD~1"],
      expect.objectContaining({ cwd: process.cwd() }),
    );

    if (originalEnv !== undefined) {
      process.env.CANON_PROJECT_DIR = originalEnv;
    }
  });

  it("uses CANON_PROJECT_DIR env var as cwd when projectDir is not provided", async () => {
    const tmpDir = makeTmpDir();
    const plansDir = join(tmpDir, "plans", "my-slug");
    await mkdir(plansDir, { recursive: true });

    await writeFile(
      join(plansDir, "INDEX.md"),
      "## Plan Index\n\n| Task | Wave | Depends on | Files | Principles |\n|------|------|------------|-------|------------|\n| t-01 | 1 | -- | file.ts | some-principle |\n",
    );

    const envProjectDir = "/env/project/root";
    process.env.CANON_PROJECT_DIR = envProjectDir;

    await resolveWaveVariables(tmpDir, 1, "my-slug", 1);

    expect(mockSpawnSync).toHaveBeenCalledWith(
      "git",
      ["diff", "HEAD~1"],
      expect.objectContaining({ cwd: envProjectDir }),
    );

    delete process.env.CANON_PROJECT_DIR;
  });
});

// ---------------------------------------------------------------------------
// Fix 6: update-board.ts — once() listener cleanup (no listener leak)
// ---------------------------------------------------------------------------

describe("updateBoard — once() listener cleanup", () => {
  it("does not leak board_updated listeners after enter_state", async () => {
    const workspace = makeTmpDir();
    const flow = makeMinimalFlow();
    await writeBoard(workspace, initBoard(flow, "test task", "abc123"));

    const before = flowEventBus.listenerCount("board_updated");

    await updateBoard({ workspace, action: "enter_state", state_id: "build" });

    const after = flowEventBus.listenerCount("board_updated");
    expect(after).toBe(before);
  });

  it("does not leak state_entered listeners after enter_state", async () => {
    const workspace = makeTmpDir();
    const flow = makeMinimalFlow();
    await writeBoard(workspace, initBoard(flow, "test task", "abc123"));

    const before = flowEventBus.listenerCount("state_entered");

    await updateBoard({ workspace, action: "enter_state", state_id: "build" });

    const after = flowEventBus.listenerCount("state_entered");
    expect(after).toBe(before);
  });

  it("does not leak board_updated listeners after block action", async () => {
    const workspace = makeTmpDir();
    const flow = makeMinimalFlow();
    await writeBoard(workspace, initBoard(flow, "test task", "abc123"));
    await updateBoard({ workspace, action: "enter_state", state_id: "build" });

    const before = flowEventBus.listenerCount("board_updated");

    await updateBoard({
      workspace,
      action: "block",
      state_id: "build",
      blocked_reason: "testing",
    });

    const after = flowEventBus.listenerCount("board_updated");
    expect(after).toBe(before);
  });

  it("does not leak board_updated listeners after complete_flow action", async () => {
    const workspace = makeTmpDir();
    const flow = makeMinimalFlow();
    await writeBoard(workspace, initBoard(flow, "test task", "abc123"));
    await updateBoard({ workspace, action: "enter_state", state_id: "ship" });

    const before = flowEventBus.listenerCount("board_updated");

    await updateBoard({ workspace, action: "complete_flow" });

    const after = flowEventBus.listenerCount("board_updated");
    expect(after).toBe(before);
  });

  it("cleans up state_entered listener even when board_updated emit throws", async () => {
    const workspace = makeTmpDir();
    const flow = makeMinimalFlow();
    await writeBoard(workspace, initBoard(flow, "test task", "abc123"));

    // Add a throwing external listener on board_updated to cause emit to throw
    flowEventBus.on("board_updated", () => {
      throw new Error("forced board_updated error");
    });

    const stateEnteredBefore = flowEventBus.listenerCount("state_entered");

    try {
      await updateBoard({ workspace, action: "enter_state", state_id: "build" });
    } catch {
      // External listener throws — expected
    }

    // The internal state_entered listener should be cleaned up in finally block
    const stateEnteredAfter = flowEventBus.listenerCount("state_entered");
    expect(stateEnteredAfter).toBe(stateEnteredBefore);
  });
});

// ---------------------------------------------------------------------------
// Fix 5: report-result.ts — once() listener cleanup for transition_evaluated
// on the nested emit path (covers the finally block)
// ---------------------------------------------------------------------------

describe("reportResult — once() listener cleanup on all event paths", () => {
  it("does not leak transition_evaluated listeners after successful call", async () => {
    const workspace = makeTmpDir();
    const flow = makeMinimalFlow();
    await writeBoard(workspace, initBoard(flow, "test task", "abc123"));

    const before = flowEventBus.listenerCount("transition_evaluated");

    await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
    });

    const after = flowEventBus.listenerCount("transition_evaluated");
    expect(after).toBe(before);
  });

  it("does not leak state_completed listeners after successful call", async () => {
    const workspace = makeTmpDir();
    const flow = makeMinimalFlow();
    await writeBoard(workspace, initBoard(flow, "test task", "abc123"));

    const before = flowEventBus.listenerCount("state_completed");

    await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
    });

    const after = flowEventBus.listenerCount("state_completed");
    expect(after).toBe(before);
  });

  it("cleans up transition_evaluated listener when state_completed emit throws", async () => {
    const workspace = makeTmpDir();
    const flow = makeMinimalFlow();
    await writeBoard(workspace, initBoard(flow, "test task", "abc123"));

    // Attach throwing listener on state_completed to cause emit sequence to abort early
    flowEventBus.on("state_completed", () => {
      throw new Error("forced state_completed error");
    });

    const transitionBefore = flowEventBus.listenerCount("transition_evaluated");

    try {
      await reportResult({
        workspace,
        state_id: "build",
        status_keyword: "DONE",
        flow,
      });
    } catch {
      // External listener throws — expected
    }

    // The internal transition_evaluated once() listener is cleaned up in finally
    const transitionAfter = flowEventBus.listenerCount("transition_evaluated");
    expect(transitionAfter).toBe(transitionBefore);
  });
});
