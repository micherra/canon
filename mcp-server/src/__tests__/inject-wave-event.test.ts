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

const BASE_EXECUTION: InitExecutionParams = {
  base_commit: "abc1234",
  branch: "main",
  created: new Date().toISOString(),
  current_state: "implement",
  entry: "research",
  flow: "test-flow",
  flow_name: "test-flow",
  last_updated: new Date().toISOString(),
  sanitized: "main",
  slug: "test-task",
  started: new Date().toISOString(),
  task: "Test task",
  tier: "small",
};

function setupStoreWithWave(workspace: string, stateId = "implement"): void {
  const store = getExecutionStore(workspace);
  store.initExecution(BASE_EXECUTION);
  store.upsertState(stateId, {
    entries: 1,
    status: "in_progress",
    wave: 1,
  });
}

function _setupStoreWithNoWave(workspace: string): void {
  const store = getExecutionStore(workspace);
  store.initExecution(BASE_EXECUTION);
  store.upsertState("research", {
    entries: 0,
    status: "pending",
  });
}

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "canon-inject-wave-event-"));
  setupStoreWithWave(workspace);
});

afterEach(async () => {
  await rm(workspace, { force: true, recursive: true });
  vi.restoreAllMocks();
});

// 1. Active-wave guard

describe("active-wave guard", () => {
  it("throws when no execution exists in store", async () => {
    const emptyWorkspace = await mkdtemp(join(tmpdir(), "canon-empty-ws-"));
    try {
      await expect(
        injectWaveEvent({ payload: {}, type: "guidance", workspace: emptyWorkspace }),
      ).rejects.toThrow("No active wave state found");
    } finally {
      await rm(emptyWorkspace, { force: true, recursive: true });
    }
  });

  it("throws when states exist but none are in_progress", async () => {
    const ws2 = await mkdtemp(join(tmpdir(), "canon-no-wave-ws-"));
    try {
      const store = getExecutionStore(ws2);
      store.initExecution(BASE_EXECUTION);
      store.upsertState("research", { entries: 1, status: "done", wave: 1 });
      store.upsertState("implement", { entries: 0, status: "pending", wave: 2 });

      await expect(
        injectWaveEvent({ payload: {}, type: "guidance", workspace: ws2 }),
      ).rejects.toThrow("No active wave state found");
    } finally {
      await rm(ws2, { force: true, recursive: true });
    }
  });

  it("throws when a state is in_progress but has no wave field", async () => {
    const ws3 = await mkdtemp(join(tmpdir(), "canon-no-wave-field-"));
    try {
      const store = getExecutionStore(ws3);
      store.initExecution(BASE_EXECUTION);
      store.upsertState("implement", { entries: 1, status: "in_progress" }); // no wave

      await expect(
        injectWaveEvent({ payload: { task_id: "task-01" }, type: "skip_task", workspace: ws3 }),
      ).rejects.toThrow("No active wave state found");
    } finally {
      await rm(ws3, { force: true, recursive: true });
    }
  });

  it("succeeds when exactly one state has both wave set and status in_progress", async () => {
    // Default workspace has this setup
    await expect(
      injectWaveEvent({ payload: { context: "ok" }, type: "guidance", workspace }),
    ).resolves.toBeDefined();
  });

  it("succeeds when multiple states exist but only one satisfies the guard", async () => {
    const ws4 = await mkdtemp(join(tmpdir(), "canon-multi-state-"));
    try {
      const store = getExecutionStore(ws4);
      store.initExecution(BASE_EXECUTION);
      store.upsertState("research", { entries: 1, status: "done" });
      store.upsertState("implement", { entries: 1, status: "in_progress", wave: 2 });
      store.upsertState("review", { entries: 0, status: "pending" });

      await expect(
        injectWaveEvent({ payload: { context: "ctx" }, type: "inject_context", workspace: ws4 }),
      ).resolves.toBeDefined();
    } finally {
      await rm(ws4, { force: true, recursive: true });
    }
  });
});

// 2. Event posting and result shape

describe("event posting and result shape", () => {
  it("returns an event with id, type, timestamp, and payload", async () => {
    const result = await injectWaveEvent({
      payload: { description: "A new task" },
      type: "add_task",
      workspace,
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
      payload: { context: "first" },
      type: "guidance",
      workspace,
    });
    expect(result1.pending_count).toBe(1);

    const result2 = await injectWaveEvent({
      payload: { context: "second" },
      type: "inject_context",
      workspace,
    });
    expect(result2.pending_count).toBe(2);
  });

  it("preserves all payload fields on the returned event", async () => {
    const result = await injectWaveEvent({
      payload: { task_id: "task-03", wave: 3 },
      type: "reprioritize",
      workspace,
    });

    expect(result.event.payload.task_id).toBe("task-03");
    expect(result.event.payload.wave).toBe(3);
  });

  it("returned event has status pending", async () => {
    const result = await injectWaveEvent({
      payload: {},
      type: "pause",
      workspace,
    });

    expect(result.event.status).toBe("pending");
  });

  it("event is persisted in store after injection", async () => {
    const result = await injectWaveEvent({
      payload: { description: "Persisted task" },
      type: "add_task",
      workspace,
    });

    const store = getExecutionStore(workspace);
    const events = store.getWaveEvents({ status: "pending" });
    expect(events.some((e) => e.id === result.event.id)).toBe(true);
  });
});

// 3. Event bus emission and listener cleanup

describe("event bus emission and listener cleanup", () => {
  it("emits wave_event_injected with correct fields", async () => {
    const emitSpy = vi.spyOn(flowEventBus, "emit");

    const result = await injectWaveEvent({
      payload: { description: "Bus test" },
      type: "add_task",
      workspace,
    });

    const emittedCall = emitSpy.mock.calls.find(
      ([eventName]) => eventName === "wave_event_injected",
    );
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
      payload: { context: "listener order check" },
      type: "guidance",
      workspace,
    });

    const onceCall = onceSpy.mock.calls.find(([name]) => name === "wave_event_injected");
    expect(onceCall).toBeDefined();

    const emitCallIndex = emitSpy.mock.calls.findIndex(([name]) => name === "wave_event_injected");
    const onceCallIndex =
      onceSpy.mock.invocationCallOrder[
        onceSpy.mock.calls.findIndex(([name]) => name === "wave_event_injected")
      ];
    const emitCallOrder = emitSpy.mock.invocationCallOrder[emitCallIndex];

    expect(onceCallIndex).toBeLessThan(emitCallOrder);
  });

  it("removes the once listener after the call (no lingering listeners)", async () => {
    const removeListenerSpy = vi.spyOn(flowEventBus, "removeListener");

    await injectWaveEvent({
      payload: { context: "cleanup check" },
      type: "inject_context",
      workspace,
    });

    const removalCall = removeListenerSpy.mock.calls.find(
      ([name]) => name === "wave_event_injected",
    );
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

    await expect(injectWaveEvent({ payload: {}, type: "pause", workspace })).rejects.toThrow(
      "Simulated emit failure",
    );

    const removalCall = removeListenerSpy.mock.calls.find(
      ([name]) => name === "wave_event_injected",
    );
    expect(removalCall).toBeDefined();
  });
});
