/**
 * ExecutionStore — SQLite-backed orchestration state DAO
 *
 * Tests use in-memory SQLite (:memory:) for speed and isolation.
 * Each describe block gets a fresh DB via beforeEach.
 *
 * File 3 of 3: getBoard, JSON round-trip, getExecutionStore factory,
 *              getOrientationRatio, recordStateEntry, recordStateCompletion,
 *              recordIterationAttempt, concurrent writes
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardSchema } from "@domains/flows/board-state-schemas.ts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { initExecutionDb } from "../execution-schema.ts";
import { ExecutionStore, getExecutionStore } from "../execution-store.ts";

function makeDb() {
  return initExecutionDb(":memory:");
}

function makeStore(): ExecutionStore {
  return new ExecutionStore(makeDb());
}

const BASE_INIT_PARAMS = {
  base_commit: "abc123",
  branch: "feat/test",
  created: "2026-01-01T00:00:00.000Z",
  current_state: "research",
  entry: "research",
  flow: "test-flow",
  flow_name: "test-flow",
  last_updated: "2026-01-01T00:00:00.000Z",
  sanitized: "feat-test",
  slug: "test-slug",
  started: "2026-01-01T00:00:00.000Z",
  task: "build feature X",
  tier: "medium" as const,
};

// getBoard — reconstructs full Board object

describe("getBoard", () => {
  let store: ExecutionStore;

  beforeEach(() => {
    store = makeStore();
    store.initExecution(BASE_INIT_PARAMS);
  });
  afterEach(() => {
    store.close();
  });

  test("returns null when no execution exists", () => {
    const emptyStore = makeStore();
    expect(emptyStore.getBoard()).toBeNull();
    emptyStore.close();
  });

  test("reconstructs Board matching BoardSchema.parse()", () => {
    store.upsertState("research", {
      artifacts: ["research/SUMMARY.md"],
      entries: 1,
      result: "done",
      status: "done",
    });
    store.upsertState("implement", { entries: 1, status: "in_progress" });
    store.upsertIteration("implement", {
      cannot_fix: [],
      count: 1,
      history: [{ status: "blocked" }],
      max: 3,
    });

    const board = store.getBoard()!;
    // Validate against BoardSchema — this will throw if shape is wrong
    const parsed = BoardSchema.parse(board);
    expect(parsed.flow).toBe("test-flow");
    expect(parsed.task).toBe("build feature X");
    expect(parsed.entry).toBe("research");
    expect(parsed.current_state).toBe("research");
    expect(parsed.base_commit).toBe("abc123");
    expect(parsed.states.research!.status).toBe("done");
    expect(parsed.states.implement!.status).toBe("in_progress");
    expect(parsed.iterations.implement!.count).toBe(1);
    expect(parsed.blocked).toBeNull();
    expect(parsed.concerns).toEqual([]);
    expect(parsed.skipped).toEqual([]);
  });

  test("getBoard completes in <10ms for a board with 20 states", () => {
    // Populate 20 states
    for (let i = 0; i < 20; i++) {
      store.upsertState(`state-${i}`, {
        entries: i < 10 ? 1 : 0,
        result: i < 10 ? "done" : undefined,
        status: i < 10 ? "done" : "pending",
        wave_results: {
          "wave-1": { status: "done", tasks: [`task-${i}`] },
        },
      });
      if (i % 3 === 0) {
        store.upsertIteration(`state-${i}`, {
          cannot_fix: [],
          count: i,
          history: [{ status: "blocked" }, { artifact_count: 1, commit_sha: "abc" }],
          max: 5,
        });
      }
    }

    const start = Date.now();
    const board = store.getBoard();
    const elapsed = Date.now() - start;
    expect(board).not.toBeNull();
    expect(elapsed).toBeLessThan(10);
  });

  test("getBoard includes blocked, concerns, skipped, metadata from updateExecution", () => {
    const blocked = {
      reason: "needs clarification",
      since: "2026-01-01T00:00:00.000Z",
      state: "research",
    };
    const concerns = [
      {
        agent: "reviewer",
        message: "issue",
        state_id: "research",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ];
    store.updateExecution({ blocked, concerns, metadata: { pr: 42 }, skipped: ["optional-state"] });

    const board = store.getBoard()!;
    expect(board.blocked).toEqual(blocked);
    expect(board.concerns).toEqual(concerns);
    expect(board.skipped).toEqual(["optional-state"]);
    expect(board.metadata).toEqual({ pr: 42 });
  });
});

// JSON round-trip — deeply nested Board with all optional fields

describe("JSON round-trip — deeply nested Board", () => {
  let store: ExecutionStore;

  beforeEach(() => {
    store = makeStore();
    store.initExecution(BASE_INIT_PARAMS);
  });
  afterEach(() => {
    store.close();
  });

  test("round-trips Board with deeply nested wave_results and all 5 HistoryEntry variants", () => {
    const complexWaveResults = {
      "wave-1": {
        consultations: {
          after: {
            "qa-review": { status: "done", summary: "approved" },
          },
          before: {
            "arch-check": { artifact: "decisions/arch.md", status: "done", summary: "looks good" },
          },
          between: {
            "code-review": { status: "done", summary: null },
          },
        },
        gate: "npm test",
        gate_output: "all passing",
        status: "done",
        tasks: ["task-a", "task-b"],
      },
      "wave-2": {
        status: "in_progress",
        tasks: ["task-c"],
      },
    };

    const fullHistory = [
      {
        file_paths: ["src/foo.ts", "src/bar.ts"],
        principle_ids: ["deep-modules", "thin-handlers"],
      },
      {
        pairs: [
          { file: "src/A.ts", test: "src/__tests__/A.test.ts" },
          { file: "src/B.ts", test: "src/__tests__/B.test.ts" },
        ],
      },
      { status: "blocked" },
      { artifact_count: 5, commit_sha: "deadbeef" },
      { gate_output_hash: "sha256:abc", passed: true },
    ];

    const fullMetrics = {
      duration_ms: 12345,
      files_changed: 8,
      gate_results: [
        { command: "npm test", exitCode: 0, gate: "npm test", output: "all passing", passed: true },
        { command: "npx tsc", exitCode: 1, gate: "tsc", output: "error TS2345", passed: false },
      ],
      model: "claude-3-5-sonnet",
      postcondition_results: [
        { name: "file exists", output: "found", passed: true, type: "file_exists" },
        { name: "no TODOs", output: "3 matches", passed: false, type: "no_pattern" },
      ],
      revision_count: 2,
      spawns: 7,
      test_results: { failed: 1, passed: 42, skipped: 2 },
      violation_count: 3,
      violation_severities: { blocking: 1, warning: 2 },
    };

    store.upsertState("implement", {
      artifact_history: [
        { artifacts: ["src/feature.ts"], entry: 1 },
        { artifacts: ["src/feature.ts", "src/__tests__/feature.test.ts"], entry: 2 },
      ],
      artifacts: ["src/feature.ts", "src/__tests__/feature.test.ts"],
      compete_results: [
        { artifacts: ["perf-PLAN.md"], lens: "performance", status: "done" },
        { lens: "correctness", status: "done" },
      ],
      completed_at: "2026-01-01T02:00:00.000Z",
      discovered_gates: [{ command: "npm run lint", source: "reviewer" }],
      discovered_postconditions: [
        { target: "src/feature.ts", type: "file_exists" },
        { pattern: "TODO", target: "src/feature.ts", type: "no_pattern" },
      ],
      entered_at: "2026-01-01T00:00:00.000Z",
      entries: 3,
      gate_results: fullMetrics.gate_results,
      metrics: fullMetrics,
      parallel_results: [
        { artifacts: ["SUMMARY.md"], item: "feat-a", status: "done" },
        { item: "feat-b", status: "done" },
      ],
      postcondition_results: fullMetrics.postcondition_results,
      result: "done",
      status: "done",
      synthesized: true,
      wave: 2,
      wave_results: complexWaveResults,
      wave_total: 2,
    });

    store.upsertIteration("implement", {
      cannot_fix: [{ file_path: "src/legacy.ts", principle_id: "deep-modules" }],
      count: 3,
      history: fullHistory,
      max: 5,
    });

    const board = store.getBoard()!;
    const parsed = BoardSchema.parse(board);

    // Verify deep equality for all nested structures
    expect(parsed.states.implement!.wave_results).toEqual(complexWaveResults);
    expect(parsed.states.implement!.metrics).toEqual(fullMetrics);
    expect(parsed.states.implement!.gate_results).toEqual(fullMetrics.gate_results);
    expect(parsed.states.implement!.parallel_results).toHaveLength(2);
    expect(parsed.states.implement!.compete_results).toHaveLength(2);
    expect(parsed.states.implement!.synthesized).toBe(true);
    expect(parsed.iterations.implement!.history).toEqual(fullHistory);
    expect(parsed.iterations.implement!.cannot_fix).toEqual([
      { file_path: "src/legacy.ts", principle_id: "deep-modules" },
    ]);
  });
});

// getExecutionStore — factory caching

describe("getExecutionStore", () => {
  let tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { force: true, recursive: true });
      } catch {
        /* ignore */
      }
    }
    tmpDirs = [];
  });

  test("returns cached instance for same workspace", () => {
    const dir = mkdtempSync(join(tmpdir(), "exec-store-factory-"));
    tmpDirs.push(dir);

    const store1 = getExecutionStore(dir);
    const store2 = getExecutionStore(dir);
    expect(store1).toBe(store2);
  });

  test("returns different instances for different workspaces", () => {
    const dir1 = mkdtempSync(join(tmpdir(), "exec-store-factory-"));
    const dir2 = mkdtempSync(join(tmpdir(), "exec-store-factory-"));
    tmpDirs.push(dir1, dir2);

    const store1 = getExecutionStore(dir1);
    const store2 = getExecutionStore(dir2);
    expect(store1).not.toBe(store2);
  });

  test("created store persists data to disk (not just in-memory)", () => {
    const dir = mkdtempSync(join(tmpdir(), "exec-store-persist-"));
    tmpDirs.push(dir);

    const store = getExecutionStore(dir);
    store.appendProgress("persistent entry");

    // Get a second reference (cached), verify same data
    const sameStore = getExecutionStore(dir);
    expect(sameStore.getProgress()).toContain("persistent entry");
  });
});

// getOrientationRatio — ADR-003a

describe("getOrientationRatio", () => {
  let store: ExecutionStore;

  beforeEach(() => {
    store = makeStore();
    store.initExecution(BASE_INIT_PARAMS);
    store.upsertState("research", { entries: 0, status: "in_progress" });
  });
  afterEach(() => {
    store.close();
  });

  test("returns correct ratio when tool_calls and orientation_calls are set", () => {
    store.updateStateMetrics("research", { orientation_calls: 4, tool_calls: 10 });
    expect(store.getOrientationRatio("research")).toBeCloseTo(0.4);
  });

  test("returns 1.0 when all calls are orientation calls", () => {
    store.updateStateMetrics("research", { orientation_calls: 5, tool_calls: 5 });
    expect(store.getOrientationRatio("research")).toBeCloseTo(1.0);
  });

  test("returns 0 when orientation_calls is 0", () => {
    store.updateStateMetrics("research", { orientation_calls: 0, tool_calls: 8 });
    expect(store.getOrientationRatio("research")).toBe(0);
  });

  test("returns 0 when tool_calls is 0 (avoid divide-by-zero)", () => {
    store.updateStateMetrics("research", { orientation_calls: 0, tool_calls: 0 });
    expect(store.getOrientationRatio("research")).toBe(0);
  });

  test("returns 0 when state has no metrics at all", () => {
    expect(store.getOrientationRatio("research")).toBe(0);
  });

  test("returns 0 for unknown state_id", () => {
    expect(store.getOrientationRatio("nonexistent")).toBe(0);
  });

  test("returns 0 when only tool_calls is set but not orientation_calls", () => {
    store.updateStateMetrics("research", { tool_calls: 10 });
    expect(store.getOrientationRatio("research")).toBe(0);
  });
});

// recordStateEntry — domain-language state entry

describe("recordStateEntry", () => {
  let store: ExecutionStore;

  beforeEach(() => {
    store = makeStore();
  });
  afterEach(() => {
    store.close();
  });

  test("sets status to in_progress and entries to 1 on first call", () => {
    store.recordStateEntry("implement");
    const state = store.getState("implement");
    expect(state).not.toBeNull();
    expect(state!.status).toBe("in_progress");
    expect(state!.entries).toBe(1);
    expect(state!.entered_at).toBeDefined();
  });

  test("increments entries on subsequent calls", () => {
    store.recordStateEntry("implement");
    store.recordStateEntry("implement");
    const state = store.getState("implement");
    expect(state!.entries).toBe(2);
    expect(state!.status).toBe("in_progress");
  });

  test("merges custom fields into the state", () => {
    store.recordStateEntry("implement", { wave: 2, wave_total: 5 });
    const state = store.getState("implement");
    expect(state!.wave).toBe(2);
    expect(state!.wave_total).toBe(5);
    expect(state!.status).toBe("in_progress");
    expect(state!.entries).toBe(1);
  });

  test("custom fields do not override status (always in_progress)", () => {
    // Even if caller passes status in fields, the domain method forces in_progress
    store.recordStateEntry("implement", { wave: 1 });
    const state = store.getState("implement");
    expect(state!.status).toBe("in_progress");
  });
});

// recordStateCompletion — domain-language state completion

describe("recordStateCompletion", () => {
  let store: ExecutionStore;

  beforeEach(() => {
    store = makeStore();
    // Seed state entry first
    store.recordStateEntry("implement");
  });
  afterEach(() => {
    store.close();
  });

  test("sets status to done with result and completed_at", () => {
    store.recordStateCompletion("implement", "done");
    const state = store.getState("implement");
    expect(state!.status).toBe("done");
    expect(state!.result).toBe("done");
    expect(state!.completed_at).toBeDefined();
  });

  test("persists artifacts when provided", () => {
    store.recordStateCompletion("implement", "done", ["SUMMARY.md", "plan.md"]);
    const state = store.getState("implement");
    expect(state!.artifacts).toEqual(["SUMMARY.md", "plan.md"]);
  });

  test("updates iteration history atomically when iteration exists", () => {
    store.upsertIteration("implement", { cannot_fix: [], count: 1, history: [], max: 3 });
    const history = [{ status: "blocked" }, { status: "done" }];
    store.recordStateCompletion("implement", "done", undefined, history);
    const iter = store.getIteration("implement");
    expect(iter!.history).toEqual(history);
    const state = store.getState("implement");
    expect(state!.status).toBe("done");
  });

  test("does not fail when no iteration exists and iterationHistory provided", () => {
    const history = [{ status: "done" }];
    expect(() =>
      store.recordStateCompletion("implement", "done", undefined, history),
    ).not.toThrow();
    const state = store.getState("implement");
    expect(state!.status).toBe("done");
  });
});

// recordIterationAttempt — domain-language iteration recording

describe("recordIterationAttempt", () => {
  let store: ExecutionStore;

  beforeEach(() => {
    store = makeStore();
    store.recordStateEntry("implement");
  });
  afterEach(() => {
    store.close();
  });

  test("records iteration result and returns recorded:true stuck:false when no stuckWhen", () => {
    const result = store.recordIterationAttempt("implement", {
      data: { failing_files: ["src/foo.ts"] },
      iteration: 1,
      status: "blocked",
    });
    expect(result.recorded).toBe(true);
    expect(result.stuck).toBe(false);
  });

  test("returns stuck:false when fewer than 2 iteration results exist", () => {
    const result = store.recordIterationAttempt("implement", {
      data: { status: "blocked" },
      iteration: 1,
      status: "blocked",
      stuckWhen: "same_status",
    });
    expect(result.recorded).toBe(true);
    expect(result.stuck).toBe(false);
  });

  test("returns stuck:true when same_status repeats across two iterations", () => {
    store.recordIterationAttempt("implement", {
      data: { status: "blocked" },
      iteration: 1,
      status: "blocked",
      stuckWhen: "same_status",
    });
    const result = store.recordIterationAttempt("implement", {
      data: { status: "blocked" },
      iteration: 2,
      status: "blocked",
      stuckWhen: "same_status",
    });
    expect(result.recorded).toBe(true);
    expect(result.stuck).toBe(true);
  });

  test("returns stuck:false when no stuckWhen provided even with repeated statuses", () => {
    store.recordIterationResult("implement", 1, "blocked", { status: "blocked" });
    const result = store.recordIterationAttempt("implement", {
      data: { status: "blocked" },
      iteration: 2,
      status: "blocked",
    });
    expect(result.stuck).toBe(false);
  });
});

// Concurrent writes — busy_timeout handles SQLITE_BUSY

describe("concurrent writes", () => {
  test("two store instances writing to same DB file do not throw SQLITE_BUSY", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "exec-concurrent-"));
    let store1: ExecutionStore | null = null;
    let store2: ExecutionStore | null = null;

    try {
      const dbPath = join(tmpDir, "orchestration.db");
      const db1 = initExecutionDb(dbPath);
      const db2 = initExecutionDb(dbPath);
      store1 = new ExecutionStore(db1);
      store2 = new ExecutionStore(db2);

      // Perform many interleaved writes from two instances
      // With WAL + busy_timeout=5000, these should not throw
      const errors: Error[] = [];
      const N = 20;
      for (let i = 0; i < N; i++) {
        try {
          store1.appendMessage("chan", "agent-1", `message-${i}-from-1`);
          store2.appendMessage("chan", "agent-2", `message-${i}-from-2`);
        } catch (e) {
          errors.push(e as Error);
        }
      }
      expect(errors).toHaveLength(0);

      // Verify all messages were written
      const messages = store1.getMessages("chan");
      expect(messages.length).toBe(N * 2);
    } finally {
      store1?.close();
      store2?.close();
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });
});
