/**
 * Tests for get-spawn-prompt.ts
 *
 * Covers:
 * 1. getSpawnPrompt — board state comes from ExecutionStore (not readBoard)
 * 2. getSpawnPrompt — progress content comes from store.getProgress() (not readFile)
 * 3. getSpawnPrompt — wave briefing injection via consultation_outputs
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Mock execution-store so tests don't need a real SQLite DB
// ---------------------------------------------------------------------------

const mockStore = {
  getBoard: vi.fn(),
  getProgress: vi.fn(),
  appendProgress: vi.fn(),
  getExecution: vi.fn(),
};

vi.mock("../orchestration/execution-store.ts", () => ({
  getExecutionStore: vi.fn(() => mockStore),
}));

// ---------------------------------------------------------------------------
// Hoist mock for wave-briefing before module import
// ---------------------------------------------------------------------------

vi.mock("../orchestration/wave-briefing.ts", () => ({
  readWaveGuidance: vi.fn().mockResolvedValue(""),
  assembleWaveBriefing: vi.fn(),
}));

import { getExecutionStore } from "../orchestration/execution-store.ts";
import { assembleWaveBriefing } from "../orchestration/wave-briefing.ts";
import { getSpawnPrompt } from "../tools/get-spawn-prompt.ts";
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

function makeWaveFlow(overrides: Partial<ResolvedFlow> = {}): ResolvedFlow {
  return {
    name: "test-wave-flow",
    description: "Test wave flow",
    entry: "build",
    states: {
      build: { type: "wave", agent: "canon-implementor" },
      done: { type: "terminal" },
    },
    spawn_instructions: { build: "Build ${item}." },
    ...overrides,
  };
}

afterEach(() => {
  for (const d of tmpDirs) {
    rmSync(d, { recursive: true, force: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
  // Reset mock store
  mockStore.getBoard.mockReset();
  mockStore.getProgress.mockReset();
  mockStore.appendProgress.mockReset();
  mockStore.getExecution.mockReset();
});

// ---------------------------------------------------------------------------
// getSpawnPrompt — board state comes from store
// ---------------------------------------------------------------------------

describe("getSpawnPrompt — board state from ExecutionStore", () => {
  it("reads board from store when _board is not provided and board is needed", async () => {
    const workspace = makeTmpDir();
    const board = makeBoard();
    mockStore.getBoard.mockReturnValue(board);
    mockStore.getProgress.mockReturnValue("");

    const flow = makeFlow({
      states: {
        implement: { type: "single", agent: "canon-implementor", skip_when: "auto_approved" },
        done: { type: "terminal" },
      },
    });

    await getSpawnPrompt({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "my task", CANON_PLUGIN_ROOT: "" },
    });

    // Store should have been queried for board (skip_when requires board)
    expect(vi.mocked(getExecutionStore)).toHaveBeenCalledWith(workspace);
    expect(mockStore.getBoard).toHaveBeenCalled();
  });

  it("uses _board directly when provided (no store call for board)", async () => {
    const workspace = makeTmpDir();
    const board = makeBoard();
    mockStore.getProgress.mockReturnValue("");

    const flow = makeFlow();

    await getSpawnPrompt({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "my task", CANON_PLUGIN_ROOT: "" },
      _board: board,
    });

    // Store should NOT have been called for board since _board was provided
    expect(mockStore.getBoard).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getSpawnPrompt — progress from store
// ---------------------------------------------------------------------------

describe("getSpawnPrompt — progress from store", () => {
  it("reads progress from store when flow.progress is configured", async () => {
    const workspace = makeTmpDir();
    mockStore.getBoard.mockReturnValue(makeBoard());
    mockStore.getProgress.mockReturnValue("- Progress entry 1\n- Progress entry 2");

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
    expect(prompt).toContain("Progress entry 1");
    expect(prompt).toContain("Progress entry 2");

    // Store.getProgress should have been called with 8 (the max entries cap)
    expect(mockStore.getProgress).toHaveBeenCalledWith(8);
  });

  it("injects empty progress string when store returns empty", async () => {
    const workspace = makeTmpDir();
    mockStore.getBoard.mockReturnValue(makeBoard());
    mockStore.getProgress.mockReturnValue("");

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
    // Should not throw; progress is just empty
    expect(result.prompts[0].prompt).toBeDefined();
  });

  it("reads progress from store.getProgress() (not from file system)", async () => {
    // Verifies that progress content comes from store.getProgress(), not fs.readFile()
    // by confirming: (1) mockStore.getProgress was called, (2) the content appears in prompt
    const workspace = makeTmpDir();
    mockStore.getBoard.mockReturnValue(makeBoard());
    mockStore.getProgress.mockReturnValue("- step done");

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

    // Store.getProgress must have been called (store-based, not file-based)
    expect(mockStore.getProgress).toHaveBeenCalledWith(8);
    // Content from store must appear in the prompt
    expect(result.prompts[0].prompt).toContain("- step done");
  });
});

// ---------------------------------------------------------------------------
// getSpawnPrompt — wave briefing injection
// ---------------------------------------------------------------------------

describe("getSpawnPrompt — wave briefing injection", () => {
  it("injects assembleWaveBriefing output into wave-type prompts when consultation_outputs is provided", async () => {
    const workspace = makeTmpDir();
    mockStore.getBoard.mockReturnValue(makeBoard());
    mockStore.getProgress.mockReturnValue("");
    vi.mocked(assembleWaveBriefing).mockReturnValue("## Wave Briefing (from wave 1)\n\n### Security\nUse parameterized queries.");

    const flow = makeWaveFlow();

    const result = await getSpawnPrompt({
      workspace,
      state_id: "build",
      flow,
      variables: { task: "my task", CANON_PLUGIN_ROOT: "" },
      items: ["task-a", "task-b"],
      wave: 1,
      consultation_outputs: {
        security: { section: "Security", summary: "Use parameterized queries." },
      },
    });

    expect(vi.mocked(assembleWaveBriefing)).toHaveBeenCalledWith({
      wave: 1,
      summaries: [],
      consultationOutputs: {
        security: { section: "Security", summary: "Use parameterized queries." },
      },
    });

    expect(result.prompts).toHaveLength(2);
    for (const entry of result.prompts) {
      expect(entry.prompt).toContain("## Wave Briefing (from wave 1)");
      expect(entry.prompt).toContain("Use parameterized queries.");
    }
  });

  it("does not inject briefing when consultation_outputs is undefined", async () => {
    const workspace = makeTmpDir();
    mockStore.getBoard.mockReturnValue(makeBoard());
    mockStore.getProgress.mockReturnValue("");
    vi.mocked(assembleWaveBriefing).mockReturnValue("## Wave Briefing (from wave 1)\n");

    const flow = makeWaveFlow();

    const result = await getSpawnPrompt({
      workspace,
      state_id: "build",
      flow,
      variables: { task: "my task", CANON_PLUGIN_ROOT: "" },
      items: ["task-a"],
      wave: 1,
    });

    expect(vi.mocked(assembleWaveBriefing)).not.toHaveBeenCalled();
    expect(result.prompts[0].prompt).not.toContain("Wave Briefing");
  });

  it("does not inject briefing for single-type states", async () => {
    const workspace = makeTmpDir();
    mockStore.getBoard.mockReturnValue(makeBoard());
    mockStore.getProgress.mockReturnValue("");
    vi.mocked(assembleWaveBriefing).mockReturnValue("## Wave Briefing (from wave 1)\n");

    const flow = makeFlow();

    const result = await getSpawnPrompt({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "my task", CANON_PLUGIN_ROOT: "" },
      wave: 1,
      consultation_outputs: {
        security: { section: "Security", summary: "Some advice." },
      },
    });

    expect(vi.mocked(assembleWaveBriefing)).not.toHaveBeenCalled();
    expect(result.prompts[0].prompt).not.toContain("Wave Briefing");
  });

  it("pre-escaped \\${ patterns survive unchanged in assembled prompt", async () => {
    const workspace = makeTmpDir();
    mockStore.getBoard.mockReturnValue(makeBoard());
    mockStore.getProgress.mockReturnValue("");

    const escapedSummary = "Use \\${PARAM} in queries.";
    vi.mocked(assembleWaveBriefing).mockReturnValue(`## Wave Briefing (from wave 1)\n\n### Security\n${escapedSummary}`);

    const flow = makeWaveFlow();

    const result = await getSpawnPrompt({
      workspace,
      state_id: "build",
      flow,
      variables: { task: "my task", CANON_PLUGIN_ROOT: "" },
      items: ["task-a"],
      wave: 2,
      consultation_outputs: {
        security: { section: "Security", summary: escapedSummary },
      },
    });

    expect(result.prompts[0].prompt).toContain("\\${PARAM}");
  });

  it("does not inject briefing when assembleWaveBriefing returns empty string", async () => {
    const workspace = makeTmpDir();
    mockStore.getBoard.mockReturnValue(makeBoard());
    mockStore.getProgress.mockReturnValue("");
    vi.mocked(assembleWaveBriefing).mockReturnValue("");

    const flow = makeWaveFlow();
    const result = await getSpawnPrompt({
      workspace,
      state_id: "build",
      flow,
      variables: { task: "my task", CANON_PLUGIN_ROOT: "" },
      items: ["task-a"],
      wave: 1,
      consultation_outputs: {},
    });

    expect(result.prompts[0].prompt).not.toContain("\n\n\n\n");
  });

  it("injects briefing into parallel-per state prompts", async () => {
    const workspace = makeTmpDir();
    mockStore.getBoard.mockReturnValue(makeBoard());
    mockStore.getProgress.mockReturnValue("");
    vi.mocked(assembleWaveBriefing).mockReturnValue("## Wave Briefing (from wave 1)\n\n### Arch\nUse services.");

    const flow: ResolvedFlow = {
      name: "test-parallel-per-flow",
      description: "Test parallel-per flow",
      entry: "review",
      states: {
        review: { type: "parallel-per", agent: "canon-reviewer" },
        done: { type: "terminal" },
      },
      spawn_instructions: { review: "Review ${item}." },
    };

    const result = await getSpawnPrompt({
      workspace,
      state_id: "review",
      flow,
      variables: { task: "my task", CANON_PLUGIN_ROOT: "" },
      items: ["file-a.ts", "file-b.ts"],
      wave: 1,
      consultation_outputs: {
        arch: { section: "Arch", summary: "Use services." },
      },
    });

    expect(result.prompts).toHaveLength(2);
    for (const entry of result.prompts) {
      expect(entry.prompt).toContain("## Wave Briefing (from wave 1)");
    }
  });
});
