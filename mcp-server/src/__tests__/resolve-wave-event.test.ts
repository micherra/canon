/**
 * resolve-wave-event.test.ts — Store-backed wave event resolution
 *
 * Tests now go against ExecutionStore (SQLite) instead of file-based JSONL.
 * withBoardLock removed — SQLite transaction handles atomicity.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { resolveWaveEvent } from "../tools/resolve-wave-event.ts";
import { flowEventBus } from "../orchestration/event-bus-instance.ts";
import { getExecutionStore } from "../orchestration/execution-store.ts";
import type { InitExecutionParams } from "../orchestration/execution-store.ts";

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

function postEvent(workspace: string, type: string, payload: Record<string, unknown> = {}) {
  const store = getExecutionStore(workspace);
  const id = `evt_test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  store.postWaveEvent({ id, type, payload, timestamp: new Date().toISOString(), status: "pending" });
  return { id, type, payload };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "canon-resolve-wave-event-"));
  const store = getExecutionStore(workspace);
  store.initExecution(BASE_EXECUTION);
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Apply action
// ---------------------------------------------------------------------------

describe("apply action", () => {
  it("marks event applied and returns the event_id", async () => {
    const event = postEvent(workspace, "add_task", { description: "do something" });

    const result = await resolveWaveEvent({
      workspace,
      event_id: event.id,
      action: "apply",
    });

    expect(result.event_id).toBe(event.id);
    expect(result.action).toBe("apply");
  });

  it("persists applied status in store", async () => {
    const event = postEvent(workspace, "add_task", { description: "persist test" });

    await resolveWaveEvent({ workspace, event_id: event.id, action: "apply" });

    const store = getExecutionStore(workspace);
    const events = store.getWaveEvents();
    const updated = events.find((e) => e.id === event.id)!;
    expect(updated.status).toBe("applied");
    expect(updated.applied_at).toBeDefined();
    expect(new Date(updated.applied_at!).getTime()).not.toBeNaN();
  });

  it("returns agents from resolveEventAgents for the event type", async () => {
    const event = postEvent(workspace, "add_task", { description: "new task" });

    const result = await resolveWaveEvent({
      workspace,
      event_id: event.id,
      action: "apply",
    });

    expect(result.agents).toEqual(["canon-architect"]);
    expect(result.descriptions["canon-architect"]).toBeDefined();
  });

  it("resolution is optional for apply", async () => {
    const event = postEvent(workspace, "guidance");

    const result = await resolveWaveEvent({
      workspace,
      event_id: event.id,
      action: "apply",
    });

    expect(result.action).toBe("apply");
  });

  it("pending_count decrements after applying an event", async () => {
    const event1 = postEvent(workspace, "guidance");
    postEvent(workspace, "pause");

    const result = await resolveWaveEvent({
      workspace,
      event_id: event1.id,
      action: "apply",
    });

    expect(result.pending_count).toBe(1);
  });

  it("accepts a resolution object when applying", async () => {
    const event = postEvent(workspace, "add_task", { description: "task" });

    const result = await resolveWaveEvent({
      workspace,
      event_id: event.id,
      action: "apply",
      resolution: { plan_id: "plan-01", tasks: ["a", "b"] },
    });

    expect(result.action).toBe("apply");

    // Verify resolution was persisted
    const store = getExecutionStore(workspace);
    const events = store.getWaveEvents();
    const updated = events.find((e) => e.id === event.id)!;
    expect(updated.resolution).toEqual({ plan_id: "plan-01", tasks: ["a", "b"] });
  });
});

// ---------------------------------------------------------------------------
// 2. Reject action
// ---------------------------------------------------------------------------

describe("reject action", () => {
  it("marks event rejected with reason and returns the event_id", async () => {
    const event = postEvent(workspace, "add_task");

    const result = await resolveWaveEvent({
      workspace,
      event_id: event.id,
      action: "reject",
      reason: "Not relevant for this wave",
    });

    expect(result.event_id).toBe(event.id);
    expect(result.action).toBe("reject");
  });

  it("persists rejected status and reason in store", async () => {
    const event = postEvent(workspace, "add_task");

    await resolveWaveEvent({
      workspace,
      event_id: event.id,
      action: "reject",
      reason: "Out of scope",
    });

    const store = getExecutionStore(workspace);
    const events = store.getWaveEvents();
    const updated = events.find((e) => e.id === event.id)!;
    expect(updated.status).toBe("rejected");
    expect(updated.rejection_reason).toBe("Out of scope");
  });

  it("throws if reason is missing when action is reject", async () => {
    const event = postEvent(workspace, "add_task");

    await resolveWaveEvent({
      workspace,
      event_id: event.id,
      action: "reject",
      reason: "Out of scope",
    });

    const store = getExecutionStore(workspace);
    const events = store.getWaveEvents();
    const updated = events.find((e) => e.id === event.id)!;
    expect(updated.status).toBe("rejected");
    expect(updated.rejection_reason).toBe("Out of scope");
  });

  it("throws if reason is missing when action is reject", async () => {
    const event = postEvent(workspace, "add_task");

    await expect(resolveWaveEvent({ workspace, event_id: event.id, action: "reject" })).rejects.toThrow(
      "reason is required when action is reject",
    );
  });

  it("returns agents from resolveEventAgents even for reject", async () => {
    const event = postEvent(workspace, "add_task");

    const result = await resolveWaveEvent({
      workspace,
      event_id: event.id,
      action: "reject",
      reason: "Not needed",
    });

    expect(result.agents).toEqual(["canon-architect"]);
  });

  it("pending_count decrements after rejecting an event", async () => {
    const event1 = postEvent(workspace, "guidance");
    postEvent(workspace, "pause");

    const result = await resolveWaveEvent({
      workspace,
      event_id: event1.id,
      action: "reject",
      reason: "Rejected for testing",
    });

    expect(result.pending_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Validation: unknown event, already-applied/rejected
// ---------------------------------------------------------------------------

describe("validation", () => {
  it("throws on unknown event_id", async () => {
    await expect(resolveWaveEvent({ workspace, event_id: "evt_does_not_exist", action: "apply" })).rejects.toThrow(
      "Event not found: evt_does_not_exist",
    );
  });

  it("throws on already-applied event", async () => {
    const event = postEvent(workspace, "guidance");

    await resolveWaveEvent({ workspace, event_id: event.id, action: "apply" });

    await expect(
      resolveWaveEvent({ workspace, event_id: event.id, action: "apply" }),
    ).rejects.toThrow(`Event ${event.id} is already applied`);
  });

  it("throws on already-rejected event", async () => {
    const event = postEvent(workspace, "guidance");

    await resolveWaveEvent({ workspace, event_id: event.id, action: "reject", reason: "nope" });

    await expect(
      resolveWaveEvent({ workspace, event_id: event.id, action: "apply" }),
    ).rejects.toThrow(`Event ${event.id} is already rejected`);
  });
});

// ---------------------------------------------------------------------------
// 4. Full lifecycle: inject → resolve → verify
// ---------------------------------------------------------------------------

describe("full lifecycle", () => {
  it("inject → apply → verify applied status in store", async () => {
    const store = getExecutionStore(workspace);
    store.upsertState("implement", { status: "in_progress", entries: 1, wave: 1 });

    const { injectWaveEvent } = await import("../tools/inject-wave-event.ts");
    const injected = await injectWaveEvent({
      workspace,
      type: "add_task",
      payload: { description: "Full lifecycle task" },
    });

    expect(injected.event.status).toBe("pending");
    expect(injected.pending_count).toBe(1);

    const resolved = await resolveWaveEvent({
      workspace,
      event_id: injected.event.id,
      action: "apply",
    });

    expect(resolved.pending_count).toBe(0);

    const events = store.getWaveEvents({ status: "pending" });
    expect(events).toHaveLength(0);

    const allEvents = store.getWaveEvents();
    const evt = allEvents.find((e) => e.id === injected.event.id)!;
    expect(evt.status).toBe("applied");
    expect(evt.applied_at).toBeDefined();
  });

  it("inject → reject with reason → verify rejected status", async () => {
    const store = getExecutionStore(workspace);
    store.upsertState("implement", { status: "in_progress", entries: 1, wave: 1 });

    const { injectWaveEvent } = await import("../tools/inject-wave-event.ts");
    const injected = await injectWaveEvent({
      workspace,
      type: "guidance",
      payload: { context: "Reject this" },
    });

    const resolved = await resolveWaveEvent({
      workspace,
      event_id: injected.event.id,
      action: "reject",
      reason: "Not applicable",
    });

    expect(resolved.pending_count).toBe(0);

    const allEvents = store.getWaveEvents();
    const evt = allEvents.find((e) => e.id === injected.event.id)!;
    expect(evt.status).toBe("rejected");
    expect(evt.rejection_reason).toBe("Not applicable");
  });
});

// ---------------------------------------------------------------------------
// 5. Event bus emission and listener cleanup
// ---------------------------------------------------------------------------

describe("event bus emission and listener cleanup", () => {
  it("emits wave_event_resolved with correct fields", async () => {
    const event = postEvent(workspace, "add_task", { description: "Bus test" });
    const emitSpy = vi.spyOn(flowEventBus, "emit");

    await resolveWaveEvent({ workspace, event_id: event.id, action: "apply" });

    const emittedCall = emitSpy.mock.calls.find(([eventName]) => eventName === "wave_event_resolved");
    expect(emittedCall).toBeDefined();

    const payload = emittedCall![1] as {
      eventId: string;
      eventType: string;
      action: "apply" | "reject";
      workspace: string;
      timestamp: string;
    };
    expect(payload.eventId).toBe(event.id);
    expect(payload.eventType).toBe("add_task");
    expect(payload.action).toBe("apply");
    expect(payload.workspace).toBe(workspace);
    expect(payload.timestamp).toBeDefined();
    expect(new Date(payload.timestamp).getTime()).not.toBeNaN();
  });

  it("emits wave_event_resolved with action=reject when rejecting", async () => {
    const event = postEvent(workspace, "guidance");
    const emitSpy = vi.spyOn(flowEventBus, "emit");

    await resolveWaveEvent({ workspace, event_id: event.id, action: "reject", reason: "not needed" });

    const emittedCall = emitSpy.mock.calls.find(([eventName]) => eventName === "wave_event_resolved");
    expect(emittedCall).toBeDefined();
    const payload = emittedCall![1] as { action: string };
    expect(payload.action).toBe("reject");
  });

  it("removes the once listener after the call (no lingering listeners)", async () => {
    const event = postEvent(workspace, "guidance");
    const removeListenerSpy = vi.spyOn(flowEventBus, "removeListener");

    await resolveWaveEvent({ workspace, event_id: event.id, action: "apply" });

    const removalCall = removeListenerSpy.mock.calls.find(([name]) => name === "wave_event_resolved");
    expect(removalCall).toBeDefined();
  });

  it("removes the once listener in the finally block even when emit throws", async () => {
    const event = postEvent(workspace, "guidance");
    const removeListenerSpy = vi.spyOn(flowEventBus, "removeListener");

    vi.spyOn(flowEventBus, "emit").mockImplementationOnce((eventName: string) => {
      if (eventName === "wave_event_resolved") {
        throw new Error("Simulated emit failure");
      }
      return false;
    });

    await expect(
      resolveWaveEvent({ workspace, event_id: event.id, action: "apply" }),
    ).rejects.toThrow("Simulated emit failure");

    const removalCall = removeListenerSpy.mock.calls.find(
      ([name]) => name === "wave_event_resolved",
    );

    const removalCall = removeListenerSpy.mock.calls.find(([name]) => name === "wave_event_resolved");
    expect(removalCall).toBeDefined();
  });
});
