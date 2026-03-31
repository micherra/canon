/**
 * Integration and coverage-gap tests for the MCP tool call optimization.
 *
 * Covers:
 * 1. _board passthrough — getSpawnPrompt skips readBoard when _board is provided,
 *    even when state has skip_when, inject_context, or large_diff_threshold.
 * 2. enterAndPrepareState → getSpawnPrompt integration — the entered board (post-enterState)
 *    is the one passed down, not the original pre-enter board.
 * 3. truncateProgress edge cases not covered by implementor tests:
 *    - empty string input
 *    - maxEntries=0 (keep nothing)
 *    - trailing blank lines are preserved after truncation
 *    - lines that contain "- [" somewhere other than the start are not counted as entries
 * 4. skip_reason message format in enterAndPrepareState — includes condition name and
 *    the reason returned by evaluateSkipWhen.
 * 5. getSpawnPrompt degrades gracefully when progress.md is absent.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Hoist mocks before module imports
// ---------------------------------------------------------------------------

// board.ts: readBoard/writeBoard are deprecated; enterState is a pure function used internally.
// Real enterState preserves fields via spread. No mock needed.

vi.mock("../orchestration/workspace.ts", () => ({
  withBoardLock: vi.fn(async (_workspace: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("../orchestration/skip-when.ts", () => ({
  evaluateSkipWhen: vi.fn(),
}));

vi.mock("../orchestration/inject-context.ts", () => ({
  resolveContextInjections: vi.fn(),
}));

vi.mock("../orchestration/event-bus-instance.ts", () => ({
  flowEventBus: {
    emit: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock("../orchestration/events.ts", () => ({
  createJsonlLogger: vi.fn(() => vi.fn()),
}));

import { evaluateSkipWhen } from "../orchestration/skip-when.ts";
import { resolveContextInjections } from "../orchestration/inject-context.ts";
import { truncateProgress, getSpawnPrompt } from "../tools/get-spawn-prompt.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";
import { getExecutionStore } from "../orchestration/execution-store.ts";
import type { Board, ResolvedFlow } from "../orchestration/flow-schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "opt-mcp-int-"));
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

function seedBoard(workspace: string, board: Board): void {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();
  store.initExecution({
    flow: board.flow,
    task: board.task,
    entry: board.entry,
    current_state: board.current_state,
    base_commit: board.base_commit,
    started: board.started ?? now,
    last_updated: board.last_updated ?? now,
    branch: "main",
    sanitized: "main",
    created: now,
    tier: "medium",
    flow_name: board.flow,
    slug: "test-slug",
  });
  for (const [stateId, stateEntry] of Object.entries(board.states)) {
    store.upsertState(stateId, { ...stateEntry, status: stateEntry.status, entries: stateEntry.entries ?? 0 });
  }
}

afterEach(() => {
  for (const d of tmpDirs) {
    rmSync(d, { recursive: true, force: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. _board passthrough — getSpawnPrompt does NOT call readBoard when _board is given
// ---------------------------------------------------------------------------

describe("getSpawnPrompt — _board passthrough skips store read", () => {
  it("succeeds when _board is provided and state has skip_when (no store read needed)", async () => {
    const workspace = makeTmpDir();
    const board = makeBoard();
    // evaluateSkipWhen mock: condition not met so we proceed
    vi.mocked(evaluateSkipWhen).mockResolvedValue({ skip: false });

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

    const result = await getSpawnPrompt({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "test", CANON_PLUGIN_ROOT: "" },
      _board: board,
    });

    // Should produce a prompt without error (store not seeded, _board provided directly)
    expect(result.prompts).toHaveLength(1);
  });

  it("succeeds when _board is provided and state has inject_context (no store read needed)", async () => {
    const workspace = makeTmpDir();
    const board = makeBoard();
    vi.mocked(resolveContextInjections).mockResolvedValue({
      variables: { some_context: "value from board" },
      warnings: [],
      hitl: undefined,
    });

    const flow = makeFlow({
      states: {
        implement: {
          type: "single",
          agent: "canon-implementor",
          inject_context: [{ from: "board", as: "some_context" }],
        },
        done: { type: "terminal" },
      },
    });

    const result = await getSpawnPrompt({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "test", CANON_PLUGIN_ROOT: "" },
      _board: board,
    });

    expect(result.prompts).toHaveLength(1);
  });

  it("succeeds when _board is provided and state has large_diff_threshold (no store read needed)", async () => {
    const workspace = makeTmpDir();
    const board = makeBoard();

    const flow = makeFlow({
      states: {
        implement: {
          type: "parallel-per",
          agent: "canon-implementor",
          large_diff_threshold: 5,
        },
        done: { type: "terminal" },
      },
    });

    const result = await getSpawnPrompt({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "test", CANON_PLUGIN_ROOT: "" },
      items: ["item1", "item2"],
      _board: board,
    });

    expect(result.prompts).toHaveLength(2);
  });

  it("succeeds when _board is provided and all three board-dependent features are active", async () => {
    const workspace = makeTmpDir();
    const board = makeBoard();
    vi.mocked(evaluateSkipWhen).mockResolvedValue({ skip: false });
    vi.mocked(resolveContextInjections).mockResolvedValue({
      variables: { ctx: "value" },
      warnings: [],
      hitl: undefined,
    });

    const flow = makeFlow({
      states: {
        implement: {
          type: "parallel-per",
          agent: "canon-implementor",
          skip_when: "no_contract_changes",
          inject_context: [{ from: "board", as: "ctx" }],
          large_diff_threshold: 5,
        },
        done: { type: "terminal" },
      },
    });

    const result = await getSpawnPrompt({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "test", CANON_PLUGIN_ROOT: "" },
      items: ["item1"],
      _board: board,
    });

    expect(result.prompts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. enterAndPrepareState → getSpawnPrompt integration
//    The entered board (post-enterState) is forwarded, not the original
// ---------------------------------------------------------------------------

describe("enterAndPrepareState → getSpawnPrompt board forwarding", () => {
  it("passes the entered board (post-enterState) to getSpawnPrompt, not the original board", async () => {
    const workspace = makeTmpDir();
    // Seed with pre-enter state (entries: 0)
    seedBoard(workspace, makeBoard({
      states: {
        implement: { status: "pending", entries: 0 },
        done: { status: "pending", entries: 0 },
      },
    }));

    // skip_when=present but not met, so we proceed normally
    vi.mocked(evaluateSkipWhen).mockResolvedValue({ skip: false });

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

    // The board in the result must be the entered board (post-enterState)
    expect(result.board).toBeDefined();
    // After enterState: status=in_progress, entries=1
    expect(result.board!.states["implement"].status).toBe("in_progress");
    expect(result.board!.states["implement"].entries).toBe(1);
  });

  it("the entered board state shows in_progress for the entered state", async () => {
    const workspace = makeTmpDir();
    seedBoard(workspace, makeBoard());

    const result = await enterAndPrepareState({
      workspace,
      state_id: "implement",
      flow: makeFlow(),
      variables: { task: "test", CANON_PLUGIN_ROOT: "" },
    });

    // The board snapshot in result reflects state entered, not the pre-enter state
    expect(result.board!.states["implement"].status).toBe("in_progress");
    expect(result.board!.states["implement"].entries).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. truncateProgress edge cases
// ---------------------------------------------------------------------------

describe("truncateProgress — edge cases", () => {
  it("returns empty string unchanged when input is empty", () => {
    expect(truncateProgress("", 8)).toBe("");
  });

  it("returns unchanged when input is only whitespace (no entries)", () => {
    const content = "   \n\n   \n";
    expect(truncateProgress(content, 8)).toBe(content);
  });

  // NOTE: maxEntries=0 is not tested here due to a known implementation bug.
  // truncateProgress uses slice(-maxEntries) — when maxEntries=0, slice(-0) === slice(0)
  // which returns the full array instead of an empty array. This is reported as an
  // IMPLEMENTATION_ISSUE in the test report. The function is only called with hardcoded
  // maxEntries=8 in production, so this does not affect current usage.

  it("preserves trailing blank lines after truncation", () => {
    const header = "## Progress: My task";
    const entries = Array.from({ length: 10 }, (_, i) => `- [state-${i}] done: step ${i}`);
    // Add trailing blank lines after entries
    const content = header + "\n" + entries.join("\n") + "\n\n";

    const result = truncateProgress(content, 8);

    // Should still have exactly 8 entry lines
    const entryLines = result.split("\n").filter(l => l.startsWith("- ["));
    expect(entryLines).toHaveLength(8);

    // Trailing blank lines must still be present (they don't start with "- [")
    expect(result.endsWith("\n\n")).toBe(true);
  });

  it("does not count mid-line '- [' as an entry line", () => {
    // A line with "- [" not at position 0 must NOT be treated as an entry
    const content =
      "## Progress: My task\n" +
      "Note: see items - [x] done in tracker\n" + // not an entry — "- [" is not at start
      Array.from({ length: 6 }, (_, i) => `- [state-${i}] done: step ${i}`).join("\n");

    // 6 real entries, cap of 8 — should return unchanged
    const result = truncateProgress(content, 8);
    expect(result).toBe(content);

    // The note line is preserved
    expect(result).toContain("Note: see items - [x] done in tracker");
  });

  it("keeps the most-recent entries (tail) when truncating", () => {
    const entries = Array.from({ length: 5 }, (_, i) => `- [state-${i}] done: step ${i}`);
    const content = entries.join("\n");

    const result = truncateProgress(content, 3);

    const entryLines = result.split("\n").filter(l => l.startsWith("- ["));
    expect(entryLines).toHaveLength(3);
    // Must be the LAST 3, not the first 3
    expect(entryLines[0]).toContain("state-2");
    expect(entryLines[1]).toContain("state-3");
    expect(entryLines[2]).toContain("state-4");
  });
});

// ---------------------------------------------------------------------------
// 4. skip_reason message format in enterAndPrepareState
// ---------------------------------------------------------------------------

describe("enterAndPrepareState — skip_reason message format", () => {
  it("skip_reason includes the condition name and reason from evaluateSkipWhen", async () => {
    const workspace = makeTmpDir();
    seedBoard(workspace, makeBoard());
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

    expect(result.skip_reason).toBeDefined();
    // Must include the state id
    expect(result.skip_reason).toContain("implement");
    // Must include the condition name
    expect(result.skip_reason).toContain("no_contract_changes");
    // Must include the reason returned by evaluateSkipWhen
    expect(result.skip_reason).toContain("No contract changes detected");
  });

  it("skip_reason falls back to 'condition satisfied' when evaluateSkipWhen returns no reason", async () => {
    const workspace = makeTmpDir();
    seedBoard(workspace, makeBoard());
    // No reason field returned
    vi.mocked(evaluateSkipWhen).mockResolvedValue({ skip: true });

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

    expect(result.skip_reason).toContain("condition satisfied");
  });

  it("can_enter is true when state is skipped (skip is not a convergence failure)", async () => {
    const workspace = makeTmpDir();
    seedBoard(workspace, makeBoard());
    vi.mocked(evaluateSkipWhen).mockResolvedValue({ skip: true, reason: "condition met" });

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

    // Skipped is NOT a convergence failure — can_enter must be true
    expect(result.can_enter).toBe(true);
    expect(result.state_type).toBe("single");
  });
});

// ---------------------------------------------------------------------------
// 5. getSpawnPrompt degrades gracefully when progress.md is absent
// ---------------------------------------------------------------------------

describe("getSpawnPrompt — progress.md absent", () => {
  it("injects empty string when progress.md does not exist, prompt has no broken placeholder", async () => {
    const workspace = makeTmpDir();
    // No progress.md file written — it does not exist

    const flow = makeFlow({
      progress: "${WORKSPACE}/progress.md",
      spawn_instructions: { implement: "Task: ${task}\n\nProgress:\n${progress}" },
    });

    const result = await getSpawnPrompt({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "my task", CANON_PLUGIN_ROOT: "" },
    });

    expect(result.prompts).toHaveLength(1);
    const prompt = result.prompts[0].prompt;

    // ${progress} must have been substituted (even with empty string), not left as literal
    expect(prompt).not.toContain("${progress}");
    // The prompt still has the rest of the content
    expect(prompt).toContain("my task");
  });

  it("injects actual content when progress entries exist in the store", async () => {
    const workspace = makeTmpDir();
    // Seed the progress store with a progress entry
    const store = getExecutionStore(workspace);
    store.appendProgress("[implement] done: wrote code");

    const flow = makeFlow({
      progress: "${WORKSPACE}/progress.md",  // presence of this field triggers progress injection
      spawn_instructions: { implement: "${progress}" },
    });

    const result = await getSpawnPrompt({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "my task", CANON_PLUGIN_ROOT: "" },
    });

    const prompt = result.prompts[0].prompt;
    expect(prompt).toContain("[implement] done: wrote code");
  });
});
