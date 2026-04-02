/**
 * Tests for isolation field on SpawnPromptEntry in get-spawn-prompt.ts
 *
 * Covers:
 * - Wave state prompts include isolation: "worktree" on all entries
 * - Non-wave state prompts (single) do NOT include isolation field
 * - parallel-per state prompts include isolation: "worktree"
 * - SpawnPromptEntry.worktree_path field is present as optional (not set by getSpawnPrompt itself)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock execution-store so tests don't need a real SQLite DB
// ---------------------------------------------------------------------------

const mockStore = {
  getBoard: vi.fn(),
  getProgress: vi.fn().mockReturnValue(""),
  appendProgress: vi.fn(),
  getExecution: vi.fn(),
  getCachePrefix: vi.fn().mockReturnValue(""),
};

vi.mock("../orchestration/execution-store.ts", () => ({
  getExecutionStore: vi.fn(() => mockStore),
}));

vi.mock("../orchestration/wave-briefing.ts", () => ({
  readWaveGuidance: vi.fn().mockResolvedValue(""),
  assembleWaveBriefing: vi.fn().mockReturnValue(""),
}));

import type { ResolvedFlow } from "../orchestration/flow-schema.ts";
import { getSpawnPrompt } from "../tools/get-spawn-prompt.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsp-iso-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs) {
    rmSync(d, { recursive: true, force: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

function makeWaveFlow(overrides: Partial<ResolvedFlow> = {}): ResolvedFlow {
  return {
    name: "test-flow",
    description: "Test flow",
    entry: "implement",
    states: {
      implement: {
        type: "wave",
        agent: "canon-implementor",
      },
    },
    spawn_instructions: {
      implement: "Implement task ${item}",
    },
    ...overrides,
  } as ResolvedFlow;
}

function makeSingleFlow(): ResolvedFlow {
  return {
    name: "test-flow",
    description: "Test flow",
    entry: "research",
    states: {
      research: {
        type: "single",
        agent: "canon-researcher",
      },
    },
    spawn_instructions: {
      research: "Research the problem",
    },
  } as ResolvedFlow;
}

function makeParallelPerFlow(): ResolvedFlow {
  return {
    name: "test-flow",
    description: "Test flow",
    entry: "implement",
    states: {
      implement: {
        type: "parallel-per",
        agent: "canon-implementor",
      },
    },
    spawn_instructions: {
      implement: "Implement ${item}",
    },
  } as ResolvedFlow;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getSpawnPrompt — wave state isolation", () => {
  it("sets isolation: 'worktree' on all wave state prompt entries", async () => {
    const workspace = makeTmpDir();
    const flow = makeWaveFlow();

    const result = await getSpawnPrompt({
      workspace,
      state_id: "implement",
      flow,
      variables: {},
      items: ["task-01", "task-02", "task-03"],
    });

    expect(result.prompts).toHaveLength(3);
    for (const entry of result.prompts) {
      expect(entry.isolation).toBe("worktree");
    }
  });

  it("sets isolation: 'worktree' even for a single wave item", async () => {
    const workspace = makeTmpDir();
    const flow = makeWaveFlow();

    const result = await getSpawnPrompt({
      workspace,
      state_id: "implement",
      flow,
      variables: {},
      items: ["task-01"],
    });

    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0].isolation).toBe("worktree");
  });

  it("wave entries have undefined worktree_path by default (caller sets it)", async () => {
    const workspace = makeTmpDir();
    const flow = makeWaveFlow();

    const result = await getSpawnPrompt({
      workspace,
      state_id: "implement",
      flow,
      variables: {},
      items: ["task-01"],
    });

    expect(result.prompts[0].worktree_path).toBeUndefined();
  });
});

describe("getSpawnPrompt — single state has no isolation", () => {
  it("does NOT set isolation on single state prompt entries", async () => {
    const workspace = makeTmpDir();
    const flow = makeSingleFlow();

    const result = await getSpawnPrompt({
      workspace,
      state_id: "research",
      flow,
      variables: {},
    });

    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0].isolation).toBeUndefined();
  });
});

describe("getSpawnPrompt — parallel-per state isolation", () => {
  it("sets isolation: 'worktree' on all parallel-per state prompt entries", async () => {
    const workspace = makeTmpDir();
    const flow = makeParallelPerFlow();

    const result = await getSpawnPrompt({
      workspace,
      state_id: "implement",
      flow,
      variables: {},
      items: ["file-a.ts", "file-b.ts"],
    });

    expect(result.prompts).toHaveLength(2);
    for (const entry of result.prompts) {
      expect(entry.isolation).toBe("worktree");
    }
  });
});
