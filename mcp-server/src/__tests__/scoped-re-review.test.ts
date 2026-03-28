/**
 * Tests for scoped re-review -- review_scope variable injection in enterAndPrepareState.
 *
 * Covers:
 * 1. review_scope is empty when entries is 0 or 1 (first review)
 * 2. review_scope is populated with file list when entries > 1 and git diff succeeds
 * 3. review_scope is empty string when git diff fails (graceful degradation)
 * 4. review_scope is empty string when base_commit is invalid/missing
 * 5. review_scope variable appears in the final spawn prompt
 */

import { describe, it, expect, vi, afterEach } from "vitest";
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

vi.mock("../orchestration/consultation-executor.js", () => ({
  resolveConsultationPrompt: vi.fn(),
}));

vi.mock("../orchestration/wave-variables.js", () => ({
  escapeDollarBrace: vi.fn((s: string) => s),
  substituteVariables: vi.fn((s: string) => s),
  buildTemplateInjection: vi.fn(() => ""),
  parseTaskIdsForWave: vi.fn(() => []),
  extractFilePaths: vi.fn(() => []),
}));

// Mock child_process for git diff
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

import { readBoard, enterState } from "../orchestration/board.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";
import type { Board, ResolvedFlow } from "../orchestration/flow-schema.ts";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "scoped-review-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeBoard(overrides: Record<string, unknown> = {}): Board {
  return {
    flow: "test-flow",
    task: "test task",
    entry: "review",
    current_state: "review",
    base_commit: "abc1234",
    started: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    states: {
      review: { status: "pending", entries: 0 },
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
    entry: "review",
    states: {
      review: { type: "single", agent: "canon-reviewer" },
      done: { type: "terminal" },
    },
    spawn_instructions: {
      review: "Review changes via git diff ${base_commit}..HEAD. ${review_scope}",
    },
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

describe("scoped re-review (review_scope injection)", () => {
  describe("first review (entries <= 1)", () => {
    it("does not inject review_scope when entries is 0", async () => {
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

      const flow = makeFlow();
      const result = await enterAndPrepareState({
        workspace,
        state_id: "review",
        flow,
        variables: { task: "test", base_commit: "abc1234", CANON_PLUGIN_ROOT: "" },
      });

      expect(result.can_enter).toBe(true);
      // git diff should NOT have been called for entries <= 1
      expect(spawnSync).not.toHaveBeenCalled();
    });

    it("does not inject review_scope when entries is 1", async () => {
      const workspace = makeTmpDir();
      // After the first review runs, entries becomes 1 -- next entry will be 1 already completed
      // The check is: if enteredBoard.states[state_id]?.entries > 1
      // So entries=1 means this is the first time being entered (not a re-entry)
      const board = makeBoard({
        states: {
          review: { status: "done", entries: 1 },
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

      const flow = makeFlow();
      await enterAndPrepareState({
        workspace,
        state_id: "review",
        flow,
        variables: { task: "test", base_commit: "abc1234", CANON_PLUGIN_ROOT: "" },
      });

      // git diff should NOT be called for a non-re-entry
      expect(spawnSync).not.toHaveBeenCalled();
    });
  });

  describe("re-entry (entries > 1)", () => {
    it("injects review_scope with file list when git diff succeeds", async () => {
      const workspace = makeTmpDir();
      const board = makeBoard({
        base_commit: "abc1234",
        states: {
          review: { status: "done", entries: 1 },
          done: { status: "pending", entries: 0 },
        },
      });
      // After enterState, entries becomes 2 (re-entry)
      const enteredBoard = makeBoard({
        base_commit: "abc1234",
        states: {
          review: { status: "in_progress", entries: 2 },
          done: { status: "pending", entries: 0 },
        },
      });
      vi.mocked(readBoard).mockResolvedValue(board);
      vi.mocked(enterState).mockReturnValue(enteredBoard);

      // Mock git diff to return changed files
      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
        stdout: "src/tools/enter-and-prepare-state.ts\nflows/fragments/review-fix-loop.md\n",
        stderr: "",
        pid: 1,
        output: [],
        signal: null,
      });

      const flow = makeFlow();
      const result = await enterAndPrepareState({
        workspace,
        state_id: "review",
        flow,
        variables: { task: "test", base_commit: "abc1234", CANON_PLUGIN_ROOT: "" },
      });

      expect(result.can_enter).toBe(true);
      expect(spawnSync).toHaveBeenCalledWith(
        "git",
        ["diff", "--name-only", "abc1234..HEAD"],
        expect.objectContaining({ encoding: "utf-8", timeout: 5000 }),
      );

      // The prompt should contain the review_scope content
      const prompt = result.prompts[0]?.prompt ?? "";
      expect(prompt).toContain("Scoped re-review");
      expect(prompt).toContain("src/tools/enter-and-prepare-state.ts");
      expect(prompt).toContain("flows/fragments/review-fix-loop.md");
    });

    it("uses empty review_scope when git diff fails (graceful degradation)", async () => {
      const workspace = makeTmpDir();
      const board = makeBoard({
        base_commit: "abc1234",
        states: {
          review: { status: "done", entries: 1 },
          done: { status: "pending", entries: 0 },
        },
      });
      const enteredBoard = makeBoard({
        base_commit: "abc1234",
        states: {
          review: { status: "in_progress", entries: 2 },
          done: { status: "pending", entries: 0 },
        },
      });
      vi.mocked(readBoard).mockResolvedValue(board);
      vi.mocked(enterState).mockReturnValue(enteredBoard);

      // Mock git diff failure (non-zero exit code)
      vi.mocked(spawnSync).mockReturnValue({
        status: 128,
        stdout: "",
        stderr: "fatal: not a git repository",
        pid: 1,
        output: [],
        signal: null,
      });

      const flow = makeFlow();
      const result = await enterAndPrepareState({
        workspace,
        state_id: "review",
        flow,
        variables: { task: "test", base_commit: "abc1234", CANON_PLUGIN_ROOT: "" },
      });

      // Should still succeed -- full review, no scope restriction
      expect(result.can_enter).toBe(true);
      // Prompt should not contain Scoped re-review since review_scope is empty
      const prompt = result.prompts[0]?.prompt ?? "";
      expect(prompt).not.toContain("Scoped re-review");
    });

    it("uses empty review_scope when git diff throws an exception", async () => {
      const workspace = makeTmpDir();
      const board = makeBoard({
        base_commit: "abc1234",
        states: {
          review: { status: "done", entries: 1 },
          done: { status: "pending", entries: 0 },
        },
      });
      const enteredBoard = makeBoard({
        base_commit: "abc1234",
        states: {
          review: { status: "in_progress", entries: 2 },
          done: { status: "pending", entries: 0 },
        },
      });
      vi.mocked(readBoard).mockResolvedValue(board);
      vi.mocked(enterState).mockReturnValue(enteredBoard);

      // Mock spawnSync to throw
      vi.mocked(spawnSync).mockImplementation(() => {
        throw new Error("spawn failed");
      });

      const flow = makeFlow();
      const result = await enterAndPrepareState({
        workspace,
        state_id: "review",
        flow,
        variables: { task: "test", base_commit: "abc1234", CANON_PLUGIN_ROOT: "" },
      });

      // Should degrade gracefully
      expect(result.can_enter).toBe(true);
      expect(result.prompts).toHaveLength(1);
    });

    it("uses empty review_scope when base_commit is missing", async () => {
      const workspace = makeTmpDir();
      const board = makeBoard({
        base_commit: "",
        states: {
          review: { status: "done", entries: 1 },
          done: { status: "pending", entries: 0 },
        },
      });
      const enteredBoard = makeBoard({
        base_commit: "",
        states: {
          review: { status: "in_progress", entries: 2 },
          done: { status: "pending", entries: 0 },
        },
      });
      vi.mocked(readBoard).mockResolvedValue(board);
      vi.mocked(enterState).mockReturnValue(enteredBoard);

      const flow = makeFlow();
      await enterAndPrepareState({
        workspace,
        state_id: "review",
        flow,
        variables: { task: "test", base_commit: "", CANON_PLUGIN_ROOT: "" },
      });

      // git diff should NOT be called when base_commit is empty
      expect(spawnSync).not.toHaveBeenCalled();
    });

    it("uses empty review_scope when base_commit fails the safety regex", async () => {
      const workspace = makeTmpDir();
      // An invalid/suspicious commit ref
      const board = makeBoard({
        base_commit: "not-a-valid-sha; rm -rf /",
        states: {
          review: { status: "done", entries: 1 },
          done: { status: "pending", entries: 0 },
        },
      });
      const enteredBoard = makeBoard({
        base_commit: "not-a-valid-sha; rm -rf /",
        states: {
          review: { status: "in_progress", entries: 2 },
          done: { status: "pending", entries: 0 },
        },
      });
      vi.mocked(readBoard).mockResolvedValue(board);
      vi.mocked(enterState).mockReturnValue(enteredBoard);

      const flow = makeFlow();
      await enterAndPrepareState({
        workspace,
        state_id: "review",
        flow,
        variables: { task: "test", base_commit: "not-a-valid-sha; rm -rf /", CANON_PLUGIN_ROOT: "" },
      });

      // git diff should NOT be called for an invalid base_commit
      expect(spawnSync).not.toHaveBeenCalled();
    });

    it("uses empty review_scope when git diff returns empty file list", async () => {
      const workspace = makeTmpDir();
      const board = makeBoard({
        base_commit: "abc1234",
        states: {
          review: { status: "done", entries: 1 },
          done: { status: "pending", entries: 0 },
        },
      });
      const enteredBoard = makeBoard({
        base_commit: "abc1234",
        states: {
          review: { status: "in_progress", entries: 2 },
          done: { status: "pending", entries: 0 },
        },
      });
      vi.mocked(readBoard).mockResolvedValue(board);
      vi.mocked(enterState).mockReturnValue(enteredBoard);

      // Git diff returns empty output (no files changed)
      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
        stdout: "",
        stderr: "",
        pid: 1,
        output: [],
        signal: null,
      });

      const flow = makeFlow();
      const result = await enterAndPrepareState({
        workspace,
        state_id: "review",
        flow,
        variables: { task: "test", base_commit: "abc1234", CANON_PLUGIN_ROOT: "" },
      });

      expect(result.can_enter).toBe(true);
      // Empty file list means review_scope remains empty
      const prompt = result.prompts[0]?.prompt ?? "";
      expect(prompt).not.toContain("Scoped re-review");
    });
  });

  describe("review_scope in spawn prompt", () => {
    it("review_scope variable is substituted in the spawn prompt", async () => {
      const workspace = makeTmpDir();
      const board = makeBoard({
        base_commit: "deadbeef",
        states: {
          review: { status: "done", entries: 1 },
          done: { status: "pending", entries: 0 },
        },
      });
      const enteredBoard = makeBoard({
        base_commit: "deadbeef",
        states: {
          review: { status: "in_progress", entries: 2 },
          done: { status: "pending", entries: 0 },
        },
      });
      vi.mocked(readBoard).mockResolvedValue(board);
      vi.mocked(enterState).mockReturnValue(enteredBoard);

      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
        stdout: "src/foo.ts\nsrc/bar.ts\n",
        stderr: "",
        pid: 1,
        output: [],
        signal: null,
      });

      const flow = makeFlow({
        spawn_instructions: {
          review: "Review via git diff. ${review_scope}\n${progress}",
        },
      });

      const result = await enterAndPrepareState({
        workspace,
        state_id: "review",
        flow,
        variables: { task: "test", base_commit: "deadbeef", CANON_PLUGIN_ROOT: "" },
      });

      expect(result.prompts).toHaveLength(1);
      const prompt = result.prompts[0].prompt;
      expect(prompt).toContain("Scoped re-review");
      expect(prompt).toContain("src/foo.ts");
      expect(prompt).toContain("src/bar.ts");
    });
  });
});
