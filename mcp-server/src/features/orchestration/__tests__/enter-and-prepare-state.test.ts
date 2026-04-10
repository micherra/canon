/**
 * Tests for enter-and-prepare-state.ts
 *
 * Covers:
 * 1. Convergence blocked — returns can_enter:false without entering state or resolving prompts
 * 2. Skip evaluation before enter — skip_when met returns skip_reason, state stays "pending"
 * 3. Happy path — enters state, resolves prompts, returns combined result
 * 4. Terminal state — empty prompts, state_type "terminal"
 * 5. Store-based state entry — execution_states and execution tables updated
 * 6. No board.json or .lock file created
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
import { evaluateSkipWhen } from "@domains/flows/skip-when.ts";
import { escapeDollarBrace } from "@domains/workspaces/wave-variables.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { wrapHandler } from "@shared/lib/wrap-handler.ts";
import { resolveConsultationPrompt } from "../engine/consultation-executor.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";
import { stateId as sid, flowName, workspacePath } from "@domains/flows/board-state-schemas.ts";
import type { StateId, WorkspacePath } from "@domains/flows/board-state-schemas.ts";

let tmpDirs: string[] = [];

function makeTmpDir(): WorkspacePath {
  const dir = mkdtempSync(join(tmpdir(), "eaps-test-"));
  tmpDirs.push(dir);
  return workspacePath(dir);
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
    store.upsertState(stateId as StateId, { entries: state.entries ?? 0, status: state.status });
  }

  // Create iteration rows if provided
  const iterations = overrides.iterations as Board["iterations"] | undefined;
  if (iterations) {
    for (const [stateId, iter] of Object.entries(iterations)) {
      store.upsertIteration(stateId as StateId, {
        cannot_fix: iter.cannot_fix ?? [],
        count: iter.count,
        history: iter.history ?? [],
        max: iter.max,
      });
    }
  }

  return store;
}

function makeFlow(overrides: Partial<ResolvedFlow> = {}): ResolvedFlow {
  return {
    description: "Test flow",
    entry: sid("implement"),
    name: flowName("test-flow"),
    spawn_instructions: { [sid("implement")]: "Implement ${task}." },
    states: {
      [sid("done")]: { type: "terminal" },
      [sid("implement")]: { agent: "canon-implementor", type: "single" },
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

describe("enterAndPrepareState", () => {
  describe("convergence blocked", () => {
    it("returns can_enter:false when max iterations reached, without entering state", async () => {
      const workspace = makeTmpDir();
      seedStore(workspace, {
        iterations: {
          [sid("implement")]: { cannot_fix: [], count: 3, history: [], max: 3 },
        },
      });

      const flow = makeFlow();
      const result = await enterAndPrepareState({
        flow,
        state_id: "implement",
        variables: { CANON_PLUGIN_ROOT: "", task: "test" },
        workspace,
      });
      assertOk(result);

      expect(result.can_enter).toBe(false);
      expect(result.iteration_count).toBe(3);
      expect(result.max_iterations).toBe(3);
      expect(result.prompts).toHaveLength(0);

      // State must NOT have been entered — still pending
      const store = getExecutionStore(workspace);
      const stateEntry = store.getState(sid("implement"));
      expect(stateEntry?.status).toBe("pending");
    });

    it("includes cannot_fix_items and history in the convergence-blocked result", async () => {
      const workspace = makeTmpDir();
      const cannotFixItems = [{ file_path: "src/api/handler.ts", principle_id: "thin-handlers" }];
      const history = [{ file_paths: ["src/api/handler.ts"], principle_ids: ["thin-handlers"] }];
      seedStore(workspace, {
        iterations: {
          [sid("implement")]: { cannot_fix: cannotFixItems, count: 2, history, max: 2 },
        },
      });

      const result = await enterAndPrepareState({
        flow: makeFlow(),
        state_id: "implement",
        variables: { CANON_PLUGIN_ROOT: "", task: "test" },
        workspace,
      });
      assertOk(result);

      expect(result.can_enter).toBe(false);
      expect(result.cannot_fix_items).toEqual(cannotFixItems);
      expect(result.history).toEqual(history);
    });
  });

  describe("skip evaluation before enter", () => {
    it("returns skipped when skip_when condition is met, without entering state", async () => {
      const workspace = makeTmpDir();
      seedStore(workspace);
      vi.mocked(evaluateSkipWhen).mockResolvedValue({
        reason: "No contract changes detected — all changes are internal",
        skip: true,
      });

      const flow = makeFlow({
        states: {
          [sid("done")]: { type: "terminal" },
          [sid("implement")]: {
            agent: "canon-implementor",
            skip_when: "no_contract_changes",
            type: "single",
          },
        },
      });

      const result = await enterAndPrepareState({
        flow,
        state_id: "implement",
        variables: { CANON_PLUGIN_ROOT: "", task: "test" },
        workspace,
      });
      assertOk(result);

      expect(result.can_enter).toBe(true);
      expect(result.skip_reason).toBeDefined();
      expect(result.skip_reason).toContain("no_contract_changes");
      expect(result.prompts).toHaveLength(0);

      // State must NOT have been entered — still pending
      const store = getExecutionStore(workspace);
      expect(store.getState(sid("implement"))?.status).toBe("pending");
    });

    it("does not skip when skip_when condition is not met", async () => {
      const workspace = makeTmpDir();
      seedStore(workspace);
      vi.mocked(evaluateSkipWhen).mockResolvedValue({ skip: false });

      const flow = makeFlow({
        states: {
          [sid("done")]: { type: "terminal" },
          [sid("implement")]: {
            agent: "canon-implementor",
            skip_when: "no_contract_changes",
            type: "single",
          },
        },
      });

      const result = await enterAndPrepareState({
        flow,
        state_id: "implement",
        variables: { CANON_PLUGIN_ROOT: "", task: "test" },
        workspace,
      });
      assertOk(result);

      expect(result.can_enter).toBe(true);
      expect(result.skip_reason).toBeUndefined();
      expect(result.prompts).toHaveLength(1);

      // State must have been entered — now in_progress
      const store = getExecutionStore(workspace);
      expect(store.getState(sid("implement"))?.status).toBe("in_progress");
    });
  });

  describe("happy path", () => {
    it("returns can_enter:true and resolved prompts for a single-agent state", async () => {
      const workspace = makeTmpDir();
      seedStore(workspace);

      const flow = makeFlow();
      const result = await enterAndPrepareState({
        flow,
        state_id: "implement",
        variables: { CANON_PLUGIN_ROOT: "", task: "build the widget" },
        workspace,
      });
      assertOk(result);

      expect(result.can_enter).toBe(true);
      expect(result.state_type).toBe("single");
      expect(result.prompts).toHaveLength(1);
      expect(result.prompts[0].agent).toBe("canon-implementor");
      expect(result.prompts[0].prompt).toContain("build the widget");
    });

    it("returns the updated board in the result with in_progress status", async () => {
      const workspace = makeTmpDir();
      seedStore(workspace);

      const flow = makeFlow();
      const result = await enterAndPrepareState({
        flow,
        state_id: "implement",
        variables: { CANON_PLUGIN_ROOT: "", task: "test" },
        workspace,
      });
      assertOk(result);

      expect(result.board).toBeDefined();
      expect(result.board!.states[sid("implement")].status).toBe("in_progress");
      expect(result.board!.states[sid("implement")].entries).toBe(1);
    });

    it("persists state entry to execution_states table — not board.json", async () => {
      const workspace = makeTmpDir();
      seedStore(workspace);

      const flow = makeFlow();
      await enterAndPrepareState({
        flow,
        state_id: "implement",
        variables: { CANON_PLUGIN_ROOT: "", task: "test" },
        workspace,
      });

      // Board.json must NOT exist
      expect(existsSync(join(workspace, "board.json"))).toBe(false);
      // .lock must NOT exist
      expect(existsSync(join(workspace, ".lock"))).toBe(false);

      // State must be persisted in SQLite
      const store = getExecutionStore(workspace);
      const stateEntry = store.getState(sid("implement"));
      expect(stateEntry?.status).toBe("in_progress");
      expect(stateEntry?.entries).toBe(1);
    });

    it("increments iteration count when state has iteration limits", async () => {
      const workspace = makeTmpDir();
      seedStore(workspace, {
        iterations: {
          [sid("implement")]: { cannot_fix: [], count: 1, history: [], max: 5 },
        },
      });

      const flow = makeFlow({
        states: {
          [sid("done")]: { type: "terminal" },
          [sid("implement")]: { agent: "canon-implementor", max_iterations: 5, type: "single" },
        },
      });

      await enterAndPrepareState({
        flow,
        state_id: "implement",
        variables: { CANON_PLUGIN_ROOT: "", task: "test" },
        workspace,
      });

      const store = getExecutionStore(workspace);
      const iter = store.getIteration(sid("implement"));
      expect(iter?.count).toBe(2);
    });

    it("returns iteration_count from board for a state without iteration limits", async () => {
      const workspace = makeTmpDir();
      seedStore(workspace);

      const flow = makeFlow();
      const result = await enterAndPrepareState({
        flow,
        state_id: "implement",
        variables: { CANON_PLUGIN_ROOT: "", task: "test" },
        workspace,
      });
      assertOk(result);

      expect(result.iteration_count).toBe(0);
      expect(result.max_iterations).toBe(0);
      expect(result.cannot_fix_items).toEqual([]);
      expect(result.history).toEqual([]);
    });
  });

  describe("terminal state", () => {
    it("returns can_enter:true with empty prompts and state_type 'terminal'", async () => {
      const workspace = makeTmpDir();
      seedStore(workspace, {
        states: {
          [sid("done")]: { entries: 0, status: "pending" },
          [sid("implement")]: { entries: 0, status: "pending" },
        },
      });

      const flow = makeFlow();
      const result = await enterAndPrepareState({
        flow,
        state_id: "done",
        variables: { CANON_PLUGIN_ROOT: "", task: "test" },
        workspace,
      });
      assertOk(result);

      expect(result.can_enter).toBe(true);
      expect(result.state_type).toBe("terminal");
      expect(result.prompts).toHaveLength(0);
    });
  });

  describe("parallel state", () => {
    it("returns one prompt per agent for parallel states", async () => {
      const workspace = makeTmpDir();
      seedStore(workspace, {
        states: {
          [sid("done")]: { entries: 0, status: "pending" },
          [sid("review")]: { entries: 0, status: "pending" },
        },
      });

      const flow: ResolvedFlow = {
        description: "Test flow",
        entry: sid("review"),
        name: flowName("test-flow"),
        spawn_instructions: { [sid("review")]: "Review the code for ${task}." },
        states: {
          [sid("done")]: { type: "terminal" },
          [sid("review")]: { agents: ["canon-reviewer", "canon-security"], type: "parallel" },
        },
      };

      const result = await enterAndPrepareState({
        flow,
        state_id: "review",
        variables: { CANON_PLUGIN_ROOT: "", task: "security" },
        workspace,
      });
      assertOk(result);

      expect(result.state_type).toBe("parallel");
      expect(result.prompts).toHaveLength(2);
      expect(result.prompts[0].agent).toBe("canon-reviewer");
      expect(result.prompts[1].agent).toBe("canon-security");
    });
  });

  describe("consultation_prompts", () => {
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
        name: flowName("test-flow"),
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
        name: flowName("risk-assessment"),
        prompt: "Assess risks for test task.",
        role: "security-reviewer",
        section: "Risk Assessment",
        timeout: "10m",
      });
    });

    it("returns consultation_prompts for before breakpoint when wave is null/undefined", async () => {
      const workspace = makeTmpDir();
      seedStore(workspace);

      const flow = makeFlowWithConsultations("before");
      vi.mocked(resolveConsultationPrompt).mockReturnValue({
        agent: "canon-security",
        prompt: "Assess risks for test task.",
        role: "security-reviewer",
      });

      const result = await enterAndPrepareState({
        flow,
        state_id: "implement",
        variables: { CANON_PLUGIN_ROOT: "", task: "test task" },
        workspace,
        // wave is undefined
      });
      assertOk(result);

      expect(result.consultation_prompts).toBeDefined();
      expect(result.consultation_prompts).toHaveLength(1);
      expect(result.consultation_prompts![0].name).toBe("risk-assessment");
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
        wave: 1, // uses "between" breakpoint — but only "before" declared
        workspace,
      });
      assertOk(result);

      expect(result.consultation_prompts).toBeUndefined();
      expect(resolveConsultationPrompt).not.toHaveBeenCalled();
    });

    it("returns no consultation_prompts when stateDef has no consultations", async () => {
      const workspace = makeTmpDir();
      seedStore(workspace);

      const flow = makeFlow(); // no consultations declared

      const result = await enterAndPrepareState({
        flow,
        state_id: "implement",
        variables: { CANON_PLUGIN_ROOT: "", task: "test task" },
        wave: 0,
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

      // Seed store with a state that has a completed consultation in wave_results
      const store = getExecutionStore(workspace);
      const now = new Date().toISOString();
      store.initExecution({
        base_commit: "abc1234",
        branch: "feat/test",
        created: now,
        current_state: "implement",
        entry: "implement",
        flow: flowName("test-flow"),
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
              "risk-assessment": {
                status: "done",
                summary: "Risk: ${evil} injection attempt",
              },
            },
          },
          status: "done",
          tasks: [],
        },
      };

      store.upsertState(sid("implement"), {
        entries: 1,
        status: "in_progress",
        wave_results: waveResults,
      });
      store.upsertState(sid("done"), { entries: 0, status: "pending" });

      // escapeDollarBrace should escape the injection string
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

  describe("workspace not found", () => {
    it("returns WORKSPACE_NOT_FOUND ToolResult when workspace has no execution", async () => {
      const workspace = makeTmpDir(); // not seeded — no execution row

      const flow = makeFlow();
      const result = await enterAndPrepareState({
        flow,
        state_id: "implement",
        variables: { CANON_PLUGIN_ROOT: "", task: "test" },
        workspace,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
      expect(result.message).toContain(workspace);
    });
  });
});

describe("enterAndPrepareState — session branch variable injection", () => {
  it("injects branch from session into spawn prompt variables", async () => {
    const workspace = makeTmpDir();
    seedStore(workspace); // seeds with branch: "feat/test"

    const flow = makeFlow({
      spawn_instructions: { [sid("implement")]: "Branch is ${branch}." },
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
      flow: flowName("test-flow"),
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
    store.upsertState(sid("implement"), { entries: 0, status: "pending" });
    store.upsertState(sid("done"), { entries: 0, status: "pending" });

    const flow = makeFlow({
      spawn_instructions: { [sid("implement")]: "Worktree: ${worktree_branch}" },
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
      flow: flowName("test-flow"),
      flow_name: "test-flow",
      last_updated: now,
      sanitized: "feat-my-feature",
      slug: "my-slug",
      started: now,
      task: "test task",
      tier: "medium",
      worktree_path: "/tmp/worktrees/my-slug",
    });
    store.upsertState(sid("implement"), { entries: 0, status: "pending" });
    store.upsertState(sid("done"), { entries: 0, status: "pending" });

    const flow = makeFlow({
      spawn_instructions: { [sid("implement")]: "Path: ${worktree_path}" },
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
      spawn_instructions: { [sid("implement")]: "Branch: ${branch}" },
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
        [sid("implement")]: "Branch: ${branch}, Worktree: ${worktree_branch}, Path: ${worktree_path}",
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
    const missingWorkspace = workspacePath(join(tmpdir(), ".canon", "workspaces", "nonexistent-dir-for-eaps"));

    const flow: ResolvedFlow = {
      description: "",
      entry: "implement",
      name: flowName("test-flow"),
      states: {
        implement: {
          prompt: "test",
          roles: [{ name: flowName("implementor") }],
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
