import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, access } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { injectWaveEvent } from "../tools/inject-wave-event.ts";
import { flowEventBus } from "../orchestration/event-bus-instance.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

async function writeBoard(workspace: string, board: unknown): Promise<void> {
  await writeFile(join(workspace, "board.json"), JSON.stringify(board, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "canon-inject-wave-event-"));
  // Write a valid board with one state in_progress + wave set (happy path default)
  await writeBoard(workspace, makeBoard());
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. withBoardLock — acquisition and release
// ---------------------------------------------------------------------------

describe("withBoardLock acquisition and release", () => {
  it("releases the lock after a successful call (no .lock file remains)", async () => {
    await injectWaveEvent({
      workspace,
      type: "guidance",
      payload: { context: "Test guidance" },
    });

    // Lock file must be gone after a successful call
    await expect(access(join(workspace, ".lock"))).rejects.toThrow();
  });

  it("releases the lock even when an error is thrown (no .lock file remains)", async () => {
    // Board with no active wave — triggers the guard error
    await writeBoard(workspace, makeBoard({ states: { research: { status: "pending", entries: 0 } } }));

    await expect(
      injectWaveEvent({ workspace, type: "guidance", payload: {} }),
    ).rejects.toThrow("No active wave state found");

    // Lock must still be released
    await expect(access(join(workspace, ".lock"))).rejects.toThrow();
  });

  it("creates the lock file during callback execution", async () => {
    let lockExistedDuringCall = false;

    // Spy on postWaveEvent to check lock presence at call time
    const { postWaveEvent } = await import("../orchestration/wave-events.ts");
    vi.spyOn(
      await import("../orchestration/wave-events.ts"),
      "postWaveEvent",
    ).mockImplementationOnce(async (...args) => {
      try {
        await access(join(workspace, ".lock"));
        lockExistedDuringCall = true;
      } catch {
        // lock not present
      }
      return postWaveEvent(...args);
    });

    await injectWaveEvent({ workspace, type: "guidance", payload: { context: "check lock" } });
    expect(lockExistedDuringCall).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Active-wave guard
// ---------------------------------------------------------------------------

describe("active-wave guard", () => {
  it("throws when states object is empty", async () => {
    await writeBoard(workspace, makeBoard({ states: {} }));

    await expect(
      injectWaveEvent({ workspace, type: "add_task", payload: { description: "New task" } }),
    ).rejects.toThrow("No active wave state found");
  });

  it("throws when states exist but none are in_progress", async () => {
    await writeBoard(
      workspace,
      makeBoard({
        states: {
          research: { status: "done", entries: 1, wave: 1 },
          implement: { status: "pending", entries: 0, wave: 2 },
        },
      }),
    );

    await expect(
      injectWaveEvent({ workspace, type: "guidance", payload: {} }),
    ).rejects.toThrow("No active wave state found");
  });

  it("throws when a state is in_progress but has no wave field", async () => {
    await writeBoard(
      workspace,
      makeBoard({
        states: {
          implement: { status: "in_progress", entries: 1 },
          // no wave field
        },
      }),
    );

    await expect(
      injectWaveEvent({ workspace, type: "skip_task", payload: { task_id: "task-01" } }),
    ).rejects.toThrow("No active wave state found");
  });

  it("succeeds when exactly one state has both wave set and status in_progress", async () => {
    // Default board fixture has exactly this — should not throw
    await expect(
      injectWaveEvent({ workspace, type: "guidance", payload: { context: "ok" } }),
    ).resolves.toBeDefined();
  });

  it("succeeds when multiple states exist but only one satisfies the guard", async () => {
    await writeBoard(
      workspace,
      makeBoard({
        states: {
          research: { status: "done", entries: 1 },
          implement: { status: "in_progress", entries: 1, wave: 2 },
          review: { status: "pending", entries: 0 },
        },
      }),
    );

    await expect(
      injectWaveEvent({ workspace, type: "inject_context", payload: { context: "ctx" } }),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Event posting and result shape
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
    // First call — 1 pending event
    const result1 = await injectWaveEvent({
      workspace,
      type: "guidance",
      payload: { context: "first" },
    });
    expect(result1.pending_count).toBe(1);

    // Second call — 2 pending events
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
});

// ---------------------------------------------------------------------------
// 4. Event bus emission and listener cleanup
// ---------------------------------------------------------------------------

describe("event bus emission and listener cleanup", () => {
  it("emits wave_event_injected with correct fields", async () => {
    const emitSpy = vi.spyOn(flowEventBus, "emit");

    const result = await injectWaveEvent({
      workspace,
      type: "add_task",
      payload: { description: "Bus test" },
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
      workspace,
      type: "guidance",
      payload: { context: "listener order check" },
    });

    // Find the once call for wave_event_injected
    const onceCall = onceSpy.mock.calls.find(([name]) => name === "wave_event_injected");
    expect(onceCall).toBeDefined();

    // Find the emit call for wave_event_injected
    const emitCallIndex = emitSpy.mock.calls.findIndex(
      ([name]) => name === "wave_event_injected",
    );
    const onceCallIndex = onceSpy.mock.invocationCallOrder[
      onceSpy.mock.calls.findIndex(([name]) => name === "wave_event_injected")
    ];
    const emitCallOrder = emitSpy.mock.invocationCallOrder[emitCallIndex];

    // once must be registered before emit fires
    expect(onceCallIndex).toBeLessThan(emitCallOrder);
  });

  it("removes the once listener after the call (no lingering listeners)", async () => {
    const removeListenerSpy = vi.spyOn(flowEventBus, "removeListener");

    await injectWaveEvent({
      workspace,
      type: "inject_context",
      payload: { context: "cleanup check" },
    });

    const removalCall = removeListenerSpy.mock.calls.find(
      ([name]) => name === "wave_event_injected",
    );
    expect(removalCall).toBeDefined();
  });

  it("removes the once listener in the finally block even when emit throws", async () => {
    // The finally block that calls removeListener wraps only the emit call.
    // Verify that if emit throws synchronously, the listener is still removed.
    const removeListenerSpy = vi.spyOn(flowEventBus, "removeListener");

    // Make emit throw synchronously for wave_event_injected only
    vi.spyOn(flowEventBus, "emit").mockImplementationOnce((eventName: string) => {
      if (eventName === "wave_event_injected") {
        throw new Error("Simulated emit failure");
      }
      return false;
    });

    await expect(
      injectWaveEvent({ workspace, type: "pause", payload: {} }),
    ).rejects.toThrow("Simulated emit failure");

    // removeListener must still have been called in the finally block
    const removalCall = removeListenerSpy.mock.calls.find(
      ([name]) => name === "wave_event_injected",
    );
    expect(removalCall).toBeDefined();
  });
});
