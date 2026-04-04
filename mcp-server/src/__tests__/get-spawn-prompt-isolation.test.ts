/**
 * Tests for isolation field on SpawnPromptEntry in get-spawn-prompt.ts
 *
 * Covers:
 * - Wave state prompts include isolation: "worktree" on all entries
 * - Single state prompts include isolation: "worktree" on all entries
 * - parallel-per state prompts include isolation: "worktree"
 * - SpawnPromptEntry.worktree_path field is present as optional (not set by getSpawnPrompt itself)
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
  getProgress: vi.fn().mockReturnValue(""),
};

vi.mock("../orchestration/execution-store.ts", () => ({
  getExecutionStore: vi.fn(() => mockStore),
}));

vi.mock("../orchestration/wave-briefing.ts", () => ({
  assembleWaveBriefing: vi.fn().mockReturnValue(""),
  readWaveGuidance: vi.fn().mockResolvedValue(""),
}));

import type { ResolvedFlow } from "../orchestration/flow-schema.ts";
import { getSpawnPrompt } from "../tools/get-spawn-prompt.ts";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsp-iso-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs) {
    rmSync(d, { force: true, recursive: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

function makeWaveFlow(overrides: Partial<ResolvedFlow> = {}): ResolvedFlow {
  return {
    description: "Test flow",
    entry: "implement",
    name: "test-flow",
    spawn_instructions: {
      implement: "Implement task ${item}",
    },
    states: {
      implement: {
        agent: "canon-implementor",
        type: "wave",
      },
    },
    ...overrides,
  } as ResolvedFlow;
}

function makeSingleFlow(): ResolvedFlow {
  return {
    description: "Test flow",
    entry: "research",
    name: "test-flow",
    spawn_instructions: {
      research: "Research the problem",
    },
    states: {
      research: {
        agent: "canon-researcher",
        type: "single",
      },
    },
  } as ResolvedFlow;
}

function makeParallelPerFlow(): ResolvedFlow {
  return {
    description: "Test flow",
    entry: "implement",
    name: "test-flow",
    spawn_instructions: {
      implement: "Implement ${item}",
    },
    states: {
      implement: {
        agent: "canon-implementor",
        type: "parallel-per",
      },
    },
  } as ResolvedFlow;
}

describe("getSpawnPrompt — wave state isolation", () => {
  it("sets isolation: 'worktree' on all wave state prompt entries", async () => {
    const workspace = makeTmpDir();
    const flow = makeWaveFlow();

    const result = await getSpawnPrompt({
      flow,
      items: ["task-01", "task-02", "task-03"],
      state_id: "implement",
      variables: {},
      workspace,
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
      flow,
      items: ["task-01"],
      state_id: "implement",
      variables: {},
      workspace,
    });

    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0].isolation).toBe("worktree");
  });

  it("wave entries have undefined worktree_path by default (caller sets it)", async () => {
    const workspace = makeTmpDir();
    const flow = makeWaveFlow();

    const result = await getSpawnPrompt({
      flow,
      items: ["task-01"],
      state_id: "implement",
      variables: {},
      workspace,
    });

    expect(result.prompts[0].worktree_path).toBeUndefined();
  });
});

describe("getSpawnPrompt — single state isolation", () => {
  it("sets isolation: 'worktree' on single state prompt entries", async () => {
    const workspace = makeTmpDir();
    const flow = makeSingleFlow();

    const result = await getSpawnPrompt({
      flow,
      state_id: "research",
      variables: {},
      workspace,
    });

    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0].isolation).toBe("worktree");
  });
});

describe("getSpawnPrompt — parallel-per state isolation", () => {
  it("sets isolation: 'worktree' on all parallel-per state prompt entries", async () => {
    const workspace = makeTmpDir();
    const flow = makeParallelPerFlow();

    const result = await getSpawnPrompt({
      flow,
      items: ["file-a.ts", "file-b.ts"],
      state_id: "implement",
      variables: {},
      workspace,
    });

    expect(result.prompts).toHaveLength(2);
    for (const entry of result.prompts) {
      expect(entry.isolation).toBe("worktree");
    }
  });
});
