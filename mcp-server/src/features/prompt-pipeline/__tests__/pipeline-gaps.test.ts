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
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Hoist mocks — mock only external I/O, not pipeline internals

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
    .mockReturnValue("## Wave Coordination\n\nCoordination instructions."),
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

import type { ResolvedFlow, StateDefinition } from "@domains/flows/flow-definition-schemas.ts";
import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store.ts";
import { inspectDebateProgress } from "@features/orchestration/engine/debate.ts";
import { clusterDiff } from "@features/orchestration/services/diff-cluster.ts";
import type {
  SpawnPromptEntry,
  SpawnPromptResult,
  TaskItem,
} from "@features/orchestration/tools/get-spawn-prompt.ts";
import { assemblePrompt, getSpawnPrompt } from "@features/orchestration/tools/get-spawn-prompt.ts";
import type { PromptContext, SpawnPromptInput } from "../model/types.ts";
import { fanout } from "../tools/fanout.ts";

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

function makeFanoutCtx(
  overrides: Partial<PromptContext> & {
    workspace?: string;
    state_id?: string;
    flow?: ResolvedFlow;
    variables?: Record<string, string>;
    items?: PromptContext["input"]["items"];
  } = {},
): PromptContext {
  const { workspace, state_id, flow, variables, items, ...rest } = overrides;
  return {
    basePrompt: "Do the thing",
    input: {
      flow: flow ?? makeFlow(),
      state_id: state_id ?? "implement",
      variables: variables ?? { CANON_PLUGIN_ROOT: "" },
      workspace: workspace ?? "/tmp/test-ws",
      ...("items" in overrides ? { items } : {}),
    },
    mergedVariables: { CANON_PLUGIN_ROOT: "" },
    prompts: [],
    rawInstruction: "Do the thing",
    state: { agent: "canon-implementor", type: "single" } as StateDefinition,
    warnings: [],
    ...rest,
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

// 1. get-spawn-prompt thin wrapper — delegation contract

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
      spawn_instructions: { build: "Build ${item}." },
      states: {
        build: { agent: "canon-implementor", type: "wave" },
        done: { type: "terminal" },
      },
    });
    const result = await getSpawnPrompt(
      makeInput(workspace, { flow, items, state_id: "build", wave: 1 }),
    );

    expect(result.prompts).toHaveLength(2);
    expect(result.prompts[0].item).toBe("task-1");
    expect(result.prompts[1].item).toBe("task-2");
  });
});

// 2. Escaping ownership transfer — stage 6 owns consultation output escaping

describe("escaping ownership transfer — pipeline escapes raw consultation summaries", () => {
  it("raw ${VAR} in consultation summary is escaped to \\${VAR} in the final prompt", async () => {
    const workspace = seedWorkspace();
    const flow = makeFlow({
      spawn_instructions: { build: "Build ${item}." },
      states: {
        build: { agent: "canon-implementor", type: "wave" },
        done: { type: "terminal" },
      },
    });
    // Simulate enter-and-prepare-state passing RAW (unescaped) summaries — the new contract
    const input = makeInput(workspace, {
      consultation_outputs: {
        research: { summary: "Use ${WORKSPACE}/output as the path" },
      },
      flow,
      items: ["task-1"],
      state_id: "build",
      wave: 2,
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
      spawn_instructions: { build: "Build ${item}." },
      states: {
        build: { agent: "canon-implementor", type: "wave" },
        done: { type: "terminal" },
      },
    });
    const input = makeInput(workspace, {
      consultation_outputs: {
        research: { summary: "Use layered architecture with clear boundaries" },
      },
      flow,
      items: ["task-1"],
      state_id: "build",
      wave: 1,
    });

    const result = await getSpawnPrompt(input);

    const allText = result.prompts.map((p) => p.prompt).join("\n");
    expect(allText).toContain("Use layered architecture with clear boundaries");
  });

  it("multiple consultation summaries are all escaped independently", async () => {
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
        architecture: { summary: "Write to ${WORKSPACE}/dist" },
        research: { summary: "Read from ${CANON_DIR}/output" },
      },
      flow,
      items: ["task-1"],
      state_id: "build",
      wave: 1,
    });

    const result = await getSpawnPrompt(input);

    const allText = result.prompts.map((p) => p.prompt).join("\n");
    expect(allText).toContain("\\${CANON_DIR}");
    expect(allText).toContain("\\${WORKSPACE}");
  });
});

// 3. fanout fanned_out flag — single-state expansion vs wave expansion

describe("fanout — fanned_out flag is set only for single-state multi-prompt expansion", () => {
  it("sets fanned_out: true when single state expands into multiple cluster prompts", async () => {
    vi.mocked(clusterDiff).mockReturnValue([
      { files: ["src/a.ts"], key: "cluster-1" },
      { files: ["src/b.ts"], key: "cluster-2" },
    ] as never);

    const ctx = makeFanoutCtx({
      basePrompt: "Review ${item.cluster_key}",
      state: {
        agent: "canon-implementor",
        large_diff_threshold: 5,
        type: "single",
      } as StateDefinition,
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
      items: ["task-1", "task-2"],
      state: { agent: "canon-implementor", type: "wave" } as StateDefinition,
    });

    const result = await fanout(ctx);

    expect(result.prompts).toHaveLength(2);
    // Wave expansion is expected multi-agent — not classified as fanned_out
    expect(result.fanned_out).toBeFalsy();
  });
});

// 4. fanout debate guard — debate only triggered on entry state

describe("fanout — debate triggered only when state_id === flow.entry", () => {
  it("does NOT inspect debate progress when state_id is NOT the flow entry state", async () => {
    const flow: ResolvedFlow = {
      debate: {
        composition: ["canon-architect"],
        continue_to_build: true,
        convergence_check_after: 2,
        hitl_checkpoint: false,
        max_rounds: 3,
        min_rounds: 1,
        teams: 2,
      },
      description: "Test",
      entry: "implement", // entry is "implement"
      name: "debate-flow",
      spawn_instructions: { implement: "Implement", review: "Review" },
      states: {
        done: { type: "terminal" },
        implement: { agent: "canon-architect", type: "single" },
        review: { agent: "canon-reviewer", type: "single" },
      },
    } as unknown as ResolvedFlow;

    const ctx = makeFanoutCtx({
      basePrompt: "Review this",
      flow,
      state: { agent: "canon-reviewer", type: "single" } as StateDefinition,
      state_id: "review", // NOT the entry state
    });

    vi.mocked(inspectDebateProgress).mockResolvedValueOnce({
      completed: false,
      last_completed_round: 0,
      next_channel: "debate-round-1",
      next_round: 1,
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
      debate: {
        composition: ["canon-architect"],
        continue_to_build: true,
        convergence_check_after: 2,
        hitl_checkpoint: false,
        max_rounds: 3,
        min_rounds: 1,
        teams: 2,
      },
      description: "Test",
      entry: "implement",
      name: "debate-flow",
      spawn_instructions: { implement: "Implement this" },
      states: {
        done: { type: "terminal" },
        implement: { agent: "canon-architect", type: "single" },
      },
    } as unknown as ResolvedFlow;

    const ctx = makeFanoutCtx({
      flow,
      state: { agent: "canon-architect", type: "single" } as StateDefinition,
      state_id: "implement", // IS the entry state
    });

    vi.mocked(inspectDebateProgress).mockResolvedValueOnce({
      completed: true,
      last_completed_round: 0,
      next_channel: "debate-round-1",
      next_round: 1,
      summary: "",
    });

    await fanout(ctx);

    expect(inspectDebateProgress).toHaveBeenCalledOnce();
  });
});

// 5. fanout — parallel state edge cases

describe("fanout — parallel state edge cases", () => {
  it("parallel state with empty agents array produces zero prompts", async () => {
    const ctx = makeFanoutCtx({
      state: {
        agents: [],
        type: "parallel",
      } as StateDefinition,
    });

    const result = await fanout(ctx);

    expect(result.prompts).toHaveLength(0);
  });

  it("parallel state with multiple agents AND multiple roles fans out per-agent (not per-role)", async () => {
    // When agents.length > 1, the per-agent path is used regardless of roles
    const ctx = makeFanoutCtx({
      state: {
        agents: ["canon-implementor", "canon-reviewer"],
        roles: ["frontend", "backend"],
        type: "parallel",
      } as StateDefinition,
    });

    const result = await fanout(ctx);

    // 2 agents → 2 prompts (per-agent, not per-role)
    expect(result.prompts).toHaveLength(2);
    expect(result.prompts[0].agent).toBe("canon-implementor");
    expect(result.prompts[1].agent).toBe("canon-reviewer");
  });
});
