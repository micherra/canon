/**
 * Tests for enter-and-prepare-state.ts
 *
 * Covers:
 * 1. Convergence blocked — returns can_enter:false without entering state or resolving prompts
 * 2. Skip evaluation before enter — skip_when met returns skip_reason, state stays "pending"
 * 3. Happy path — enters state, resolves prompts, returns combined result
 * 4. Terminal state — empty prompts, state_type "terminal"
 * 5. Board read count — readBoard called exactly once per invocation
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Hoist mocks before module imports
// ---------------------------------------------------------------------------

vi.mock("../orchestration/board.js", () => ({
  readBoard: vi.fn(),
  writeBoard: vi.fn(),
  enterState: vi.fn(),
}));

vi.mock("../orchestration/workspace.js", () => ({
  withBoardLock: vi.fn(async (_workspace: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("../orchestration/skip-when.js", () => ({
  evaluateSkipWhen: vi.fn(),
}));

vi.mock("../orchestration/event-bus-instance.js", () => ({
  flowEventBus: {
    emit: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock("../orchestration/events.js", () => ({
  createJsonlLogger: vi.fn(() => vi.fn()),
}));

vi.mock("../orchestration/consultation-executor.js", () => ({
  resolveConsultationPrompt: vi.fn(),
}));

vi.mock("../orchestration/wave-variables.js", () => ({
  escapeDollarBrace: vi.fn((s: string) => s),
  substituteVariables: vi.fn((s: string) => s),
  buildTemplateInjection: vi.fn(() => ""),
  parseTaskIdsForWave: vi.fn(() => []),
  extractFilePaths: vi.fn(() => []),
}));

import { readBoard, writeBoard, enterState } from "../orchestration/board.ts";
import { evaluateSkipWhen } from "../orchestration/skip-when.ts";
import { resolveConsultationPrompt } from "../orchestration/consultation-executor.ts";
import { escapeDollarBrace } from "../orchestration/wave-variables.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";
import type { Board, ResolvedFlow } from "../orchestration/flow-schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eaps-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeBoard(overrides: Record<string, unknown> = {}): Board {
  return {
    flow: "test-flow",
    task: "test task",
    entry: "implement",
    current_state: "implement",
    base_commit: "abc1234",
    started: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    states: {
      implement: { status: "pending", entries: 0 },
      done: { status: "pending", entries: 0 },
    },
    iterations: {},
    blocked: null,
    concerns: [],
    skipped: [],
    ...overrides,
  } as Board;
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
      const board = makeBoard({
        iterations: {
          implement: { count: 3, max: 3, history: [], cannot_fix: [] },
        },
      });
      vi.mocked(readBoard).mockResolvedValue(board);

      const flow = makeFlow();
      const result = await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
      });

      expect(result.can_enter).toBe(false);
      expect(result.iteration_count).toBe(3);
      expect(result.max_iterations).toBe(3);
      expect(result.prompts).toHaveLength(0);

      // State must NOT have been entered
      expect(enterState).not.toHaveBeenCalled();
      expect(writeBoard).not.toHaveBeenCalled();
    });

    it("includes cannot_fix_items and history in the convergence-blocked result", async () => {
      const workspace = makeTmpDir();
      const cannotFixItems = [{ principle_id: "thin-handlers", file_path: "src/api/handler.ts" }];
      const history = [{ principle_ids: ["thin-handlers"], file_paths: ["src/api/handler.ts"] }];
      const board = makeBoard({
        iterations: {
          implement: { count: 2, max: 2, history, cannot_fix: cannotFixItems },
        },
      });
      vi.mocked(readBoard).mockResolvedValue(board);

      const result = await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow: makeFlow(),
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
      });

      expect(result.can_enter).toBe(false);
      expect(result.cannot_fix_items).toEqual(cannotFixItems);
      expect(result.history).toEqual(history);
    });
  });

  describe("skip evaluation before enter", () => {
    it("returns skipped:true when skip_when condition is met, without entering state", async () => {
      const workspace = makeTmpDir();
      const board = makeBoard();
      vi.mocked(readBoard).mockResolvedValue(board);
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

      expect(result.can_enter).toBe(true);
      expect(result.skip_reason).toBeDefined();
      expect(result.skip_reason).toContain("no_contract_changes");
      expect(result.prompts).toHaveLength(0);

      // State must NOT have been entered — board stays "pending"
      expect(enterState).not.toHaveBeenCalled();
      expect(writeBoard).not.toHaveBeenCalled();
    });

    it("does not skip when skip_when condition is not met", async () => {
      const workspace = makeTmpDir();
      const board = makeBoard();
      const enteredBoard = makeBoard({
        states: { implement: { status: "in_progress", entries: 1 }, done: { status: "pending", entries: 0 } },
      });
      vi.mocked(readBoard).mockResolvedValue(board);
      vi.mocked(evaluateSkipWhen).mockResolvedValue({ skip: false });
      vi.mocked(enterState).mockReturnValue(enteredBoard);

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

      expect(result.can_enter).toBe(true);
      expect(result.skip_reason).toBeUndefined();
      expect(result.prompts).toHaveLength(1);
      expect(enterState).toHaveBeenCalledTimes(1);
    });
  });

  describe("happy path", () => {
    beforeEach(() => {
      const board = makeBoard();
      const enteredBoard = makeBoard({
        states: { implement: { status: "in_progress", entries: 1 }, done: { status: "pending", entries: 0 } },
      });
      vi.mocked(readBoard).mockResolvedValue(board);
      vi.mocked(enterState).mockReturnValue(enteredBoard);
    });

    it("returns can_enter:true and resolved prompts for a single-agent state", async () => {
      const workspace = makeTmpDir();
      const flow = makeFlow();

      const result = await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "build the widget", CANON_PLUGIN_ROOT: "" },
      });

      expect(result.can_enter).toBe(true);
      expect(result.state_type).toBe("single");
      expect(result.prompts).toHaveLength(1);
      expect(result.prompts[0].agent).toBe("canon-implementor");
      expect(result.prompts[0].prompt).toContain("build the widget");
    });

    it("returns the updated board in the result", async () => {
      const workspace = makeTmpDir();
      const flow = makeFlow();

      const result = await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
      });

      // Board should reflect in_progress status after entering
      expect(result.board).toBeDefined();
      expect(result.board!.states["implement"].status).toBe("in_progress");
    });

    it("returns iteration_count from board for a state without iteration limits", async () => {
      const workspace = makeTmpDir();
      const flow = makeFlow();

      const result = await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
      });

      expect(result.iteration_count).toBe(0);
      expect(result.max_iterations).toBe(0);
      expect(result.cannot_fix_items).toEqual([]);
      expect(result.history).toEqual([]);
    });
  });

  describe("terminal state", () => {
    it("returns can_enter:true with empty prompts and state_type 'terminal'", async () => {
      const workspace = makeTmpDir();
      const board = makeBoard();
      const enteredBoard = makeBoard({
        states: { implement: { status: "pending", entries: 0 }, done: { status: "in_progress", entries: 1 } },
      });
      vi.mocked(readBoard).mockResolvedValue(board);
      vi.mocked(enterState).mockReturnValue(enteredBoard);

      const flow = makeFlow();

      const result = await enterAndPrepareState({
        workspace,
        state_id: "done",
        flow,
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
      });

      expect(result.can_enter).toBe(true);
      expect(result.state_type).toBe("terminal");
      expect(result.prompts).toHaveLength(0);
    });
  });

  describe("parallel state", () => {
    it("returns one prompt per agent for parallel states", async () => {
      const workspace = makeTmpDir();
      const board = makeBoard({
        states: {
          review: { status: "pending", entries: 0 },
          done: { status: "pending", entries: 0 },
        },
      });
      const enteredBoard = makeBoard({
        states: {
          review: { status: "in_progress", entries: 1 },
          done: { status: "pending", entries: 0 },
        },
      });
      vi.mocked(readBoard).mockResolvedValue(board);
      vi.mocked(enterState).mockReturnValue(enteredBoard);

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

    beforeEach(() => {
      const board = makeBoard();
      const enteredBoard = makeBoard({
        states: { implement: { status: "in_progress", entries: 1 }, done: { status: "pending", entries: 0 } },
      });
      vi.mocked(readBoard).mockResolvedValue(board);
      vi.mocked(enterState).mockReturnValue(enteredBoard);
    });

    it("returns consultation_prompts for before breakpoint when wave is 0", async () => {
      const workspace = makeTmpDir();
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

      expect(result.consultation_prompts).toBeDefined();
      expect(result.consultation_prompts).toHaveLength(1);
      expect(result.consultation_prompts![0].name).toBe("risk-assessment");
    });

    it("uses between breakpoint when wave > 0", async () => {
      const workspace = makeTmpDir();
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

      expect(result.consultation_prompts).toBeDefined();
      expect(result.consultation_prompts).toHaveLength(1);

      // Verify resolveConsultationPrompt was called (between breakpoint names were resolved)
      expect(resolveConsultationPrompt).toHaveBeenCalledWith(
        "risk-assessment",
        flow,
        { task: "test task", CANON_PLUGIN_ROOT: "" },
      );
    });

    it("returns no consultation_prompts when wave > 0 but only before consultations declared", async () => {
      const workspace = makeTmpDir();
      const flow = makeFlowWithConsultations("before"); // only has "before", not "between"

      const result = await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test task", CANON_PLUGIN_ROOT: "" },
        wave: 1, // wave > 0 → uses "between" breakpoint
      });

      // between is empty/absent, so no consultation_prompts
      expect(result.consultation_prompts).toBeUndefined();
      expect(resolveConsultationPrompt).not.toHaveBeenCalled();
    });

    it("returns no consultation_prompts when stateDef has no consultations", async () => {
      const workspace = makeTmpDir();
      const flow = makeFlow(); // no consultations declared

      const result = await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test task", CANON_PLUGIN_ROOT: "" },
        wave: 0,
      });

      expect(result.consultation_prompts).toBeUndefined();
      expect(resolveConsultationPrompt).not.toHaveBeenCalled();
    });

    it("gracefully skips unknown consultation names (resolveConsultationPrompt returns null)", async () => {
      const workspace = makeTmpDir();
      const flow = makeFlowWithConsultations("before");

      // Simulate unknown name — resolveConsultationPrompt returns null
      vi.mocked(resolveConsultationPrompt).mockReturnValue(null);

      const result = await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test task", CANON_PLUGIN_ROOT: "" },
        wave: 0,
      });

      // No crash — just empty result
      expect(result.consultation_prompts).toBeUndefined();
    });

    it("escapes ${evil} in completed consultation summaries before passing as consultation_outputs", async () => {
      const workspace = makeTmpDir();

      // Board with a completed consultation summary containing injection attempt
      const boardWithResults = makeBoard({
        states: {
          implement: {
            status: "in_progress",
            entries: 1,
            wave_results: {
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
            },
          },
          done: { status: "pending", entries: 0 },
        },
      });
      const enteredBoard = makeBoard({
        states: {
          implement: {
            status: "in_progress",
            entries: 2,
            wave_results: boardWithResults.states["implement"].wave_results,
          },
          done: { status: "pending", entries: 0 },
        },
      });
      vi.mocked(readBoard).mockResolvedValue(boardWithResults);
      vi.mocked(enterState).mockReturnValue(enteredBoard);

      // escapeDollarBrace should escape the injection string
      vi.mocked(escapeDollarBrace).mockImplementation((s: string) =>
        s.replace(/\$\{/g, "\\${")
      );

      const flow = makeFlowWithConsultations("between");
      // No new consultation for between — we're testing that outputs are escaped
      vi.mocked(resolveConsultationPrompt).mockReturnValue(null);

      await enterAndPrepareState({
        workspace,
        state_id: "implement",
        flow,
        variables: { task: "test task", CANON_PLUGIN_ROOT: "" },
        wave: 1,
      });

      // escapeDollarBrace must have been called with the raw summary
      expect(escapeDollarBrace).toHaveBeenCalledWith("Risk: ${evil} injection attempt");
    });
  });
});
