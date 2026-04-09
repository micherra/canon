/**
 * enter-and-prepare-state-session.test.ts — Tests for session variable injection and
 * workspace error handling in enterAndPrepareState.
 *
 * Covers:
 * - Session branch variable injection into spawn prompt variables
 * - worktree_branch and worktree_path injection
 * - Caller-provided variable overrides
 * - Missing directory returns WORKSPACE_NOT_FOUND via wrapHandler
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExecutionStore, getExecutionStore } from "@domains/workspaces/execution-store.ts";
import { afterEach, describe, expect, it, vi } from "vitest";

// Hoist mocks before module imports

vi.mock("@domains/flows/skip-when.ts", () => ({
  evaluateSkipWhen: vi.fn(),
}));

vi.mock("@domains/messages/event-bus-instance.ts", () => ({
  flowEventBus: {
    emit: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock("../engine/consultation-executor.ts", () => ({
  resolveConsultationPrompt: vi.fn(),
}));

vi.mock("@domains/workspaces/wave-variables.ts", () => ({
  buildTemplateInjection: vi.fn(() => ""),
  escapeDollarBrace: vi.fn((s: string) => s),
  extractFilePaths: vi.fn(() => []),
  parseTaskIdsForWave: vi.fn(() => []),
  substituteVariables: vi.fn((s: string) => s),
}));

import type { Board } from "@domains/flows/board-state-schemas.ts";
import type { ResolvedFlow } from "@domains/flows/flow-definition-schemas.ts";
import { escapeDollarBrace } from "@domains/workspaces/wave-variables.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { wrapHandler } from "@shared/lib/wrap-handler.ts";
import { resolveConsultationPrompt } from "../engine/consultation-executor.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eaps-test-"));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Seed the store with a minimal execution row so getBoard() returns a Board.
 */
function seedStore(workspace: string, overrides: Partial<Board> = {}): ExecutionStore {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();

  // Initialize execution row (board top-level fields + session)
  store.initExecution({
    base_commit: overrides.base_commit ?? "abc1234",
    branch: "feat/test",
    created: now,
    current_state: overrides.current_state ?? "implement",
    entry: overrides.entry ?? "implement",
    flow: overrides.flow ?? "test-flow",
    flow_name: "test-flow",
    last_updated: overrides.last_updated ?? now,
    sanitized: "feat-test",
    slug: "test-slug",
    started: overrides.started ?? now,
    task: overrides.task ?? "test task",
    tier: "medium",
  });

  // Create initial state rows
  const states = (overrides.states as Board["states"]) ?? {
    done: { entries: 0, status: "pending" },
    implement: { entries: 0, status: "pending" },
  };
  for (const [stateId, state] of Object.entries(states)) {
    store.upsertState(stateId, { entries: state.entries ?? 0, status: state.status });
  }

  return store;
}

function makeFlow(overrides: Partial<ResolvedFlow> = {}): ResolvedFlow {
  return {
    description: "Test flow",
    entry: "implement",
    name: "test-flow",
    spawn_instructions: { implement: "Implement ${task}." },
    states: {
      done: { type: "terminal" },
      implement: { agent: "canon-implementor", type: "single" },
    },
    ...overrides,
  };
}

afterEach(() => {
  // Clear store cache between tests
  const cache = (getExecutionStore as any).__cache;
  if (cache instanceof Map) cache.clear();

  for (const d of tmpDirs) {
    rmSync(d, { force: true, recursive: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

describe("enterAndPrepareState — consultation_prompts", () => {
  function makeFlowWithConsultations(breakpoint: "before" | "between" = "before"): ResolvedFlow {
    return {
      consultations: {
        "risk-assessment": {
          agent: "canon-security",
          fragment: "risk-assessment",
          role: "security-reviewer",
          section: "Risk Assessment",
          timeout: "10m",
        },
      },
      description: "Test flow",
      entry: "implement",
      name: "test-flow",
      spawn_instructions: {
        implement: "Implement ${task}.",
        "risk-assessment": "Assess risks for ${task}.",
      },
      states: {
        done: { type: "terminal" },
        implement: {
          agent: "canon-implementor",
          consultations: { [breakpoint]: ["risk-assessment"] },
          type: "wave",
        },
      },
    } as unknown as ResolvedFlow;
  }

  it("returns consultation_prompts for before breakpoint when wave is 0", async () => {
    const workspace = makeTmpDir();
    seedStore(workspace);

    const flow = makeFlowWithConsultations("before");
    vi.mocked(resolveConsultationPrompt).mockReturnValue({
      agent: "canon-security",
      prompt: "Assess risks for test task.",
      role: "security-reviewer",
      section: "Risk Assessment",
      timeout: "10m",
    });

    const result = await enterAndPrepareState({
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "test task" },
      wave: 0,
      workspace,
    });
    assertOk(result);

    expect(result.consultation_prompts).toBeDefined();
    expect(result.consultation_prompts).toHaveLength(1);
    expect(result.consultation_prompts![0]).toEqual({
      agent: "canon-security",
      name: "risk-assessment",
      prompt: "Assess risks for test task.",
      role: "security-reviewer",
      section: "Risk Assessment",
      timeout: "10m",
    });
  });

  it("uses between breakpoint when wave > 0", async () => {
    const workspace = makeTmpDir();
    seedStore(workspace);

    const flow = makeFlowWithConsultations("between");
    vi.mocked(resolveConsultationPrompt).mockReturnValue({
      agent: "canon-security",
      prompt: "Assess risks between waves.",
      role: "security-reviewer",
    });

    const result = await enterAndPrepareState({
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "test task" },
      wave: 1,
      workspace,
    });
    assertOk(result);

    expect(result.consultation_prompts).toBeDefined();
    expect(result.consultation_prompts).toHaveLength(1);
    expect(resolveConsultationPrompt).toHaveBeenCalledWith("risk-assessment", flow, {
      CANON_PLUGIN_ROOT: "",
      task: "test task",
    });
  });

  it("returns no consultation_prompts when wave > 0 but only before consultations declared", async () => {
    const workspace = makeTmpDir();
    seedStore(workspace);

    const flow = makeFlowWithConsultations("before");

    const result = await enterAndPrepareState({
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "test task" },
      wave: 1,
      workspace,
    });
    assertOk(result);

    expect(result.consultation_prompts).toBeUndefined();
    expect(resolveConsultationPrompt).not.toHaveBeenCalled();
  });

  it("gracefully skips unknown consultation names (resolveConsultationPrompt returns null)", async () => {
    const workspace = makeTmpDir();
    seedStore(workspace);

    const flow = makeFlowWithConsultations("before");
    vi.mocked(resolveConsultationPrompt).mockReturnValue(null);

    const result = await enterAndPrepareState({
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "test task" },
      wave: 0,
      workspace,
    });
    assertOk(result);

    expect(result.consultation_prompts).toBeUndefined();
  });

  it("escapes ${evil} in completed consultation summaries before passing as consultation_outputs", async () => {
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
      task: "test task",
      tier: "medium",
    });

    const waveResults = {
      "wave-0": {
        consultations: {
          before: {
            "risk-assessment": { status: "done", summary: "Risk: ${evil} injection attempt" },
          },
        },
        status: "done",
        tasks: [],
      },
    };

    store.upsertState("implement", {
      entries: 1,
      status: "in_progress",
      wave_results: waveResults,
    });
    store.upsertState("done", { entries: 0, status: "pending" });

    vi.mocked(escapeDollarBrace).mockImplementation((s: string) => s.replace(/\$\{/g, "\\${"));

    const flow = makeFlowWithConsultations("between");
    vi.mocked(resolveConsultationPrompt).mockReturnValue(null);

    await enterAndPrepareState({
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "test task" },
      wave: 1,
      workspace,
    });

    expect(escapeDollarBrace).toHaveBeenCalledWith("Risk: ${evil} injection attempt");
  });
});

describe("enterAndPrepareState — session branch variable injection", () => {
  it("injects branch from session into spawn prompt variables", async () => {
    const workspace = makeTmpDir();
    seedStore(workspace); // seeds with branch: "feat/test"

    const flow = makeFlow({
      spawn_instructions: { implement: "Branch is ${branch}." },
    });

    const result = await enterAndPrepareState({
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "test" },
      workspace,
    });
    assertOk(result);

    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0].prompt).toContain("Branch is feat/test.");
  });

  it("injects worktree_branch when persisted in session", async () => {
    const workspace = makeTmpDir();
    const store = getExecutionStore(workspace);
    const now = new Date().toISOString();
    store.initExecution({
      base_commit: "abc1234",
      branch: "feat/my-feature",
      created: now,
      current_state: "implement",
      entry: "implement",
      flow: "test-flow",
      flow_name: "test-flow",
      last_updated: now,
      sanitized: "feat-my-feature",
      slug: "my-slug",
      started: now,
      task: "test task",
      tier: "medium",
      worktree_branch: "canon-build/my-slug",
      worktree_path: "/tmp/worktrees/my-slug",
    });
    store.upsertState("implement", { entries: 0, status: "pending" });
    store.upsertState("done", { entries: 0, status: "pending" });

    const flow = makeFlow({
      spawn_instructions: { implement: "Worktree: ${worktree_branch}" },
    });

    const result = await enterAndPrepareState({
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "test" },
      workspace,
    });
    assertOk(result);

    expect(result.prompts[0].prompt).toContain("Worktree: canon-build/my-slug");
  });

  it("injects worktree_path when persisted in session", async () => {
    const workspace = makeTmpDir();
    const store = getExecutionStore(workspace);
    const now = new Date().toISOString();
    store.initExecution({
      base_commit: "abc1234",
      branch: "feat/my-feature",
      created: now,
      current_state: "implement",
      entry: "implement",
      flow: "test-flow",
      flow_name: "test-flow",
      last_updated: now,
      sanitized: "feat-my-feature",
      slug: "my-slug",
      started: now,
      task: "test task",
      tier: "medium",
      worktree_path: "/tmp/worktrees/my-slug",
    });
    store.upsertState("implement", { entries: 0, status: "pending" });
    store.upsertState("done", { entries: 0, status: "pending" });

    const flow = makeFlow({
      spawn_instructions: { implement: "Path: ${worktree_path}" },
    });

    const result = await enterAndPrepareState({
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "test" },
      workspace,
    });
    assertOk(result);

    expect(result.prompts[0].prompt).toContain("Path: /tmp/worktrees/my-slug");
  });

  it("caller-provided variables override session branch variables", async () => {
    const workspace = makeTmpDir();
    seedStore(workspace); // seeds with branch: "feat/test"

    const flow = makeFlow({
      spawn_instructions: { implement: "Branch: ${branch}" },
    });

    const result = await enterAndPrepareState({
      flow,
      state_id: "implement",
      // Caller explicitly overrides branch
      variables: { branch: "override/branch", CANON_PLUGIN_ROOT: "", task: "test" },
      workspace,
    });
    assertOk(result);

    expect(result.prompts[0].prompt).toContain("Branch: override/branch");
  });

  it("omits worktree_branch and worktree_path when not set in session", async () => {
    const workspace = makeTmpDir();
    seedStore(workspace); // no worktree_branch/worktree_path set

    const flow = makeFlow({
      spawn_instructions: {
        implement: "Branch: ${branch}, Worktree: ${worktree_branch}, Path: ${worktree_path}",
      },
    });

    const result = await enterAndPrepareState({
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "test" },
      workspace,
    });
    assertOk(result);

    // branch is substituted, but worktree_branch and worktree_path are not (no values set)
    expect(result.prompts[0].prompt).toContain("Branch: feat/test");
    expect(result.prompts[0].prompt).toContain("${worktree_branch}");
    expect(result.prompts[0].prompt).toContain("${worktree_path}");
  });
});

describe("enterAndPrepareState — missing directory", () => {
  it("returns WORKSPACE_NOT_FOUND via wrapHandler when workspace directory does not exist", async () => {
    const missingWorkspace = join(tmpdir(), ".canon", "workspaces", "nonexistent-dir-for-eaps");

    const flow: ResolvedFlow = {
      description: "",
      entry: "implement",
      name: "test-flow",
      states: {
        implement: {
          prompt: "test",
          roles: [{ name: "implementor" }],
        },
      },
    } as unknown as ResolvedFlow;

    const wrappedEnterAndPrepare = wrapHandler(
      async (input: Parameters<typeof enterAndPrepareState>[0]) => enterAndPrepareState(input),
    );

    const response = await wrappedEnterAndPrepare({
      flow,
      state_id: "implement",
      variables: { CANON_PLUGIN_ROOT: "", task: "test task" },
      workspace: missingWorkspace,
    });
    const result = JSON.parse(response.content[0].text);

    expect(result.ok).toBe(false);
    expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
  });
});
