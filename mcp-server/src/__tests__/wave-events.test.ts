/**
 * wave-events.test.ts — Store-backed wave event operations
 *
 * Tests now go against ExecutionStore (SQLite), not the file-based JSONL ops.
 * The resolveEventAgents pure function is tested here too.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initExecutionDb } from "../orchestration/execution-schema.ts";
import { ExecutionStore } from "../orchestration/execution-store.ts";
import { resolveEventAgents } from "../orchestration/wave-events.ts";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let db: Database.Database;
let store: ExecutionStore;

beforeEach(() => {
  db = initExecutionDb(":memory:");
  store = new ExecutionStore(db);
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Store-backed wave event operations
// ---------------------------------------------------------------------------

describe("postWaveEvent (store)", () => {
  it("inserts a pending event with id, type, timestamp, and payload", () => {
    store.postWaveEvent({
      id: "evt_test_001",
      type: "add_task",
      payload: { description: "New task to add" },
      timestamp: new Date().toISOString(),
      status: "pending",
    });

    const events = store.getWaveEvents();
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe("evt_test_001");
    expect(events[0].type).toBe("add_task");
    expect(events[0].status).toBe("pending");
    expect(events[0].payload.description).toBe("New task to add");
  });

  it("inserts multiple events that can all be read back", () => {
    store.postWaveEvent({ id: "evt-1", type: "add_task", payload: { description: "First" }, timestamp: "2026-01-01T00:00:00.000Z", status: "pending" });
    store.postWaveEvent({ id: "evt-2", type: "skip_task", payload: { task_id: "task-01" }, timestamp: "2026-01-01T00:01:00.000Z", status: "pending" });
    store.postWaveEvent({ id: "evt-3", type: "pause", payload: {}, timestamp: "2026-01-01T00:02:00.000Z", status: "pending" });

    const events = store.getWaveEvents();
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("add_task");
    expect(events[1].type).toBe("skip_task");
    expect(events[2].type).toBe("pause");
  });

  it("preserves payload fields", () => {
    store.postWaveEvent({
      id: "evt-payload",
      type: "reprioritize",
      payload: { task_id: "task-03", wave: 2 },
      timestamp: new Date().toISOString(),
      status: "pending",
    });

    const events = store.getWaveEvents();
    expect(events[0].payload.task_id).toBe("task-03");
    expect(events[0].payload.wave).toBe(2);
  });
});

describe("getWaveEvents (store)", () => {
  it("returns empty array when no events exist", () => {
    expect(store.getWaveEvents()).toEqual([]);
  });

  it("returns all events regardless of status", () => {
    store.postWaveEvent({ id: "evt-1", type: "add_task", payload: {}, timestamp: "2026-01-01T00:00:00.000Z", status: "pending" });
    store.postWaveEvent({ id: "evt-2", type: "guidance", payload: {}, timestamp: "2026-01-01T00:01:00.000Z", status: "pending" });
    store.updateWaveEvent("evt-1", { status: "applied", applied_at: new Date().toISOString() });

    const all = store.getWaveEvents();
    expect(all).toHaveLength(2);
    const statuses = all.map((e) => e.status);
    expect(statuses).toContain("applied");
    expect(statuses).toContain("pending");
  });

  it("filters by status=pending", () => {
    store.postWaveEvent({ id: "evt-1", type: "add_task", payload: {}, timestamp: "2026-01-01T00:00:00.000Z", status: "pending" });
    store.postWaveEvent({ id: "evt-2", type: "guidance", payload: {}, timestamp: "2026-01-01T00:01:00.000Z", status: "pending" });
    store.postWaveEvent({ id: "evt-3", type: "pause", payload: {}, timestamp: "2026-01-01T00:02:00.000Z", status: "pending" });
    store.updateWaveEvent("evt-1", { status: "applied", applied_at: new Date().toISOString() });
    store.updateWaveEvent("evt-2", { status: "rejected", rejection_reason: "Not relevant" });

    const pending = store.getWaveEvents({ status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe("evt-3");
    expect(pending[0].status).toBe("pending");
  });
});

describe("updateWaveEvent (store)", () => {
  it("transitions pending to applied, sets applied_at", () => {
    const before = new Date().toISOString();
    store.postWaveEvent({ id: "evt-apply", type: "add_task", payload: { description: "Apply me" }, timestamp: new Date().toISOString(), status: "pending" });

    store.updateWaveEvent("evt-apply", { status: "applied", applied_at: new Date().toISOString() });

    const events = store.getWaveEvents();
    const updated = events.find((e) => e.id === "evt-apply")!;
    expect(updated.status).toBe("applied");
    expect(updated.applied_at).toBeDefined();
    expect(new Date(updated.applied_at!).getTime()).not.toBeNaN();
    expect(updated.applied_at! >= before).toBe(true);
  });

  it("transitions pending to rejected, sets rejection_reason", () => {
    store.postWaveEvent({ id: "evt-reject", type: "add_task", payload: {}, timestamp: new Date().toISOString(), status: "pending" });

    store.updateWaveEvent("evt-reject", { status: "rejected", rejection_reason: "Out of scope for this wave" });

    const events = store.getWaveEvents();
    const updated = events.find((e) => e.id === "evt-reject")!;
    expect(updated.status).toBe("rejected");
    expect(updated.rejection_reason).toBe("Out of scope for this wave");
  });

  it("attaches resolution when provided", () => {
    store.postWaveEvent({ id: "evt-res", type: "add_task", payload: {}, timestamp: new Date().toISOString(), status: "pending" });

    const resolution = {
      agents_spawned: ["canon-architect"],
      artifacts: ["plans/task-04.md"],
      summary: "Task planned and slotted",
    };

    store.updateWaveEvent("evt-res", { status: "applied", applied_at: new Date().toISOString(), resolution });

    const events = store.getWaveEvents();
    const updated = events.find((e) => e.id === "evt-res")!;
    expect(updated.status).toBe("applied");
    expect(updated.resolution).toEqual(resolution);
  });

  it("does not modify other events", () => {
    store.postWaveEvent({ id: "evt-target", type: "add_task", payload: {}, timestamp: "2026-01-01T00:00:00.000Z", status: "pending" });
    store.postWaveEvent({ id: "evt-other", type: "pause", payload: {}, timestamp: "2026-01-01T00:01:00.000Z", status: "pending" });

    store.updateWaveEvent("evt-target", { status: "applied", applied_at: new Date().toISOString() });

    const events = store.getWaveEvents();
    const untouched = events.find((e) => e.id === "evt-other")!;
    expect(untouched.status).toBe("pending");
  });

  it("resolution is absent when not provided on apply", () => {
    store.postWaveEvent({ id: "evt-no-res", type: "skip_task", payload: {}, timestamp: new Date().toISOString(), status: "pending" });
    store.updateWaveEvent("evt-no-res", { status: "applied", applied_at: new Date().toISOString() });

    const events = store.getWaveEvents();
    const updated = events.find((e) => e.id === "evt-no-res")!;
    expect(updated.status).toBe("applied");
    expect(updated.resolution).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveEventAgents (pure function — unchanged)
// ---------------------------------------------------------------------------

describe("resolveEventAgents", () => {
  it("add_task returns canon-architect", () => {
    const result = resolveEventAgents("add_task");
    expect(result.agents).toEqual(["canon-architect"]);
    expect(result.descriptions["canon-architect"]).toBeDefined();
  });

  it("skip_task returns no agents", () => {
    const result = resolveEventAgents("skip_task");
    expect(result.agents).toEqual([]);
    expect(result.descriptions).toEqual({});
  });

  it("reprioritize returns canon-architect", () => {
    const result = resolveEventAgents("reprioritize");
    expect(result.agents).toEqual(["canon-architect"]);
    expect(result.descriptions["canon-architect"]).toBeDefined();
  });

  it("inject_context returns no agents", () => {
    const result = resolveEventAgents("inject_context");
    expect(result.agents).toEqual([]);
    expect(result.descriptions).toEqual({});
  });

  it("guidance returns no agents (mechanical orchestrator operation)", () => {
    const result = resolveEventAgents("guidance");
    expect(result.agents).toEqual([]);
    expect(result.descriptions).toEqual({});
  });

  it("pause returns no agents", () => {
    const result = resolveEventAgents("pause");
    expect(result.agents).toEqual([]);
    expect(result.descriptions).toEqual({});
  });
});
