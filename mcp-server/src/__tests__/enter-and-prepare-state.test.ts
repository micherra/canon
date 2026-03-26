/**
 * Tests for enter-and-prepare-state.ts
 *
 * Covers:
 * 1. Convergence blocked — returns can_enter:false without entering state or resolving prompts
 * 2. Skip evaluation before enter — skip_when met returns skip_reason, state stays "pending"
 * 3. Happy path — enters state, resolves prompts, returns combined result
 * 4. Terminal state — empty prompts, state_type "terminal"
 * 5. Board read count — readBoard called exactly once per invocation
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Hoist mocks before module imports
// ---------------------------------------------------------------------------

vi.mock("../orchestration/board.js", () => ({
  readBoard: vi.fn(),
  writeBoard: vi.fn(),
  enterState: vi.fn(),
}));

vi.mock("../orchestration/workspace.js", () => ({
  withBoardLock: vi.fn(async (_workspace: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("../orchestration/skip-when.js", () => ({
  evaluateSkipWhen: vi.fn(),
}));

vi.mock("../orchestration/event-bus-instance.js", () => ({
  flowEventBus: {
    emit: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock("../orchestration/events.js", () => ({
  createJsonlLogger: vi.fn(() => vi.fn()),
}));

import { readBoard, writeBoard, enterState } from "../orchestration/board.ts";
import { withBoardLock } from "../orchestration/workspace.ts";
import { evaluateSkipWhen } from "../orchestration/skip-when.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";
import type { Board, ResolvedFlow } from "../orchestration/flow-schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eaps-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeBoard(overrides: Record<string, unknown> = {}): Board {
  return {
    flow: "test-flow",
    task: "test task",
    entry: "implement",
    current_state: "implement",
    base_commit: "abc1234",
    started: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    states: {
      implement: { status: "pending", entries: 0 },
      done: { status: "pending", entries: 0 },
    },
    iterations: {},
    blocked: null,
    concerns: [],
    skipped: [],
    ...overrides,
  } as Board;
}

function makeFlow(overrides: Partial<ResolvedFlow> = {}): ResolvedFlow {
  return {
    name: "test-flow",
    description: "Test flow",
    entry: "implement",
    states: {
      implement: { type: "single", agent: "canon-implementor" },
      done: { type: "terminal" },
    },
    spawn_instructions: { implement: "Implement ${task}." },
    ...overrides,
  };
}

afterEach(() => {
  for (const d of tmpDirs) {
    rmSync(d, { recursive: true, force: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("enterAndPrepareState", () => {
  describe("convergence blocked", () => {
    it("returns can_enter:false when max iterations reached, without entering state", async () => {
      const workspace = makeTmpDir();
      const board = makeBoard({
        iterations: {
          implement: { count: 3, max: 3, history: [], cannot_fix: [] },
        },
      });
      vi.mocked(readBoard).mockResolvedValue(board);

      const flow = makeFlow();
      const result = await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
      });

      expect(result.can_enter).toBe(false);
      expect(result.iteration_count).toBe(3);
      expect(result.max_iterations).toBe(3);
      expect(result.prompts).toHaveLength(0);

      // State must NOT have been entered
      expect(enterState).not.toHaveBeenCalled();
      expect(writeBoard).not.toHaveBeenCalled();
    });

    it("includes cannot_fix_items and history in the convergence-blocked result", async () => {
      const workspace = makeTmpDir();
      const cannotFixItems = [{ principle_id: "thin-handlers", file_path: "src/api/handler.ts" }];
      const history = [{ principle_ids: ["thin-handlers"], file_paths: ["src/api/handler.ts"] }];
      const board = makeBoard({
        iterations: {
          implement: { count: 2, max: 2, history, cannot_fix: cannotFixItems },
        },
      });
      vi.mocked(readBoard).mockResolvedValue(board);

      const result = await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow: makeFlow(),
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
      });

      expect(result.can_enter).toBe(false);
      expect(result.cannot_fix_items).toEqual(cannotFixItems);
      expect(result.history).toEqual(history);
    });
  });

  describe("skip evaluation before enter", () => {
    it("returns skipped:true when skip_when condition is met, without entering state", async () => {
      const workspace = makeTmpDir();
      const board = makeBoard();
      vi.mocked(readBoard).mockResolvedValue(board);
      vi.mocked(evaluateSkipWhen).mockResolvedValue({
        skip: true,
        reason: "No contract changes detected — all changes are internal",
      });

      const flow = makeFlow({
        states: {
          implement: {
            type: "single",
            agent: "canon-implementor",
            skip_when: "no_contract_changes",
          },
          done: { type: "terminal" },
        },
      });

      const result = await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
      });

      expect(result.can_enter).toBe(true);
      expect(result.skip_reason).toBeDefined();
      expect(result.skip_reason).toContain("no_contract_changes");
      expect(result.prompts).toHaveLength(0);

      // State must NOT have been entered — board stays "pending"
      expect(enterState).not.toHaveBeenCalled();
      expect(writeBoard).not.toHaveBeenCalled();
    });

    it("does not skip when skip_when condition is not met", async () => {
      const workspace = makeTmpDir();
      const board = makeBoard();
      const enteredBoard = makeBoard({
        states: { implement: { status: "in_progress", entries: 1 }, done: { status: "pending", entries: 0 } },
      });
      vi.mocked(readBoard).mockResolvedValue(board);
      vi.mocked(evaluateSkipWhen).mockResolvedValue({ skip: false });
      vi.mocked(enterState).mockReturnValue(enteredBoard);

      const flow = makeFlow({
        states: {
          implement: {
            type: "single",
            agent: "canon-implementor",
            skip_when: "no_contract_changes",
          },
          done: { type: "terminal" },
        },
      });

      const result = await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
      });

      expect(result.can_enter).toBe(true);
      expect(result.skip_reason).toBeUndefined();
      expect(result.prompts).toHaveLength(1);
      expect(enterState).toHaveBeenCalledTimes(1);
    });
  });

  describe("happy path", () => {
    beforeEach(() => {
      const board = makeBoard();
      const enteredBoard = makeBoard({
        states: { implement: { status: "in_progress", entries: 1 }, done: { status: "pending", entries: 0 } },
      });
      vi.mocked(readBoard).mockResolvedValue(board);
      vi.mocked(enterState).mockReturnValue(enteredBoard);
    });

    it("returns can_enter:true and resolved prompts for a single-agent state", async () => {
      const workspace = makeTmpDir();
      const flow = makeFlow();

      const result = await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "build the widget", CANON_PLUGIN_ROOT: "" },
      });

      expect(result.can_enter).toBe(true);
      expect(result.state_type).toBe("single");
      expect(result.prompts).toHaveLength(1);
      expect(result.prompts[0].agent).toBe("canon-implementor");
      expect(result.prompts[0].prompt).toContain("build the widget");
    });

    it("enters the state (calls enterState + writeBoard)", async () => {
      const workspace = makeTmpDir();
      const flow = makeFlow();

      await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
      });

      expect(enterState).toHaveBeenCalledTimes(1);
      expect(writeBoard).toHaveBeenCalledTimes(1);
    });

    it("returns the updated board in the result", async () => {
      const workspace = makeTmpDir();
      const flow = makeFlow();

      const result = await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
      });

      // Board should reflect in_progress status after entering
      expect(result.board).toBeDefined();
      expect(result.board!.states["implement"].status).toBe("in_progress");
    });

    it("returns iteration_count from board for a state without iteration limits", async () => {
      const workspace = makeTmpDir();
      const flow = makeFlow();

      const result = await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
      });

      expect(result.iteration_count).toBe(0);
      expect(result.max_iterations).toBe(0);
      expect(result.cannot_fix_items).toEqual([]);
      expect(result.history).toEqual([]);
    });
  });

  describe("terminal state", () => {
    it("returns can_enter:true with empty prompts and state_type 'terminal'", async () => {
      const workspace = makeTmpDir();
      const board = makeBoard();
      const enteredBoard = makeBoard({
        states: { implement: { status: "pending", entries: 0 }, done: { status: "in_progress", entries: 1 } },
      });
      vi.mocked(readBoard).mockResolvedValue(board);
      vi.mocked(enterState).mockReturnValue(enteredBoard);

      const flow = makeFlow();

      const result = await enterAndPrepareState({
        workspace,
        state_id: "done",
        flow,
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
      });

      expect(result.can_enter).toBe(true);
      expect(result.state_type).toBe("terminal");
      expect(result.prompts).toHaveLength(0);
    });
  });

  describe("board read count", () => {
    it("calls readBoard exactly once per invocation", async () => {
      const workspace = makeTmpDir();
      const board = makeBoard();
      const enteredBoard = makeBoard({
        states: { implement: { status: "in_progress", entries: 1 }, done: { status: "pending", entries: 0 } },
      });
      vi.mocked(readBoard).mockResolvedValue(board);
      vi.mocked(enterState).mockReturnValue(enteredBoard);

      const flow = makeFlow({
        states: {
          implement: {
            type: "single",
            agent: "canon-implementor",
            skip_when: "no_contract_changes",
          },
          done: { type: "terminal" },
        },
      });

      // skip_when NOT met, so it will proceed to enter state
      vi.mocked(evaluateSkipWhen).mockResolvedValue({ skip: false });

      await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
      });

      // Only one readBoard call total — not once per sub-call
      expect(readBoard).toHaveBeenCalledTimes(1);
    });

    it("calls readBoard exactly once even when state has no skip_when", async () => {
      const workspace = makeTmpDir();
      const board = makeBoard();
      const enteredBoard = makeBoard({
        states: { implement: { status: "in_progress", entries: 1 }, done: { status: "pending", entries: 0 } },
      });
      vi.mocked(readBoard).mockResolvedValue(board);
      vi.mocked(enterState).mockReturnValue(enteredBoard);

      const flow = makeFlow();

      await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
      });

      expect(readBoard).toHaveBeenCalledTimes(1);
    });
  });

  describe("parallel state", () => {
    it("returns one prompt per agent for parallel states", async () => {
      const workspace = makeTmpDir();
      const board = makeBoard({
        states: {
          review: { status: "pending", entries: 0 },
          done: { status: "pending", entries: 0 },
        },
      });
      const enteredBoard = makeBoard({
        states: {
          review: { status: "in_progress", entries: 1 },
          done: { status: "pending", entries: 0 },
        },
      });
      vi.mocked(readBoard).mockResolvedValue(board);
      vi.mocked(enterState).mockReturnValue(enteredBoard);

      const flow: ResolvedFlow = {
        name: "test-flow",
        description: "Test flow",
        entry: "review",
        states: {
          review: { type: "parallel", agents: ["canon-reviewer", "canon-security"] },
          done: { type: "terminal" },
        },
        spawn_instructions: { review: "Review the code for ${task}." },
      };

      const result = await enterAndPrepareState({
        workspace,
        state_id: "review",
        flow,
        variables: { task: "security", CANON_PLUGIN_ROOT: "" },
      });

      expect(result.state_type).toBe("parallel");
      expect(result.prompts).toHaveLength(2);
      expect(result.prompts[0].agent).toBe("canon-reviewer");
      expect(result.prompts[1].agent).toBe("canon-security");
    });
  });
});
