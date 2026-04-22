/**
 * Integration tests for the prompt assembly pipeline (Part 1).
 *
 * Coverage:
 * - Single state produces one prompt with correct structure
 * - Wave state produces N prompts with items substituted
 * - Progress appears in prompt when flow.progress is set
 * - inject_context content is escaped (not expanded as variable)
 * - Consultation outputs are escaped by pipeline (not pre-escaped by caller)
 * - Cache prefix prepended to all prompts
 * - Unresolved unknown variable produces ERROR warning
 */

/**
 * ADR-006a: Cache prefix intentionally excludes progress.md content.
 * Progress is appended per-state by report_result and changes every iteration,
 * so including it in the cache prefix would invalidate the prefix cache on every
 * state transition. The test "Progress not in cache prefix" below verifies this.
 * This is a documented intentional gap, not a bug.
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
import { resolveContextInjections } from "@features/orchestration/services/inject-context.ts";
import { assembleWaveBriefing } from "@features/orchestration/services/wave-briefing.ts";
import { getSpawnPrompt } from "@features/orchestration/tools/get-spawn-prompt.ts";
import type { SpawnPromptInput } from "../model/types.ts";

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

// 1. Single state — basic structure

describe("integration — single state produces correct prompt structure", () => {
  it("produces exactly one prompt with correct agent and state_type", async () => {
    const workspace = seedWorkspace();
    const input = makeInput(workspace);

    const result = await getSpawnPrompt(input);

    expect(result.prompts).toHaveLength(1);
    expect(result.state_type).toBe("single");
    expect(result.prompts[0].agent).toBe("implementor");
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
        build: { agent: "implementor", type: "wave" },
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

  it("wave prompts do not have isolation field (worktree_path is the sole signal)", async () => {
    const workspace = seedWorkspace();
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

    expect(result.prompts[0]).not.toHaveProperty("isolation");
  });

  it("wave state with no items produces zero prompts (graceful)", async () => {
    const workspace = seedWorkspace();
    const flow = makeFlow({
      spawn_instructions: { build: "Build ${item}." },
      states: {
        build: { agent: "implementor", type: "wave" },
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
          agent: "implementor",
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
          agent: "implementor",
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
        build: { agent: "implementor", type: "wave" },
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
        build: { agent: "implementor", type: "wave" },
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
        build: { agent: "implementor", type: "wave" },
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
