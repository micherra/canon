/**
 * Integration tests — wave event lifecycle
 *
 * These tests exercise the full cross-tool flow:
 *   inject_wave_event → get_messages(include_events) → resolve_wave_event
 *
 * They are distinct from the unit tests in resolve-wave-event.test.ts and
 * inject-wave-event.test.ts, which test each tool in isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { injectWaveEvent } from "../tools/inject-wave-event.ts";
import { resolveWaveEvent } from "../tools/resolve-wave-event.ts";
import { getMessages } from "../tools/get-messages.ts";
import { getExecutionStore } from "../orchestration/execution-store.ts";
import type { WaveEvent } from "../orchestration/flow-schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedStore(workspace: string): void {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();
  store.initExecution({
    flow: "test-flow",
    task: "Integration test task",
    entry: "implement",
    current_state: "implement",
    base_commit: "abc1234",
    started: now,
    last_updated: now,
    branch: "main",
    sanitized: "integration-test-task",
    created: now,
    tier: "small",
    flow_name: "test-flow",
    slug: "integration-test-task",
    status: "active",
  });
  store.upsertState("implement", {
    status: "in_progress",
    entries: 1,
    wave: 1,
  });
}

function readPendingEvents(workspace: string): WaveEvent[] {
  return getExecutionStore(workspace).getWaveEvents({ status: "pending" });
}

function readAllEvents(workspace: string): WaveEvent[] {
  return getExecutionStore(workspace).getWaveEvents();
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "canon-wave-lifecycle-"));
  seedStore(workspace);
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. End-to-end lifecycle: inject → pending → resolve → no longer pending
// ---------------------------------------------------------------------------

describe("end-to-end lifecycle: inject → resolve → pending drops to zero", () => {
  it("event appears in pending list after inject and disappears after apply", async () => {
    const injected = await injectWaveEvent({
      workspace,
      type: "add_task",
      payload: { description: "New integration task" },
    });

    // Event must be in pending list after inject
    const pendingBefore = readPendingEvents(workspace);
    expect(pendingBefore).toHaveLength(1);
    expect(pendingBefore[0].id).toBe(injected.event.id);
    expect(pendingBefore[0].status).toBe("pending");

    await resolveWaveEvent({
      workspace,
      event_id: injected.event.id,
      action: "apply",
    });

    // Event must no longer appear in pending list after resolve
    const pendingAfter = readPendingEvents(workspace);
    expect(pendingAfter).toHaveLength(0);
  });

  it("event appears in pending list after inject and disappears after reject", async () => {
    const injected = await injectWaveEvent({
      workspace,
      type: "guidance",
      payload: { context: "Please reconsider the approach" },
    });

    const pendingBefore = readPendingEvents(workspace);
    expect(pendingBefore).toHaveLength(1);

    await resolveWaveEvent({
      workspace,
      event_id: injected.event.id,
      action: "reject",
      reason: "Out of scope",
    });

    const pendingAfter = readPendingEvents(workspace);
    expect(pendingAfter).toHaveLength(0);
  });

  it("resolveWaveEvent pending_count matches readPendingEvents length after mixed resolutions", async () => {
    // Inject 3 events
    const e1 = await injectWaveEvent({ workspace, type: "add_task", payload: { description: "Task A" } });
    const e2 = await injectWaveEvent({ workspace, type: "skip_task", payload: { task_id: "task-02" } });
    const e3 = await injectWaveEvent({ workspace, type: "guidance", payload: { context: "Clarification" } });

    // Apply first event
    const result1 = await resolveWaveEvent({ workspace, event_id: e1.event.id, action: "apply" });
    expect(result1.pending_count).toBe(2);

    // Verify matches actual pending state
    const actualPending2 = readPendingEvents(workspace);
    expect(actualPending2).toHaveLength(2);

    // Reject second event
    const result2 = await resolveWaveEvent({
      workspace,
      event_id: e2.event.id,
      action: "reject",
      reason: "Task already handled",
    });
    expect(result2.pending_count).toBe(1);

    const actualPending1 = readPendingEvents(workspace);
    expect(actualPending1).toHaveLength(1);
    expect(actualPending1[0].id).toBe(e3.event.id);
  });
});

// ---------------------------------------------------------------------------
// 2. cross-tool: inject → get_messages(include_events) → resolve
// ---------------------------------------------------------------------------

describe("cross-tool: inject + get_messages(include_events) + resolve", () => {
  it("get_messages reflects pending events from inject, then zero after resolve", async () => {
    // Inject two events
    const e1 = await injectWaveEvent({ workspace, type: "add_task", payload: { description: "Task B" } });
    const e2 = await injectWaveEvent({ workspace, type: "pause", payload: {} });

    // Messages with include_events should list both pending events
    const resultBefore = await getMessages({ workspace, channel: "wave-001", include_events: true });
    expect(resultBefore.events).toBeDefined();
    expect(resultBefore.events_count).toBe(2);
    const eventIds = resultBefore.events!.map((e) => e.id);
    expect(eventIds).toContain(e1.event.id);
    expect(eventIds).toContain(e2.event.id);
    expect(resultBefore.events!.every((e) => e.status === "pending")).toBe(true);

    // Resolve both events
    await resolveWaveEvent({ workspace, event_id: e1.event.id, action: "apply" });
    await resolveWaveEvent({ workspace, event_id: e2.event.id, action: "reject", reason: "Pausing deferred" });

    // Messages should now report no pending events
    const resultAfter = await getMessages({ workspace, channel: "wave-001", include_events: true });
    expect(resultAfter.events_count).toBe(0);
    expect(resultAfter.events).toEqual([]);
  });

  it("get_messages without include_events never includes event fields", async () => {
    await injectWaveEvent({ workspace, type: "guidance", payload: { context: "Some guidance" } });

    const result = await getMessages({ workspace, channel: "wave-001" });
    expect(result.events).toBeUndefined();
    expect(result.events_count).toBeUndefined();
  });

  it("get_messages events field only returns pending events, not resolved ones", async () => {
    const e1 = await injectWaveEvent({ workspace, type: "add_task", payload: { description: "Keep pending" } });
    const e2 = await injectWaveEvent({ workspace, type: "skip_task", payload: { task_id: "t1" } });

    // Resolve only e2
    await resolveWaveEvent({ workspace, event_id: e2.event.id, action: "apply" });

    const result = await getMessages({ workspace, channel: "wave-001", include_events: true });
    expect(result.events_count).toBe(1);
    expect(result.events![0].id).toBe(e1.event.id);
    expect(result.events![0].status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// 3. Concurrent resolution: second resolve on the same event must fail
// ---------------------------------------------------------------------------

describe("concurrent resolution: double-resolve on the same event", () => {
  it("second resolve throws 'already applied' when both calls are apply", async () => {
    const injected = await injectWaveEvent({
      workspace,
      type: "add_task",
      payload: { description: "Race condition test" },
    });

    // First resolve succeeds
    await resolveWaveEvent({ workspace, event_id: injected.event.id, action: "apply" });

    // Second resolve must throw, not silently succeed
    await expect(resolveWaveEvent({ workspace, event_id: injected.event.id, action: "apply" })).rejects.toThrow(
      `Event ${injected.event.id} is already applied`,
    );
  });

  it("second resolve throws 'already rejected' when first rejected and second tries to apply", async () => {
    const injected = await injectWaveEvent({
      workspace,
      type: "guidance",
      payload: { context: "Race condition reject" },
    });

    await resolveWaveEvent({
      workspace,
      event_id: injected.event.id,
      action: "reject",
      reason: "Not applicable",
    });

    await expect(resolveWaveEvent({ workspace, event_id: injected.event.id, action: "apply" })).rejects.toThrow(
      `Event ${injected.event.id} is already rejected`,
    );
  });

  it("concurrent Promise.all calls — exactly one succeeds and one rejects", async () => {
    const injected = await injectWaveEvent({
      workspace,
      type: "reprioritize",
      payload: { task_id: "task-01", wave: 2 },
    });

    // Fire two resolve calls simultaneously — board lock ensures only one can proceed
    const results = await Promise.allSettled([
      resolveWaveEvent({ workspace, event_id: injected.event.id, action: "apply" }),
      resolveWaveEvent({ workspace, event_id: injected.event.id, action: "apply" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // After the race, only one final state in the events file
    const all = readAllEvents(workspace);
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("applied");
  });
});

// ---------------------------------------------------------------------------
// 4. Resolution data persists to the events file
// ---------------------------------------------------------------------------

describe("resolution data persisted to events file after apply", () => {
  it("applied event has applied_at timestamp in the JSONL file", async () => {
    const injected = await injectWaveEvent({
      workspace,
      type: "add_task",
      payload: { description: "Persist test" },
    });

    const before = new Date().toISOString();
    await resolveWaveEvent({ workspace, event_id: injected.event.id, action: "apply" });

    const all = readAllEvents(workspace);
    const resolved = all.find((e) => e.id === injected.event.id)!;
    expect(resolved.status).toBe("applied");
    expect(resolved.applied_at).toBeDefined();
    expect(new Date(resolved.applied_at!).getTime()).not.toBeNaN();
    expect(resolved.applied_at! >= before).toBe(true);
  });

  it("applied event stores the resolution object when provided", async () => {
    const injected = await injectWaveEvent({
      workspace,
      type: "add_task",
      payload: { description: "Resolution object test" },
    });

    const resolution = { plan_id: "plan-03", tasks: ["impl-01", "impl-02"], summary: "Planned" };

    await resolveWaveEvent({
      workspace,
      event_id: injected.event.id,
      action: "apply",
      resolution,
    });

    const all = readAllEvents(workspace);
    const resolved = all.find((e) => e.id === injected.event.id)!;
    expect(resolved.resolution).toEqual(resolution);
  });

  it("rejected event has rejection_reason in the JSONL file", async () => {
    const injected = await injectWaveEvent({
      workspace,
      type: "guidance",
      payload: { context: "Reject persist test" },
    });

    await resolveWaveEvent({
      workspace,
      event_id: injected.event.id,
      action: "reject",
      reason: "Does not apply to this wave",
    });

    const all = readAllEvents(workspace);
    const resolved = all.find((e) => e.id === injected.event.id)!;
    expect(resolved.status).toBe("rejected");
    expect(resolved.rejection_reason).toBe("Does not apply to this wave");
  });

  it("resolving one event does not mutate other events in the file", async () => {
    const e1 = await injectWaveEvent({ workspace, type: "add_task", payload: { description: "Mutate guard" } });
    const e2 = await injectWaveEvent({ workspace, type: "pause", payload: {} });
    const e3 = await injectWaveEvent({ workspace, type: "skip_task", payload: { task_id: "task-05" } });

    await resolveWaveEvent({ workspace, event_id: e2.event.id, action: "apply" });

    const all = readAllEvents(workspace);
    const ev1 = all.find((e) => e.id === e1.event.id)!;
    const ev3 = all.find((e) => e.id === e3.event.id)!;

    expect(ev1.status).toBe("pending");
    expect(ev3.status).toBe("pending");
    expect(ev1.applied_at).toBeUndefined();
    expect(ev3.applied_at).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Agent routing end-to-end: event type → correct agents in resolve result
// ---------------------------------------------------------------------------

describe("agent routing: resolveEventAgents contract via resolveWaveEvent", () => {
  it("add_task event resolves to canon-architect via full inject+resolve path", async () => {
    const injected = await injectWaveEvent({
      workspace,
      type: "add_task",
      payload: { description: "Agent routing test" },
    });

    const result = await resolveWaveEvent({
      workspace,
      event_id: injected.event.id,
      action: "apply",
    });

    expect(result.agents).toEqual(["canon-architect"]);
    expect(result.descriptions["canon-architect"]).toBeDefined();
    expect(typeof result.descriptions["canon-architect"]).toBe("string");
    expect(result.descriptions["canon-architect"].length).toBeGreaterThan(0);
  });

  it("guidance event resolves to empty agents via full inject+resolve path", async () => {
    const injected = await injectWaveEvent({
      workspace,
      type: "guidance",
      payload: { context: "Please use a more functional approach" },
    });

    const result = await resolveWaveEvent({
      workspace,
      event_id: injected.event.id,
      action: "apply",
    });

    expect(result.agents).toEqual([]);
    expect(result.descriptions).toEqual({});
  });

  it("pause event resolves to empty agents and reject also returns empty agents", async () => {
    const injected = await injectWaveEvent({
      workspace,
      type: "pause",
      payload: {},
    });

    const result = await resolveWaveEvent({
      workspace,
      event_id: injected.event.id,
      action: "reject",
      reason: "Will not pause now",
    });

    expect(result.agents).toEqual([]);
    expect(result.descriptions).toEqual({});
  });

  it("inject_context event resolves to empty agents", async () => {
    const injected = await injectWaveEvent({
      workspace,
      type: "inject_context",
      payload: { context: "Additional context for implementors" },
    });

    const result = await resolveWaveEvent({
      workspace,
      event_id: injected.event.id,
      action: "apply",
    });

    expect(result.agents).toEqual([]);
  });

  it("skip_task event resolves to empty agents", async () => {
    const injected = await injectWaveEvent({
      workspace,
      type: "skip_task",
      payload: { task_id: "task-07" },
    });

    const result = await resolveWaveEvent({
      workspace,
      event_id: injected.event.id,
      action: "apply",
    });

    expect(result.agents).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. Return shape contract
// ---------------------------------------------------------------------------

describe("resolveWaveEvent return shape contract", () => {
  it("result always contains event_id, action, agents, descriptions, pending_count", async () => {
    const injected = await injectWaveEvent({
      workspace,
      type: "reprioritize",
      payload: { task_id: "task-03", wave: 2 },
    });

    const result = await resolveWaveEvent({
      workspace,
      event_id: injected.event.id,
      action: "apply",
    });

    expect(result.event_id).toBe(injected.event.id);
    expect(result.action).toBe("apply");
    expect(Array.isArray(result.agents)).toBe(true);
    expect(typeof result.descriptions).toBe("object");
    expect(typeof result.pending_count).toBe("number");
  });

  it("event_id in result matches the event_id passed in", async () => {
    const injected = await injectWaveEvent({
      workspace,
      type: "guidance",
      payload: { context: "Shape contract test" },
    });

    const result = await resolveWaveEvent({
      workspace,
      event_id: injected.event.id,
      action: "reject",
      reason: "Noted but deferred",
    });

    expect(result.event_id).toBe(injected.event.id);
    expect(result.action).toBe("reject");
  });
});
