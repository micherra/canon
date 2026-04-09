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
import { assertOk } from "@shared/lib/tool-result.ts";
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

  // Create iteration rows if provided
  const iterations = overrides.iterations as Board["iterations"] | undefined;
  if (iterations) {
    for (const [stateId, iter] of Object.entries(iterations)) {
      store.upsertIteration(stateId, {
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

describe("enterAndPrepareState", () => {
  describe("convergence blocked", () => {
    it("returns can_enter:false when max iterations reached, without entering state", async () => {
      const workspace = makeTmpDir();
      seedStore(workspace, {
        iterations: {
          implement: { cannot_fix: [], count: 3, history: [], max: 3 },
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
      const stateEntry = store.getState("implement");
      expect(stateEntry?.status).toBe("pending");
    });

    it("includes cannot_fix_items and history in the convergence-blocked result", async () => {
      const workspace = makeTmpDir();
      const cannotFixItems = [{ file_path: "src/api/handler.ts", principle_id: "thin-handlers" }];
      const history = [{ file_paths: ["src/api/handler.ts"], principle_ids: ["thin-handlers"] }];
      seedStore(workspace, {
        iterations: {
          implement: { cannot_fix: cannotFixItems, count: 2, history, max: 2 },
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
          done: { type: "terminal" },
          implement: {
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
      expect(store.getState("implement")?.status).toBe("pending");
    });

    it("does not skip when skip_when condition is not met", async () => {
      const workspace = makeTmpDir();
      seedStore(workspace);
      vi.mocked(evaluateSkipWhen).mockResolvedValue({ skip: false });

      const flow = makeFlow({
        states: {
          done: { type: "terminal" },
          implement: {
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
      expect(store.getState("implement")?.status).toBe("in_progress");
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
      expect(result.board!.states.implement.status).toBe("in_progress");
      expect(result.board!.states.implement.entries).toBe(1);
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
      const stateEntry = store.getState("implement");
      expect(stateEntry?.status).toBe("in_progress");
      expect(stateEntry?.entries).toBe(1);
    });

    it("increments iteration count when state has iteration limits", async () => {
      const workspace = makeTmpDir();
      seedStore(workspace, {
        iterations: {
          implement: { cannot_fix: [], count: 1, history: [], max: 5 },
        },
      });

      const flow = makeFlow({
        states: {
          done: { type: "terminal" },
          implement: { agent: "canon-implementor", max_iterations: 5, type: "single" },
        },
      });

      await enterAndPrepareState({
        flow,
        state_id: "implement",
        variables: { CANON_PLUGIN_ROOT: "", task: "test" },
        workspace,
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
          done: { entries: 0, status: "pending" },
          implement: { entries: 0, status: "pending" },
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
          done: { entries: 0, status: "pending" },
          review: { entries: 0, status: "pending" },
        },
      });

      const flow: ResolvedFlow = {
        description: "Test flow",
        entry: "review",
        name: "test-flow",
        spawn_instructions: { review: "Review the code for ${task}." },
        states: {
          done: { type: "terminal" },
          review: { agents: ["canon-reviewer", "canon-security"], type: "parallel" },
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

  // consultation_prompts tests moved to enter-and-prepare-state-session.test.ts

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
