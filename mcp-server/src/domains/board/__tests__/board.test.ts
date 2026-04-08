import type { Board } from "@domains/flows/board-state-schemas.ts";
import type { ResolvedFlow } from "@domains/flows/flow-definition-schemas.ts";
import { describe, expect, it } from "vitest";
import {
  accumulateCannotFix,
  appendConcern,
  canEnterState,
  completeState,
  enterState,
  initBoard,
  recordConsultationResult,
  recordGateResult,
  setBlocked,
} from "../board.ts";

function makeMinimalFlow(overrides?: Partial<ResolvedFlow>): ResolvedFlow {
  return {
    description: "A test flow",
    entry: "start",
    name: "test-flow",
    spawn_instructions: {},
    states: {
      done: { type: "terminal" },
      review: { agent: "canon:canon-implementor", max_iterations: 3, type: "single" },
      start: { agent: "canon:canon-implementor", type: "single" },
    },
    ...overrides,
  };
}

function makeBoard(): Board {
  return initBoard(makeMinimalFlow(), "build feature X", "abc123");
}

// initBoard

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
      expect(board.states[key]).toEqual({ entries: 0, status: "pending" });
    }
  });

  it("populates iterations for states with max_iterations", () => {
    const board = makeBoard();

    // "review" has max_iterations: 3
    expect(board.iterations.review).toEqual({
      cannot_fix: [],
      count: 0,
      history: [],
      max: 3,
    });

    // "start" and "done" do not have max_iterations
    expect(board.iterations.start).toBeUndefined();
    expect(board.iterations.done).toBeUndefined();
  });
});

// enterState

describe("enterState", () => {
  it("sets status to in_progress and increments entries", () => {
    const board = makeBoard();
    const result = enterState(board, "start");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.board.current_state).toBe("start");
    expect(result.board.states.start.status).toBe("in_progress");
    expect(result.board.states.start.entries).toBe(1);
  });

  it("sets entered_at timestamp", () => {
    const board = makeBoard();
    const result = enterState(board, "start");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.board.states.start.entered_at).toBeTruthy();
  });

  it("increments iteration count for iterable states", () => {
    const board = makeBoard();
    const r1 = enterState(board, "review");
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    expect(r1.board.iterations.review.count).toBe(1);

    const r2 = enterState(r1.board, "review");
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.board.iterations.review.count).toBe(2);
    expect(r2.board.states.review.entries).toBe(2);
  });

  it("does not mutate the original board", () => {
    const board = makeBoard();
    const result = enterState(board, "start");
    expect(board.states.start.status).toBe("pending");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.board.states.start.status).toBe("in_progress");
  });

  it("returns ok: false when state is already done", () => {
    const board = makeBoard();
    // Manually set the state to done
    const doneBoard: Board = {
      ...board,
      states: {
        ...board.states,
        start: { ...board.states.start, status: "done" },
      },
    };
    const result = enterState(doneBoard, "start");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/already done/i);
  });

  it("returns ok: true for pending state", () => {
    const board = makeBoard();
    const result = enterState(board, "start");
    expect(result.ok).toBe(true);
  });

  it("returns ok: true for in_progress state (re-enter)", () => {
    const board = makeBoard();
    const r1 = enterState(board, "start");
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = enterState(r1.board, "start");
    expect(r2.ok).toBe(true);
  });
});

// completeState

describe("completeState", () => {
  it("sets status to done and records result", () => {
    const entered = enterState(makeBoard(), "start");
    expect(entered.ok).toBe(true);
    if (!entered.ok) return;

    const result = completeState(entered.board, "start", "all checks passed");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.board.states.start.status).toBe("done");
    expect(result.board.states.start.result).toBe("all checks passed");
    expect(result.board.states.start.completed_at).toBeTruthy();
  });

  it("records artifacts when provided", () => {
    const entered = enterState(makeBoard(), "start");
    expect(entered.ok).toBe(true);
    if (!entered.ok) return;

    const result = completeState(entered.board, "start", "ok", ["report.md", "diff.patch"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.board.states.start.artifacts).toEqual(["report.md", "diff.patch"]);
  });

  it("does not include artifacts key when not provided", () => {
    const entered = enterState(makeBoard(), "start");
    expect(entered.ok).toBe(true);
    if (!entered.ok) return;

    const result = completeState(entered.board, "start", "ok");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.board.states.start.artifacts).toBeUndefined();
  });

  it("returns ok: false when state is not in_progress", () => {
    const board = makeBoard(); // start is "pending"
    const result = completeState(board, "start", "done");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/not in_progress/i);
  });

  it("returns ok: false for done state", () => {
    const entered = enterState(makeBoard(), "start");
    expect(entered.ok).toBe(true);
    if (!entered.ok) return;

    const completed = completeState(entered.board, "start", "done");
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;

    // Try to complete again — state is now "done", not "in_progress"
    const result = completeState(completed.board, "start", "done again");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/not in_progress/i);
  });

  it("returns ok: true when state is in_progress", () => {
    const entered = enterState(makeBoard(), "start");
    expect(entered.ok).toBe(true);
    if (!entered.ok) return;

    const result = completeState(entered.board, "start", "ok");
    expect(result.ok).toBe(true);
  });
});

// setBlocked

describe("setBlocked", () => {
  it("sets blocked info and state status to blocked", () => {
    const entered = enterState(makeBoard(), "start");
    expect(entered.ok).toBe(true);
    if (!entered.ok) return;

    const result = setBlocked(entered.board, "start", "missing credentials");

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

// recordConsultationResult

describe("recordConsultationResult", () => {
  it("adds a consultation result to the correct breakpoint", () => {
    const board = makeBoard();
    const consultationResult = { status: "done", summary: "looks good" };

    const result = recordConsultationResult(board, "start", {
      breakpoint: "before",
      name: "plan-review",
      result: consultationResult,
      waveKey: "wave_1",
    });

    expect(result.states.start.wave_results?.wave_1.consultations?.before?.["plan-review"]).toEqual(
      consultationResult,
    );
  });

  it("does not mutate the input board", () => {
    const board = makeBoard();
    const originalStates = board.states;
    const originalStart = board.states.start;

    recordConsultationResult(board, "start", {
      breakpoint: "before",
      name: "plan-review",
      result: { status: "done" },
      waveKey: "wave_1",
    });

    // Reference equality — input must not be mutated
    expect(board.states).toBe(originalStates);
    expect(board.states.start).toBe(originalStart);
    expect(board.states.start.wave_results).toBeUndefined();
  });

  it("creates wave_results if it does not exist (legacy board)", () => {
    const board = makeBoard();
    // Confirm no wave_results initially
    expect(board.states.start.wave_results).toBeUndefined();

    const result = recordConsultationResult(board, "start", {
      breakpoint: "after",
      name: "quality-check",
      result: { status: "done", summary: "all good" },
      waveKey: "wave_1",
    });

    expect(result.states.start.wave_results).toBeDefined();
    expect(result.states.start.wave_results?.wave_1).toBeDefined();
    expect(
      result.states.start.wave_results?.wave_1.consultations?.after?.["quality-check"],
    ).toEqual({ status: "done", summary: "all good" });
  });

  it("preserves existing consultation results in other breakpoints", () => {
    const board = makeBoard();

    const r1 = recordConsultationResult(board, "start", {
      breakpoint: "before",
      name: "pre-check",
      result: { status: "done", summary: "pre ok" },
      waveKey: "wave_1",
    });

    const r2 = recordConsultationResult(r1, "start", {
      breakpoint: "after",
      name: "post-check",
      result: { status: "done", summary: "post ok" },
      waveKey: "wave_1",
    });

    // before breakpoint preserved
    expect(r2.states.start.wave_results?.wave_1.consultations?.before?.["pre-check"]).toEqual({
      status: "done",
      summary: "pre ok",
    });
    // after breakpoint present
    expect(r2.states.start.wave_results?.wave_1.consultations?.after?.["post-check"]).toEqual({
      status: "done",
      summary: "post ok",
    });
  });

  it("overwrites same-name consultation (idempotent)", () => {
    const board = makeBoard();

    const r1 = recordConsultationResult(board, "start", {
      breakpoint: "between",
      name: "mid-check",
      result: { status: "done", summary: "first run" },
      waveKey: "wave_1",
    });

    const r2 = recordConsultationResult(r1, "start", {
      breakpoint: "between",
      name: "mid-check",
      result: { status: "done", summary: "second run" },
      waveKey: "wave_1",
    });

    // Should have the second value, not both
    expect(r2.states.start.wave_results?.wave_1.consultations?.between?.["mid-check"]).toEqual({
      status: "done",
      summary: "second run",
    });
  });
});

// recordGateResult

describe("recordGateResult", () => {
  it("sets gate and gate_output on wave result", () => {
    const board = makeBoard();

    const result = recordGateResult(board, "start", {
      gate: "quality-gate",
      gateOutput: "PASS: all checks passed",
      waveKey: "wave_1",
    });

    const waveResult = result.states.start.wave_results?.wave_1;
    expect(waveResult?.gate).toBe("quality-gate");
    expect(waveResult?.gate_output).toBe("PASS: all checks passed");
  });

  it("does not mutate the input board", () => {
    const board = makeBoard();
    const originalStates = board.states;
    const originalStart = board.states.start;

    recordGateResult(board, "start", {
      gate: "some-gate",
      gateOutput: "output",
      waveKey: "wave_1",
    });

    expect(board.states).toBe(originalStates);
    expect(board.states.start).toBe(originalStart);
    expect(board.states.start.wave_results).toBeUndefined();
  });

  it("creates wave_results if it does not exist (legacy board)", () => {
    const board = makeBoard();
    expect(board.states.start.wave_results).toBeUndefined();

    const result = recordGateResult(board, "start", {
      gate: "final-gate",
      gateOutput: "PASS",
      waveKey: "wave_2",
    });

    expect(result.states.start.wave_results).toBeDefined();
    expect(result.states.start.wave_results?.wave_2.gate).toBe("final-gate");
    expect(result.states.start.wave_results?.wave_2.gate_output).toBe("PASS");
  });
});

// canEnterState

describe("canEnterState", () => {
  it("returns allowed: true when no iteration tracking for the state", () => {
    const board = makeBoard(); // "start" has no max_iterations
    const result = canEnterState(board, "start");
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("returns allowed: true when iteration count is below max", () => {
    const board = makeBoard(); // "review" has max: 3, count: 0
    const result = canEnterState(board, "review");
    expect(result.allowed).toBe(true);
  });

  it("returns allowed: false when iteration count equals max", () => {
    const board = makeBoard();
    // Manually set count to max
    const atMax: Board = {
      ...board,
      iterations: {
        ...board.iterations,
        review: { ...board.iterations.review, count: 3 },
      },
    };
    const result = canEnterState(atMax, "review");
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/max iterations/i);
  });

  it("returns allowed: false when iteration count exceeds max", () => {
    const board = makeBoard();
    const overMax: Board = {
      ...board,
      iterations: {
        ...board.iterations,
        review: { ...board.iterations.review, count: 5 },
      },
    };
    const result = canEnterState(overMax, "review");
    expect(result.allowed).toBe(false);
  });
});

// appendConcern

describe("appendConcern", () => {
  it("appends a concern entry to board.concerns", () => {
    const board = makeBoard();
    const result = appendConcern(board, "start", "canon-implementor", "something to watch");

    expect(result.concerns).toHaveLength(1);
    expect(result.concerns[0].state_id).toBe("start");
    expect(result.concerns[0].agent).toBe("canon-implementor");
    expect(result.concerns[0].message).toBe("something to watch");
    expect(result.concerns[0].timestamp).toBeTruthy();
  });

  it("preserves existing concerns when appending", () => {
    const board = makeBoard();
    const r1 = appendConcern(board, "start", "agent-1", "first concern");
    const r2 = appendConcern(r1, "review", "agent-2", "second concern");

    expect(r2.concerns).toHaveLength(2);
    expect(r2.concerns[0].message).toBe("first concern");
    expect(r2.concerns[1].message).toBe("second concern");
  });

  it("does not mutate the original board", () => {
    const board = makeBoard();
    const originalConcerns = board.concerns;
    appendConcern(board, "start", "agent", "some concern");
    expect(board.concerns).toBe(originalConcerns);
    expect(board.concerns).toHaveLength(0);
  });
});

// accumulateCannotFix

describe("accumulateCannotFix", () => {
  it("returns board unchanged when stateId has no iteration tracking", () => {
    const board = makeBoard(); // "start" has no iterations
    const result = accumulateCannotFix(board, "start", ["p-001"], ["/path/to/file.ts"]);
    expect(result).toBe(board); // same reference — no changes
  });

  it("adds cannot_fix items to the iteration (cross-product)", () => {
    const board = makeBoard(); // "review" has iterations
    const result = accumulateCannotFix(
      board,
      "review",
      ["p-001", "p-002"],
      ["/file-a.ts", "/file-b.ts"],
    );

    const items = result.iterations.review.cannot_fix ?? [];
    expect(items).toHaveLength(4); // 2 principles x 2 files
    expect(items).toContainEqual({ principle_id: "p-001", file_path: "/file-a.ts" });
    expect(items).toContainEqual({ principle_id: "p-001", file_path: "/file-b.ts" });
    expect(items).toContainEqual({ principle_id: "p-002", file_path: "/file-a.ts" });
    expect(items).toContainEqual({ principle_id: "p-002", file_path: "/file-b.ts" });
  });

  it("deduplicates against existing items", () => {
    const board = makeBoard();
    // Add initial items
    const r1 = accumulateCannotFix(board, "review", ["p-001"], ["/file-a.ts"]);
    // Add again — same item should not be duplicated
    const r2 = accumulateCannotFix(r1, "review", ["p-001"], ["/file-a.ts"]);

    const items = r2.iterations.review.cannot_fix ?? [];
    expect(items).toHaveLength(1);
  });

  it("returns board unchanged when principleIds is empty", () => {
    const board = makeBoard();
    const result = accumulateCannotFix(board, "review", [], ["/file-a.ts"]);
    expect(result).toBe(board);
  });

  it("returns board unchanged when filePaths is empty", () => {
    const board = makeBoard();
    const result = accumulateCannotFix(board, "review", ["p-001"], []);
    expect(result).toBe(board);
  });
});
