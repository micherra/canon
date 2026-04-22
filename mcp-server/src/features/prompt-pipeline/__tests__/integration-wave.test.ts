/**
 * Integration tests for the prompt assembly pipeline (Part 2).
 *
 * Coverage:
 * - Wave briefing injection — wave state with consultation_outputs
 * - Stage ordering preserved end-to-end
 * - Debate state produces debate prompts
 * - Cluster fanout for single state
 * - Resumed workspace prefix availability (risk #8)
 * - Terminal state early exit
 */

/**
 * ADR-006a: Cache prefix intentionally excludes progress.md content.
 * Progress is appended per-state by report_result and changes every iteration,
 * so including it in the cache prefix would invalidate the prefix cache on every
 * state transition.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Hoist mocks before module imports — only mock external I/O, not the pipeline

vi.mock("@features/orchestration/services/wave-briefing.ts", () => ({
  assembleWaveBriefing: vi
    .fn()
    .mockImplementation(
      (opts: {
        wave: number;
        summaries: string[];
        consultationOutputs: Record<string, { section?: string; summary: string }>;
      }) => {
        const outputs = opts.consultationOutputs ?? {};
        const keys = Object.keys(outputs);
        if (keys.length === 0) return "";
        const parts = keys.map((k) => `${k}: ${outputs[k].summary}`);
        return `## Consultation Briefing\n\n${parts.join("\n")}`;
      },
    ),
  readWaveGuidance: vi.fn().mockResolvedValue(""),
}));

vi.mock("@domains/messages/messages.ts", () => ({
  buildMessageInstructions: vi
    .fn()
    .mockReturnValue("## Wave Coordination\n\nCoordination instructions here."),
  readChannelAsContext: vi.fn().mockResolvedValue(""),
}));

vi.mock("@features/orchestration/services/inject-context.ts", () => ({
  resolveContextInjections: vi.fn().mockResolvedValue({
    hitl: undefined,
    variables: {},
    warnings: [],
  }),
}));

vi.mock("@features/orchestration/services/diff-cluster.ts", () => ({
  clusterDiff: vi.fn().mockReturnValue(null),
}));

vi.mock("@features/orchestration/engine/debate.ts", () => ({
  buildDebatePrompt: vi.fn().mockReturnValue("Debate prompt content"),
  debateTeamLabel: vi.fn().mockImplementation((i: number) => `team-${i}`),
  inspectDebateProgress: vi.fn().mockResolvedValue({ completed: true, summary: "" }),
}));

vi.mock("@features/orchestration/engine/compete.ts", () => ({
  expandCompetitorPrompts: vi.fn().mockReturnValue([]),
}));

vi.mock("@domains/flows/skip-when.ts", () => ({
  evaluateSkipWhen: vi.fn().mockResolvedValue({ skip: false }),
}));

// Imports (after mocks)

import type { ResolvedFlow } from "@domains/flows/flow-definition-schemas.ts";
import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store.ts";
import { buildDebatePrompt, inspectDebateProgress } from "@features/orchestration/engine/debate.ts";
import { clusterDiff } from "@features/orchestration/services/diff-cluster.ts";
import { readWaveGuidance } from "@features/orchestration/services/wave-briefing.ts";
import { getSpawnPrompt } from "@features/orchestration/tools/get-spawn-prompt.ts";
import type { SpawnPromptInput } from "../model/types.ts";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-integration-test-"));
  tmpDirs.push(dir);
  return dir;
}

function seedWorkspace(task = "test task"): string {
  const workspace = makeTmpDir();
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();
  store.initExecution({
    base_commit: "abc1234",
    branch: "feat/test",
    created: now,
    current_state: "implement",
    entry: "implement",
    flow: "test-flow",
    flow_name: "test-flow",
    last_updated: now,
    sanitized: "feat-test",
    slug: "test-slug",
    started: now,
    task,
    tier: "medium",
  });
  store.upsertState("implement", { entries: 0, status: "pending" });
  store.upsertState("done", { entries: 0, status: "pending" });
  return workspace;
}

function makeFlow(overrides: Partial<ResolvedFlow> = {}): ResolvedFlow {
  return {
    description: "Test flow",
    entry: "implement",
    name: "test-flow",
    spawn_instructions: { implement: "Implement the task." },
    states: {
      done: { type: "terminal" },
      implement: { agent: "implementor", type: "single" },
    },
    ...overrides,
  };
}

function makeInput(workspace: string, overrides: Partial<SpawnPromptInput> = {}): SpawnPromptInput {
  return {
    flow: makeFlow(),
    state_id: "implement",
    variables: { CANON_PLUGIN_ROOT: "" },
    workspace,
    ...overrides,
  };
}

afterEach(() => {
  clearStoreCache();
  vi.clearAllMocks();
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
});

// 6. Cache prefix

describe("integration — cache prefix prepended to all prompts", () => {
  it("cache prefix is prepended to single-state prompt", async () => {
    const workspace = seedWorkspace();
    const store = getExecutionStore(workspace);
    const prefix = "## Shared Context\n\nThis is the stable prefix content.\n\n---\n\n";
    store.setCachePrefix(prefix);

    const input = makeInput(workspace, {
      flow: makeFlow({ spawn_instructions: { implement: "Do the work." } }),
    });

    const result = await getSpawnPrompt(input);

    expect(result.prompts[0].prompt).toContain("Shared Context");
    const prefixIdx = result.prompts[0].prompt.indexOf("Shared Context");
    const instrIdx = result.prompts[0].prompt.indexOf("Do the work.");
    expect(prefixIdx).toBeLessThan(instrIdx);
  });

  it("cache prefix prepended to ALL wave prompts", async () => {
    const workspace = seedWorkspace();
    const store = getExecutionStore(workspace);
    const prefix = "## Shared Prefix\n\n";
    store.setCachePrefix(prefix);

    const flow = makeFlow({
      spawn_instructions: { build: "Build ${item}." },
      states: {
        build: { agent: "implementor", type: "wave" },
        done: { type: "terminal" },
      },
    });
    const input = makeInput(workspace, {
      flow,
      items: ["task-1", "task-2"],
      state_id: "build",
      wave: 1,
    });

    const result = await getSpawnPrompt(input);

    for (const entry of result.prompts) {
      expect(entry.prompt).toContain("## Shared Prefix");
    }
  });

  it("no cache prefix when store has empty prefix (graceful degradation)", async () => {
    const workspace = seedWorkspace();

    const input = makeInput(workspace, {
      flow: makeFlow({ spawn_instructions: { implement: "Do the work." } }),
    });

    const result = await getSpawnPrompt(input);

    expect(result.prompts[0].prompt).toContain("Do the work.");
    expect(result.prompts[0].prompt).not.toContain("undefined");
    expect(result.prompts[0].prompt).not.toContain("null");
  });
});

// 8. Wave briefing injection — wave state with consultation_outputs

describe("integration — wave briefing injection", () => {
  it("wave briefing appears in each wave prompt when consultation_outputs provided", async () => {
    const workspace = seedWorkspace();
    const flow = makeFlow({
      spawn_instructions: { build: "Build ${item}." },
      states: {
        build: { agent: "implementor", type: "wave" },
        done: { type: "terminal" },
      },
    });
    const input = makeInput(workspace, {
      consultation_outputs: {
        architecture: { summary: "Use layered architecture" },
      },
      flow,
      items: ["task-1", "task-2"],
      state_id: "build",
      wave: 1,
    });

    const result = await getSpawnPrompt(input);

    // Every prompt should contain the briefing
    for (const entry of result.prompts) {
      expect(entry.prompt).toContain("Consultation Briefing");
      expect(entry.prompt).toContain("Use layered architecture");
    }
  });

  it("wave guidance from file is injected when present", async () => {
    const workspace = seedWorkspace();
    vi.mocked(readWaveGuidance).mockResolvedValueOnce("Use the strangler fig pattern.");

    const flow = makeFlow({
      spawn_instructions: { build: "Build ${item}." },
      states: {
        build: { agent: "implementor", type: "wave" },
        done: { type: "terminal" },
      },
    });
    const input = makeInput(workspace, {
      flow,
      items: ["task-1"],
      state_id: "build",
      wave: 1,
    });

    const result = await getSpawnPrompt(input);

    expect(result.prompts[0].prompt).toContain("Wave Guidance");
    expect(result.prompts[0].prompt).toContain("strangler fig pattern");
  });
});

// 9. Stage ordering preserved

describe("integration — stage ordering preserved end-to-end", () => {
  it("cache prefix appears before instruction content, metrics footer appears last", async () => {
    const workspace = seedWorkspace();
    const store = getExecutionStore(workspace);
    store.setCachePrefix("## STABLE PREFIX ##\n\n");

    const flow = makeFlow({ spawn_instructions: { implement: "## INSTRUCTION CONTENT ##" } });
    const input = makeInput(workspace, { flow });

    const result = await getSpawnPrompt(input);

    const prompt = result.prompts[0].prompt;
    const prefixIdx = prompt.indexOf("## STABLE PREFIX ##");
    const instrIdx = prompt.indexOf("## INSTRUCTION CONTENT ##");
    const metricsIdx = prompt.indexOf("## Performance Metrics");

    // Ordering: prefix < instruction < metrics
    expect(prefixIdx).toBeLessThan(instrIdx);
    expect(instrIdx).toBeLessThan(metricsIdx);
  });

  it("for wave state: prefix < instruction < wave briefing < metrics", async () => {
    const workspace = seedWorkspace();
    const store = getExecutionStore(workspace);
    store.setCachePrefix("## CACHE_PREFIX_MARKER ##\n\n");

    const flow = makeFlow({
      spawn_instructions: { build: "## INSTRUCTION_MARKER ##\n\n${item}" },
      states: {
        build: { agent: "implementor", type: "wave" },
        done: { type: "terminal" },
      },
    });
    const input = makeInput(workspace, {
      consultation_outputs: {
        research: { summary: "findings summary" },
      },
      flow,
      items: ["task-1"],
      state_id: "build",
      wave: 1,
    });

    const result = await getSpawnPrompt(input);

    const prompt = result.prompts[0].prompt;
    const prefixIdx = prompt.indexOf("## CACHE_PREFIX_MARKER ##");
    const instrIdx = prompt.indexOf("## INSTRUCTION_MARKER ##");
    const briefingIdx = prompt.indexOf("Consultation Briefing");
    const metricsIdx = prompt.indexOf("## Performance Metrics");

    // Wave coordination messaging removed (handled by debate.ts / get_messages)
    expect(prefixIdx).toBeLessThan(instrIdx);
    expect(instrIdx).toBeLessThan(briefingIdx);
    expect(briefingIdx).toBeLessThan(metricsIdx);
  });
});

// 10. Debate state

describe("integration — debate state produces debate prompts", () => {
  it("active debate on entry state produces per-team prompts with fanned_out flag", async () => {
    const workspace = seedWorkspace();

    vi.mocked(inspectDebateProgress).mockResolvedValueOnce({
      completed: false,
      last_completed_round: 0,
      next_channel: "debate-round-1",
      next_round: 1,
      transcript: undefined,
    });
    vi.mocked(buildDebatePrompt).mockReturnValue("## Debate Prompt for team");

    const flow = makeFlow({
      debate: {
        composition: ["implementor"],
        max_rounds: 3,
        teams: 2,
      },
    } as unknown as Partial<ResolvedFlow>);

    const input = makeInput(workspace, { flow });

    const result = await getSpawnPrompt(input);

    // 2 teams × 1 agent each = 2 debate prompts
    expect(result.prompts).toHaveLength(2);
    expect(result.fanned_out).toBe(true);
  });
});

// 11. Cluster fanout

describe("integration — cluster fanout for single state", () => {
  it("cluster fanout produces one prompt per cluster", async () => {
    const workspace = seedWorkspace();

    vi.mocked(clusterDiff).mockReturnValueOnce([
      { files: ["src/a.ts", "src/b.ts"], key: "cluster-1" },
      { files: ["src/c.ts"], key: "cluster-2" },
    ] as never);

    const flow = makeFlow({
      spawn_instructions: { implement: "Implement files: ${item.files}" },
      states: {
        done: { type: "terminal" },
        implement: {
          agent: "implementor",
          large_diff_threshold: 5,
          type: "single",
        } as never,
      },
    });
    const input = makeInput(workspace, {
      _board: {
        base_commit: "abc",
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
        task: "t",
      },
      flow,
    });

    const result = await getSpawnPrompt(input);

    // One prompt per cluster
    expect(result.prompts).toHaveLength(2);
    expect(result.fanned_out).toBe(true);
    // First cluster files appear in first prompt
    expect(result.prompts[0].prompt).toContain("src/a.ts");
    expect(result.prompts[1].prompt).toContain("src/c.ts");
  });
});

// 12. Resumed workspace prefix availability (risk #8)

describe("integration — resumed workspace prefix availability (risk #8)", () => {
  it("cache prefix persists across store cache clear (simulated process restart)", async () => {
    const workspace = seedWorkspace();
    const store = getExecutionStore(workspace);
    const expectedPrefix = "## Stable Flow Context\n\nPersisted at init time.\n\n---\n\n";
    store.setCachePrefix(expectedPrefix);

    // Simulate process restart by clearing the in-memory store cache
    clearStoreCache();

    // Re-open the store and verify prefix is still available
    const resumedStore = getExecutionStore(workspace);
    const prefix = resumedStore.getCachePrefix();
    expect(prefix).toBe(expectedPrefix);

    // Now run pipeline using the resumed workspace — prefix should appear in prompt
    const input = makeInput(workspace, {
      flow: makeFlow({ spawn_instructions: { implement: "Do the work." } }),
    });
    const result = await getSpawnPrompt(input);

    expect(result.prompts[0].prompt).toContain("Stable Flow Context");
    expect(result.prompts[0].prompt).toContain("Persisted at init time.");
  });
});

// 7. Validate stage — unresolved variables produce ERROR warnings

describe("integration — unresolved variable produces ERROR warning", () => {
  it("unknown variable in instruction produces ERROR: warning", async () => {
    const workspace = seedWorkspace();
    const flow = makeFlow({
      spawn_instructions: { implement: "Use the ${completely_unknown_variable} here." },
    });
    const input = makeInput(workspace, { flow });

    const result = await getSpawnPrompt(input);

    expect(result.warnings).toBeDefined();
    const errorWarning = (result.warnings ?? []).find(
      (w) => w.startsWith("ERROR:") && w.includes("completely_unknown_variable"),
    );
    expect(errorWarning).toBeDefined();
  });

  it("prompts are still returned even when there are ERROR warnings", async () => {
    const workspace = seedWorkspace();
    const flow = makeFlow({
      spawn_instructions: { implement: "Use ${unknown_thing} here." },
    });
    const input = makeInput(workspace, { flow });

    const result = await getSpawnPrompt(input);

    // Prompts returned — caller decides policy (fail-closed-by-default)
    expect(result.prompts).toHaveLength(1);
  });

  it("known runtime variables (${task}, ${WORKSPACE}) do not produce ERROR warnings", async () => {
    const workspace = seedWorkspace();
    const flow = makeFlow({
      spawn_instructions: { implement: "Task: ${task}. Workspace: ${WORKSPACE}." },
    });
    const input = makeInput(workspace, { flow });

    const result = await getSpawnPrompt(input);

    const errorWarnings = (result.warnings ?? []).filter((w) => w.startsWith("ERROR:"));
    expect(errorWarnings).toHaveLength(0);
  });
});

// 13. Terminal state early exit

describe("integration — terminal state returns empty prompts", () => {
  it("terminal state returns empty prompts without running pipeline", async () => {
    const workspace = seedWorkspace();
    const input = makeInput(workspace, { state_id: "done" });

    const result = await getSpawnPrompt(input);

    expect(result.prompts).toHaveLength(0);
    expect(result.state_type).toBe("terminal");
  });
});
