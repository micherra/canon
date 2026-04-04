/**
 * wave-events.test.ts — Store-backed wave event operations
 *
 * Tests now go against ExecutionStore (SQLite), not the file-based JSONL ops.
 * The resolveEventAgents pure function is tested here too.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initExecutionDb } from "../orchestration/execution-schema.ts";
import { ExecutionStore } from "../orchestration/execution-store.ts";
import { resolveEventAgents } from "../orchestration/wave-events.ts";

let db: Database.Database;
let store: ExecutionStore;

beforeEach(() => {
  db = initExecutionDb(":memory:");
  store = new ExecutionStore(db);
});

afterEach(() => {
  db.close();
});

// Store-backed wave event operations

describe("postWaveEvent (store)", () => {
  it("inserts a pending event with id, type, timestamp, and payload", () => {
    store.postWaveEvent({
      id: "evt_test_001",
      payload: { description: "New task to add" },
      status: "pending",
      timestamp: new Date().toISOString(),
      type: "add_task",
    });

    const events = store.getWaveEvents();
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe("evt_test_001");
    expect(events[0].type).toBe("add_task");
    expect(events[0].status).toBe("pending");
    expect(events[0].payload.description).toBe("New task to add");
  });

  it("inserts multiple events that can all be read back", () => {
    store.postWaveEvent({
      id: "evt-1",
      payload: { description: "First" },
      status: "pending",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "add_task",
    });
    store.postWaveEvent({
      id: "evt-2",
      payload: { task_id: "task-01" },
      status: "pending",
      timestamp: "2026-01-01T00:01:00.000Z",
      type: "skip_task",
    });
    store.postWaveEvent({
      id: "evt-3",
      payload: {},
      status: "pending",
      timestamp: "2026-01-01T00:02:00.000Z",
      type: "pause",
    });

    const events = store.getWaveEvents();
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("add_task");
    expect(events[1].type).toBe("skip_task");
    expect(events[2].type).toBe("pause");
  });

  it("preserves payload fields", () => {
    store.postWaveEvent({
      id: "evt-payload",
      payload: { task_id: "task-03", wave: 2 },
      status: "pending",
      timestamp: new Date().toISOString(),
      type: "reprioritize",
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
    store.postWaveEvent({
      id: "evt-1",
      payload: {},
      status: "pending",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "add_task",
    });
    store.postWaveEvent({
      id: "evt-2",
      payload: {},
      status: "pending",
      timestamp: "2026-01-01T00:01:00.000Z",
      type: "guidance",
    });
    store.updateWaveEvent("evt-1", { applied_at: new Date().toISOString(), status: "applied" });

    const all = store.getWaveEvents();
    expect(all).toHaveLength(2);
    const statuses = all.map((e) => e.status);
    expect(statuses).toContain("applied");
    expect(statuses).toContain("pending");
  });

  it("filters by status=pending", () => {
    store.postWaveEvent({
      id: "evt-1",
      payload: {},
      status: "pending",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "add_task",
    });
    store.postWaveEvent({
      id: "evt-2",
      payload: {},
      status: "pending",
      timestamp: "2026-01-01T00:01:00.000Z",
      type: "guidance",
    });
    store.postWaveEvent({
      id: "evt-3",
      payload: {},
      status: "pending",
      timestamp: "2026-01-01T00:02:00.000Z",
      type: "pause",
    });
    store.updateWaveEvent("evt-1", { applied_at: new Date().toISOString(), status: "applied" });
    store.updateWaveEvent("evt-2", { rejection_reason: "Not relevant", status: "rejected" });

    const pending = store.getWaveEvents({ status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe("evt-3");
    expect(pending[0].status).toBe("pending");
  });
});

describe("updateWaveEvent (store)", () => {
  it("transitions pending to applied, sets applied_at", () => {
    const before = new Date().toISOString();
    store.postWaveEvent({
      id: "evt-apply",
      payload: { description: "Apply me" },
      status: "pending",
      timestamp: new Date().toISOString(),
      type: "add_task",
    });

    store.updateWaveEvent("evt-apply", { applied_at: new Date().toISOString(), status: "applied" });

    const events = store.getWaveEvents();
    const updated = events.find((e) => e.id === "evt-apply")!;
    expect(updated.status).toBe("applied");
    expect(updated.applied_at).toBeDefined();
    expect(new Date(updated.applied_at!).getTime()).not.toBeNaN();
    expect(updated.applied_at! >= before).toBe(true);
  });

  it("transitions pending to rejected, sets rejection_reason", () => {
    store.postWaveEvent({
      id: "evt-reject",
      payload: {},
      status: "pending",
      timestamp: new Date().toISOString(),
      type: "add_task",
    });

    store.updateWaveEvent("evt-reject", {
      rejection_reason: "Out of scope for this wave",
      status: "rejected",
    });

    const events = store.getWaveEvents();
    const updated = events.find((e) => e.id === "evt-reject")!;
    expect(updated.status).toBe("rejected");
    expect(updated.rejection_reason).toBe("Out of scope for this wave");
  });

  it("attaches resolution when provided", () => {
    store.postWaveEvent({
      id: "evt-res",
      payload: {},
      status: "pending",
      timestamp: new Date().toISOString(),
      type: "add_task",
    });

    const resolution = {
      agents_spawned: ["canon-architect"],
      artifacts: ["plans/task-04.md"],
      summary: "Task planned and slotted",
    };

    store.updateWaveEvent("evt-res", {
      applied_at: new Date().toISOString(),
      resolution,
      status: "applied",
    });

    const events = store.getWaveEvents();
    const updated = events.find((e) => e.id === "evt-res")!;
    expect(updated.status).toBe("applied");
    expect(updated.resolution).toEqual(resolution);
  });

  it("does not modify other events", () => {
    store.postWaveEvent({
      id: "evt-target",
      payload: {},
      status: "pending",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "add_task",
    });
    store.postWaveEvent({
      id: "evt-other",
      payload: {},
      status: "pending",
      timestamp: "2026-01-01T00:01:00.000Z",
      type: "pause",
    });

    store.updateWaveEvent("evt-target", {
      applied_at: new Date().toISOString(),
      status: "applied",
    });

    const events = store.getWaveEvents();
    const untouched = events.find((e) => e.id === "evt-other")!;
    expect(untouched.status).toBe("pending");
  });

  it("resolution is absent when not provided on apply", () => {
    store.postWaveEvent({
      id: "evt-no-res",
      payload: {},
      status: "pending",
      timestamp: new Date().toISOString(),
      type: "skip_task",
    });
    store.updateWaveEvent("evt-no-res", {
      applied_at: new Date().toISOString(),
      status: "applied",
    });

    const events = store.getWaveEvents();
    const updated = events.find((e) => e.id === "evt-no-res")!;
    expect(updated.status).toBe("applied");
    expect(updated.resolution).toBeUndefined();
  });
});

// resolveEventAgents (pure function — unchanged)

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
