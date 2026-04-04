/**
 * Integration tests for the prompt assembly pipeline.
 *
 * These tests exercise the full pipeline through the public getSpawnPrompt API,
 * verifying behavioral equivalence with the original monolith implementation.
 *
 * Tests use real ExecutionStore instances (temp dirs) and only mock external
 * I/O that is non-deterministic or filesystem-bound (wave guidance, message
 * channel reads, inject_context resolution, diff clustering, debate).
 *
 * Coverage:
 * - Single state produces one prompt with correct structure
 * - Wave state produces N prompts with items substituted
 * - Progress appears in prompt when flow.progress is set
 * - inject_context content is escaped (not expanded as variable)
 * - consultation_outputs are escaped by pipeline (not pre-escaped by caller)
 * - Cache prefix prepended to all prompts
 * - Unresolved unknown variable produces ERROR warning
 * - Metrics footer appears last in every prompt
 * - Debate state produces debate prompts with fanned_out flag
 * - Cluster fanout for single state produces cluster prompts
 * - Both callers (with and without consultation_outputs) work correctly
 * - Stage ordering preserved: prefix → substituted content → templates → briefing → coordination → metrics
 * - Resumed workspace prefix availability (risk #8)
 * - Progress not in cache prefix (ADR-006a risk)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Hoist mocks before module imports — only mock external I/O, not the pipeline

vi.mock("../../orchestration/wave-briefing.ts", () => ({
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

vi.mock("../../orchestration/messages.ts", () => ({
  buildMessageInstructions: vi
    .fn()
    .mockReturnValue("## Wave Coordination\n\nCoordination instructions here."),
  readChannelAsContext: vi.fn().mockResolvedValue(""),
}));

vi.mock("../../orchestration/inject-context.ts", () => ({
  resolveContextInjections: vi.fn().mockResolvedValue({
    hitl: undefined,
    variables: {},
    warnings: [],
  }),
}));

vi.mock("../../orchestration/diff-cluster.ts", () => ({
  clusterDiff: vi.fn().mockReturnValue(null),
}));

vi.mock("../../orchestration/debate.ts", () => ({
  buildDebatePrompt: vi.fn().mockReturnValue("Debate prompt content"),
  debateTeamLabel: vi.fn().mockImplementation((i: number) => `team-${i}`),
  inspectDebateProgress: vi.fn().mockResolvedValue({ completed: true, summary: "" }),
}));

vi.mock("../../orchestration/compete.ts", () => ({
  expandCompetitorPrompts: vi.fn().mockReturnValue([]),
}));

vi.mock("../../orchestration/skip-when.ts", () => ({
  evaluateSkipWhen: vi.fn().mockResolvedValue({ skip: false }),
}));

// Imports (after mocks)

import { buildDebatePrompt, inspectDebateProgress } from "../../orchestration/debate.ts";
import { clusterDiff } from "../../orchestration/diff-cluster.ts";
import { clearStoreCache, getExecutionStore } from "../../orchestration/execution-store.ts";
import type { ResolvedFlow } from "../../orchestration/flow-schema.ts";
import { resolveContextInjections } from "../../orchestration/inject-context.ts";
import { assembleWaveBriefing, readWaveGuidance } from "../../orchestration/wave-briefing.ts";
import { getSpawnPrompt } from "../../tools/get-spawn-prompt.ts";
import type { SpawnPromptInput } from "../../tools/prompt-pipeline/types.ts";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-integration-test-"));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Seed a workspace with a real ExecutionStore.
 * Returns the workspace path and the seeded store.
 */
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
      implement: { agent: "canon-implementor", type: "single" },
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

// 1. Single state — basic structure

describe("integration — single state produces correct prompt structure", () => {
  it("produces exactly one prompt with correct agent and state_type", async () => {
    const workspace = seedWorkspace();
    const input = makeInput(workspace);

    const result = await getSpawnPrompt(input);

    expect(result.prompts).toHaveLength(1);
    expect(result.state_type).toBe("single");
    expect(result.prompts[0].agent).toBe("canon-implementor");
    expect(result.skip_reason).toBeUndefined();
  });

  it("prompt contains the raw instruction text", async () => {
    const workspace = seedWorkspace();
    const flow = makeFlow({ spawn_instructions: { implement: "Build the feature now." } });
    const input = makeInput(workspace, { flow });

    const result = await getSpawnPrompt(input);

    expect(result.prompts[0].prompt).toContain("Build the feature now.");
  });

  it("metrics footer appears in every prompt", async () => {
    const workspace = seedWorkspace();
    const input = makeInput(workspace);

    const result = await getSpawnPrompt(input);

    for (const entry of result.prompts) {
      expect(entry.prompt).toContain("record_agent_metrics");
      expect(entry.prompt).toContain(`"${workspace}"`);
      expect(entry.prompt).toContain('"implement"');
    }
  });

  it("metrics footer appears after the instruction content (not before)", async () => {
    const workspace = seedWorkspace();
    const flow = makeFlow({ spawn_instructions: { implement: "Implement the feature." } });
    const input = makeInput(workspace, { flow });

    const result = await getSpawnPrompt(input);

    const prompt = result.prompts[0].prompt;
    const metricsIdx = prompt.indexOf("## Performance Metrics");
    const contentIdx = prompt.indexOf("Implement the feature.");

    // Instruction content appears before the metrics footer
    expect(contentIdx).toBeGreaterThanOrEqual(0);
    expect(metricsIdx).toBeGreaterThan(contentIdx);
    // The metrics footer is present
    expect(metricsIdx).toBeGreaterThanOrEqual(0);
  });
});

// 2. Wave state — N prompts with item substitution

describe("integration — wave state produces N prompts with items substituted", () => {
  it("produces one prompt per item for wave state", async () => {
    const workspace = seedWorkspace();
    const flow = makeFlow({
      spawn_instructions: { build: "Build ${item}." },
      states: {
        build: { agent: "canon-implementor", type: "wave" },
        done: { type: "terminal" },
      },
    });
    const input = makeInput(workspace, {
      flow,
      items: ["task-1", "task-2", "task-3"],
      state_id: "build",
      wave: 1,
    });

    const result = await getSpawnPrompt(input);

    expect(result.prompts).toHaveLength(3);
    expect(result.state_type).toBe("wave");
    expect(result.prompts[0].prompt).toContain("Build task-1");
    expect(result.prompts[1].prompt).toContain("Build task-2");
    expect(result.prompts[2].prompt).toContain("Build task-3");
  });

  it("wave prompts have isolation: worktree set", async () => {
    const workspace = seedWorkspace();
    const flow = makeFlow({
      spawn_instructions: { build: "Build ${item}." },
      states: {
        build: { agent: "canon-implementor", type: "wave" },
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

    expect(result.prompts[0].isolation).toBe("worktree");
  });

  it("wave state with no items produces zero prompts (graceful)", async () => {
    const workspace = seedWorkspace();
    const flow = makeFlow({
      spawn_instructions: { build: "Build ${item}." },
      states: {
        build: { agent: "canon-implementor", type: "wave" },
        done: { type: "terminal" },
      },
    });
    const input = makeInput(workspace, {
      flow,
      items: [],
      state_id: "build",
      wave: 1,
    });

    const result = await getSpawnPrompt(input);

    expect(result.prompts).toHaveLength(0);
    expect(result.state_type).toBe("wave");
    expect(result.skip_reason).toBeUndefined();
  });
});

// 3. Progress injection

describe("integration — progress variable injection", () => {
  it("progress appears in prompt when flow.progress is set", async () => {
    const workspace = seedWorkspace();
    const store = getExecutionStore(workspace);

    // Seed progress entries
    store.appendProgress("- [x] Implemented stage 1");
    store.appendProgress("- [x] Implemented stage 2");

    const flow = makeFlow({
      progress: "progress.md",
      spawn_instructions: { implement: "Do the work.\n\n${progress}" },
    });
    const input = makeInput(workspace, { flow });

    const result = await getSpawnPrompt(input);

    expect(result.prompts[0].prompt).toContain("Implemented stage 1");
    expect(result.prompts[0].prompt).toContain("Implemented stage 2");
  });

  it("progress is NOT included in cache prefix", async () => {
    const workspace = seedWorkspace();
    const store = getExecutionStore(workspace);

    const cachePrefix =
      "## Flow: test-flow\n\nA test flow.\n\n---\n\n## Workspace\n\n- Task: test task";
    store.setCachePrefix(cachePrefix);

    store.appendProgress("- [x] State entered");

    const flow = makeFlow({
      progress: "progress.md",
      spawn_instructions: { implement: "${progress}" },
    });
    const input = makeInput(workspace, { flow });

    const result = await getSpawnPrompt(input);

    const prompt = result.prompts[0].prompt;
    const cacheIdx = prompt.indexOf(cachePrefix);
    const progressIdx = prompt.indexOf("State entered");

    // Cache prefix appears before progress
    expect(cacheIdx).toBeLessThan(progressIdx);

    // The cache prefix itself does not contain progress content
    const prefixPortion = prompt.substring(cacheIdx, cacheIdx + cachePrefix.length);
    expect(prefixPortion).not.toContain("State entered");
  });

  it("absent progress gracefully degrades to empty string (no ${progress} in output)", async () => {
    const workspace = seedWorkspace();
    // No progress entries seeded

    const flow = makeFlow({
      progress: "progress.md",
      spawn_instructions: { implement: "Work: ${progress}" },
    });
    const input = makeInput(workspace, { flow });

    const result = await getSpawnPrompt(input);

    // ${progress} should be substituted with empty string — not left as literal
    expect(result.prompts[0].prompt).not.toContain("${progress}");
    // But the instruction text is still present
    expect(result.prompts[0].prompt).toContain("Work:");
  });
});

// 4. inject_context escaping

describe("integration — inject_context content is escaped (not expanded as variable)", () => {
  it("${WORKSPACE} in inject_context value appears escaped in final prompt", async () => {
    const workspace = seedWorkspace();

    // Mock inject_context to return a value containing ${WORKSPACE}
    vi.mocked(resolveContextInjections).mockResolvedValueOnce({
      hitl: undefined,
      variables: {
        context_data: "Use ${WORKSPACE} for the output path",
      },
      warnings: [],
    });

    const flow = makeFlow({
      spawn_instructions: { implement: "Context: ${context_data}" },
      states: {
        done: { type: "terminal" },
        implement: {
          agent: "canon-implementor",
          inject_context: [{ from: "state", name: "context_data" }] as unknown as never[],
          type: "single",
        },
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

    // ${WORKSPACE} in injected content must appear escaped (\${WORKSPACE}) in the prompt
    // so substituteVariables does not expand it to the workspace path
    expect(result.prompts[0].prompt).toContain("\\${WORKSPACE}");
    expect(result.prompts[0].prompt).not.toMatch(/Use [^\\]\${WORKSPACE}/);
  });

  it("inject_context values with no ${...} patterns pass through unchanged", async () => {
    const workspace = seedWorkspace();

    vi.mocked(resolveContextInjections).mockResolvedValueOnce({
      hitl: undefined,
      variables: {
        context_data: "Plain text without dollar patterns",
      },
      warnings: [],
    });

    const flow = makeFlow({
      spawn_instructions: { implement: "Context: ${context_data}" },
      states: {
        done: { type: "terminal" },
        implement: {
          agent: "canon-implementor",
          inject_context: [{ from: "state", name: "context_data" }] as unknown as never[],
          type: "single",
        },
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

    expect(result.prompts[0].prompt).toContain("Plain text without dollar patterns");
  });
});

// 5. Consultation outputs — escaping by pipeline (not pre-escaped by caller)

describe("integration — consultation_outputs escaped by pipeline", () => {
  it("raw ${var} in consultation summary appears escaped in final prompt", async () => {
    const workspace = seedWorkspace();
    const flow = makeFlow({
      spawn_instructions: { build: "Build ${item}." },
      states: {
        build: { agent: "canon-implementor", type: "wave" },
        done: { type: "terminal" },
      },
    });
    const input = makeInput(workspace, {
      consultation_outputs: {
        research: { summary: "Use ${PATTERN} in the implementation" },
      },
      flow,
      items: ["task-1"],
      state_id: "build",
      wave: 1,
    });

    const result = await getSpawnPrompt(input);

    const allText = result.prompts.map((p) => p.prompt).join("\n");
    // Stage 6 escapes the summary — ${PATTERN} → \${PATTERN}
    expect(allText).toContain("\\${PATTERN}");
    // No unescaped ${PATTERN} should appear (except as part of the escaped form)
    expect(allText).not.toMatch(/[^\\]\$\{PATTERN\}/);
  });

  it("absent consultation_outputs does not error and produces clean prompt", async () => {
    const workspace = seedWorkspace();
    const flow = makeFlow({
      spawn_instructions: { build: "Build ${item}." },
      states: {
        build: { agent: "canon-implementor", type: "wave" },
        done: { type: "terminal" },
      },
    });
    const input = makeInput(workspace, {
      flow,
      items: ["task-1"],
      state_id: "build",
      wave: 1,
      // no consultation_outputs
    });

    const result = await getSpawnPrompt(input);

    expect(result.prompts).toHaveLength(1);
    // assembleWaveBriefing not called when no consultation_outputs
    expect(assembleWaveBriefing).not.toHaveBeenCalled();
  });

  it("both paths (with and without consultation_outputs) produce prompts without error", async () => {
    const workspace = seedWorkspace();

    // Path 1: without consultation_outputs
    const flow = makeFlow({
      spawn_instructions: { build: "Build ${item}." },
      states: {
        build: { agent: "canon-implementor", type: "wave" },
        done: { type: "terminal" },
      },
    });
    const inputWithout = makeInput(workspace, {
      flow,
      items: ["task-a"],
      state_id: "build",
      wave: 1,
    });
    const resultWithout = await getSpawnPrompt(inputWithout);
    expect(resultWithout.prompts).toHaveLength(1);

    // Path 2: with consultation_outputs (same workspace)
    const inputWith = makeInput(workspace, {
      consultation_outputs: {
        research: { summary: "Plain text findings" },
      },
      flow,
      items: ["task-b"],
      state_id: "build",
      wave: 1,
    });
    const resultWith = await getSpawnPrompt(inputWith);
    expect(resultWith.prompts).toHaveLength(1);
    expect(resultWith.prompts[0].prompt).toContain("Plain text findings");
  });
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
    // Prefix must appear before instruction content
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
        build: { agent: "canon-implementor", type: "wave" },
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
    // No setCachePrefix called — defaults to empty string

    const input = makeInput(workspace, {
      flow: makeFlow({ spawn_instructions: { implement: "Do the work." } }),
    });

    const result = await getSpawnPrompt(input);

    expect(result.prompts[0].prompt).toContain("Do the work.");
    // No doubled prefix artifacts
    expect(result.prompts[0].prompt).not.toContain("undefined");
    expect(result.prompts[0].prompt).not.toContain("null");
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

// 8. Wave briefing injection — wave state with consultation_outputs

describe("integration — wave briefing injection", () => {
  it("wave briefing appears in each wave prompt when consultation_outputs provided", async () => {
    const workspace = seedWorkspace();
    const flow = makeFlow({
      spawn_instructions: { build: "Build ${item}." },
      states: {
        build: { agent: "canon-implementor", type: "wave" },
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
        build: { agent: "canon-implementor", type: "wave" },
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

  it("for wave state: prefix < instruction < wave briefing < coordination < metrics", async () => {
    const workspace = seedWorkspace();
    const store = getExecutionStore(workspace);
    store.setCachePrefix("## CACHE_PREFIX_MARKER ##\n\n");

    const flow = makeFlow({
      spawn_instructions: { build: "## INSTRUCTION_MARKER ##\n\n${item}" },
      states: {
        build: { agent: "canon-implementor", type: "wave" },
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
    const coordIdx = prompt.indexOf("## Wave Coordination");
    const metricsIdx = prompt.indexOf("## Performance Metrics");

    // Full ordering validation
    expect(prefixIdx).toBeLessThan(instrIdx);
    expect(instrIdx).toBeLessThan(briefingIdx);
    expect(briefingIdx).toBeLessThan(coordIdx);
    expect(coordIdx).toBeLessThan(metricsIdx);
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
        composition: ["canon-implementor"],
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
          agent: "canon-implementor",
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
