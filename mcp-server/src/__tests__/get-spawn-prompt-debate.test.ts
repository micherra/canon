import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../orchestration/wave-briefing.ts", () => ({
  assembleWaveBriefing: vi.fn().mockReturnValue(undefined),
  readWaveGuidance: vi.fn().mockResolvedValue(""),
}));

vi.mock("../orchestration/diff-cluster.ts", () => ({
  clusterDiff: vi.fn(),
}));

import { clusterDiff } from "../orchestration/diff-cluster.ts";
import type { ResolvedFlow } from "../orchestration/flow-schema.ts";
import { writeMessage } from "../orchestration/messages.ts";
import { getSpawnPrompt } from "../tools/get-spawn-prompt.ts";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsp-debate-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeFlow(overrides: Partial<ResolvedFlow> = {}): ResolvedFlow {
  return {
    debate: {
      composition: ["canon-researcher", "canon-architect"],
      continue_to_build: true,
      convergence_check_after: 3,
      hitl_checkpoint: true,
      max_rounds: 4,
      min_rounds: 2,
      teams: 2,
    },
    description: "Test debate flow",
    entry: "research",
    name: "debate-flow",
    spawn_instructions: {
      research: "Research ${task}.",
    },
    states: {
      build: { type: "terminal" },
      research: {
        agent: "canon-researcher",
        transitions: { done: "build" },
        type: "single",
      },
    },
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

describe("getSpawnPrompt — debate expansion", () => {
  it("expands the entry state into team debate prompts", async () => {
    const workspace = makeTmpDir();
    vi.mocked(clusterDiff).mockReturnValue(null);

    const result = await getSpawnPrompt({
      flow: makeFlow(),
      state_id: "research",
      variables: { task: "design auth" },
      workspace,
    });

    expect(result.prompts).toHaveLength(4);
    expect(result.fanned_out).toBe(true);
    expect(result.prompts[0].prompt).toContain("Debate Round 1");
    expect(result.prompts[0].prompt).toContain('channel="debate-round-1"');
  });

  it("includes prior debate transcript in later rounds", async () => {
    const workspace = makeTmpDir();
    vi.mocked(clusterDiff).mockReturnValue(null);

    await writeMessage(
      workspace,
      "debate-round-1",
      "round-1-team-a-canon-researcher",
      "Use event sourcing.",
    );
    await writeMessage(
      workspace,
      "debate-round-1",
      "round-1-team-b-canon-architect",
      "Prefer CRUD plus audit.",
    );

    const result = await getSpawnPrompt({
      flow: makeFlow(),
      state_id: "research",
      variables: { task: "design auth" },
      workspace,
    });

    expect(result.prompts).toHaveLength(4);
    expect(result.prompts[0].prompt).toContain("Debate Round 2");
    expect(result.prompts[0].prompt).toContain("Use event sourcing.");
    expect(result.prompts[0].prompt).toContain("Prefer CRUD plus audit.");
  });
});
