/**
 * inject-wave-event.test.ts — Store-backed wave event injection
 *
 * The tool now uses ExecutionStore (SQLite) instead of file-based JSONL.
 * Board state is read from store, not from board.json.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flowEventBus } from "../orchestration/event-bus-instance.ts";
import type { InitExecutionParams } from "../orchestration/execution-store.ts";
import { getExecutionStore } from "../orchestration/execution-store.ts";
import { injectWaveEvent } from "../tools/inject-wave-event.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_EXECUTION: InitExecutionParams = {
  flow: "test-flow",
  task: "Test task",
  entry: "research",
  current_state: "implement",
  base_commit: "abc1234",
  started: new Date().toISOString(),
  last_updated: new Date().toISOString(),
  branch: "main",
  sanitized: "main",
  created: new Date().toISOString(),
  tier: "small",
  flow_name: "test-flow",
  slug: "test-task",
};

function setupStoreWithWave(workspace: string, stateId = "implement"): void {
  const store = getExecutionStore(workspace);
  store.initExecution(BASE_EXECUTION);
  store.upsertState(stateId, {
    status: "in_progress",
    entries: 1,
    wave: 1,
  });
}

function _setupStoreWithNoWave(workspace: string): void {
  const store = getExecutionStore(workspace);
  store.initExecution(BASE_EXECUTION);
  store.upsertState("research", {
    status: "pending",
    entries: 0,
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "canon-inject-wave-event-"));
  setupStoreWithWave(workspace);
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Active-wave guard
// ---------------------------------------------------------------------------

describe("active-wave guard", () => {
  it("throws when no execution exists in store", async () => {
    const emptyWorkspace = await mkdtemp(join(tmpdir(), "canon-empty-ws-"));
    try {
      await expect(injectWaveEvent({ workspace: emptyWorkspace, type: "guidance", payload: {} })).rejects.toThrow(
        "No active wave state found",
      );
    } finally {
      await rm(emptyWorkspace, { recursive: true, force: true });
    }
  });

  it("throws when states exist but none are in_progress", async () => {
    const ws2 = await mkdtemp(join(tmpdir(), "canon-no-wave-ws-"));
    try {
      const store = getExecutionStore(ws2);
      store.initExecution(BASE_EXECUTION);
      store.upsertState("research", { status: "done", entries: 1, wave: 1 });
      store.upsertState("implement", { status: "pending", entries: 0, wave: 2 });

      await expect(injectWaveEvent({ workspace: ws2, type: "guidance", payload: {} })).rejects.toThrow(
        "No active wave state found",
      );
    } finally {
      await rm(ws2, { recursive: true, force: true });
    }
  });

  it("throws when a state is in_progress but has no wave field", async () => {
    const ws3 = await mkdtemp(join(tmpdir(), "canon-no-wave-field-"));
    try {
      const store = getExecutionStore(ws3);
      store.initExecution(BASE_EXECUTION);
      store.upsertState("implement", { status: "in_progress", entries: 1 }); // no wave

      await expect(
        injectWaveEvent({ workspace: ws3, type: "skip_task", payload: { task_id: "task-01" } }),
      ).rejects.toThrow("No active wave state found");
    } finally {
      await rm(ws3, { recursive: true, force: true });
    }
  });

  it("succeeds when exactly one state has both wave set and status in_progress", async () => {
    // Default workspace has this setup
    await expect(injectWaveEvent({ workspace, type: "guidance", payload: { context: "ok" } })).resolves.toBeDefined();
  });

  it("succeeds when multiple states exist but only one satisfies the guard", async () => {
    const ws4 = await mkdtemp(join(tmpdir(), "canon-multi-state-"));
    try {
      const store = getExecutionStore(ws4);
      store.initExecution(BASE_EXECUTION);
      store.upsertState("research", { status: "done", entries: 1 });
      store.upsertState("implement", { status: "in_progress", entries: 1, wave: 2 });
      store.upsertState("review", { status: "pending", entries: 0 });

      await expect(
        injectWaveEvent({ workspace: ws4, type: "inject_context", payload: { context: "ctx" } }),
      ).resolves.toBeDefined();
    } finally {
      await rm(ws4, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Event posting and result shape
// ---------------------------------------------------------------------------

describe("event posting and result shape", () => {
  it("returns an event with id, type, timestamp, and payload", async () => {
    const result = await injectWaveEvent({
      workspace,
      type: "add_task",
      payload: { description: "A new task" },
    });

    expect(result.event).toBeDefined();
    expect(result.event.id).toMatch(/^evt/);
    expect(result.event.type).toBe("add_task");
    expect(result.event.timestamp).toBeDefined();
    expect(new Date(result.event.timestamp).getTime()).not.toBeNaN();
    expect(result.event.payload.description).toBe("A new task");
  });

  it("returns pending_count equal to the number of pending events", async () => {
    const result1 = await injectWaveEvent({
      workspace,
      type: "guidance",
      payload: { context: "first" },
    });
    expect(result1.pending_count).toBe(1);

    const result2 = await injectWaveEvent({
      workspace,
      type: "inject_context",
      payload: { context: "second" },
    });
    expect(result2.pending_count).toBe(2);
  });

  it("preserves all payload fields on the returned event", async () => {
    const result = await injectWaveEvent({
      workspace,
      type: "reprioritize",
      payload: { task_id: "task-03", wave: 3 },
    });

    expect(result.event.payload.task_id).toBe("task-03");
    expect(result.event.payload.wave).toBe(3);
  });

  it("returned event has status pending", async () => {
    const result = await injectWaveEvent({
      workspace,
      type: "pause",
      payload: {},
    });

    expect(result.event.status).toBe("pending");
  });

  it("event is persisted in store after injection", async () => {
    const result = await injectWaveEvent({
      workspace,
      type: "add_task",
      payload: { description: "Persisted task" },
    });

    const store = getExecutionStore(workspace);
    const events = store.getWaveEvents({ status: "pending" });
    expect(events.some((e) => e.id === result.event.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Event bus emission and listener cleanup
// ---------------------------------------------------------------------------

describe("event bus emission and listener cleanup", () => {
  it("emits wave_event_injected with correct fields", async () => {
    const emitSpy = vi.spyOn(flowEventBus, "emit");

    const result = await injectWaveEvent({
      workspace,
      type: "add_task",
      payload: { description: "Bus test" },
    });

    const emittedCall = emitSpy.mock.calls.find(([eventName]) => eventName === "wave_event_injected");
    expect(emittedCall).toBeDefined();

    const payload = emittedCall![1] as {
      eventId: string;
      eventType: string;
      workspace: string;
      timestamp: string;
    };
    expect(payload.eventId).toBe(result.event.id);
    expect(payload.eventType).toBe("add_task");
    expect(payload.workspace).toBe(workspace);
    expect(payload.timestamp).toBe(result.event.timestamp);
  });

  it("registers a once listener before emitting", async () => {
    const onceSpy = vi.spyOn(flowEventBus, "once");
    const emitSpy = vi.spyOn(flowEventBus, "emit");

    await injectWaveEvent({
      workspace,
      type: "guidance",
      payload: { context: "listener order check" },
    });

    const onceCall = onceSpy.mock.calls.find(([name]) => name === "wave_event_injected");
    expect(onceCall).toBeDefined();

    const emitCallIndex = emitSpy.mock.calls.findIndex(([name]) => name === "wave_event_injected");
    const onceCallIndex =
      onceSpy.mock.invocationCallOrder[onceSpy.mock.calls.findIndex(([name]) => name === "wave_event_injected")];
    const emitCallOrder = emitSpy.mock.invocationCallOrder[emitCallIndex];

    expect(onceCallIndex).toBeLessThan(emitCallOrder);
  });

  it("removes the once listener after the call (no lingering listeners)", async () => {
    const removeListenerSpy = vi.spyOn(flowEventBus, "removeListener");

    await injectWaveEvent({
      workspace,
      type: "inject_context",
      payload: { context: "cleanup check" },
    });

    const removalCall = removeListenerSpy.mock.calls.find(([name]) => name === "wave_event_injected");
    expect(removalCall).toBeDefined();
  });

  it("removes the once listener in the finally block even when emit throws", async () => {
    const removeListenerSpy = vi.spyOn(flowEventBus, "removeListener");

    vi.spyOn(flowEventBus, "emit").mockImplementationOnce((eventName: string) => {
      if (eventName === "wave_event_injected") {
        throw new Error("Simulated emit failure");
      }
      return false;
    });

    await expect(injectWaveEvent({ workspace, type: "pause", payload: {} })).rejects.toThrow("Simulated emit failure");

    const removalCall = removeListenerSpy.mock.calls.find(([name]) => name === "wave_event_injected");
    expect(removalCall).toBeDefined();
  });
});
