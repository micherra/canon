/**
 * Tests for report-and-enter-next-state.ts
 *
 * Covers:
 * 1. Normal transition: reports done, enters next state, returns combined result
 * 2. HITL triggered: reports blocked/stuck, no enter phase
 * 3. Terminal next state: reports done but skips enter because next state is terminal
 * 4. Report error: returns error without entering next state
 * 5. Enter convergence exceeded: report succeeds, enter returns can_enter:false
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearStoreCache, getExecutionStore } from "../orchestration/execution-store.ts";
import type { ResolvedFlow } from "../orchestration/flow-schema.ts";
import { assertOk } from "../utils/tool-result.ts";

// Hoist mocks before module imports

vi.mock("../orchestration/skip-when.ts", () => ({
  evaluateSkipWhen: vi.fn().mockResolvedValue({ skip: false }),
}));

vi.mock("../orchestration/event-bus-instance.ts", () => ({
  flowEventBus: {
    emit: vi.fn(),
    once: vi.fn(),
    removeAllListeners: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock("../orchestration/consultation-executor.ts", () => ({
  resolveConsultationPrompt: vi.fn(),
}));

vi.mock("../orchestration/wave-variables.ts", () => ({
  buildTemplateInjection: vi.fn(() => ""),
  escapeDollarBrace: vi.fn((s: string) => s),
  extractFilePaths: vi.fn(() => []),
  parseTaskIdsForWave: vi.fn(() => []),
  substituteVariables: vi.fn((s: string) => s),
}));

import { reportAndEnterNextState } from "../tools/report-and-enter-next-state.ts";

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "raens-test-"));
  tmpDirs.push(dir);
  return dir;
}

function setupWorkspace(workspace: string, flow: ResolvedFlow): void {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();

  store.initExecution({
    base_commit: "abc123",
    branch: "feat/test",
    created: now,
    current_state: flow.entry,
    entry: flow.entry,
    flow: flow.name,
    flow_name: flow.name,
    last_updated: now,
    sanitized: "feat-test",
    slug: "test-slug",
    started: now,
    task: "test task",
    tier: "medium",
  });

  for (const stateId of Object.keys(flow.states)) {
    store.upsertState(stateId, { entries: 0, status: "pending" });
  }
}

function makeFlow(overrides?: Partial<ResolvedFlow>): ResolvedFlow {
  return {
    description: "A test flow",
    entry: "build",
    name: "test-flow",
    spawn_instructions: {
      build: "Build the thing: ${task}",
      review: "Review the thing: ${task}",
    },
    states: {
      build: {
        agent: "canon-implementor",
        transitions: {
          done: "review",
          failed: "hitl",
        },
        type: "single",
      },
      hitl: { type: "terminal" },
      review: {
        agent: "canon-reviewer",
        transitions: {
          done: "ship",
        },
        type: "single",
      },
      ship: { type: "terminal" },
    },
    ...overrides,
  };
}

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

describe("reportAndEnterNextState", () => {
  describe("normal transition", () => {
    it("reports done and enters next state, returning combined result", async () => {
      const workspace = makeTmpWorkspace();
      const flow = makeFlow();
      setupWorkspace(workspace, flow);

      const result = await reportAndEnterNextState({
        flow,
        state_id: "build",
        status_keyword: "DONE",
        variables: { CANON_PLUGIN_ROOT: "", task: "build the widget" },
        workspace,
      });
      assertOk(result);

      // Report phase should be present with correct transition
      expect(result.report.transition_condition).toBe("done");
      expect(result.report.next_state).toBe("review");
      expect(result.report.hitl_required).toBe(false);
      expect(result.report.stuck).toBe(false);

      // Enter phase should be present since next state is non-terminal
      expect(result.enter).toBeDefined();
      expect(result.enter!.can_enter).toBe(true);
      expect(result.enter!.state_type).toBe("single");
      expect(result.enter!.prompts).toHaveLength(1);
      expect(result.enter!.prompts[0].agent).toBe("canon-reviewer");
    });

    it("updates board current_state to next state after report", async () => {
      const workspace = makeTmpWorkspace();
      const flow = makeFlow();
      setupWorkspace(workspace, flow);

      const result = await reportAndEnterNextState({
        flow,
        state_id: "build",
        status_keyword: "DONE",
        variables: { CANON_PLUGIN_ROOT: "", task: "test" },
        workspace,
      });
      assertOk(result);

      // Board should reflect the next state entered
      expect(result.board).toBeDefined();
      expect(result.board.states.build.status).toBe("done");

      // Enter phase should have entered the review state
      expect(result.enter!.board).toBeDefined();
      expect(result.enter!.board!.states.review.status).toBe("in_progress");
    });

    it("uses the enter phase board as the final board when enter succeeds", async () => {
      const workspace = makeTmpWorkspace();
      const flow = makeFlow();
      setupWorkspace(workspace, flow);

      const result = await reportAndEnterNextState({
        flow,
        state_id: "build",
        status_keyword: "DONE",
        variables: { CANON_PLUGIN_ROOT: "", task: "test" },
        workspace,
      });
      assertOk(result);

      // The top-level board should be the enter phase board (more up-to-date)
      expect(result.board.states.review.status).toBe("in_progress");
    });
  });

  describe("HITL triggered", () => {
    it("returns report only when hitl_required is true (unrecognized status)", async () => {
      const workspace = makeTmpWorkspace();
      const flow = makeFlow();
      setupWorkspace(workspace, flow);

      const result = await reportAndEnterNextState({
        flow,
        state_id: "build",
        status_keyword: "COMPLETELY_BROKEN",
        variables: { CANON_PLUGIN_ROOT: "", task: "test" },
        workspace,
      });
      assertOk(result);

      expect(result.report.hitl_required).toBe(true);
      expect(result.report.hitl_reason).toContain("COMPLETELY_BROKEN");

      // Enter phase must be absent
      expect(result.enter).toBeUndefined();
    });

    it("returns report only when transition leads to hitl state", async () => {
      const workspace = makeTmpWorkspace();
      const flow = makeFlow();
      setupWorkspace(workspace, flow);

      const result = await reportAndEnterNextState({
        flow,
        state_id: "build",
        status_keyword: "FAILED",
        variables: { CANON_PLUGIN_ROOT: "", task: "test" },
        workspace,
      });
      assertOk(result);

      expect(result.report.hitl_required).toBe(true);

      // Enter phase must be absent
      expect(result.enter).toBeUndefined();
    });
  });

  describe("terminal next state", () => {
    it("returns report only when next state is terminal", async () => {
      const workspace = makeTmpWorkspace();
      // Flow where build transitions directly to terminal state
      const flow = makeFlow({
        states: {
          build: {
            agent: "canon-implementor",
            transitions: { done: "ship" },
            type: "single",
          },
          ship: { type: "terminal" },
        },
      });
      setupWorkspace(workspace, flow);

      const result = await reportAndEnterNextState({
        flow,
        state_id: "build",
        status_keyword: "DONE",
        variables: { CANON_PLUGIN_ROOT: "", task: "test" },
        workspace,
      });
      assertOk(result);

      expect(result.report.next_state).toBe("ship");
      expect(result.report.hitl_required).toBe(false);

      // Enter phase must be absent — ship is terminal
      expect(result.enter).toBeUndefined();
    });

    it("returns report only when next_state is null", async () => {
      const workspace = makeTmpWorkspace();
      // Flow where build has no matching transition for "done"
      const flow = makeFlow({
        states: {
          build: {
            agent: "canon-implementor",
            transitions: { failed: "hitl" },
            type: "single",
          },
          hitl: { type: "terminal" },
        },
      });
      setupWorkspace(workspace, flow);

      const result = await reportAndEnterNextState({
        flow,
        state_id: "build",
        status_keyword: "DONE",
        variables: { CANON_PLUGIN_ROOT: "", task: "test" },
        workspace,
      });
      assertOk(result);

      // HITL triggered due to unmatched transition
      expect(result.report.hitl_required).toBe(true);

      // Enter phase must be absent
      expect(result.enter).toBeUndefined();
    });
  });

  describe("report error", () => {
    it("returns error without entering next state when no execution initialized in workspace", async () => {
      // Create a workspace directory with no execution store initialized
      const workspace = makeTmpWorkspace();
      const flow = makeFlow();
      // Intentionally do NOT call setupWorkspace — no execution row exists

      const result = await reportAndEnterNextState({
        flow,
        state_id: "build",
        status_keyword: "DONE",
        variables: { CANON_PLUGIN_ROOT: "", task: "test" },
        workspace,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
      }
    });
  });

  describe("enter convergence exceeded", () => {
    it("returns enter with can_enter:false when max iterations reached", async () => {
      const workspace = makeTmpWorkspace();
      const flow = makeFlow({
        states: {
          build: {
            agent: "canon-implementor",
            transitions: { done: "review" },
            type: "single",
          },
          review: {
            agent: "canon-reviewer",
            max_iterations: 2,
            transitions: { done: "ship" },
            type: "single",
          },
          ship: { type: "terminal" },
        },
      });
      setupWorkspace(workspace, flow);

      // Seed the review state with max iterations already reached
      const store = getExecutionStore(workspace);
      store.upsertIteration("review", {
        cannot_fix: [],
        count: 2,
        history: [],
        max: 2,
      });

      const result = await reportAndEnterNextState({
        flow,
        state_id: "build",
        status_keyword: "DONE",
        variables: { CANON_PLUGIN_ROOT: "", task: "test" },
        workspace,
      });
      assertOk(result);

      // Report phase succeeds
      expect(result.report.next_state).toBe("review");
      expect(result.report.hitl_required).toBe(false);

      // Enter phase is present but can_enter is false
      expect(result.enter).toBeDefined();
      expect(result.enter!.can_enter).toBe(false);
      expect(result.enter!.iteration_count).toBe(2);
      expect(result.enter!.max_iterations).toBe(2);
      expect(result.enter!.prompts).toHaveLength(0);
    });
  });

  describe("passthrough fields", () => {
    it("passes artifacts and progress_line to the report phase", async () => {
      const workspace = makeTmpWorkspace();
      const flow = makeFlow();
      setupWorkspace(workspace, flow);

      const result = await reportAndEnterNextState({
        artifacts: ["summary.md"],
        flow,
        progress_line: "- [build] done: built the thing",
        state_id: "build",
        status_keyword: "DONE",
        variables: { CANON_PLUGIN_ROOT: "", task: "test" },
        workspace,
      });
      assertOk(result);

      // Artifacts should be on the board state
      expect(result.board.states.build.artifacts).toEqual(["summary.md"]);
    });
  });
});
