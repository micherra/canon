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

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { initExecutionDb } from "../orchestration/execution-schema.ts";
import { ExecutionStore, getExecutionStore } from "../orchestration/execution-store.ts";

// ---------------------------------------------------------------------------
// Hoist mocks before module imports
// ---------------------------------------------------------------------------

vi.mock("../orchestration/skip-when.ts", () => ({
  evaluateSkipWhen: vi.fn(),
}));

vi.mock("../orchestration/event-bus-instance.ts", () => ({
  flowEventBus: {
    emit: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock("../orchestration/consultation-executor.ts", () => ({
  resolveConsultationPrompt: vi.fn(),
}));

vi.mock("../orchestration/wave-variables.ts", () => ({
  escapeDollarBrace: vi.fn((s: string) => s),
  substituteVariables: vi.fn((s: string) => s),
  buildTemplateInjection: vi.fn(() => ""),
  parseTaskIdsForWave: vi.fn(() => []),
  extractFilePaths: vi.fn(() => []),
}));

import { evaluateSkipWhen } from "../orchestration/skip-when.ts";
import { resolveConsultationPrompt } from "../orchestration/consultation-executor.ts";
import { escapeDollarBrace } from "../orchestration/wave-variables.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";
import type { Board, ResolvedFlow } from "../orchestration/flow-schema.ts";
import { assertOk } from "../utils/tool-result.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    flow: overrides.flow ?? "test-flow",
    task: overrides.task ?? "test task",
    entry: overrides.entry ?? "implement",
    current_state: overrides.current_state ?? "implement",
    base_commit: overrides.base_commit ?? "abc1234",
    started: overrides.started ?? now,
    last_updated: overrides.last_updated ?? now,
    branch: "feat/test",
    sanitized: "feat-test",
    created: now,
    tier: "medium",
    flow_name: "test-flow",
    slug: "test-slug",
  });

  // Create initial state rows
  const states = (overrides.states as Board['states']) ?? {
    implement: { status: "pending", entries: 0 },
    done: { status: "pending", entries: 0 },
  };
  for (const [stateId, state] of Object.entries(states)) {
    store.upsertState(stateId, { status: state.status, entries: state.entries ?? 0 });
  }

  // Create iteration rows if provided
  const iterations = overrides.iterations as Board['iterations'] | undefined;
  if (iterations) {
    for (const [stateId, iter] of Object.entries(iterations)) {
      store.upsertIteration(stateId, {
        count: iter.count,
        max: iter.max,
        history: iter.history ?? [],
        cannot_fix: iter.cannot_fix ?? [],
      });
    }
  }

  return store;
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
    spawn_instructions: { implement: "Implement ${task}." },
    ...overrides,
  };
}

afterEach(() => {
  // Clear store cache between tests
  const cache = (getExecutionStore as any).__cache;
  if (cache instanceof Map) cache.clear();

  for (const d of tmpDirs) {
    rmSync(d, { recursive: true, force: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("enterAndPrepareState", () => {
  describe("convergence blocked", () => {
    it("returns can_enter:false when max iterations reached, without entering state", async () => {
      const workspace = makeTmpDir();
      seedStore(workspace, {
        iterations: {
          implement: { count: 3, max: 3, history: [], cannot_fix: [] },
        },
      });

      const flow = makeFlow();
      const result = await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
      });
      assertOk(result);

      expect(result.can_enter).toBe(false);
      expect(result.iteration_count).toBe(3);
      expect(result.max_iterations).toBe(3);
      expect(result.prompts).toHaveLength(0);

      // State must NOT have been entered — still pending
      const store = getExecutionStore(workspace);
      const stateEntry = store.getState("implement");
      expect(stateEntry?.status).toBe("pending");
    });

    it("includes cannot_fix_items and history in the convergence-blocked result", async () => {
      const workspace = makeTmpDir();
      const cannotFixItems = [{ principle_id: "thin-handlers", file_path: "src/api/handler.ts" }];
      const history = [{ principle_ids: ["thin-handlers"], file_paths: ["src/api/handler.ts"] }];
      seedStore(workspace, {
        iterations: {
          implement: { count: 2, max: 2, history, cannot_fix: cannotFixItems },
        },
      });

      const result = await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow: makeFlow(),
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
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
        skip: true,
        reason: "No contract changes detected — all changes are internal",
      });

      const flow = makeFlow({
        states: {
          implement: {
            type: "single",
            agent: "canon-implementor",
            skip_when: "no_contract_changes",
          },
          done: { type: "terminal" },
        },
      });

      const result = await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
      });
      assertOk(result);

      expect(result.can_enter).toBe(true);
      expect(result.skip_reason).toBeDefined();
      expect(result.skip_reason).toContain("no_contract_changes");
      expect(result.prompts).toHaveLength(0);

      // State must NOT have been entered — still pending
      const store = getExecutionStore(workspace);
      expect(store.getState("implement")?.status).toBe("pending");
    });

    it("does not skip when skip_when condition is not met", async () => {
      const workspace = makeTmpDir();
      seedStore(workspace);
      vi.mocked(evaluateSkipWhen).mockResolvedValue({ skip: false });

      const flow = makeFlow({
        states: {
          implement: {
            type: "single",
            agent: "canon-implementor",
            skip_when: "no_contract_changes",
          },
          done: { type: "terminal" },
        },
      });

      const result = await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
      });
      assertOk(result);

      expect(result.can_enter).toBe(true);
      expect(result.skip_reason).toBeUndefined();
      expect(result.prompts).toHaveLength(1);

      // State must have been entered — now in_progress
      const store = getExecutionStore(workspace);
      expect(store.getState("implement")?.status).toBe("in_progress");
    });
  });

  describe("happy path", () => {
    it("returns can_enter:true and resolved prompts for a single-agent state", async () => {
      const workspace = makeTmpDir();
      seedStore(workspace);

      const flow = makeFlow();
      const result = await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "build the widget", CANON_PLUGIN_ROOT: "" },
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
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
      });
      assertOk(result);

      expect(result.board).toBeDefined();
      expect(result.board!.states["implement"].status).toBe("in_progress");
      expect(result.board!.states["implement"].entries).toBe(1);
    });

    it("persists state entry to execution_states table — not board.json", async () => {
      const workspace = makeTmpDir();
      seedStore(workspace);

      const flow = makeFlow();
      await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
      });

      // Board.json must NOT exist
      expect(existsSync(join(workspace, "board.json"))).toBe(false);
      // .lock must NOT exist
      expect(existsSync(join(workspace, ".lock"))).toBe(false);

      // State must be persisted in SQLite
      const store = getExecutionStore(workspace);
      const stateEntry = store.getState("implement");
      expect(stateEntry?.status).toBe("in_progress");
      expect(stateEntry?.entries).toBe(1);
    });

    it("increments iteration count when state has iteration limits", async () => {
      const workspace = makeTmpDir();
      seedStore(workspace, {
        iterations: {
          implement: { count: 1, max: 5, history: [], cannot_fix: [] },
        },
      });

      const flow = makeFlow({
        states: {
          implement: { type: "single", agent: "canon-implementor", max_iterations: 5 },
          done: { type: "terminal" },
        },
      });

      await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
      });

      const store = getExecutionStore(workspace);
      const iter = store.getIteration("implement");
      expect(iter?.count).toBe(2);
    });

    it("returns iteration_count from board for a state without iteration limits", async () => {
      const workspace = makeTmpDir();
      seedStore(workspace);

      const flow = makeFlow();
      const result = await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
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
          implement: { status: "pending", entries: 0 },
          done: { status: "pending", entries: 0 },
        },
      });

      const flow = makeFlow();
      const result = await enterAndPrepareState({
        workspace,
        state_id: "done",
        flow,
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
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
          review: { status: "pending", entries: 0 },
          done: { status: "pending", entries: 0 },
        },
      });

      const flow: ResolvedFlow = {
        name: "test-flow",
        description: "Test flow",
        entry: "review",
        states: {
          review: { type: "parallel", agents: ["canon-reviewer", "canon-security"] },
          done: { type: "terminal" },
        },
        spawn_instructions: { review: "Review the code for ${task}." },
      };

      const result = await enterAndPrepareState({
        workspace,
        state_id: "review",
        flow,
        variables: { task: "security", CANON_PLUGIN_ROOT: "" },
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
        name: "test-flow",
        description: "Test flow",
        entry: "implement",
        states: {
          implement: {
            type: "wave",
            agent: "canon-implementor",
            consultations: { [breakpoint]: ["risk-assessment"] },
          },
          done: { type: "terminal" },
        },
        spawn_instructions: {
          implement: "Implement ${task}.",
          "risk-assessment": "Assess risks for ${task}.",
        },
        consultations: {
          "risk-assessment": {
            fragment: "risk-assessment",
            agent: "canon-security",
            role: "security-reviewer",
            timeout: "10m",
            section: "Risk Assessment",
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
        timeout: "10m",
        section: "Risk Assessment",
      });

      const result = await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test task", CANON_PLUGIN_ROOT: "" },
        wave: 0,
      });
      assertOk(result);

      expect(result.consultation_prompts).toBeDefined();
      expect(result.consultation_prompts).toHaveLength(1);
      expect(result.consultation_prompts![0]).toEqual({
        name: "risk-assessment",
        agent: "canon-security",
        prompt: "Assess risks for test task.",
        role: "security-reviewer",
        timeout: "10m",
        section: "Risk Assessment",
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
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test task", CANON_PLUGIN_ROOT: "" },
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
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test task", CANON_PLUGIN_ROOT: "" },
        wave: 1,
      });
      assertOk(result);

      expect(result.consultation_prompts).toBeDefined();
      expect(result.consultation_prompts).toHaveLength(1);
      expect(resolveConsultationPrompt).toHaveBeenCalledWith(
        "risk-assessment",
        flow,
        { task: "test task", CANON_PLUGIN_ROOT: "" },
      );
    });

    it("returns no consultation_prompts when wave > 0 but only before consultations declared", async () => {
      const workspace = makeTmpDir();
      seedStore(workspace);

      const flow = makeFlowWithConsultations("before");

      const result = await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test task", CANON_PLUGIN_ROOT: "" },
        wave: 1, // uses "between" breakpoint — but only "before" declared
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
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test task", CANON_PLUGIN_ROOT: "" },
        wave: 0,
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
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test task", CANON_PLUGIN_ROOT: "" },
        wave: 0,
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
        flow: "test-flow",
        task: "test task",
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

      const waveResults = {
        "wave-0": {
          tasks: [],
          status: "done",
          consultations: {
            before: {
              "risk-assessment": {
                status: "done",
                summary: "Risk: ${evil} injection attempt",
              },
            },
          },
        },
      };

      store.upsertState("implement", {
        status: "in_progress",
        entries: 1,
        wave_results: waveResults,
      });
      store.upsertState("done", { status: "pending", entries: 0 });

      // escapeDollarBrace should escape the injection string
      vi.mocked(escapeDollarBrace).mockImplementation((s: string) =>
        s.replace(/\$\{/g, "\\${")
      );

      const flow = makeFlowWithConsultations("between");
      vi.mocked(resolveConsultationPrompt).mockReturnValue(null);

      await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test task", CANON_PLUGIN_ROOT: "" },
        wave: 1,
      });

      expect(escapeDollarBrace).toHaveBeenCalledWith("Risk: ${evil} injection attempt");
    });
  });

  describe("workspace not found", () => {
    it("returns WORKSPACE_NOT_FOUND ToolResult when workspace has no execution", async () => {
      const workspace = makeTmpDir(); // not seeded — no execution row

      const flow = makeFlow();
      const result = await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
      expect(result.message).toContain(workspace);
    });
  });

  // ---------------------------------------------------------------------------
  // worktree_entries surfacing
  // ---------------------------------------------------------------------------

  describe("worktree_entries", () => {
    function makeWaveFlow(): ResolvedFlow {
      return {
        name: "test-flow",
        description: "Test flow",
        entry: "implement",
        states: {
          implement: { type: "wave", agent: "canon-implementor" },
          done: { type: "terminal" },
        },
        spawn_instructions: { implement: "Implement ${item}." },
      };
    }

    it("returns worktree_entries from wave_results when re-entering a wave state", async () => {
      const workspace = makeTmpDir();
      const store = getExecutionStore(workspace);
      const now = new Date().toISOString();
      store.initExecution({
        flow: "test-flow",
        task: "test task",
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

      const worktreeEntries = [
        { task_id: "rwf-01", worktree_path: "/tmp/wt/rwf-01", branch: "canon-build/rwf-01", status: "active" as const },
        { task_id: "rwf-02", worktree_path: "/tmp/wt/rwf-02", branch: "canon-build/rwf-02", status: "active" as const },
      ];

      store.upsertState("implement", {
        status: "in_progress",
        entries: 1,
        wave_results: {
          wave_1: {
            tasks: ["rwf-01", "rwf-02"],
            status: "in_progress",
            worktree_entries: worktreeEntries,
          },
        },
      });
      store.upsertState("done", { status: "pending", entries: 0 });

      const flow = makeWaveFlow();
      const result = await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test task", CANON_PLUGIN_ROOT: "" },
        wave: 1,
        items: ["rwf-01", "rwf-02"],
      });

      expect(result.worktree_entries).toBeDefined();
      expect(result.worktree_entries).toHaveLength(2);
      expect(result.worktree_entries![0].task_id).toBe("rwf-01");
      expect(result.worktree_entries![1].task_id).toBe("rwf-02");
    });

    it("returns no worktree_entries on first entry of wave state (no prior wave_results)", async () => {
      const workspace = makeTmpDir();
      seedStore(workspace, {
        states: {
          implement: { status: "pending", entries: 0 },
          done: { status: "pending", entries: 0 },
        },
      });

      const flow = makeWaveFlow();
      const result = await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test task", CANON_PLUGIN_ROOT: "" },
        wave: 1,
        items: ["rwf-01", "rwf-02"],
      });

      expect(result.worktree_entries).toBeUndefined();
    });

    it("populates worktree_path on SpawnPromptEntry when matching active worktree entry exists", async () => {
      const workspace = makeTmpDir();
      const store = getExecutionStore(workspace);
      const now = new Date().toISOString();
      store.initExecution({
        flow: "test-flow",
        task: "test task",
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

      const worktreeEntries = [
        { task_id: "rwf-01", worktree_path: "/tmp/wt/rwf-01", branch: "canon-build/rwf-01", status: "active" as const },
        { task_id: "rwf-02", worktree_path: "/tmp/wt/rwf-02", branch: "canon-build/rwf-02", status: "merged" as const },
      ];

      store.upsertState("implement", {
        status: "in_progress",
        entries: 1,
        wave_results: {
          wave_1: {
            tasks: ["rwf-01", "rwf-02"],
            status: "in_progress",
            worktree_entries: worktreeEntries,
          },
        },
      });
      store.upsertState("done", { status: "pending", entries: 0 });

      const flow = makeWaveFlow();
      const result = await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test task", CANON_PLUGIN_ROOT: "" },
        wave: 1,
        items: ["rwf-01", "rwf-02"],
      });

      // rwf-01 is "active" — worktree_path should be set
      const prompt01 = result.prompts.find(p => p.item === "rwf-01");
      expect(prompt01).toBeDefined();
      expect(prompt01!.worktree_path).toBe("/tmp/wt/rwf-01");

      // rwf-02 is "merged" — worktree_path should NOT be set
      const prompt02 = result.prompts.find(p => p.item === "rwf-02");
      expect(prompt02).toBeDefined();
      expect(prompt02!.worktree_path).toBeUndefined();
    });
  });
});
