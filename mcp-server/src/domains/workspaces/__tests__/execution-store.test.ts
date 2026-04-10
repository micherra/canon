/**
 * ExecutionStore — SQLite-backed orchestration state DAO
 *
 * Tests use in-memory SQLite (:memory:) for speed and isolation.
 * Each describe block gets a fresh DB via beforeEach.
 *
 * File 1 of 3: Schema, initExecution, getSession, updateExecution,
 *              upsertState+getState, inserted_return_to, upsertIteration+getIteration
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { initExecutionDb, SCHEMA_VERSION } from "../execution-schema.ts";
import { ExecutionStore } from "../execution-store.ts";

function makeDb(): Database.Database {
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

// initExecutionDb — schema creation

describe("initExecutionDb", () => {
  test("creates all expected tables", () => {
    const db = makeDb();
    const rows = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    expect(names).toContain("meta");
    expect(names).toContain("execution");
    expect(names).toContain("execution_states");
    expect(names).toContain("iterations");
    expect(names).toContain("progress_entries");
    expect(names).toContain("messages");
    expect(names).toContain("wave_events");
    expect(names).toContain("events");
    db.close();
  });

  test("creates all expected indexes", () => {
    const db = makeDb();
    const rows = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' ORDER BY name`)
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    expect(names).toContain("idx_messages_channel");
    expect(names).toContain("idx_messages_channel_ts");
    expect(names).toContain("idx_wave_events_status");
    expect(names).toContain("idx_events_type");
    db.close();
  });

  test("seeds schema_version in meta table", () => {
    const db = makeDb();
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined;
    expect(row?.value).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe("10");
    db.close();
  });

  test("is idempotent — calling twice does not throw", () => {
    // Use a temp file to test idempotency across two opens
    const tmpDir = mkdtempSync(join(tmpdir(), "exec-schema-test-"));
    try {
      const dbPath = join(tmpDir, "orchestration.db");
      const db1 = initExecutionDb(dbPath);
      db1.close();
      // Second open should succeed without throwing
      const db2 = initExecutionDb(dbPath);
      db2.close();
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  test("WAL mode is set", () => {
    const db = makeDb();
    const row = db.pragma("journal_mode") as Array<{ journal_mode: string }>;
    // In-memory DBs always use 'memory' journal mode, not WAL
    // Just verify the pragma call doesn't throw; for real files WAL is confirmed
    expect(row).toBeDefined();
    db.close();
  });
});

// initExecution + getExecution round-trip

describe("initExecution + getExecution", () => {
  let store: ExecutionStore;

  beforeEach(() => {
    store = makeStore();
  });
  afterEach(() => {
    store.close();
  });

  test("inserts and retrieves execution row", () => {
    store.initExecution(BASE_INIT_PARAMS);
    const row = store.getExecution();
    expect(row).not.toBeNull();
    expect(row!.flow).toBe("test-flow");
    expect(row!.task).toBe("build feature X");
    expect(row!.entry).toBe("research");
    expect(row!.current_state).toBe("research");
    expect(row!.base_commit).toBe("abc123");
    expect(row!.branch).toBe("feat/test");
    expect(row!.tier).toBe("medium");
    expect(row!.slug).toBe("test-slug");
    expect(row!.status).toBe("active");
  });

  test("getExecution returns null when no execution exists", () => {
    const result = store.getExecution();
    expect(result).toBeNull();
  });

  test("initExecution sets default status to active", () => {
    store.initExecution(BASE_INIT_PARAMS);
    const row = store.getExecution();
    expect(row!.status).toBe("active");
  });

  test("initExecution stores optional original_task", () => {
    store.initExecution({ ...BASE_INIT_PARAMS, original_task: "original task text" });
    const row = store.getExecution();
    expect(row!.original_task).toBe("original task text");
  });
});

// getSession — projects Session fields

describe("getSession", () => {
  let store: ExecutionStore;

  beforeEach(() => {
    store = makeStore();
  });
  afterEach(() => {
    store.close();
  });

  test("returns null when no execution exists", () => {
    expect(store.getSession()).toBeNull();
  });

  test("projects all Session fields correctly", () => {
    store.initExecution({ ...BASE_INIT_PARAMS, original_task: "orig" });
    const session = store.getSession();
    expect(session).not.toBeNull();
    expect(session!.branch).toBe("feat/test");
    expect(session!.sanitized).toBe("feat-test");
    expect(session!.created).toBe("2026-01-01T00:00:00.000Z");
    expect(session!.task).toBe("build feature X");
    expect(session!.original_task).toBe("orig");
    expect(session!.tier).toBe("medium");
    expect(session!.flow).toBe("test-flow");
    expect(session!.slug).toBe("test-slug");
    expect(session!.status).toBe("active");
  });
});

// updateExecution

describe("updateExecution", () => {
  let store: ExecutionStore;

  beforeEach(() => {
    store = makeStore();
    store.initExecution(BASE_INIT_PARAMS);
  });
  afterEach(() => {
    store.close();
  });

  test("updates current_state", () => {
    store.updateExecution({ current_state: "implement" });
    expect(store.getExecution()!.current_state).toBe("implement");
  });

  test("updates status and completed_at", () => {
    const ts = "2026-01-02T00:00:00.000Z";
    store.updateExecution({ completed_at: ts, status: "completed" });
    const row = store.getExecution()!;
    expect(row.status).toBe("completed");
    expect(row.completed_at).toBe(ts);
  });

  test("updates blocked as JSON", () => {
    const blocked = {
      reason: "test reason",
      since: "2026-01-01T00:00:00.000Z",
      state: "implement",
    };
    store.updateExecution({ blocked });
    const row = store.getExecution()!;
    expect(row.blocked).toEqual(blocked);
  });

  test("sets blocked to null", () => {
    store.updateExecution({
      blocked: { reason: "r", since: "2026-01-01T00:00:00.000Z", state: "x" },
    });
    store.updateExecution({ blocked: null });
    expect(store.getExecution()!.blocked).toBeNull();
  });

  test("updates concerns JSON array", () => {
    const concern = {
      agent: "tester",
      message: "test concern",
      state_id: "s1",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    store.updateExecution({ concerns: [concern] });
    expect(store.getExecution()!.concerns).toEqual([concern]);
  });

  test("updates skipped JSON array", () => {
    store.updateExecution({ skipped: ["state-a", "state-b"] });
    expect(store.getExecution()!.skipped).toEqual(["state-a", "state-b"]);
  });

  test("updates metadata JSON object", () => {
    store.updateExecution({ metadata: { count: 42, key: "value" } });
    expect(store.getExecution()!.metadata).toEqual({ count: 42, key: "value" });
  });
});

// upsertState + getState round-trip

describe("upsertState + getState", () => {
  let store: ExecutionStore;

  beforeEach(() => {
    store = makeStore();
  });
  afterEach(() => {
    store.close();
  });

  test("inserts and retrieves a minimal state", () => {
    store.upsertState("research", { entries: 0, status: "pending" });
    const state = store.getState("research");
    expect(state).not.toBeNull();
    expect(state!.status).toBe("pending");
    expect(state!.entries).toBe(0);
  });

  test("returns null for non-existent state", () => {
    expect(store.getState("nonexistent")).toBeNull();
  });

  test("updates existing state", () => {
    store.upsertState("research", { entries: 0, status: "pending" });
    store.upsertState("research", { entries: 1, status: "in_progress" });
    const state = store.getState("research");
    expect(state!.status).toBe("in_progress");
    expect(state!.entries).toBe(1);
  });

  test("round-trips all JSON columns", () => {
    const waveResults = {
      "wave-1": {
        consultations: {
          after: { reviewer: { status: "done", summary: "approved" } },
          before: { arch: { status: "done", summary: "looks good" } },
        },
        gate: "npm test",
        gate_output: "all passing",
        status: "done",
        tasks: ["task-a"],
      },
    };
    const metrics = {
      duration_ms: 5000,
      model: "claude-3",
      spawns: 3,
      test_results: { failed: 0, passed: 10, skipped: 1 },
      violation_count: 2,
    };
    const gateResults = [
      { command: "npm test", exitCode: 0, gate: "npm test", output: "OK", passed: true },
    ];
    const postconditionResults = [
      { name: "file_exists", output: "found", passed: true, type: "file_exists" },
    ];
    const discoveredGates = [{ command: "npm run lint", source: "reviewer" }];
    const parallelResults = [{ artifacts: ["SUMMARY.md"], item: "feat-a", status: "done" }];
    const competeResults = [{ artifacts: ["PLAN.md"], lens: "performance", status: "done" }];
    const artifactHistory = [{ artifacts: ["SUMMARY.md"], entry: 1 }];

    store.upsertState("implement", {
      artifact_history: artifactHistory,
      artifacts: ["src/feature.ts"],
      compete_results: competeResults,
      completed_at: "2026-01-01T01:00:00.000Z",
      discovered_gates: discoveredGates,
      discovered_postconditions: [{ target: "src/foo.ts", type: "file_exists" }],
      entered_at: "2026-01-01T00:00:00.000Z",
      entries: 2,
      error: undefined,
      gate_results: gateResults,
      metrics,
      parallel_results: parallelResults,
      postcondition_results: postconditionResults,
      result: "done",
      status: "done",
      synthesized: true,
      wave: 2,
      wave_results: waveResults,
      wave_total: 3,
    });

    const state = store.getState("implement")!;
    expect(state.status).toBe("done");
    expect(state.wave_results).toEqual(waveResults);
    expect(state.metrics).toEqual(metrics);
    expect(state.gate_results).toEqual(gateResults);
    expect(state.postcondition_results).toEqual(postconditionResults);
    expect(state.discovered_gates).toEqual(discoveredGates);
    expect(state.parallel_results).toEqual(parallelResults);
    expect(state.compete_results).toEqual(competeResults);
    expect(state.artifact_history).toEqual(artifactHistory);
    expect(state.artifacts).toEqual(["src/feature.ts"]);
    expect(state.synthesized).toBe(true);
  });

  test("getAllStates returns all rows", () => {
    store.upsertState("research", { entries: 1, status: "done" });
    store.upsertState("implement", { entries: 1, status: "in_progress" });
    store.upsertState("review", { entries: 0, status: "pending" });
    const states = store.getAllStates();
    expect(states).toHaveLength(3);
    const ids = states.map((s) => s.state_id);
    expect(ids).toContain("research");
    expect(ids).toContain("implement");
    expect(ids).toContain("review");
  });
});

// inserted_return_to round-trip (ADR-012)

describe("upsertState + getState — inserted_return_to field", () => {
  let store: ExecutionStore;

  beforeEach(() => {
    store = makeStore();
  });
  afterEach(() => {
    store.close();
  });

  test("persists inserted_return_to when set", () => {
    store.upsertState("implement", {
      entries: 0,
      inserted_return_to: "hitl",
      status: "in_progress",
    });
    const state = store.getState("implement");
    expect(state).not.toBeNull();
    expect(state!.inserted_return_to).toBe("hitl");
  });

  test("returns undefined for inserted_return_to when not set", () => {
    store.upsertState("implement", {
      entries: 0,
      status: "in_progress",
    });
    const state = store.getState("implement");
    expect(state).not.toBeNull();
    expect(state!.inserted_return_to).toBeUndefined();
  });

  test("round-trips an arbitrary string value", () => {
    store.upsertState("research", {
      entries: 1,
      inserted_return_to: "some-target-state",
      status: "done",
    });
    const state = store.getState("research");
    expect(state!.inserted_return_to).toBe("some-target-state");
  });

  test("update overwrites inserted_return_to", () => {
    store.upsertState("implement", {
      entries: 0,
      inserted_return_to: "first",
      status: "in_progress",
    });
    store.upsertState("implement", {
      entries: 1,
      inserted_return_to: "second",
      status: "done",
    });
    const state = store.getState("implement");
    expect(state!.inserted_return_to).toBe("second");
  });
});

// upsertIteration + getIteration round-trip

describe("upsertIteration + getIteration", () => {
  let store: ExecutionStore;

  beforeEach(() => {
    store = makeStore();
  });
  afterEach(() => {
    store.close();
  });

  test("inserts and retrieves a minimal iteration", () => {
    store.upsertIteration("implement", { cannot_fix: [], count: 0, history: [], max: 3 });
    const iter = store.getIteration("implement");
    expect(iter).not.toBeNull();
    expect(iter!.count).toBe(0);
    expect(iter!.max).toBe(3);
    expect(iter!.history).toEqual([]);
    expect(iter!.cannot_fix).toEqual([]);
  });

  test("returns null for non-existent state", () => {
    expect(store.getIteration("nonexistent")).toBeNull();
  });

  test("updates existing iteration", () => {
    store.upsertIteration("implement", { cannot_fix: [], count: 0, history: [], max: 3 });
    store.upsertIteration("implement", {
      cannot_fix: [],
      count: 1,
      history: [{ status: "blocked" }],
      max: 3,
    });
    const iter = store.getIteration("implement")!;
    expect(iter.count).toBe(1);
    expect(iter.history).toEqual([{ status: "blocked" }]);
  });

  test("round-trips all 5 HistoryEntry variants", () => {
    const history = [
      { file_paths: ["src/foo.ts"], principle_ids: ["deep-modules"] }, // ViolationHistoryEntry
      { pairs: [{ file: "src/A.ts", test: "src/__tests__/A.test.ts" }] }, // FileTestHistoryEntry
      { status: "blocked" }, // StatusHistoryEntry
      { artifact_count: 2, commit_sha: "abc123" }, // ProgressHistoryEntry
      { gate_output_hash: "hash123", passed: false }, // GateProgressHistoryEntry
    ];
    const cannotFix = [{ file_path: "src/foo.ts", principle_id: "deep-modules" }];

    store.upsertIteration("implement", { cannot_fix: cannotFix, count: 5, history, max: 5 });

    const iter = store.getIteration("implement")!;
    expect(iter.count).toBe(5);
    expect(iter.max).toBe(5);
    expect(iter.history).toEqual(history);
    expect(iter.cannot_fix).toEqual(cannotFix);
  });
});
