/**
 * Tests for get-spawn-prompt.ts
 *
 * Covers:
 * 1. truncateProgress — pure function, all branches
 * 2. getSpawnPrompt calls readBoard exactly once (consolidation)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Hoist mock for readBoard before module import
// ---------------------------------------------------------------------------

vi.mock("../orchestration/board.js", () => ({
  readBoard: vi.fn(),
  writeBoard: vi.fn(),
}));

import { readBoard } from "../orchestration/board.ts";
import { truncateProgress, getSpawnPrompt } from "../tools/get-spawn-prompt.ts";
import type { Board, ResolvedFlow } from "../orchestration/flow-schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsp-test-"));
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
    states: {},
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
// truncateProgress — pure function tests
// ---------------------------------------------------------------------------

describe("truncateProgress", () => {
  it("returns unchanged content when there are 0 entries (header only)", () => {
    const content = "## Progress: My task\n";
    expect(truncateProgress(content, 8)).toBe(content);
  });

  it("returns unchanged content when entry count is under the cap", () => {
    const header = "## Progress: My task\n";
    const entries = [
      "- [research] done: found solution",
      "- [design] done: made plan",
      "- [implement] done: wrote code",
    ].join("\n");
    const content = header + "\n" + entries + "\n";
    expect(truncateProgress(content, 8)).toBe(content);
  });

  it("returns unchanged content when entry count equals the cap exactly", () => {
    const header = "## Progress: My task\n";
    const entries = Array.from({ length: 8 }, (_, i) => `- [state-${i}] done: step ${i}`).join("\n");
    const content = header + "\n" + entries + "\n";
    expect(truncateProgress(content, 8)).toBe(content);
  });

  it("truncates to last maxEntries when entry count exceeds cap", () => {
    const header = "## Progress: My task";
    const entries = Array.from({ length: 12 }, (_, i) => `- [state-${i}] done: step ${i}`);
    const content = header + "\n" + entries.join("\n");

    const result = truncateProgress(content, 8);

    // Must contain header
    expect(result).toContain(header);

    // Must contain the last 8 entries
    for (let i = 4; i < 12; i++) {
      expect(result).toContain(`- [state-${i}] done: step ${i}`);
    }

    // Must NOT contain the first 4 entries
    for (let i = 0; i < 4; i++) {
      expect(result).not.toContain(`- [state-${i}] done: step ${i}`);
    }
  });

  it("preserves header lines that appear before the first entry line", () => {
    const header = "## Progress: My task\n\nSome metadata line\n";
    const entries = Array.from({ length: 10 }, (_, i) => `- [state-${i}] done: step ${i}`);
    const content = header + entries.join("\n");

    const result = truncateProgress(content, 8);

    // Header and metadata must be preserved
    expect(result).toContain("## Progress: My task");
    expect(result).toContain("Some metadata line");

    // Only last 8 entries
    const entryLines = result.split("\n").filter(l => l.startsWith("- ["));
    expect(entryLines).toHaveLength(8);
  });

  it("handles content with no header (all lines are entries)", () => {
    const entries = Array.from({ length: 10 }, (_, i) => `- [state-${i}] done: step ${i}`);
    const content = entries.join("\n");

    const result = truncateProgress(content, 8);

    const entryLines = result.split("\n").filter(l => l.startsWith("- ["));
    expect(entryLines).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// getSpawnPrompt — readBoard called exactly once
// ---------------------------------------------------------------------------

describe("getSpawnPrompt — readBoard consolidation", () => {
  it("calls readBoard exactly once when state has skip_when", async () => {
    const workspace = makeTmpDir();
    const board = makeBoard();
    vi.mocked(readBoard).mockResolvedValue(board);

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

    await getSpawnPrompt({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "test", CANON_PLUGIN_ROOT: "" },
    });

    expect(readBoard).toHaveBeenCalledTimes(1);
  });

  it("calls readBoard exactly once when state has inject_context", async () => {
    const workspace = makeTmpDir();
    const board = makeBoard();
    vi.mocked(readBoard).mockResolvedValue(board);

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

    await getSpawnPrompt({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "test", CANON_PLUGIN_ROOT: "" },
    });

    expect(readBoard).toHaveBeenCalledTimes(1);
  });

  it("calls readBoard exactly once when state has large_diff_threshold", async () => {
    const workspace = makeTmpDir();
    const board = makeBoard();
    vi.mocked(readBoard).mockResolvedValue(board);

    const flow = makeFlow({
      states: {
        implement: {
          type: "parallel-per",
          agent: "canon-implementor",
          large_diff_threshold: 10,
        },
        done: { type: "terminal" },
      },
    });

    await getSpawnPrompt({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "test", CANON_PLUGIN_ROOT: "" },
      items: ["item1", "item2"],
    });

    expect(readBoard).toHaveBeenCalledTimes(1);
  });

  it("calls readBoard exactly once when all three conditions are present", async () => {
    const workspace = makeTmpDir();
    const board = makeBoard();
    vi.mocked(readBoard).mockResolvedValue(board);

    const flow = makeFlow({
      states: {
        implement: {
          type: "parallel-per",
          agent: "canon-implementor",
          skip_when: "no_contract_changes",
          inject_context: [{ from: "board", as: "ctx" }],
          large_diff_threshold: 10,
        },
        done: { type: "terminal" },
      },
    });

    await getSpawnPrompt({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "test", CANON_PLUGIN_ROOT: "" },
      items: ["item1"],
    });

    expect(readBoard).toHaveBeenCalledTimes(1);
  });

  it("does not call readBoard when no board-dependent features are used", async () => {
    const workspace = makeTmpDir();
    vi.mocked(readBoard).mockResolvedValue(makeBoard());

    const flow = makeFlow(); // no skip_when, inject_context, or large_diff_threshold

    await getSpawnPrompt({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "test", CANON_PLUGIN_ROOT: "" },
    });

    expect(readBoard).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// getSpawnPrompt — progress truncation integration
// ---------------------------------------------------------------------------

describe("getSpawnPrompt — progress truncation", () => {
  it("truncates progress to last 8 entries before injecting into prompt", async () => {
    const workspace = makeTmpDir();
    vi.mocked(readBoard).mockResolvedValue(makeBoard());

    // Write a progress.md with 12 entries
    const header = "## Progress: My task";
    const entries = Array.from({ length: 12 }, (_, i) => `- [state-${i}] done: step ${i}`);
    const progressContent = header + "\n" + entries.join("\n") + "\n";
    await writeFile(join(workspace, "progress.md"), progressContent, "utf-8");

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

    const prompt = result.prompts[0].prompt;

    // Last 8 entries should appear
    for (let i = 4; i < 12; i++) {
      expect(prompt).toContain(`- [state-${i}] done: step ${i}`);
    }
    // First 4 entries should NOT appear
    for (let i = 0; i < 4; i++) {
      expect(prompt).not.toContain(`- [state-${i}] done: step ${i}`);
    }
  });

  it("passes through all entries unchanged when count is within cap", async () => {
    const workspace = makeTmpDir();
    vi.mocked(readBoard).mockResolvedValue(makeBoard());

    const header = "## Progress: My task";
    const entries = Array.from({ length: 5 }, (_, i) => `- [state-${i}] done: step ${i}`);
    const progressContent = header + "\n" + entries.join("\n") + "\n";
    await writeFile(join(workspace, "progress.md"), progressContent, "utf-8");

    const flow = makeFlow({
      progress: "${WORKSPACE}/progress.md",
      spawn_instructions: { implement: "${progress}" },
    });

    const result = await getSpawnPrompt({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "my task", CANON_PLUGIN_ROOT: "" },
    });

    const prompt = result.prompts[0].prompt;
    for (let i = 0; i < 5; i++) {
      expect(prompt).toContain(`- [state-${i}] done: step ${i}`);
    }
  });
});
