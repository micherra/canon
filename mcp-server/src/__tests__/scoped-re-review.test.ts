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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Hoist mocks before module imports

vi.mock("../orchestration/skip-when.ts", () => ({
  evaluateSkipWhen: vi.fn(),
}));

vi.mock("../orchestration/event-bus-instance.ts", () => ({
  flowEventBus: {
    emit: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock("../orchestration/consultation-executor.ts", () => ({
  resolveConsultationPrompt: vi.fn(),
}));

vi.mock("../orchestration/wave-variables.ts", () => ({
  buildTemplateInjection: vi.fn(() => ""),
  escapeDollarBrace: vi.fn((s: string) => s),
  extractFilePaths: vi.fn(() => []),
  parseTaskIdsForWave: vi.fn(() => []),
  substituteVariables: vi.fn((s: string) => s),
}));

// Mock child_process for git diff
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import { getExecutionStore } from "../orchestration/execution-store.ts";
import type { Board, ResolvedFlow } from "../orchestration/flow-schema.ts";
import { assertOk } from "../shared/lib/tool-result.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "scoped-review-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeBoard(overrides: Record<string, unknown> = {}): Board {
  return {
    base_commit: "abc1234",
    blocked: null,
    concerns: [],
    current_state: "review",
    entry: "review",
    flow: "test-flow",
    iterations: {},
    last_updated: new Date().toISOString(),
    skipped: [],
    started: new Date().toISOString(),
    states: {
      done: { entries: 0, status: "pending" },
      review: { entries: 0, status: "pending" },
    },
    task: "test task",
    ...overrides,
  } as Board;
}

function makeFlow(overrides: Partial<ResolvedFlow> = {}): ResolvedFlow {
  return {
    description: "Test flow",
    entry: "review",
    name: "test-flow",
    spawn_instructions: {
      review: "Review changes via git diff ${base_commit}..HEAD. ${review_scope}",
    },
    states: {
      done: { type: "terminal" },
      review: { agent: "canon-reviewer", type: "single" },
    },
    ...overrides,
  };
}

function seedBoard(workspace: string, board: Board): void {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();
  store.initExecution({
    base_commit: board.base_commit,
    branch: "main",
    created: now,
    current_state: board.current_state,
    entry: board.entry,
    flow: board.flow,
    flow_name: board.flow,
    last_updated: board.last_updated ?? now,
    sanitized: "main",
    slug: "test-slug",
    started: board.started ?? now,
    task: board.task,
    tier: "medium",
  });
  for (const [stateId, stateEntry] of Object.entries(board.states)) {
    store.upsertState(stateId, {
      ...stateEntry,
      entries: stateEntry.entries ?? 0,
      status: stateEntry.status,
    });
  }
}

afterEach(() => {
  for (const d of tmpDirs) {
    rmSync(d, { force: true, recursive: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

describe("scoped re-review (review_scope injection)", () => {
  describe("first review (entries <= 1)", () => {
    it("does not inject review_scope when entries is 0", async () => {
      const workspace = makeTmpDir();
      // Pre-enter: entries=0 → after enterState: entries=1 (not > 1, no git diff)
      seedBoard(
        workspace,
        makeBoard({
          states: {
            done: { entries: 0, status: "pending" },
            review: { entries: 0, status: "pending" },
          },
        }),
      );

      const flow = makeFlow();
      const result = await enterAndPrepareState({
        flow,
        state_id: "review",
        variables: { base_commit: "abc1234", CANON_PLUGIN_ROOT: "", task: "test" },
        workspace,
      });
      assertOk(result);

      expect(result.can_enter).toBe(true);
      // git diff should NOT have been called for entries <= 1
      expect(spawnSync).not.toHaveBeenCalled();
    });

    it("does not inject review_scope when entries is 1", async () => {
      const workspace = makeTmpDir();
      // The check is: if enteredBoard.states[state_id]?.entries > 1
      // Pre-enter: entries=0 → after enterState: entries=1 (not > 1, no git diff)
      seedBoard(
        workspace,
        makeBoard({
          states: {
            done: { entries: 0, status: "pending" },
            review: { entries: 0, status: "done" },
          },
        }),
      );

      const flow = makeFlow();
      await enterAndPrepareState({
        flow,
        state_id: "review",
        variables: { base_commit: "abc1234", CANON_PLUGIN_ROOT: "", task: "test" },
        workspace,
      });

      // git diff should NOT be called for a non-re-entry
      expect(spawnSync).not.toHaveBeenCalled();
    });
  });

  describe("re-entry (entries > 1)", () => {
    it("injects review_scope with file list when git diff succeeds", async () => {
      const workspace = makeTmpDir();
      // Pre-enter: entries=1 → after enterState: entries=2 (re-entry, git diff called)
      seedBoard(
        workspace,
        makeBoard({
          base_commit: "abc1234",
          states: {
            done: { entries: 0, status: "pending" },
            review: { entries: 1, status: "done" },
          },
        }),
      );

      // Mock git diff to return changed files
      vi.mocked(spawnSync).mockReturnValue({
        output: [],
        pid: 1,
        signal: null,
        status: 0,
        stderr: "",
        stdout: "src/tools/enter-and-prepare-state.ts\nflows/fragments/review-fix-loop.md\n",
      });

      const flow = makeFlow();
      const result = await enterAndPrepareState({
        flow,
        state_id: "review",
        variables: { base_commit: "abc1234", CANON_PLUGIN_ROOT: "", task: "test" },
        workspace,
      });
      assertOk(result);

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
      // Pre-enter: entries=1 → after enterState: entries=2 (re-entry, git diff called)
      seedBoard(
        workspace,
        makeBoard({
          base_commit: "abc1234",
          states: {
            done: { entries: 0, status: "pending" },
            review: { entries: 1, status: "done" },
          },
        }),
      );

      // Mock git diff failure (non-zero exit code)
      vi.mocked(spawnSync).mockReturnValue({
        output: [],
        pid: 1,
        signal: null,
        status: 128,
        stderr: "fatal: not a git repository",
        stdout: "",
      });

      const flow = makeFlow();
      const result = await enterAndPrepareState({
        flow,
        state_id: "review",
        variables: { base_commit: "abc1234", CANON_PLUGIN_ROOT: "", task: "test" },
        workspace,
      });
      assertOk(result);

      // Should still succeed -- full review, no scope restriction
      expect(result.can_enter).toBe(true);
      // Prompt should not contain Scoped re-review since review_scope is empty
      const prompt = result.prompts[0]?.prompt ?? "";
      expect(prompt).not.toContain("Scoped re-review");
    });

    it("uses empty review_scope when git diff throws an exception", async () => {
      const workspace = makeTmpDir();
      // Pre-enter: entries=1 → after enterState: entries=2 (re-entry)
      seedBoard(
        workspace,
        makeBoard({
          base_commit: "abc1234",
          states: {
            done: { entries: 0, status: "pending" },
            review: { entries: 1, status: "done" },
          },
        }),
      );

      // Mock spawnSync to throw
      vi.mocked(spawnSync).mockImplementation(() => {
        throw new Error("spawn failed");
      });

      const flow = makeFlow();
      const result = await enterAndPrepareState({
        flow,
        state_id: "review",
        variables: { base_commit: "abc1234", CANON_PLUGIN_ROOT: "", task: "test" },
        workspace,
      });
      assertOk(result);

      // Should degrade gracefully
      expect(result.can_enter).toBe(true);
      expect(result.prompts).toHaveLength(1);
    });

    it("uses empty review_scope when base_commit is missing", async () => {
      const workspace = makeTmpDir();
      // Pre-enter: entries=1 → after enterState: entries=2 (re-entry, but no git diff due to empty base_commit)
      seedBoard(
        workspace,
        makeBoard({
          base_commit: "",
          states: {
            done: { entries: 0, status: "pending" },
            review: { entries: 1, status: "done" },
          },
        }),
      );

      const flow = makeFlow();
      await enterAndPrepareState({
        flow,
        state_id: "review",
        variables: { base_commit: "", CANON_PLUGIN_ROOT: "", task: "test" },
        workspace,
      });

      // git diff should NOT be called when base_commit is empty
      expect(spawnSync).not.toHaveBeenCalled();
    });

    it("uses empty review_scope when base_commit fails the safety regex", async () => {
      const workspace = makeTmpDir();
      // Pre-enter: entries=1 → after enterState: entries=2 (re-entry)
      // Invalid base_commit fails the safety regex, so no git diff
      seedBoard(
        workspace,
        makeBoard({
          base_commit: "not-a-valid-sha; rm -rf /",
          states: {
            done: { entries: 0, status: "pending" },
            review: { entries: 1, status: "done" },
          },
        }),
      );

      const flow = makeFlow();
      await enterAndPrepareState({
        flow,
        state_id: "review",
        variables: {
          base_commit: "not-a-valid-sha; rm -rf /",
          CANON_PLUGIN_ROOT: "",
          task: "test",
        },
        workspace,
      });

      // git diff should NOT be called for an invalid base_commit
      expect(spawnSync).not.toHaveBeenCalled();
    });

    it("uses empty review_scope when git diff returns empty file list", async () => {
      const workspace = makeTmpDir();
      // Pre-enter: entries=1 → after enterState: entries=2 (re-entry, git diff called but empty)
      seedBoard(
        workspace,
        makeBoard({
          base_commit: "abc1234",
          states: {
            done: { entries: 0, status: "pending" },
            review: { entries: 1, status: "done" },
          },
        }),
      );

      // Git diff returns empty output (no files changed)
      vi.mocked(spawnSync).mockReturnValue({
        output: [],
        pid: 1,
        signal: null,
        status: 0,
        stderr: "",
        stdout: "",
      });

      const flow = makeFlow();
      const result = await enterAndPrepareState({
        flow,
        state_id: "review",
        variables: { base_commit: "abc1234", CANON_PLUGIN_ROOT: "", task: "test" },
        workspace,
      });
      assertOk(result);

      expect(result.can_enter).toBe(true);
      // Empty file list means review_scope remains empty
      const prompt = result.prompts[0]?.prompt ?? "";
      expect(prompt).not.toContain("Scoped re-review");
    });
  });

  describe("review_scope in spawn prompt", () => {
    it("review_scope variable is substituted in the spawn prompt", async () => {
      const workspace = makeTmpDir();
      // Pre-enter: entries=1 → after enterState: entries=2 (re-entry)
      seedBoard(
        workspace,
        makeBoard({
          base_commit: "deadbeef",
          states: {
            done: { entries: 0, status: "pending" },
            review: { entries: 1, status: "done" },
          },
        }),
      );

      vi.mocked(spawnSync).mockReturnValue({
        output: [],
        pid: 1,
        signal: null,
        status: 0,
        stderr: "",
        stdout: "src/foo.ts\nsrc/bar.ts\n",
      });

      const flow = makeFlow({
        spawn_instructions: {
          review: "Review via git diff. ${review_scope}\n${progress}",
        },
      });

      const result = await enterAndPrepareState({
        flow,
        state_id: "review",
        variables: { base_commit: "deadbeef", CANON_PLUGIN_ROOT: "", task: "test" },
        workspace,
      });
      assertOk(result);

      expect(result.prompts).toHaveLength(1);
      const prompt = result.prompts[0].prompt;
      expect(prompt).toContain("Scoped re-review");
      expect(prompt).toContain("src/foo.ts");
      expect(prompt).toContain("src/bar.ts");
    });
  });
});
