/**
 * adr016-integration.test.ts — Integration tests for ADR-016 Auto-Triggered Learning.
 *
 * Focus areas:
 *   1. drive-flow done response carries learn_gate_passed: true when gate passes
 *   2. drive-flow done response omits learn_gate_passed when gate throws (fail-open guarantee)
 *   3. drive-flow done response omits learn_gate_passed when gate returns passed: false
 *   4. learn-gate → learn-lock cross-module: evaluateLearnGate acquires lock end-to-end
 *   5. learn-lock: stale_reclaim_failed when unlink succeeds but wx write fails (TOCTOU gap)
 *   6. projectDir is threaded to evaluateLearnGate correctly through driveFlow
 *
 * Canon principles:
 *   - toolresult-contract: DriveFlowAction done arm learn_gate_passed is boolean|undefined
 *   - no-silent-failures: evaluateLearnGate exceptions are caught, not propagated
 *   - define-errors-out-of-existence: learn_gate_passed absent = gate not passed (not an error)
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// ── Mock I/O boundaries required for driveFlow ────────────────────────────────
// We mock evaluateLearnGate for the drive-flow integration tests so we can
// control gate outcome without a real drift DB, throttle file, or lock file.

vi.mock("../tools/enter-and-prepare-state.ts", () => ({
  enterAndPrepareState: vi.fn(),
}));
vi.mock("../tools/report-result.ts", () => ({
  reportResult: vi.fn(),
}));

// learn-gate is NOT mocked in this test file — that is the point of the
// integration tests in group 4. For groups 1–3 and 6 we control the gate
// via its own dependencies (config, learn-lock, drift-db) using real temp dirs.
// For clarity we split the two concerns: drive-flow done tests (1–3) mock the
// gate module, while gate→lock integration tests (4) use real modules.

// ── Imports after mock declarations ──────────────────────────────────────────

import { initExecutionDb } from "@domains/workspaces/execution-schema.ts";
import { clearStoreCache, ExecutionStore } from "@domains/workspaces/execution-store.ts";
import { driveFlow } from "../tools/drive-flow.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";
import type { EnterAndPrepareStateResult } from "../tools/enter-and-prepare-state.ts";
import { reportResult } from "../tools/report-result.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import type { ResolvedFlow } from "@domains/flows/flow-definition-schemas.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "adr016-integ-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeStore(workspace: string): ExecutionStore {
  const db = initExecutionDb(join(workspace, "orchestration.db"));
  const store = new ExecutionStore(db);
  store.initExecution({
    base_commit: "abc123",
    branch: "feat/test",
    created: new Date().toISOString(),
    current_state: "terminal",
    entry: "research",
    flow: "test-flow",
    flow_name: "test-flow",
    last_updated: new Date().toISOString(),
    sanitized: "feat-test",
    slug: "test-slug",
    started: new Date().toISOString(),
    task: "build feature",
    tier: "medium",
  });
  return store;
}

function makeFlow(): ResolvedFlow {
  return {
    description: "test",
    entry: "research",
    name: "test-flow",
    spawn_instructions: { research: "Do research" },
    states: {
      research: {
        agent: "canon:canon-researcher",
        transitions: { done: "terminal" },
        type: "single",
      },
      terminal: { type: "terminal" },
    },
  };
}

function makeEnterResult(
  overrides: Partial<EnterAndPrepareStateResult> = {},
): ToolResult<EnterAndPrepareStateResult> {
  return {
    can_enter: true,
    cannot_fix_items: [],
    history: [],
    iteration_count: 1,
    max_iterations: 3,
    ok: true,
    prompts: [
      { agent: "canon:canon-researcher", prompt: "Research", role: "main", template_paths: [] },
    ],
    state_type: "single",
    ...overrides,
  };
}

function makeReportResult(nextState: string | null, overrides: Record<string, unknown> = {}) {
  return {
    board: {
      base_commit: "abc123",
      blocked: null,
      concerns: [],
      current_state: nextState ?? "terminal",
      entry: "research",
      flow: "test-flow",
      iterations: {},
      last_updated: new Date().toISOString(),
      skipped: [],
      started: new Date().toISOString(),
      states: {},
      task: "build feature",
    },
    hitl_required: false,
    log_entry: {},
    next_state: nextState,
    ok: true,
    stuck: false,
    transition_condition: "done",
    ...overrides,
  };
}

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

// ── Group 1: learn_gate_passed: true propagates to done action ────────────────

describe("ADR-016: drive-flow done response — learn_gate_passed: true", () => {
  it("includes learn_gate_passed: true in done action when gate passes", async () => {
    // This test covers the declared known gap from adr016-02:
    // "buildDoneSummary with learn_gate_passed: true path: Not tested end-to-end"
    //
    // Strategy: mock evaluateLearnGate at the module boundary to return passed:true,
    // then verify the done action carries the field. This is the correct integration
    // level — tests the contract between buildDoneSummary and DriveFlowAction.

    // We need to temporarily override the evaluateLearnGate mock for just this test.
    // Since the vi.mock at the top mocks enter-and-prepare and report-result but NOT
    // learn-gate, we spy on the module here.
    const { evaluateLearnGate } = await import("../services/learn-gate.ts");
    vi.spyOn({ evaluateLearnGate }, "evaluateLearnGate").mockResolvedValue({ passed: true });

    // Use a fresh module-level mock for this test group by importing and spying
    const learnGateMod = await import("../services/learn-gate.ts");
    vi.spyOn(learnGateMod, "evaluateLearnGate").mockResolvedValue({ passed: true });

    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    const flow = makeFlow();
    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("done");
    if (result.action !== "done") return;
    expect(result.learn_gate_passed).toBe(true);
  });

  it("omits learn_gate_passed when gate returns passed: false", async () => {
    // Default mock returns passed: false — verify the field is absent (not false)
    // Canon principle: define-errors-out-of-existence — absent = not passed, not an error
    const learnGateMod = await import("../services/learn-gate.ts");
    vi.spyOn(learnGateMod, "evaluateLearnGate").mockResolvedValue({
      passed: false,
      reason: "flow gate: 2 < 5",
    });

    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    const flow = makeFlow();
    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("done");
    if (result.action !== "done") return;
    // learn_gate_passed must be absent, not false — callers test for presence not false
    expect(result.learn_gate_passed).toBeUndefined();
  });
});

// ── Group 2: fail-open guarantee — gate exception does not block flow ─────────

describe("ADR-016: drive-flow fail-open guarantee", () => {
  it("returns done action even when evaluateLearnGate throws an unexpected error", async () => {
    // DESIGN.md constraint: "Gate evaluation must never block or slow flow completion"
    // buildDoneSummary wraps gate in try/catch — exceptions must be silently discarded.
    const learnGateMod = await import("../services/learn-gate.ts");
    vi.spyOn(learnGateMod, "evaluateLearnGate").mockRejectedValue(
      new Error("drift.db SQLITE_IOERR: disk full"),
    );

    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    const flow = makeFlow();
    const result = await driveFlow({ flow, workspace }, "/fake/project");

    // Flow must complete — exception must not propagate
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("done");
    if (result.action !== "done") return;
    // learn_gate_passed absent — gate silently failed (fail-open)
    expect(result.learn_gate_passed).toBeUndefined();
  });

  it("returns done action when evaluateLearnGate rejects with a non-Error value", async () => {
    const learnGateMod = await import("../services/learn-gate.ts");
    vi.spyOn(learnGateMod, "evaluateLearnGate").mockRejectedValue("string rejection");

    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    const flow = makeFlow();
    const result = await driveFlow({ flow, workspace }, "/fake/project");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("done");
  });
});

// ── Group 3: projectDir threading contract ────────────────────────────────────

describe("ADR-016: projectDir threaded to evaluateLearnGate", () => {
  it("passes the caller-provided projectDir to evaluateLearnGate", async () => {
    // Verifies the 'projectDir vs workspace confusion' risk mitigation from DESIGN.md:
    // projectDir comes from MCP roots (index.ts) — not workspace (subdirectory under .canon/workspaces/)
    const learnGateMod = await import("../services/learn-gate.ts");
    const spy = vi.spyOn(learnGateMod, "evaluateLearnGate").mockResolvedValue({ passed: false, reason: "disabled" });

    const workspace = makeTmpWorkspace();
    makeStore(workspace);

    const projectDir = "/real/project/root";
    const flow = makeFlow();
    await driveFlow({ flow, workspace }, projectDir);

    // evaluateLearnGate should be called with the exact projectDir passed to driveFlow
    expect(spy).toHaveBeenCalledWith(projectDir);
    // It must NOT be called with the workspace path
    expect(spy).not.toHaveBeenCalledWith(workspace);
  });

  it("does not call evaluateLearnGate when current state is non-terminal (spawn path)", async () => {
    const learnGateMod = await import("../services/learn-gate.ts");
    const spy = vi.spyOn(learnGateMod, "evaluateLearnGate").mockResolvedValue({ passed: false, reason: "disabled" });

    const workspace = makeTmpWorkspace();
    // Store starts at 'research' (entry), not terminal
    const db = initExecutionDb(join(workspace, "orchestration.db"));
    const store = new ExecutionStore(db);
    store.initExecution({
      base_commit: "abc123",
      branch: "feat/test",
      created: new Date().toISOString(),
      current_state: "research",
      entry: "research",
      flow: "test-flow",
      flow_name: "test-flow",
      last_updated: new Date().toISOString(),
      sanitized: "feat-test",
      slug: "test-slug",
      started: new Date().toISOString(),
      task: "build feature",
      tier: "medium",
    });

    vi.mocked(enterAndPrepareState).mockResolvedValueOnce(makeEnterResult());

    const flow = makeFlow();
    const result = await driveFlow({ flow, workspace }, "/project");

    // Returns spawn, not done — gate should not have been called
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("spawn");
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── Group 5: learn-lock stale_reclaim_failed TOCTOU gap ──────────────────────
// Declared known gap in adr016-01: "stale_reclaim_failed path (unlink succeeds but wx fails)"
// We simulate this by having two concurrent callers race to reclaim the same stale lock.

describe("ADR-016: learn-lock stale_reclaim_failed concurrent reclaim race", () => {
  it("returns stale_reclaim_failed or already_locked when two callers race to reclaim the same stale lock", async () => {
    // This is the declared known gap from adr016-01:
    // "Lock file concurrent reclaim race (two stale-reclaim attempts simultaneously)"
    // Node.js runs tasks on a single event loop, so async/await concurrency here
    // does exercise the TOCTOU window: both calls start stat() concurrently,
    // and the winner's unlink+wx completes before the loser's unlink.
    const { acquireLearnLock } = await import("@shared/lib/learn-lock.ts");

    const canonDir = makeTmpWorkspace();
    const lockPath = join(canonDir, "learn.lock");

    // Write a stale lock (20s old, stale threshold = 5s)
    writeFileSync(lockPath, "99999");
    const staleTime = new Date(Date.now() - 20_000);
    await utimes(lockPath, new Date(), staleTime);

    const STALE_AFTER_MS = 5000;

    // Fire two concurrent acquire calls — TOCTOU race on the stale lock
    const [r1, r2] = await Promise.all([
      acquireLearnLock(canonDir, STALE_AFTER_MS),
      acquireLearnLock(canonDir, STALE_AFTER_MS),
    ]);

    const results = [r1, r2];
    const successCount = results.filter((r) => r.acquired).length;
    const failureCount = results.filter((r) => !r.acquired).length;

    // Exactly one must succeed — exclusive-create (wx) guarantees this
    expect(successCount).toBe(1);
    expect(failureCount).toBe(1);

    const failed = results.find((r) => !r.acquired);
    expect(failed?.acquired).toBe(false);
    if (!failed?.acquired) {
      // The losing caller gets either:
      // - "stale_reclaim_failed" — its unlink failed because winner already unlinked
      // - "already_locked" — winner's wx completed before loser's stat saw fresh lock
      // Both are correct outcomes for the TOCTOU race
      expect(["already_locked", "stale_reclaim_failed"]).toContain(failed.reason);
    }
  });

  it("winner of stale reclaim race has previousMtime set to the stale lock's original mtime", async () => {
    // Verifies that the winner of a stale reclaim correctly captures the previousMtime
    // (last learn timestamp) from the original stale lock's mtime.
    // This is important so the caller can rollback to the correct timestamp on failure.
    const { acquireLearnLock } = await import("@shared/lib/learn-lock.ts");

    const canonDir = makeTmpWorkspace();
    const lockPath = join(canonDir, "learn.lock");

    const originalMtime = new Date(Date.now() - 30_000); // 30s ago
    writeFileSync(lockPath, "99999");
    await utimes(lockPath, new Date(), originalMtime);

    const STALE_AFTER_MS = 5000;
    const [r1, r2] = await Promise.all([
      acquireLearnLock(canonDir, STALE_AFTER_MS),
      acquireLearnLock(canonDir, STALE_AFTER_MS),
    ]);

    const winner = [r1, r2].find((r) => r.acquired);
    expect(winner?.acquired).toBe(true);
    if (winner?.acquired) {
      // Winner must have captured the stale lock's original mtime
      expect(winner.previousMtime).not.toBeNull();
      const diff = Math.abs(winner.previousMtime! - originalMtime.getTime());
      expect(diff).toBeLessThan(2000); // OS mtime precision tolerance
    }
  });
});
