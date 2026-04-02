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

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertOk } from "../utils/tool-result.ts";
import { getExecutionStore, clearStoreCache } from "../orchestration/execution-store.ts";
import { flowEventBus } from "../orchestration/event-bus-instance.ts";
import type { ResolvedFlow } from "../orchestration/flow-schema.ts";

// ---------------------------------------------------------------------------
// Hoist mocks before module imports
// ---------------------------------------------------------------------------

vi.mock("../orchestration/skip-when.ts", () => ({
  evaluateSkipWhen: vi.fn().mockResolvedValue({ skip: false }),
}));

vi.mock("../orchestration/event-bus-instance.ts", () => ({
  flowEventBus: {
    emit: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
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

import { reportAndEnterNextState } from "../tools/report-and-enter-next-state.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    flow: flow.name,
    task: "test task",
    entry: flow.entry,
    current_state: flow.entry,
    base_commit: "abc123",
    started: now,
    last_updated: now,
    branch: "feat/test",
    sanitized: "feat-test",
    created: now,
    tier: "medium",
    flow_name: flow.name,
    slug: "test-slug",
  });

  for (const stateId of Object.keys(flow.states)) {
    store.upsertState(stateId, { status: "pending", entries: 0 });
  }
}

function makeFlow(overrides?: Partial<ResolvedFlow>): ResolvedFlow {
  return {
    name: "test-flow",
    description: "A test flow",
    entry: "build",
    spawn_instructions: {
      build: "Build the thing: ${task}",
      review: "Review the thing: ${task}",
    },
    states: {
      build: {
        type: "single",
        agent: "canon-implementor",
        transitions: {
          done: "review",
          failed: "hitl",
        },
      },
      review: {
        type: "single",
        agent: "canon-reviewer",
        transitions: {
          done: "ship",
        },
      },
      ship: { type: "terminal" },
      hitl: { type: "terminal" },
    },
    ...overrides,
  };
}

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reportAndEnterNextState", () => {
  describe("normal transition", () => {
    it("reports done and enters next state, returning combined result", async () => {
      const workspace = makeTmpWorkspace();
      const flow = makeFlow();
      setupWorkspace(workspace, flow);

      const result = await reportAndEnterNextState({
        workspace,
        state_id: "build",
        status_keyword: "DONE",
        flow,
        variables: { task: "build the widget", CANON_PLUGIN_ROOT: "" },
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
        workspace,
        state_id: "build",
        status_keyword: "DONE",
        flow,
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
      });
      assertOk(result);

      // Board should reflect the next state entered
      expect(result.board).toBeDefined();
      expect(result.board.states["build"].status).toBe("done");

      // Enter phase should have entered the review state
      expect(result.enter!.board).toBeDefined();
      expect(result.enter!.board!.states["review"].status).toBe("in_progress");
    });

    it("uses the enter phase board as the final board when enter succeeds", async () => {
      const workspace = makeTmpWorkspace();
      const flow = makeFlow();
      setupWorkspace(workspace, flow);

      const result = await reportAndEnterNextState({
        workspace,
        state_id: "build",
        status_keyword: "DONE",
        flow,
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
      });
      assertOk(result);

      // The top-level board should be the enter phase board (more up-to-date)
      expect(result.board.states["review"].status).toBe("in_progress");
    });
  });

  describe("HITL triggered", () => {
    it("returns report only when hitl_required is true (unrecognized status)", async () => {
      const workspace = makeTmpWorkspace();
      const flow = makeFlow();
      setupWorkspace(workspace, flow);

      const result = await reportAndEnterNextState({
        workspace,
        state_id: "build",
        status_keyword: "COMPLETELY_BROKEN",
        flow,
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
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
        workspace,
        state_id: "build",
        status_keyword: "FAILED",
        flow,
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
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
            type: "single",
            agent: "canon-implementor",
            transitions: { done: "ship" },
          },
          ship: { type: "terminal" },
        },
      });
      setupWorkspace(workspace, flow);

      const result = await reportAndEnterNextState({
        workspace,
        state_id: "build",
        status_keyword: "DONE",
        flow,
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
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
            type: "single",
            agent: "canon-implementor",
            transitions: { failed: "hitl" },
          },
          hitl: { type: "terminal" },
        },
      });
      setupWorkspace(workspace, flow);

      const result = await reportAndEnterNextState({
        workspace,
        state_id: "build",
        status_keyword: "DONE",
        flow,
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
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
        workspace,
        state_id: "build",
        status_keyword: "DONE",
        flow,
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
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
            type: "single",
            agent: "canon-implementor",
            transitions: { done: "review" },
          },
          review: {
            type: "single",
            agent: "canon-reviewer",
            max_iterations: 2,
            transitions: { done: "ship" },
          },
          ship: { type: "terminal" },
        },
      });
      setupWorkspace(workspace, flow);

      // Seed the review state with max iterations already reached
      const store = getExecutionStore(workspace);
      store.upsertIteration("review", {
        count: 2,
        max: 2,
        history: [],
        cannot_fix: [],
      });

      const result = await reportAndEnterNextState({
        workspace,
        state_id: "build",
        status_keyword: "DONE",
        flow,
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
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
        workspace,
        state_id: "build",
        status_keyword: "DONE",
        flow,
        variables: { task: "test", CANON_PLUGIN_ROOT: "" },
        artifacts: ["summary.md"],
        progress_line: "- [build] done: built the thing",
      });
      assertOk(result);

      // Artifacts should be on the board state
      expect(result.board.states["build"].artifacts).toEqual(["summary.md"]);
    });
  });
});
