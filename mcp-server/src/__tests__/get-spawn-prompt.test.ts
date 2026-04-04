/**
 * Tests for get-spawn-prompt.ts
 *
 * Covers:
 * 1. getSpawnPrompt — board state comes from ExecutionStore (not readBoard)
 * 2. getSpawnPrompt — progress content comes from store.getProgress() (not readFile)
 * 3. getSpawnPrompt — wave briefing injection via consultation_outputs
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock execution-store so tests don't need a real SQLite DB

const mockStore = {
  appendProgress: vi.fn(),
  getBoard: vi.fn(),
  getCachePrefix: vi.fn().mockReturnValue(""),
  getExecution: vi.fn(),
  getProgress: vi.fn(),
};

vi.mock("../orchestration/execution-store.ts", () => ({
  getExecutionStore: vi.fn(() => mockStore),
}));

// Hoist mock for wave-briefing before module import

vi.mock("../orchestration/wave-briefing.ts", () => ({
  assembleWaveBriefing: vi.fn(),
  readWaveGuidance: vi.fn().mockResolvedValue(""),
}));

import { getExecutionStore } from "../orchestration/execution-store.ts";
import type { Board, ResolvedFlow } from "../orchestration/flow-schema.ts";
import { assembleWaveBriefing } from "../orchestration/wave-briefing.ts";
import { getSpawnPrompt } from "../tools/get-spawn-prompt.ts";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsp-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeBoard(overrides: Record<string, unknown> = {}): Board {
  return {
    base_commit: "abc1234",
    blocked: null,
    concerns: [],
    current_state: "implement",
    entry: "implement",
    flow: "test-flow",
    iterations: {},
    last_updated: new Date().toISOString(),
    skipped: [],
    started: new Date().toISOString(),
    states: {},
    task: "test task",
    ...overrides,
  } as Board;
}

function makeFlow(overrides: Partial<ResolvedFlow> = {}): ResolvedFlow {
  return {
    description: "Test flow",
    entry: "implement",
    name: "test-flow",
    spawn_instructions: { implement: "Implement ${task}." },
    states: {
      done: { type: "terminal" },
      implement: { agent: "canon-implementor", type: "single" },
    },
    ...overrides,
  };
}

function makeWaveFlow(overrides: Partial<ResolvedFlow> = {}): ResolvedFlow {
  return {
    description: "Test wave flow",
    entry: "build",
    name: "test-wave-flow",
    spawn_instructions: { build: "Build ${item}." },
    states: {
      build: { agent: "canon-implementor", type: "wave" },
      done: { type: "terminal" },
    },
    ...overrides,
  };
}

afterEach(() => {
  for (const d of tmpDirs) {
    rmSync(d, { force: true, recursive: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
  // Reset mock store
  mockStore.getBoard.mockReset();
  mockStore.getProgress.mockReset();
  mockStore.appendProgress.mockReset();
  mockStore.getExecution.mockReset();
});

// getSpawnPrompt — board state comes from store

describe("getSpawnPrompt — board state from ExecutionStore", () => {
  it("reads board from store when _board is not provided and board is needed", async () => {
    const workspace = makeTmpDir();
    const board = makeBoard();
    mockStore.getBoard.mockReturnValue(board);
    mockStore.getProgress.mockReturnValue("");

    const flow = makeFlow({
      states: {
        done: { type: "terminal" },
        implement: { agent: "canon-implementor", skip_when: "auto_approved", type: "single" },
      },
    });

    await getSpawnPrompt({
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "my task" },
      workspace,
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
      _board: board,
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "my task" },
      workspace,
    });

    // Store should NOT have been called for board since _board was provided
    expect(mockStore.getBoard).not.toHaveBeenCalled();
  });
});

// getSpawnPrompt — progress from store

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
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "my task" },
      workspace,
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
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "my task" },
      workspace,
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
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "my task" },
      workspace,
    });

    // Store.getProgress must have been called (store-based, not file-based)
    expect(mockStore.getProgress).toHaveBeenCalledWith(8);
    // Content from store must appear in the prompt
    expect(result.prompts[0].prompt).toContain("- step done");
  });
});

// getSpawnPrompt — wave briefing injection

describe("getSpawnPrompt — wave briefing injection", () => {
  it("injects assembleWaveBriefing output into wave-type prompts when consultation_outputs is provided", async () => {
    const workspace = makeTmpDir();
    mockStore.getBoard.mockReturnValue(makeBoard());
    mockStore.getProgress.mockReturnValue("");
    vi.mocked(assembleWaveBriefing).mockReturnValue(
      "## Wave Briefing (from wave 1)\n\n### Security\nUse parameterized queries.",
    );

    const flow = makeWaveFlow();

    const result = await getSpawnPrompt({
      consultation_outputs: {
        security: { section: "Security", summary: "Use parameterized queries." },
      },
      flow,
      items: ["task-a", "task-b"],
      state_id: "build",
      variables: { CANON_PLUGIN_ROOT: "", task: "my task" },
      wave: 1,
      workspace,
    });

    expect(vi.mocked(assembleWaveBriefing)).toHaveBeenCalledWith({
      consultationOutputs: {
        security: { section: "Security", summary: "Use parameterized queries." },
      },
      summaries: [],
      wave: 1,
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
      flow,
      items: ["task-a"],
      state_id: "build",
      variables: { CANON_PLUGIN_ROOT: "", task: "my task" },
      wave: 1,
      workspace,
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
      consultation_outputs: {
        security: { section: "Security", summary: "Some advice." },
      },
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "my task" },
      wave: 1,
      workspace,
    });

    expect(vi.mocked(assembleWaveBriefing)).not.toHaveBeenCalled();
    expect(result.prompts[0].prompt).not.toContain("Wave Briefing");
  });

  it("pre-escaped \\${ patterns survive unchanged in assembled prompt", async () => {
    const workspace = makeTmpDir();
    mockStore.getBoard.mockReturnValue(makeBoard());
    mockStore.getProgress.mockReturnValue("");

    const escapedSummary = "Use \\${PARAM} in queries.";
    vi.mocked(assembleWaveBriefing).mockReturnValue(
      `## Wave Briefing (from wave 1)\n\n### Security\n${escapedSummary}`,
    );

    const flow = makeWaveFlow();

    const result = await getSpawnPrompt({
      consultation_outputs: {
        security: { section: "Security", summary: escapedSummary },
      },
      flow,
      items: ["task-a"],
      state_id: "build",
      variables: { CANON_PLUGIN_ROOT: "", task: "my task" },
      wave: 2,
      workspace,
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
      consultation_outputs: {},
      flow,
      items: ["task-a"],
      state_id: "build",
      variables: { CANON_PLUGIN_ROOT: "", task: "my task" },
      wave: 1,
      workspace,
    });

    expect(result.prompts[0].prompt).not.toContain("\n\n\n\n");
  });

  it("injects briefing into parallel-per state prompts", async () => {
    const workspace = makeTmpDir();
    mockStore.getBoard.mockReturnValue(makeBoard());
    mockStore.getProgress.mockReturnValue("");
    vi.mocked(assembleWaveBriefing).mockReturnValue(
      "## Wave Briefing (from wave 1)\n\n### Arch\nUse services.",
    );

    const flow: ResolvedFlow = {
      description: "Test parallel-per flow",
      entry: "review",
      name: "test-parallel-per-flow",
      spawn_instructions: { review: "Review ${item}." },
      states: {
        done: { type: "terminal" },
        review: { agent: "canon-reviewer", type: "parallel-per" },
      },
    };

    const result = await getSpawnPrompt({
      consultation_outputs: {
        arch: { section: "Arch", summary: "Use services." },
      },
      flow,
      items: ["file-a.ts", "file-b.ts"],
      state_id: "review",
      variables: { CANON_PLUGIN_ROOT: "", task: "my task" },
      wave: 1,
      workspace,
    });

    expect(result.prompts).toHaveLength(2);
    for (const entry of result.prompts) {
      expect(entry.prompt).toContain("## Wave Briefing (from wave 1)");
    }
  });
});

// getSpawnPrompt — metrics footer injection

describe("getSpawnPrompt — metrics footer injection", () => {
  it("appends metrics footer to every prompt entry from a single state", async () => {
    const workspace = makeTmpDir();
    mockStore.getBoard.mockReturnValue(makeBoard());
    mockStore.getProgress.mockReturnValue("");

    const flow = makeFlow();

    const result = await getSpawnPrompt({
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "my task" },
      workspace,
    });

    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0].prompt).toContain("## Performance Metrics");
    expect(result.prompts[0].prompt).toContain("record_agent_metrics");
    expect(result.prompts[0].prompt).toContain(`workspace: "${workspace}"`);
    expect(result.prompts[0].prompt).toContain(`state_id: "implement"`);
  });

  it("includes correct workspace and state_id values in footer", async () => {
    const workspace = makeTmpDir();
    mockStore.getBoard.mockReturnValue(makeBoard());
    mockStore.getProgress.mockReturnValue("");

    const flow: ResolvedFlow = {
      ...makeFlow(),
      entry: "review",
      spawn_instructions: { review: "Review the code." },
      states: {
        done: { type: "terminal" as const },
        review: { agent: "canon-reviewer", type: "single" as const },
      },
    };

    const result = await getSpawnPrompt({
      flow,
      state_id: "review",
      variables: { CANON_PLUGIN_ROOT: "", task: "review task" },
      workspace,
    });

    const prompt = result.prompts[0].prompt;
    expect(prompt).toContain(`workspace: "${workspace}"`);
    expect(prompt).toContain(`state_id: "review"`);
  });

  it("metrics footer appears after all other injections (after template, messaging, wave guidance)", async () => {
    const workspace = makeTmpDir();
    mockStore.getBoard.mockReturnValue(makeBoard());
    mockStore.getProgress.mockReturnValue("");
    vi.mocked(assembleWaveBriefing).mockReturnValue(
      "## Wave Briefing (from wave 1)\n\nSome briefing.",
    );

    const flow = makeWaveFlow();

    const result = await getSpawnPrompt({
      consultation_outputs: {
        security: { section: "Security", summary: "Use parameterized queries." },
      },
      flow,
      items: ["task-a"],
      state_id: "build",
      variables: { CANON_PLUGIN_ROOT: "", task: "my task" },
      wave: 1,
      workspace,
    });

    expect(result.prompts).toHaveLength(1);
    const prompt = result.prompts[0].prompt;

    // Wave briefing should appear before metrics footer
    const briefingIndex = prompt.indexOf("## Wave Briefing");
    const footerIndex = prompt.indexOf("## Performance Metrics");
    expect(briefingIndex).toBeGreaterThan(-1);
    expect(footerIndex).toBeGreaterThan(-1);
    expect(footerIndex).toBeGreaterThan(briefingIndex);
  });

  it("appends footer to all prompt entries in a wave state", async () => {
    const workspace = makeTmpDir();
    mockStore.getBoard.mockReturnValue(makeBoard());
    mockStore.getProgress.mockReturnValue("");

    const flow = makeWaveFlow();

    const result = await getSpawnPrompt({
      flow,
      items: ["task-a", "task-b", "task-c"],
      state_id: "build",
      variables: { CANON_PLUGIN_ROOT: "", task: "my task" },
      workspace,
    });

    expect(result.prompts).toHaveLength(3);
    for (const entry of result.prompts) {
      expect(entry.prompt).toContain("## Performance Metrics");
      expect(entry.prompt).toContain("record_agent_metrics");
    }
  });

  it("terminal states return empty prompts array — no footer injection", async () => {
    const workspace = makeTmpDir();
    mockStore.getBoard.mockReturnValue(makeBoard());
    mockStore.getProgress.mockReturnValue("");

    const flow: ResolvedFlow = {
      ...makeFlow(),
      spawn_instructions: { implement: "Implement ${task}." },
      states: {
        done: { type: "terminal" as const },
        implement: { agent: "canon-implementor", type: "single" as const },
      },
    };

    const result = await getSpawnPrompt({
      flow,
      state_id: "done",
      variables: { CANON_PLUGIN_ROOT: "", task: "my task" },
      workspace,
    });

    expect(result.state_type).toBe("terminal");
    expect(result.prompts).toHaveLength(0);
  });
});
