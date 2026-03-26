import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, access } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { resolveWaveEvent } from "../tools/resolve-wave-event.ts";
import { flowEventBus } from "../orchestration/event-bus-instance.ts";
import { postWaveEvent } from "../orchestration/wave-events.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function writeBoard(workspace: string, board: unknown): Promise<void> {
  await writeFile(join(workspace, "board.json"), JSON.stringify(board, null, 2) + "\n", "utf-8");
}

function makeBoard(overrides: Record<string, unknown> = {}): unknown {
  const now = new Date().toISOString();
  return {
    flow: "test-flow",
    task: "Test task",
    entry: "research",
    current_state: "implement",
    base_commit: "abc1234",
    started: now,
    last_updated: now,
    states: {
      implement: {
        status: "in_progress",
        entries: 1,
        wave: 1,
      },
    },
    iterations: {},
    blocked: null,
    concerns: [],
    skipped: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "canon-resolve-wave-event-"));
  await writeBoard(workspace, makeBoard());
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Board lock — acquisition and release
// ---------------------------------------------------------------------------

describe("withBoardLock acquisition and release", () => {
  it("releases the lock after a successful call (no .lock file remains)", async () => {
    const event = await postWaveEvent(workspace, { type: "guidance", payload: {} });

    await resolveWaveEvent({
      workspace,
      event_id: event.id,
      action: "apply",
    });

    await expect(access(join(workspace, ".lock"))).rejects.toThrow();
  });

  it("releases the lock even when an error is thrown (no .lock file remains)", async () => {
    await expect(
      resolveWaveEvent({ workspace, event_id: "evt_nonexistent", action: "apply" }),
    ).rejects.toThrow("Event not found");

    await expect(access(join(workspace, ".lock"))).rejects.toThrow();
  });

  it("creates the lock file during callback execution", async () => {
    const event = await postWaveEvent(workspace, { type: "guidance", payload: {} });

    let lockExistedDuringCall = false;

    const { markEventApplied } = await import("../orchestration/wave-events.ts");
    vi.spyOn(
      await import("../orchestration/wave-events.ts"),
      "markEventApplied",
    ).mockImplementationOnce(async (...args) => {
      try {
        await access(join(workspace, ".lock"));
        lockExistedDuringCall = true;
      } catch {
        // lock not present
      }
      return markEventApplied(...args);
    });

    await resolveWaveEvent({ workspace, event_id: event.id, action: "apply" });
    expect(lockExistedDuringCall).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Apply action
// ---------------------------------------------------------------------------

describe("apply action", () => {
  it("marks event applied and returns the event_id", async () => {
    const event = await postWaveEvent(workspace, { type: "add_task", payload: { description: "do something" } });

    const result = await resolveWaveEvent({
      workspace,
      event_id: event.id,
      action: "apply",
    });

    expect(result.event_id).toBe(event.id);
    expect(result.action).toBe("apply");
  });

  it("returns agents from resolveEventAgents for the event type", async () => {
    const event = await postWaveEvent(workspace, { type: "add_task", payload: { description: "new task" } });

    const result = await resolveWaveEvent({
      workspace,
      event_id: event.id,
      action: "apply",
    });

    // add_task resolves to canon-architect
    expect(result.agents).toEqual(["canon-architect"]);
    expect(result.descriptions["canon-architect"]).toBeDefined();
  });

  it("resolution is optional for apply", async () => {
    const event = await postWaveEvent(workspace, { type: "guidance", payload: {} });

    // Should not throw even without resolution
    const result = await resolveWaveEvent({
      workspace,
      event_id: event.id,
      action: "apply",
    });

    expect(result.action).toBe("apply");
  });

  it("pending_count decrements after applying an event", async () => {
    const event1 = await postWaveEvent(workspace, { type: "guidance", payload: {} });
    await postWaveEvent(workspace, { type: "pause", payload: {} });

    // Two pending events initially. After applying event1, should be 1.
    const result = await resolveWaveEvent({
      workspace,
      event_id: event1.id,
      action: "apply",
    });

    expect(result.pending_count).toBe(1);
  });

  it("accepts a resolution object when applying", async () => {
    const event = await postWaveEvent(workspace, { type: "add_task", payload: { description: "task" } });

    const result = await resolveWaveEvent({
      workspace,
      event_id: event.id,
      action: "apply",
      resolution: { plan_id: "plan-01", tasks: ["a", "b"] },
    });

    expect(result.action).toBe("apply");
  });
});

// ---------------------------------------------------------------------------
// 3. Reject action
// ---------------------------------------------------------------------------

describe("reject action", () => {
  it("marks event rejected with reason and returns the event_id", async () => {
    const event = await postWaveEvent(workspace, { type: "add_task", payload: {} });

    const result = await resolveWaveEvent({
      workspace,
      event_id: event.id,
      action: "reject",
      reason: "Not relevant for this wave",
    });

    expect(result.event_id).toBe(event.id);
    expect(result.action).toBe("reject");
  });

  it("throws if reason is missing when action is reject", async () => {
    const event = await postWaveEvent(workspace, { type: "add_task", payload: {} });

    await expect(
      resolveWaveEvent({ workspace, event_id: event.id, action: "reject" }),
    ).rejects.toThrow("reason is required when action is reject");
  });

  it("returns agents from resolveEventAgents even for reject", async () => {
    const event = await postWaveEvent(workspace, { type: "add_task", payload: {} });

    const result = await resolveWaveEvent({
      workspace,
      event_id: event.id,
      action: "reject",
      reason: "Not needed",
    });

    // add_task still returns canon-architect even on reject
    expect(result.agents).toEqual(["canon-architect"]);
  });

  it("pending_count decrements after rejecting an event", async () => {
    const event1 = await postWaveEvent(workspace, { type: "guidance", payload: {} });
    await postWaveEvent(workspace, { type: "pause", payload: {} });

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
// 4. Validation: unknown event, already-applied/rejected
// ---------------------------------------------------------------------------

describe("validation", () => {
  it("throws on unknown event_id", async () => {
    await expect(
      resolveWaveEvent({ workspace, event_id: "evt_does_not_exist", action: "apply" }),
    ).rejects.toThrow("Event not found: evt_does_not_exist");
  });

  it("throws on already-applied event", async () => {
    const event = await postWaveEvent(workspace, { type: "guidance", payload: {} });

    // Apply it once
    await resolveWaveEvent({ workspace, event_id: event.id, action: "apply" });

    // Attempt to apply again — should throw
    await expect(
      resolveWaveEvent({ workspace, event_id: event.id, action: "apply" }),
    ).rejects.toThrow(`Event ${event.id} is already applied`);
  });

  it("throws on already-rejected event", async () => {
    const event = await postWaveEvent(workspace, { type: "guidance", payload: {} });

    // Reject it once
    await resolveWaveEvent({ workspace, event_id: event.id, action: "reject", reason: "nope" });

    // Attempt to resolve again — should throw
    await expect(
      resolveWaveEvent({ workspace, event_id: event.id, action: "apply" }),
    ).rejects.toThrow(`Event ${event.id} is already rejected`);
  });
});

// ---------------------------------------------------------------------------
// 5. Event bus emission and listener cleanup
// ---------------------------------------------------------------------------

describe("event bus emission and listener cleanup", () => {
  it("emits wave_event_resolved with correct fields", async () => {
    const event = await postWaveEvent(workspace, { type: "add_task", payload: { description: "Bus test" } });
    const emitSpy = vi.spyOn(flowEventBus, "emit");

    await resolveWaveEvent({ workspace, event_id: event.id, action: "apply" });

    const emittedCall = emitSpy.mock.calls.find(
      ([eventName]) => eventName === "wave_event_resolved",
    );
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
    const event = await postWaveEvent(workspace, { type: "guidance", payload: {} });
    const emitSpy = vi.spyOn(flowEventBus, "emit");

    await resolveWaveEvent({ workspace, event_id: event.id, action: "reject", reason: "not needed" });

    const emittedCall = emitSpy.mock.calls.find(
      ([eventName]) => eventName === "wave_event_resolved",
    );
    expect(emittedCall).toBeDefined();
    const payload = emittedCall![1] as { action: string };
    expect(payload.action).toBe("reject");
  });

  it("registers a once listener before emitting", async () => {
    const event = await postWaveEvent(workspace, { type: "guidance", payload: {} });
    const onceSpy = vi.spyOn(flowEventBus, "once");
    const emitSpy = vi.spyOn(flowEventBus, "emit");

    await resolveWaveEvent({ workspace, event_id: event.id, action: "apply" });

    const onceCall = onceSpy.mock.calls.find(([name]) => name === "wave_event_resolved");
    expect(onceCall).toBeDefined();

    const emitCallIndex = emitSpy.mock.calls.findIndex(
      ([name]) => name === "wave_event_resolved",
    );
    const onceCallIndex =
      onceSpy.mock.invocationCallOrder[
        onceSpy.mock.calls.findIndex(([name]) => name === "wave_event_resolved")
      ];
    const emitCallOrder = emitSpy.mock.invocationCallOrder[emitCallIndex];

    // once must be registered before emit fires
    expect(onceCallIndex).toBeLessThan(emitCallOrder);
  });

  it("removes the once listener after the call (no lingering listeners)", async () => {
    const event = await postWaveEvent(workspace, { type: "guidance", payload: {} });
    const removeListenerSpy = vi.spyOn(flowEventBus, "removeListener");

    await resolveWaveEvent({ workspace, event_id: event.id, action: "apply" });

    const removalCall = removeListenerSpy.mock.calls.find(
      ([name]) => name === "wave_event_resolved",
    );
    expect(removalCall).toBeDefined();
  });

  it("removes the once listener in the finally block even when emit throws", async () => {
    const event = await postWaveEvent(workspace, { type: "guidance", payload: {} });
    const removeListenerSpy = vi.spyOn(flowEventBus, "removeListener");

    // Make emit throw synchronously for wave_event_resolved only
    vi.spyOn(flowEventBus, "emit").mockImplementationOnce((eventName: string) => {
      if (eventName === "wave_event_resolved") {
        throw new Error("Simulated emit failure");
      }
      return false;
    });

    await expect(
      resolveWaveEvent({ workspace, event_id: event.id, action: "apply" }),
    ).rejects.toThrow("Simulated emit failure");

    // removeListener must still have been called in the finally block
    const removalCall = removeListenerSpy.mock.calls.find(
      ([name]) => name === "wave_event_resolved",
    );
    expect(removalCall).toBeDefined();
  });
});
