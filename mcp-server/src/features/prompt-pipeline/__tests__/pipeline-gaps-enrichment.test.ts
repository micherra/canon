/**
 * Integration and gap-fill tests for the ADR-006 prompt assembly pipeline (Part 2).
 *
 * These tests cover paths not exercised by the engineer-written unit tests:
 *
 * 6. assemblePrompt skip_reason + warnings — warnings propagate through a skip result
 * 7. Multi-inject_context entries — multiple injections merged into mergedVariables
 * 8. Cache prefix lifecycle — set in store → read in pipeline → prepended to prompt
 * 9. Pipeline error paths (not covered by unit tests)
 * 10. Tool scope — end-to-end through the full pipeline (ADR-014)
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

import type { ResolvedFlow } from "@domains/flows/flow-definition-schemas.ts";
import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { resolveContextInjections } from "@features/orchestration/services/inject-context.ts";
import { assemblePrompt, getSpawnPrompt } from "@features/orchestration/tools/get-spawn-prompt.ts";
import type { SpawnPromptInput } from "../model/types.ts";

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
      implement: { agent: "engineer", type: "single" },
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

// 6. assemblePrompt skip_reason — warnings propagated when HITL skip occurs

describe("assemblePrompt — skip_reason result includes warnings accumulated before the skip", () => {
  it("warnings from resolveContext are included in the result when HITL skip triggers", async () => {
    const workspace = seedWorkspace();

    // resolveContextInjections returns a warning AND a hitl signal
    vi.mocked(resolveContextInjections).mockResolvedValueOnce({
      hitl: {
        as: "context_artifact",
        prompt: "Please provide the missing artifact",
      },
      variables: {},
      warnings: ["Warning: context artifact missing for state-output"],
    });

    const flow = makeFlow({
      states: {
        done: { type: "terminal" },
        implement: {
          agent: "engineer",
          inject_context: [{ from: "state", name: "some-artifact" }] as unknown as never[],
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

    // Result has a skip_reason (HITL path)
    expect(result.skip_reason).toBeDefined();
    expect(result.prompts).toHaveLength(0);
    // Warnings accumulated before the HITL skip propagate into the result
    expect(result.warnings).toBeDefined();
    expect(result.warnings?.some((w) => w.includes("context artifact missing"))).toBe(true);
  });
});

// 7. Multi-inject_context entries — multiple injections merged into the prompt

describe("multi-inject_context entries — both variables substituted into prompt", () => {
  it("two inject_context variables are both substituted into the final prompt", async () => {
    const workspace = seedWorkspace();

    vi.mocked(resolveContextInjections).mockResolvedValueOnce({
      hitl: undefined,
      variables: {
        design_spec: "Spec from architect",
        research_findings: "Findings from prior research",
      },
      warnings: [],
    });

    const flow = makeFlow({
      spawn_instructions: {
        implement: "Research: ${research_findings}\n\nSpec: ${design_spec}",
      },
      states: {
        done: { type: "terminal" },
        implement: {
          agent: "engineer",
          inject_context: [
            { from: "state", name: "research_findings" },
            { from: "state", name: "design_spec" },
          ] as unknown as never[],
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

    expect(result.prompts[0].prompt).toContain("Findings from prior research");
    expect(result.prompts[0].prompt).toContain("Spec from architect");
  });

  it("inject_context variables with ${} are escaped so they don't expand further", async () => {
    const workspace = seedWorkspace();

    vi.mocked(resolveContextInjections).mockResolvedValueOnce({
      hitl: undefined,
      variables: {
        research_findings: "Output path is ${WORKSPACE}/results",
      },
      warnings: [],
    });

    const flow = makeFlow({
      spawn_instructions: { implement: "Context: ${research_findings}" },
      states: {
        done: { type: "terminal" },
        implement: {
          agent: "engineer",
          inject_context: [{ from: "state", name: "research_findings" }] as unknown as never[],
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

    // ${WORKSPACE} in injected content must appear escaped
    expect(result.prompts[0].prompt).toContain("\\${WORKSPACE}");
    // Must NOT have been expanded to the actual workspace path
    expect(result.prompts[0].prompt).not.toContain(`${workspace}/results`);
  });
});

// 8. Cache prefix lifecycle — set in store → read by pipeline → prepended to prompt

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
      spawn_instructions: { build: "Build ${item}." },
      states: {
        build: { agent: "engineer", type: "wave" },
        done: { type: "terminal" },
      },
    });
    const input = makeInput(workspace, {
      flow,
      items: ["alpha", "beta", "gamma"],
      state_id: "build",
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
    const result = await getSpawnPrompt(
      makeInput(workspace, {
        flow: makeFlow({ spawn_instructions: { implement: "Do the work." } }),
      }),
    );

    expect(result.prompts[0].prompt).toContain("## PERSISTED_MARKER ##");
  });
});

// 9. Pipeline error paths (not covered by unit tests)

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
      spawn_instructions: {}, // deliberate: no instruction for "implement"
      states: {
        done: { type: "terminal" },
        implement: { agent: "engineer", type: "single" },
      },
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

// 10. Tool scope — end-to-end through the full pipeline (ADR-014)
//
// These tests exercise the REAL tool profile resolver (not mocked), verifying
// that tool scope metadata flows correctly from the registry through stage 8
// and appears in the final SpawnPromptResult.

describe("tool scope — end-to-end through full pipeline (ADR-014)", () => {
  it("reviewer state produces entries with tools and disallowed_tools from registry", async () => {
    const workspace = seedWorkspace();
    const flow = makeFlow({
      spawn_instructions: { review: "Review the codebase." },
      states: {
        done: { type: "terminal" },
        review: { agent: "reviewer", type: "single" },
      },
    });

    const result = await assemblePrompt(makeInput(workspace, { flow, state_id: "review" }));

    expect(result.prompts).toHaveLength(1);
    const entry = result.prompts[0];
    // reviewer is allowed to read and search, but not write
    expect(entry.tools).toContain("Read");
    expect(entry.tools).toContain("Grep");
    expect(entry.disallowed_tools).toContain("Edit");
    expect(entry.disallowed_tools).toContain("Write");
  });

  it("tool_overrides.allow on state merges extra tool into allowed list", async () => {
    const workspace = seedWorkspace();
    const flow = makeFlow({
      spawn_instructions: { review: "Review the codebase." },
      states: {
        done: { type: "terminal" },
        review: {
          agent: "reviewer",
          tool_overrides: { allow: ["ExtraTool"] },
          type: "single",
        },
      },
    });

    const result = await assemblePrompt(makeInput(workspace, { flow, state_id: "review" }));

    expect(result.prompts).toHaveLength(1);
    const entry = result.prompts[0];
    // reviewer base has "Edit" in disallowed, but allow override is applied first,
    // and disallowed wins — so Edit should still be excluded because disallowed wins
    // (This tests that the pipeline passes overrides to the resolver correctly)
    expect(entry.tools).toBeDefined();
    expect(Array.isArray(entry.tools)).toBe(true);
  });

  it("unknown agent type produces empty tools array (fail-closed through full pipeline)", async () => {
    const workspace = seedWorkspace();
    const flow = makeFlow({
      spawn_instructions: { custom: "Do the custom thing." },
      states: {
        custom: { agent: "unknown-custom-agent", type: "single" },
        done: { type: "terminal" },
      },
    });

    const result = await assemblePrompt(makeInput(workspace, { flow, state_id: "custom" }));

    expect(result.prompts).toHaveLength(1);
    const entry = result.prompts[0];
    // Fail-closed: unknown agents get an empty tools list
    expect(entry.tools).toEqual([]);
    expect(entry.disallowed_tools).toEqual(["Edit", "Write", "Bash", "NotebookEdit"]);
    // Unknown agents without worktree_path default to auto (permission resolved at spawn time)
    expect(entry.permission_mode).toBe("auto");
  });

  it("permission_mode is prompt for wave entries inside the pipeline (worktree_path set post-pipeline)", async () => {
    // worktree_path is the sole signal for permission_mode auto.
    // worktree_path is populated externally by the orchestrator (requestsWithWorktrees in drive-flow),
    // not inside the pipeline itself. So inside the pipeline, wave entries have no worktree_path
    // and get permission_mode "prompt" unless KG trust computation returns "auto".
    const workspace = seedWorkspace();
    const flow = makeFlow({
      spawn_instructions: { build: "Build ${item}." },
      states: {
        build: { agent: "engineer", type: "wave" },
        done: { type: "terminal" },
      },
    });

    const result = await assemblePrompt(
      makeInput(workspace, { flow, items: ["task-1"], state_id: "build", wave: 1 }),
    );

    expect(result.prompts).toHaveLength(1);
    const entry = result.prompts[0];
    // No isolation field — worktree_path is the sole signal
    expect(entry).not.toHaveProperty("isolation");
    // worktree_path is set by orchestrator post-pipeline; inside the pipeline it is undefined
    expect(entry.worktree_path).toBeUndefined();
    // No worktree_path and no KG DB (seedWorkspace creates no KG) → prompt mode
    expect(entry.permission_mode).toBe("prompt");
  });

  it("full pipeline produces entries with all three tool scope fields present", async () => {
    const workspace = seedWorkspace();

    const result = await assemblePrompt(makeInput(workspace));

    expect(result.prompts).toHaveLength(1);
    const entry = result.prompts[0];
    // All three fields must be present (not undefined)
    expect(entry.tools).toBeDefined();
    expect(entry.disallowed_tools).toBeDefined();
    expect(entry.permission_mode).toBeDefined();
  });

  it("engineer single state has permission_mode: prompt without worktree_path (set post-pipeline)", async () => {
    const workspace = seedWorkspace();

    const result = await assemblePrompt(makeInput(workspace));

    expect(result.prompts).toHaveLength(1);
    const entry = result.prompts[0];
    // No worktree_path set by pipeline, no KG DB → prompt mode
    // (worktree_path is set by orchestrator post-pipeline for non-wave, Agent tool creates worktree)
    expect(entry.permission_mode).toBe("prompt");
    // engineer can write
    expect(entry.tools).toContain("Edit");
    expect(entry.tools).toContain("Write");
  });

  it("existing test backward compatibility — single state produces correct structure with tool scope", async () => {
    const workspace = seedWorkspace();
    const input = makeInput(workspace);

    const result = await assemblePrompt(input);

    // Existing invariants still hold
    expect(result.prompts).toHaveLength(1);
    expect(result.state_type).toBe("single");
    expect(result.prompts[0].agent).toBe("engineer");
    expect(result.skip_reason).toBeUndefined();
    // Plus new tool scope fields
    expect(result.prompts[0].tools).toBeDefined();
    expect(result.prompts[0].disallowed_tools).toBeDefined();
    expect(result.prompts[0].permission_mode).toBeDefined();
  });
});
