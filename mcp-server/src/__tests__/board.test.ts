import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedFlow, Board } from "../orchestration/flow-schema.ts";
import {
  initBoard,
  enterState,
  completeState,
  setBlocked,
  recordConsultationResult,
  recordGateResult,
} from "../orchestration/board.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMinimalFlow(overrides?: Partial<ResolvedFlow>): ResolvedFlow {
  return {
    name: "test-flow",
    description: "A test flow",
    entry: "start",
    spawn_instructions: {},
    states: {
      start: { type: "single" },
      review: { type: "single", max_iterations: 3 },
      done: { type: "terminal" },
    },
    ...overrides,
  };
}

function makeBoard(): Board {
  return initBoard(makeMinimalFlow(), "build feature X", "abc123");
}

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "board-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs) {
    rmSync(d, { recursive: true, force: true });
  }
  tmpDirs = [];
});

// ---------------------------------------------------------------------------
// initBoard
// ---------------------------------------------------------------------------

describe("initBoard", () => {
  it("creates correct structure from a minimal ResolvedFlow", () => {
    const flow = makeMinimalFlow();
    const board = initBoard(flow, "my task", "deadbeef");

    expect(board.flow).toBe("test-flow");
    expect(board.task).toBe("my task");
    expect(board.entry).toBe("start");
    expect(board.current_state).toBe("start");
    expect(board.base_commit).toBe("deadbeef");
    expect(board.started).toBeTruthy();
    expect(board.last_updated).toBe(board.started);
    expect(board.blocked).toBeNull();
    expect(board.concerns).toEqual([]);
    expect(board.skipped).toEqual([]);

    // All states should be pending with 0 entries
    for (const key of Object.keys(flow.states)) {
      expect(board.states[key]).toEqual({ status: "pending", entries: 0 });
    }
  });

  it("populates iterations for states with max_iterations", () => {
    const board = makeBoard();

    // "review" has max_iterations: 3
    expect(board.iterations.review).toEqual({
      count: 0,
      max: 3,
      history: [],
      cannot_fix: [],
    });

    // "start" and "done" do not have max_iterations
    expect(board.iterations.start).toBeUndefined();
    expect(board.iterations.done).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// enterState
// ---------------------------------------------------------------------------

describe("enterState", () => {
  it("sets status to in_progress and increments entries", () => {
    const board = makeBoard();
    const result = enterState(board, "start");

    expect(result.current_state).toBe("start");
    expect(result.states.start.status).toBe("in_progress");
    expect(result.states.start.entries).toBe(1);
  });

  it("sets entered_at timestamp", () => {
    const board = makeBoard();
    const result = enterState(board, "start");
    expect(result.states.start.entered_at).toBeTruthy();
  });

  it("increments iteration count for iterable states", () => {
    const board = makeBoard();
    const r1 = enterState(board, "review");
    expect(r1.iterations.review.count).toBe(1);

    const r2 = enterState(r1, "review");
    expect(r2.iterations.review.count).toBe(2);
    expect(r2.states.review.entries).toBe(2);
  });

  it("does not mutate the original board", () => {
    const board = makeBoard();
    const result = enterState(board, "start");
    expect(board.states.start.status).toBe("pending");
    expect(result.states.start.status).toBe("in_progress");
  });
});

// ---------------------------------------------------------------------------
// completeState
// ---------------------------------------------------------------------------

describe("completeState", () => {
  it("sets status to done and records result", () => {
    const board = enterState(makeBoard(), "start");
    const result = completeState(board, "start", "all checks passed");

    expect(result.states.start.status).toBe("done");
    expect(result.states.start.result).toBe("all checks passed");
    expect(result.states.start.completed_at).toBeTruthy();
  });

  it("records artifacts when provided", () => {
    const board = enterState(makeBoard(), "start");
    const result = completeState(board, "start", "ok", [
      "report.md",
      "diff.patch",
    ]);

    expect(result.states.start.artifacts).toEqual([
      "report.md",
      "diff.patch",
    ]);
  });

  it("does not include artifacts key when not provided", () => {
    const board = enterState(makeBoard(), "start");
    const result = completeState(board, "start", "ok");
    expect(result.states.start.artifacts).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// setBlocked
// ---------------------------------------------------------------------------

describe("setBlocked", () => {
  it("sets blocked info and state status to blocked", () => {
    const board = enterState(makeBoard(), "start");
    const result = setBlocked(board, "start", "missing credentials");

    expect(result.blocked).not.toBeNull();
    expect(result.blocked!.state).toBe("start");
    expect(result.blocked!.reason).toBe("missing credentials");
    expect(result.blocked!.since).toBeTruthy();
    expect(result.states.start.status).toBe("blocked");
  });

  it("updates last_updated", () => {
    const board: Board = {
      ...makeBoard(),
      last_updated: "2000-01-01T00:00:00.000Z",
    };
    const result = setBlocked(board, "start", "reason");
    expect(result.last_updated).not.toBe(board.last_updated);
  });
});

// ---------------------------------------------------------------------------
// recordConsultationResult
// ---------------------------------------------------------------------------

describe("recordConsultationResult", () => {
  it("adds a consultation result to the correct breakpoint", () => {
    const board = makeBoard();
    const consultationResult = { status: "done", summary: "looks good" };

    const result = recordConsultationResult(
      board,
      "start",
      "wave_1",
      "before",
      "plan-review",
      consultationResult,
    );

    expect(
      result.states.start.wave_results?.["wave_1"].consultations?.before?.["plan-review"],
    ).toEqual(consultationResult);
  });

  it("does not mutate the input board", () => {
    const board = makeBoard();
    const originalStates = board.states;
    const originalStart = board.states.start;

    recordConsultationResult(
      board,
      "start",
      "wave_1",
      "before",
      "plan-review",
      { status: "done" },
    );

    // Reference equality — input must not be mutated
    expect(board.states).toBe(originalStates);
    expect(board.states.start).toBe(originalStart);
    expect(board.states.start.wave_results).toBeUndefined();
  });

  it("creates wave_results if it does not exist (legacy board)", () => {
    const board = makeBoard();
    // Confirm no wave_results initially
    expect(board.states.start.wave_results).toBeUndefined();

    const result = recordConsultationResult(
      board,
      "start",
      "wave_1",
      "after",
      "quality-check",
      { status: "done", summary: "all good" },
    );

    expect(result.states.start.wave_results).toBeDefined();
    expect(result.states.start.wave_results?.["wave_1"]).toBeDefined();
    expect(
      result.states.start.wave_results?.["wave_1"].consultations?.after?.["quality-check"],
    ).toEqual({ status: "done", summary: "all good" });
  });

  it("preserves existing consultation results in other breakpoints", () => {
    const board = makeBoard();

    const r1 = recordConsultationResult(
      board,
      "start",
      "wave_1",
      "before",
      "pre-check",
      { status: "done", summary: "pre ok" },
    );

    const r2 = recordConsultationResult(
      r1,
      "start",
      "wave_1",
      "after",
      "post-check",
      { status: "done", summary: "post ok" },
    );

    // before breakpoint preserved
    expect(
      r2.states.start.wave_results?.["wave_1"].consultations?.before?.["pre-check"],
    ).toEqual({ status: "done", summary: "pre ok" });
    // after breakpoint present
    expect(
      r2.states.start.wave_results?.["wave_1"].consultations?.after?.["post-check"],
    ).toEqual({ status: "done", summary: "post ok" });
  });

  it("overwrites same-name consultation (idempotent)", () => {
    const board = makeBoard();

    const r1 = recordConsultationResult(
      board,
      "start",
      "wave_1",
      "between",
      "mid-check",
      { status: "done", summary: "first run" },
    );

    const r2 = recordConsultationResult(
      r1,
      "start",
      "wave_1",
      "between",
      "mid-check",
      { status: "done", summary: "second run" },
    );

    // Should have the second value, not both
    expect(
      r2.states.start.wave_results?.["wave_1"].consultations?.between?.["mid-check"],
    ).toEqual({ status: "done", summary: "second run" });
  });
});

// ---------------------------------------------------------------------------
// recordGateResult
// ---------------------------------------------------------------------------

describe("recordGateResult", () => {
  it("sets gate and gate_output on wave result", () => {
    const board = makeBoard();

    const result = recordGateResult(
      board,
      "start",
      "wave_1",
      "quality-gate",
      "PASS: all checks passed",
    );

    const waveResult = result.states.start.wave_results?.["wave_1"];
    expect(waveResult?.gate).toBe("quality-gate");
    expect(waveResult?.gate_output).toBe("PASS: all checks passed");
  });

  it("does not mutate the input board", () => {
    const board = makeBoard();
    const originalStates = board.states;
    const originalStart = board.states.start;

    recordGateResult(board, "start", "wave_1", "some-gate", "output");

    expect(board.states).toBe(originalStates);
    expect(board.states.start).toBe(originalStart);
    expect(board.states.start.wave_results).toBeUndefined();
  });

  it("creates wave_results if it does not exist (legacy board)", () => {
    const board = makeBoard();
    expect(board.states.start.wave_results).toBeUndefined();

    const result = recordGateResult(
      board,
      "start",
      "wave_2",
      "final-gate",
      "PASS",
    );

    expect(result.states.start.wave_results).toBeDefined();
    expect(result.states.start.wave_results?.["wave_2"].gate).toBe("final-gate");
    expect(result.states.start.wave_results?.["wave_2"].gate_output).toBe("PASS");
  });
});
