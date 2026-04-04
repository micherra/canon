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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Hoist spawnSync mock so vitest can use it before module imports

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({
    error: undefined,
    output: [],
    pid: 1,
    signal: null,
    status: 0,
    stderr: "",
    stdout: "",
  })),
}));

import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { flowEventBus } from "../orchestration/event-bus-instance.ts";
import { clearStoreCache, getExecutionStore } from "../orchestration/execution-store.ts";
import { loadAndResolveFlow } from "../orchestration/flow-parser.ts";
import type { ResolvedFlow } from "../orchestration/flow-schema.ts";
import { resolveWaveVariables } from "../orchestration/wave-variables.ts";
import { reportResult } from "../tools/report-result.ts";
import { updateBoard } from "../tools/update-board.ts";

const mockSpawnSync = vi.mocked(spawnSync);

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "refactor-verify-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
  flowEventBus.removeAllListeners();
  vi.clearAllMocks();
});

function seedWorkspace(workspace: string, flow: ResolvedFlow): void {
  const now = new Date().toISOString();
  const store = getExecutionStore(workspace);
  store.initExecution({
    base_commit: "abc123",
    branch: "main",
    created: now,
    current_state: flow.entry,
    entry: flow.entry,
    flow: flow.name,
    flow_name: flow.name,
    last_updated: now,
    sanitized: "main",
    slug: "test-slug",
    started: now,
    task: "test task",
    tier: "medium",
  });
  store.upsertState(flow.entry, { entries: 0, status: "pending" });
  store.upsertIteration(flow.entry, { cannot_fix: [], count: 0, history: [], max: 3 });
}

function makeMinimalFlow(overrides?: Partial<ResolvedFlow>): ResolvedFlow {
  return {
    description: "A test flow",
    entry: "build",
    name: "test-flow",
    spawn_instructions: {},
    states: {
      build: {
        transitions: { done: "ship" },
        type: "single",
      },
      ship: { type: "terminal" },
    },
    ...overrides,
  };
}

// Fix 4: flow-parser.ts — path traversal validation on flow name

describe("loadAndResolveFlow — flow name path traversal validation", () => {
  it("rejects flow names containing path separators (forward slash)", async () => {
    await expect(loadAndResolveFlow("/some/dir", "../../etc/passwd")).rejects.toThrow(
      /invalid flow name/i,
    );
  });

  it("rejects flow names containing path separators (back slash)", async () => {
    await expect(loadAndResolveFlow("/some/dir", "..\\..\\secret")).rejects.toThrow(
      /invalid flow name/i,
    );
  });

  it("rejects flow names with spaces", async () => {
    await expect(loadAndResolveFlow("/some/dir", "my flow")).rejects.toThrow(/invalid flow name/i);
  });

  it("rejects flow names with dot extensions that could traverse", async () => {
    await expect(loadAndResolveFlow("/some/dir", "flow.md")).rejects.toThrow(/invalid flow name/i);
  });

  it("accepts valid alphanumeric flow names with hyphens and underscores", async () => {
    // Validation passes — the error will be a file-not-found, not a validation error.
    // We confirm the error is NOT "invalid flow name".
    const err = await loadAndResolveFlow("/nonexistent/dir", "review-only").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    // The error should be about file reading, not the name validation
    expect((err as Error).message).not.toMatch(/invalid flow name/i);
  });

  it("accepts flow names with underscores", async () => {
    const err = await loadAndResolveFlow("/nonexistent/dir", "deep_build").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/invalid flow name/i);
  });
});

// Fix 3: wave-variables.ts — cwd passed to git spawnSync call

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

    await resolveWaveVariables(tmpDir, {
      projectDir: customProjectDir,
      slug: "my-slug",
      totalWaves: 1,
      wave: 1,
    });

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
    process.env.CANON_PROJECT_DIR = undefined;

    await resolveWaveVariables(tmpDir, { slug: "my-slug", totalWaves: 1, wave: 1 });

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

    await resolveWaveVariables(tmpDir, { slug: "my-slug", totalWaves: 1, wave: 1 });

    expect(mockSpawnSync).toHaveBeenCalledWith(
      "git",
      ["diff", "HEAD~1"],
      expect.objectContaining({ cwd: envProjectDir }),
    );

    process.env.CANON_PROJECT_DIR = undefined;
  });
});

// FlowEventBus — no listener leaks across repeated operations

describe("FlowEventBus — no listener leaks across repeated operations", () => {
  it("listener counts are stable after 10 full reportResult + updateBoard cycles", async () => {
    const workspace = makeTmpDir();
    const flow = makeMinimalFlow();
    seedWorkspace(workspace, flow);

    // Capture baseline counts before any cycles
    const eventNames = [
      "state_completed",
      "transition_evaluated",
      "hitl_triggered",
      "state_entered",
      "board_updated",
    ] as const;

    const baseline: Record<string, number> = {};
    for (const name of eventNames) {
      baseline[name] = flowEventBus.listenerCount(name);
    }

    // Run N cycles
    const CYCLES = 10;
    for (let i = 0; i < CYCLES; i++) {
      // Reset board state for each cycle
      const store = getExecutionStore(workspace);
      store.upsertState("build", { entries: 0, status: "pending" });
      store.upsertIteration("build", { cannot_fix: [], count: 0, history: [], max: 3 });
      await updateBoard({ action: "enter_state", state_id: "build", workspace });
      await reportResult({
        flow,
        state_id: "build",
        status_keyword: "DONE",
        workspace,
      });
    }

    // Listener counts must be identical to baseline — no accumulation
    for (const name of eventNames) {
      expect(flowEventBus.listenerCount(name)).toBe(baseline[name]);
    }
  });
});
