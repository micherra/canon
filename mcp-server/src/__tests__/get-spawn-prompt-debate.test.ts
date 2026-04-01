import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../orchestration/wave-briefing.ts", () => ({
  readWaveGuidance: vi.fn().mockResolvedValue(""),
  assembleWaveBriefing: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../orchestration/diff-cluster.ts", () => ({
  clusterDiff: vi.fn(),
}));

import { clusterDiff } from "../orchestration/diff-cluster.ts";
import type { Board, ResolvedFlow } from "../orchestration/flow-schema.ts";
import { writeMessage } from "../orchestration/messages.ts";
import { getSpawnPrompt } from "../tools/get-spawn-prompt.ts";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsp-debate-test-"));
  tmpDirs.push(dir);
  return dir;
}

function _makeBoard(overrides: Record<string, unknown> = {}): Board {
  return {
    flow: "debate-flow",
    task: "test task",
    entry: "research",
    current_state: "research",
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
    name: "debate-flow",
    description: "Test debate flow",
    entry: "research",
    debate: {
      teams: 2,
      composition: ["canon-researcher", "canon-architect"],
      min_rounds: 2,
      max_rounds: 4,
      convergence_check_after: 3,
      hitl_checkpoint: true,
      continue_to_build: true,
    },
    states: {
      research: {
        type: "single",
        agent: "canon-researcher",
        transitions: { done: "build" },
      },
      build: { type: "terminal" },
    },
    spawn_instructions: {
      research: "Research ${task}.",
    },
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

describe("getSpawnPrompt — debate expansion", () => {
  it("expands the entry state into team debate prompts", async () => {
    const workspace = makeTmpDir();
    vi.mocked(clusterDiff).mockReturnValue(null);

    const result = await getSpawnPrompt({
      workspace,
      state_id: "research",
      flow: makeFlow(),
      variables: { task: "design auth" },
    });

    expect(result.prompts).toHaveLength(4);
    expect(result.fanned_out).toBe(true);
    expect(result.prompts[0].prompt).toContain("Debate Round 1");
    expect(result.prompts[0].prompt).toContain('channel="debate-round-1"');
  });

  it("includes prior debate transcript in later rounds", async () => {
    const workspace = makeTmpDir();
    vi.mocked(clusterDiff).mockReturnValue(null);

    await writeMessage(workspace, "debate-round-1", "round-1-team-a-canon-researcher", "Use event sourcing.");
    await writeMessage(workspace, "debate-round-1", "round-1-team-b-canon-architect", "Prefer CRUD plus audit.");

    const result = await getSpawnPrompt({
      workspace,
      state_id: "research",
      flow: makeFlow(),
      variables: { task: "design auth" },
    });

    expect(result.prompts).toHaveLength(4);
    expect(result.prompts[0].prompt).toContain("Debate Round 2");
    expect(result.prompts[0].prompt).toContain("Use event sourcing.");
    expect(result.prompts[0].prompt).toContain("Prefer CRUD plus audit.");
  });
});
