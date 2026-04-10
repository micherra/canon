/**
 * skip-when-injection.test.ts
 *
 * Verifies that evaluateSkipWhen() uses injected deps (gitDiff, countFlowRunsSince)
 * when provided — no real git or drift DB calls occur.
 *
 * The module-level mocks (vi.mock) that cover the concrete adapters are NOT used
 * here; instead, we pass deps directly to verify the injection seam works.
 */

import { workspacePath, flowName, stateId as sid } from "@domains/flows/board-state-schemas.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Board } from "../board-state-schemas.ts";
import { evaluateSkipWhen } from "../skip-when.ts";

// We still need to mock the heavy infrastructure dependencies at module level
// so that the module import succeeds and the default path remains testable.
vi.mock("@domains/workspaces/wave-lifecycle.ts", () => ({
  getProjectDir: vi.fn().mockReturnValue("/project"),
}));

vi.mock("@platform/storage/drift/drift-db.ts", () => ({
  getDriftDb: vi.fn().mockReturnValue({ countFlowRunsSince: vi.fn().mockReturnValue(0) }),
}));

vi.mock("@shared/lib/learn-lock.ts", () => ({
  acquireLearnLock: vi.fn().mockResolvedValue({ acquired: true, previousMtime: null }),
  getLastLearnTimestamp: vi.fn().mockResolvedValue(null),
}));

vi.mock("@shared/lib/config.ts", () => ({
  loadLearnGateConfig: vi.fn().mockResolvedValue({
    enabled: true,
    lock_stale_after_hours: 1,
    min_flows_since_last: 5,
    min_hours_since_last: 48,
  }),
}));

vi.mock("node:fs/promises", () => ({
  stat: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@platform/adapters/git-adapter.ts", () => ({
  gitExec: vi.fn().mockReturnValue({
    exitCode: 1,
    ok: false,
    stderr: "git not configured in test",
    stdout: "",
    timedOut: false,
  }),
}));

function makeBoard(overrides?: Partial<Board>): Board {
  return {
    base_commit: "abc1234",
    blocked: null,
    concerns: [],
    current_state: sid("start"),
    entry: sid("start"),
    flow: flowName("test-flow"),
    iterations: {},
    last_updated: new Date().toISOString(),
    skipped: [],
    started: new Date().toISOString(),
    states: {},
    task: "test task",
    ...overrides,
  };
}

// -------------------------------------------------------------------------
// no_contract_changes — injected gitDiff
// -------------------------------------------------------------------------

describe("evaluateSkipWhen — no_contract_changes with injected gitDiff", () => {
  it("uses the injected gitDiff runner instead of the real adapter", async () => {
    const board = makeBoard({ base_commit: "abc1234" });
    const mockGitDiff = vi.fn().mockReturnValue({
      exitCode: 0,
      ok: true,
      stderr: "",
      stdout: "src/internal/helper.ts\n",
      timedOut: false,
    });

    const result = await evaluateSkipWhen("no_contract_changes", workspacePath("/tmp/ws"), board, {
      gitDiff: mockGitDiff,
    });

    expect(mockGitDiff).toHaveBeenCalledOnce();
    expect(mockGitDiff).toHaveBeenCalledWith(
      ["diff", "--diff-filter=d", "--name-only", "abc1234..HEAD"],
      process.cwd(),
    );
    // Internal file change — no contract change → should skip
    expect(result.skip).toBe(true);
  });

  it("does not skip when injected gitDiff returns a contract file change", async () => {
    const board = makeBoard({ base_commit: "abc1234" });
    const mockGitDiff = vi.fn().mockReturnValue({
      exitCode: 0,
      ok: true,
      stderr: "",
      stdout: "src/api/users.ts\n",
      timedOut: false,
    });

    const result = await evaluateSkipWhen("no_contract_changes", workspacePath("/tmp/ws"), board, {
      gitDiff: mockGitDiff,
    });

    expect(result.skip).toBe(false);
  });

  it("does not skip when injected gitDiff returns ok: false", async () => {
    const board = makeBoard({ base_commit: "abc1234" });
    const mockGitDiff = vi.fn().mockReturnValue({
      exitCode: 128,
      ok: false,
      stderr: "fatal: not a git repository",
      stdout: "",
      timedOut: false,
    });

    const result = await evaluateSkipWhen("no_contract_changes", workspacePath("/tmp/ws"), board, {
      gitDiff: mockGitDiff,
    });

    // fail-open for skip: git failure → do not skip
    expect(result.skip).toBe(false);
  });

  it("rejects invalid base_commit without calling injected gitDiff", async () => {
    const board = makeBoard({ base_commit: "not-a-valid-sha!!!" });
    const mockGitDiff = vi.fn();

    const result = await evaluateSkipWhen("no_contract_changes", workspacePath("/tmp/ws"), board, {
      gitDiff: mockGitDiff,
    });

    expect(mockGitDiff).not.toHaveBeenCalled();
    expect(result.skip).toBe(false);
  });
});

// -------------------------------------------------------------------------
// learn_gate_not_passed — injected countFlowRunsSince
// -------------------------------------------------------------------------

describe("evaluateSkipWhen — learn_gate_not_passed with injected countFlowRunsSince", () => {
  it("uses injected countFlowRunsSince to determine flow count", async () => {
    const board = makeBoard();
    const mockCount = vi.fn().mockReturnValue(10); // above min threshold of 5

    const result = await evaluateSkipWhen("learn_gate_not_passed", workspacePath("/tmp/ws"), board, {
      countFlowRunsSince: mockCount,
    });

    expect(mockCount).toHaveBeenCalledOnce();
    // 10 >= 5 (min_flows_since_last) AND lock acquired → should NOT skip
    expect(result.skip).toBe(false);
  });

  it("skips when injected countFlowRunsSince returns count below threshold", async () => {
    const board = makeBoard();
    const mockCount = vi.fn().mockReturnValue(2); // below min threshold of 5

    const result = await evaluateSkipWhen("learn_gate_not_passed", workspacePath("/tmp/ws"), board, {
      countFlowRunsSince: mockCount,
    });

    expect(result.skip).toBe(true);
    expect(result.reason).toContain("flow gate");
    expect(result.reason).toContain("2");
  });
});

// -------------------------------------------------------------------------
// Other conditions are unaffected by deps
// -------------------------------------------------------------------------

describe("evaluateSkipWhen — conditions unaffected by deps", () => {
  it("no_fix_requested ignores deps", async () => {
    const board = makeBoard({ metadata: { fix_requested: true } });
    const result = await evaluateSkipWhen("no_fix_requested", workspacePath("/tmp/ws"), board, {
      gitDiff: vi.fn(),
      countFlowRunsSince: vi.fn(),
    });
    expect(result.skip).toBe(false);
  });

  it("auto_approved ignores deps", async () => {
    const board = makeBoard({ metadata: { auto_approve: true } });
    const result = await evaluateSkipWhen("auto_approved", workspacePath("/tmp/ws"), board, {
      gitDiff: vi.fn(),
      countFlowRunsSince: vi.fn(),
    });
    expect(result.skip).toBe(true);
  });
});
