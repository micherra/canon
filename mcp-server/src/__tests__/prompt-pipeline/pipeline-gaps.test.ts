/**
 * Integration and gap-fill tests for the ADR-006 prompt assembly pipeline.
 *
 * These tests cover paths not exercised by the implementor-written unit tests:
 *
 * 1. get-spawn-prompt thin wrapper — delegation contract and re-exported types
 * 2. Escaping ownership transfer — pipeline (stage 6) owns consultation escaping;
 *    enter-and-prepare-state no longer pre-escapes
 * 3. fanout fanned_out flag — single-state cluster fanout sets fanned_out: true;
 *    wave expansion does NOT set fanned_out
 * 4. fanout debate guard — debate only triggered when state_id === flow.entry
 * 5. fanout parallel state edge cases — empty agents array
 * 6. assemblePrompt skip_reason + warnings — warnings propagate through a skip result
 * 7. Multi-inject_context entries — multiple injections merged into mergedVariables
 * 8. Cache prefix lifecycle — set in store → read in pipeline → prepended to prompt
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Hoist mocks — mock only external I/O, not pipeline internals
// ---------------------------------------------------------------------------

vi.mock("../../orchestration/wave-briefing.ts", () => ({
  readWaveGuidance: vi.fn().mockResolvedValue(""),
  assembleWaveBriefing: vi.fn().mockImplementation(
    (opts: { wave: number; summaries: string[]; consultationOutputs: Record<string, { section?: string; summary: string }> }) => {
      const outputs = opts.consultationOutputs ?? {};
      const keys = Object.keys(outputs);
      if (keys.length === 0) return "";
      const parts = keys.map((k) => `${k}: ${outputs[k].summary}`);
      return `## Consultation Briefing\n\n${parts.join("\n")}`;
    }
  ),
}));

vi.mock("../../orchestration/messages.ts", () => ({
  readChannelAsContext: vi.fn().mockResolvedValue(""),
  buildMessageInstructions: vi.fn().mockReturnValue("## Wave Coordination\n\nCoordination instructions."),
}));

vi.mock("../../orchestration/inject-context.ts", () => ({
  resolveContextInjections: vi.fn().mockResolvedValue({
    variables: {},
    warnings: [],
    hitl: undefined,
  }),
}));

vi.mock("../../orchestration/diff-cluster.ts", () => ({
  clusterDiff: vi.fn().mockReturnValue(null),
}));

vi.mock("../../orchestration/debate.ts", () => ({
  inspectDebateProgress: vi.fn().mockResolvedValue({ completed: true, summary: "" }),
  buildDebatePrompt: vi.fn().mockReturnValue("Debate prompt content"),
  debateTeamLabel: vi.fn().mockImplementation((i: number) => `team-${i}`),
}));

vi.mock("../../orchestration/compete.ts", () => ({
  expandCompetitorPrompts: vi.fn().mockReturnValue([]),
}));

vi.mock("../../orchestration/skip-when.ts", () => ({
  evaluateSkipWhen: vi.fn().mockResolvedValue({ skip: false }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { getSpawnPrompt, assemblePrompt } from "../../tools/get-spawn-prompt.ts";
import type { SpawnPromptEntry, TaskItem, SpawnPromptResult } from "../../tools/get-spawn-prompt.ts";
import { getExecutionStore, clearStoreCache } from "../../orchestration/execution-store.ts";
import { resolveContextInjections } from "../../orchestration/inject-context.ts";
import { inspectDebateProgress } from "../../orchestration/debate.ts";
import { clusterDiff } from "../../orchestration/diff-cluster.ts";
import { fanout } from "../../tools/prompt-pipeline/fanout.ts";
import type { ResolvedFlow, StateDefinition } from "../../orchestration/flow-schema.ts";
import type { SpawnPromptInput, PromptContext } from "../../tools/prompt-pipeline/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-gaps-test-"));
  tmpDirs.push(dir);
  return dir;
}

function seedWorkspace(task = "test task"): string {
  const workspace = makeTmpDir();
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();
  store.initExecution({
    flow: "test-flow",
    task,
    entry: "implement",
    current_state: "implement",
    base_commit: "abc1234",
    started: now,
    last_updated: now,
    branch: "feat/test",
    sanitized: "feat-test",
    created: now,
    tier: "medium",
    flow_name: "test-flow",
    slug: "test-slug",
  });
  store.upsertState("implement", { status: "pending", entries: 0 });
  store.upsertState("done", { status: "pending", entries: 0 });
  return workspace;
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
    spawn_instructions: { implement: "Implement the task." },
    ...overrides,
  };
}

function makeInput(workspace: string, overrides: Partial<SpawnPromptInput> = {}): SpawnPromptInput {
  return {
    workspace,
    state_id: "implement",
    flow: makeFlow(),
    variables: { CANON_PLUGIN_ROOT: "" },
    ...overrides,
  };
}

function makeFanoutCtx(
  overrides: Partial<PromptContext> & {
    workspace?: string;
    state_id?: string;
    flow?: ResolvedFlow;
    variables?: Record<string, string>;
    items?: PromptContext["input"]["items"];
  } = {}
): PromptContext {
  const { workspace, state_id, flow, variables, items, ...rest } = overrides;
  return {
    input: {
      workspace: workspace ?? "/tmp/test-ws",
      state_id: state_id ?? "implement",
      flow: flow ?? makeFlow(),
      variables: variables ?? { CANON_PLUGIN_ROOT: "" },
      ...("items" in overrides ? { items } : {}),
    },
    state: { type: "single", agent: "canon-implementor" } as StateDefinition,
    rawInstruction: "Do the thing",
    basePrompt: "Do the thing",
    prompts: [],
    warnings: [],
    mergedVariables: { CANON_PLUGIN_ROOT: "" },
    ...rest,
  };
}

afterEach(() => {
  clearStoreCache();
  vi.clearAllMocks();
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

// ---------------------------------------------------------------------------
// 1. get-spawn-prompt thin wrapper — delegation contract
// ---------------------------------------------------------------------------

describe("get-spawn-prompt thin wrapper — delegation contract", () => {
  it("getSpawnPrompt produces the same result shape as calling assemblePrompt directly", async () => {
    const workspace = seedWorkspace();

    // Call both with equivalent inputs (separate workspaces to avoid state sharing)
    const ws2 = seedWorkspace();
    const [wrapperResult, directResult] = await Promise.all([
      getSpawnPrompt(makeInput(workspace)),
      assemblePrompt(makeInput(ws2)),
    ]);

    expect(wrapperResult.state_type).toBe(directResult.state_type);
    expect(wrapperResult.prompts).toHaveLength(directResult.prompts.length);
    expect(wrapperResult.skip_reason).toBeUndefined();
    expect(directResult.skip_reason).toBeUndefined();
  });

  it("re-exported SpawnPromptEntry type: result entries have agent, prompt, and template_paths fields", async () => {
    const workspace = seedWorkspace();
    const result = await getSpawnPrompt(makeInput(workspace));

    const entry: SpawnPromptEntry = result.prompts[0];
    expect(entry.agent).toBe("canon-implementor");
    expect(typeof entry.prompt).toBe("string");
    expect(Array.isArray(entry.template_paths)).toBe(true);
  });

  it("re-exported SpawnPromptResult type: result has prompts, state_type, and no skip_reason on success", async () => {
    const workspace = seedWorkspace();
    const result: SpawnPromptResult = await getSpawnPrompt(makeInput(workspace));

    expect(result).toHaveProperty("prompts");
    expect(result).toHaveProperty("state_type");
    expect(result.skip_reason).toBeUndefined();
  });

  it("re-exported TaskItem type: string items flow correctly through wave state", async () => {
    const workspace = seedWorkspace();
    const items: TaskItem[] = ["task-1", "task-2"];
    const flow = makeFlow({
      states: {
        build: { type: "wave", agent: "canon-implementor" },
        done: { type: "terminal" },
      },
      spawn_instructions: { build: "Build ${item}." },
    });
    const result = await getSpawnPrompt(makeInput(workspace, { state_id: "build", flow, items, wave: 1 }));

    expect(result.prompts).toHaveLength(2);
    expect(result.prompts[0].item).toBe("task-1");
    expect(result.prompts[1].item).toBe("task-2");
  });
});

// ---------------------------------------------------------------------------
// 2. Escaping ownership transfer — stage 6 owns consultation output escaping
// ---------------------------------------------------------------------------

describe("escaping ownership transfer — pipeline escapes raw consultation summaries", () => {
  it("raw ${VAR} in consultation summary is escaped to \\${VAR} in the final prompt", async () => {
    const workspace = seedWorkspace();
    const flow = makeFlow({
      states: {
        build: { type: "wave", agent: "canon-implementor" },
        done: { type: "terminal" },
      },
      spawn_instructions: { build: "Build ${item}." },
    });
    // Simulate enter-and-prepare-state passing RAW (unescaped) summaries — the new contract
    const input = makeInput(workspace, {
      state_id: "build",
      flow,
      items: ["task-1"],
      wave: 2,
      consultation_outputs: {
        research: { summary: "Use ${WORKSPACE}/output as the path" },
      },
    });

    const result = await getSpawnPrompt(input);

    const allText = result.prompts.map((p) => p.prompt).join("\n");
    // Stage 6 escapes ${WORKSPACE} → \${WORKSPACE}
    expect(allText).toContain("\\${WORKSPACE}");
    // Must NOT expand to the real workspace value
    expect(allText).not.toMatch(/[^\\]\$\{WORKSPACE\}/);
  });

  it("plain text in consultation summary passes through without modification", async () => {
    const workspace = seedWorkspace();
    const flow = makeFlow({
      states: {
        build: { type: "wave", agent: "canon-implementor" },
        done: { type: "terminal" },
      },
      spawn_instructions: { build: "Build ${item}." },
    });
    const input = makeInput(workspace, {
      state_id: "build",
      flow,
      items: ["task-1"],
      wave: 1,
      consultation_outputs: {
        research: { summary: "Use layered architecture with clear boundaries" },
      },
    });

    const result = await getSpawnPrompt(input);

    const allText = result.prompts.map((p) => p.prompt).join("\n");
    expect(allText).toContain("Use layered architecture with clear boundaries");
  });

  it("multiple consultation summaries are all escaped independently", async () => {
    const workspace = seedWorkspace();
    const flow = makeFlow({
      states: {
        build: { type: "wave", agent: "canon-implementor" },
        done: { type: "terminal" },
      },
      spawn_instructions: { build: "Build ${item}." },
    });
    const input = makeInput(workspace, {
      state_id: "build",
      flow,
      items: ["task-1"],
      wave: 1,
      consultation_outputs: {
        research: { summary: "Read from ${CANON_DIR}/output" },
        architecture: { summary: "Write to ${WORKSPACE}/dist" },
      },
    });

    const result = await getSpawnPrompt(input);

    const allText = result.prompts.map((p) => p.prompt).join("\n");
    expect(allText).toContain("\\${CANON_DIR}");
    expect(allText).toContain("\\${WORKSPACE}");
  });
});

// ---------------------------------------------------------------------------
// 3. fanout fanned_out flag — single-state expansion vs wave expansion
// ---------------------------------------------------------------------------

describe("fanout — fanned_out flag is set only for single-state multi-prompt expansion", () => {
  it("sets fanned_out: true when single state expands into multiple cluster prompts", async () => {
    vi.mocked(clusterDiff).mockReturnValue([
      { key: "cluster-1", files: ["src/a.ts"] },
      { key: "cluster-2", files: ["src/b.ts"] },
    ] as never);

    const ctx = makeFanoutCtx({
      state: {
        type: "single",
        agent: "canon-implementor",
        large_diff_threshold: 5,
      } as StateDefinition,
      basePrompt: "Review ${item.cluster_key}",
    });

    const result = await fanout(ctx);

    expect(result.prompts).toHaveLength(2);
    expect(result.fanned_out).toBe(true);
  });

  it("does NOT set fanned_out when single state produces exactly one prompt", async () => {
    const ctx = makeFanoutCtx();

    const result = await fanout(ctx);

    expect(result.prompts).toHaveLength(1);
    expect(result.fanned_out).toBeFalsy();
  });

  it("wave state with multiple items does NOT set fanned_out (wave is not a single-state expansion)", async () => {
    const ctx = makeFanoutCtx({
      state: { type: "wave", agent: "canon-implementor" } as StateDefinition,
      items: ["task-1", "task-2"],
    });

    const result = await fanout(ctx);

    expect(result.prompts).toHaveLength(2);
    // Wave expansion is expected multi-agent — not classified as fanned_out
    expect(result.fanned_out).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// 4. fanout debate guard — debate only triggered on entry state
// ---------------------------------------------------------------------------

describe("fanout — debate triggered only when state_id === flow.entry", () => {
  it("does NOT inspect debate progress when state_id is NOT the flow entry state", async () => {
    const flow: ResolvedFlow = {
      name: "debate-flow",
      description: "Test",
      entry: "implement",        // entry is "implement"
      debate: {
        teams: 2,
        composition: ["canon-architect"],
        min_rounds: 1,
        max_rounds: 3,
        convergence_check_after: 2,
        hitl_checkpoint: false,
        continue_to_build: true,
      },
      states: {
        implement: { type: "single", agent: "canon-architect" },
        review: { type: "single", agent: "canon-reviewer" },
        done: { type: "terminal" },
      },
      spawn_instructions: { implement: "Implement", review: "Review" },
    } as unknown as ResolvedFlow;

    const ctx = makeFanoutCtx({
      state_id: "review",        // NOT the entry state
      state: { type: "single", agent: "canon-reviewer" } as StateDefinition,
      flow,
      basePrompt: "Review this",
    });

    vi.mocked(inspectDebateProgress).mockResolvedValueOnce({
      completed: false,
      next_round: 1,
      last_completed_round: 0,
      next_channel: "debate-round-1",
    });

    const result = await fanout(ctx);

    // debate inspection MUST NOT be called for non-entry state
    expect(inspectDebateProgress).not.toHaveBeenCalled();
    // Normal single-state fanout produces 1 prompt
    expect(result.prompts).toHaveLength(1);
    expect(result.fanned_out).toBeFalsy();
  });

  it("DOES inspect debate progress when state_id equals flow.entry", async () => {
    const flow: ResolvedFlow = {
      name: "debate-flow",
      description: "Test",
      entry: "implement",
      debate: {
        teams: 2,
        composition: ["canon-architect"],
        min_rounds: 1,
        max_rounds: 3,
        convergence_check_after: 2,
        hitl_checkpoint: false,
        continue_to_build: true,
      },
      states: {
        implement: { type: "single", agent: "canon-architect" },
        done: { type: "terminal" },
      },
      spawn_instructions: { implement: "Implement this" },
    } as unknown as ResolvedFlow;

    const ctx = makeFanoutCtx({
      state_id: "implement",     // IS the entry state
      state: { type: "single", agent: "canon-architect" } as StateDefinition,
      flow,
    });

    vi.mocked(inspectDebateProgress).mockResolvedValueOnce({
      completed: true,
      summary: "",
      last_completed_round: 0,
      next_round: 1,
      next_channel: "debate-round-1",
    });

    await fanout(ctx);

    expect(inspectDebateProgress).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// 5. fanout — parallel state edge cases
// ---------------------------------------------------------------------------

describe("fanout — parallel state edge cases", () => {
  it("parallel state with empty agents array produces zero prompts", async () => {
    const ctx = makeFanoutCtx({
      state: {
        type: "parallel",
        agents: [],
      } as StateDefinition,
    });

    const result = await fanout(ctx);

    expect(result.prompts).toHaveLength(0);
  });

  it("parallel state with multiple agents AND multiple roles fans out per-agent (not per-role)", async () => {
    // When agents.length > 1, the per-agent path is used regardless of roles
    const ctx = makeFanoutCtx({
      state: {
        type: "parallel",
        agents: ["canon-implementor", "canon-reviewer"],
        roles: ["frontend", "backend"],
      } as StateDefinition,
    });

    const result = await fanout(ctx);

    // 2 agents → 2 prompts (per-agent, not per-role)
    expect(result.prompts).toHaveLength(2);
    expect(result.prompts[0].agent).toBe("canon-implementor");
    expect(result.prompts[1].agent).toBe("canon-reviewer");
  });
});

// ---------------------------------------------------------------------------
// 6. assemblePrompt skip_reason — warnings propagated when HITL skip occurs
// ---------------------------------------------------------------------------

describe("assemblePrompt — skip_reason result includes warnings accumulated before the skip", () => {
  it("warnings from resolveContext are included in the result when HITL skip triggers", async () => {
    const workspace = seedWorkspace();

    // resolveContextInjections returns a warning AND a hitl signal
    vi.mocked(resolveContextInjections).mockResolvedValueOnce({
      variables: {},
      warnings: ["Warning: context artifact missing for state-output"],
      hitl: {
        prompt: "Please provide the missing artifact",
        as: "context_artifact",
      },
    });

    const flow = makeFlow({
      states: {
        implement: {
          type: "single",
          agent: "canon-implementor",
          inject_context: [{ from: "state", name: "some-artifact" }] as unknown as never[],
        },
        done: { type: "terminal" },
      },
    });
    const input = makeInput(workspace, {
      flow,
      _board: {
        flow: "test-flow", task: "t", entry: "implement",
        current_state: "implement", base_commit: "abc",
        started: new Date().toISOString(), last_updated: new Date().toISOString(),
        states: {}, iterations: {}, blocked: null, concerns: [], skipped: [],
      },
    });

    const result = await getSpawnPrompt(input);

    // Result has a skip_reason (HITL path)
    expect(result.skip_reason).toBeDefined();
    expect(result.prompts).toHaveLength(0);
    // Warnings accumulated before the HITL skip propagate into the result
    expect(result.warnings).toBeDefined();
    expect(result.warnings?.some((w) => w.includes("context artifact missing"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Multi-inject_context entries — multiple injections merged into the prompt
// ---------------------------------------------------------------------------

describe("multi-inject_context entries — both variables substituted into prompt", () => {
  it("two inject_context variables are both substituted into the final prompt", async () => {
    const workspace = seedWorkspace();

    vi.mocked(resolveContextInjections).mockResolvedValueOnce({
      variables: {
        research_findings: "Findings from prior research",
        design_spec: "Spec from architect",
      },
      warnings: [],
      hitl: undefined,
    });

    const flow = makeFlow({
      states: {
        implement: {
          type: "single",
          agent: "canon-implementor",
          inject_context: [
            { from: "state", name: "research_findings" },
            { from: "state", name: "design_spec" },
          ] as unknown as never[],
        },
        done: { type: "terminal" },
      },
      spawn_instructions: {
        implement: "Research: ${research_findings}\n\nSpec: ${design_spec}",
      },
    });
    const input = makeInput(workspace, {
      flow,
      _board: {
        flow: "test-flow", task: "t", entry: "implement",
        current_state: "implement", base_commit: "abc",
        started: new Date().toISOString(), last_updated: new Date().toISOString(),
        states: {}, iterations: {}, blocked: null, concerns: [], skipped: [],
      },
    });

    const result = await getSpawnPrompt(input);

    expect(result.prompts[0].prompt).toContain("Findings from prior research");
    expect(result.prompts[0].prompt).toContain("Spec from architect");
  });

  it("inject_context variables with ${} are escaped so they don't expand further", async () => {
    const workspace = seedWorkspace();

    vi.mocked(resolveContextInjections).mockResolvedValueOnce({
      variables: {
        research_findings: "Output path is ${WORKSPACE}/results",
      },
      warnings: [],
      hitl: undefined,
    });

    const flow = makeFlow({
      states: {
        implement: {
          type: "single",
          agent: "canon-implementor",
          inject_context: [{ from: "state", name: "research_findings" }] as unknown as never[],
        },
        done: { type: "terminal" },
      },
      spawn_instructions: { implement: "Context: ${research_findings}" },
    });
    const input = makeInput(workspace, {
      flow,
      _board: {
        flow: "test-flow", task: "t", entry: "implement",
        current_state: "implement", base_commit: "abc",
        started: new Date().toISOString(), last_updated: new Date().toISOString(),
        states: {}, iterations: {}, blocked: null, concerns: [], skipped: [],
      },
    });

    const result = await getSpawnPrompt(input);

    // ${WORKSPACE} in injected content must appear escaped
    expect(result.prompts[0].prompt).toContain("\\${WORKSPACE}");
    // Must NOT have been expanded to the actual workspace path
    expect(result.prompts[0].prompt).not.toContain(`${workspace}/results`);
  });
});

// ---------------------------------------------------------------------------
// 8. Cache prefix lifecycle — set in store → read by pipeline → prepended to prompt
// ---------------------------------------------------------------------------

describe("cache prefix lifecycle — store to prompt end-to-end", () => {
  it("cache prefix set via setCachePrefix appears before instruction content in the prompt", async () => {
    const workspace = seedWorkspace();
    const store = getExecutionStore(workspace);
    const MARKER = "## STABLE_CONTEXT_MARKER ##";
    store.setCachePrefix(`${MARKER}\n\n`);

    const flow = makeFlow({ spawn_instructions: { implement: "INSTRUCTION_CONTENT" } });
    const result = await getSpawnPrompt(makeInput(workspace, { flow }));

    const prompt = result.prompts[0].prompt;
    const markerIdx = prompt.indexOf(MARKER);
    const instrIdx = prompt.indexOf("INSTRUCTION_CONTENT");

    expect(markerIdx).toBeGreaterThanOrEqual(0);
    // Cache prefix MUST appear before the instruction
    expect(markerIdx).toBeLessThan(instrIdx);
  });

  it("empty string cache prefix adds no content before the instruction", async () => {
    const workspace = seedWorkspace();
    // No setCachePrefix — defaults to empty string

    const flow = makeFlow({ spawn_instructions: { implement: "INSTRUCTION_START" } });
    const result = await getSpawnPrompt(makeInput(workspace, { flow }));

    const prompt = result.prompts[0].prompt;
    // No null/undefined artifacts prepended
    expect(prompt).not.toContain("undefined");
    expect(prompt).not.toContain("null");
    // The instruction content is still present
    expect(prompt).toContain("INSTRUCTION_START");
  });

  it("cache prefix is prepended to every prompt in a wave state", async () => {
    const workspace = seedWorkspace();
    const store = getExecutionStore(workspace);
    store.setCachePrefix("## WAVE_PREFIX ##\n\n");

    const flow = makeFlow({
      states: {
        build: { type: "wave", agent: "canon-implementor" },
        done: { type: "terminal" },
      },
      spawn_instructions: { build: "Build ${item}." },
    });
    const input = makeInput(workspace, {
      state_id: "build",
      flow,
      items: ["alpha", "beta", "gamma"],
      wave: 1,
    });

    const result = await getSpawnPrompt(input);

    expect(result.prompts).toHaveLength(3);
    for (const entry of result.prompts) {
      expect(entry.prompt).toContain("## WAVE_PREFIX ##");
    }
  });

  it("cache prefix persists across store cache clear (simulated process restart)", async () => {
    const workspace = seedWorkspace();
    const store = getExecutionStore(workspace);
    store.setCachePrefix("## PERSISTED_MARKER ##\n\n");

    // Simulate process restart
    clearStoreCache();

    // Re-open store from same workspace — prefix should be read from SQLite
    const result = await getSpawnPrompt(makeInput(workspace, {
      flow: makeFlow({ spawn_instructions: { implement: "Do the work." } }),
    }));

    expect(result.prompts[0].prompt).toContain("## PERSISTED_MARKER ##");
  });
});

// ---------------------------------------------------------------------------
// 9. Pipeline error paths (not covered by unit tests)
// ---------------------------------------------------------------------------

describe("pipeline error paths — pre-pipeline early returns", () => {
  it("returns state_type=unknown with skip_reason when state_id not found in flow", async () => {
    const workspace = seedWorkspace();
    const result = await getSpawnPrompt(makeInput(workspace, { state_id: "completely_missing" }));

    expect(result.prompts).toHaveLength(0);
    expect(result.state_type).toBe("unknown");
    expect(result.skip_reason).toContain("completely_missing");
  });

  it("returns skip_reason with no prompts when no spawn instruction exists for the state", async () => {
    const workspace = seedWorkspace();
    const flow = makeFlow({
      states: {
        implement: { type: "single", agent: "canon-implementor" },
        done: { type: "terminal" },
      },
      spawn_instructions: {}, // deliberate: no instruction for "implement"
    });

    const result = await getSpawnPrompt(makeInput(workspace, { flow }));

    expect(result.prompts).toHaveLength(0);
    expect(result.skip_reason).toContain("No spawn instruction");
  });

  it("terminal state returns empty prompts with no skip_reason (not a skip, just done)", async () => {
    const workspace = seedWorkspace();
    const result = await getSpawnPrompt(makeInput(workspace, { state_id: "done" }));

    expect(result.prompts).toHaveLength(0);
    expect(result.state_type).toBe("terminal");
    // Terminal state is NOT a skip — it's a normal completion
    expect(result.skip_reason).toBeUndefined();
  });
});
