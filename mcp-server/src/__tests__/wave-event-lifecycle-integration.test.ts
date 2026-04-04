/**
 * Integration tests — wave event lifecycle
 *
 * These tests exercise the full cross-tool flow:
 *   inject_wave_event → get_messages(include_events) → resolve_wave_event
 *
 * They are distinct from the unit tests in resolve-wave-event.test.ts and
 * inject-wave-event.test.ts, which test each tool in isolation.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getExecutionStore } from "../orchestration/execution-store.ts";
import type { WaveEvent } from "../orchestration/flow-schema.ts";
import { getMessages } from "../tools/get-messages.ts";
import { injectWaveEvent } from "../tools/inject-wave-event.ts";
import { resolveWaveEvent } from "../tools/resolve-wave-event.ts";

function seedStore(workspace: string): void {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();
  store.initExecution({
    base_commit: "abc1234",
    branch: "main",
    created: now,
    current_state: "implement",
    entry: "implement",
    flow: "test-flow",
    flow_name: "test-flow",
    last_updated: now,
    sanitized: "integration-test-task",
    slug: "integration-test-task",
    started: now,
    status: "active",
    task: "Integration test task",
    tier: "small",
  });
  store.upsertState("implement", {
    entries: 1,
    status: "in_progress",
    wave: 1,
  });
}

function readPendingEvents(workspace: string): WaveEvent[] {
  return getExecutionStore(workspace).getWaveEvents({ status: "pending" });
}

function readAllEvents(workspace: string): WaveEvent[] {
  return getExecutionStore(workspace).getWaveEvents();
}

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "canon-wave-lifecycle-"));
  seedStore(workspace);
});

afterEach(async () => {
  await rm(workspace, { force: true, recursive: true });
});

// 1. End-to-end lifecycle: inject → pending → resolve → no longer pending

describe("end-to-end lifecycle: inject → resolve → pending drops to zero", () => {
  it("event appears in pending list after inject and disappears after apply", async () => {
    const injected = await injectWaveEvent({
      payload: { description: "New integration task" },
      type: "add_task",
      workspace,
    });

    // Event must be in pending list after inject
    const pendingBefore = readPendingEvents(workspace);
    expect(pendingBefore).toHaveLength(1);
    expect(pendingBefore[0].id).toBe(injected.event.id);
    expect(pendingBefore[0].status).toBe("pending");

    await resolveWaveEvent({
      action: "apply",
      event_id: injected.event.id,
      workspace,
    });

    // Event must no longer appear in pending list after resolve
    const pendingAfter = readPendingEvents(workspace);
    expect(pendingAfter).toHaveLength(0);
  });

  it("event appears in pending list after inject and disappears after reject", async () => {
    const injected = await injectWaveEvent({
      payload: { context: "Please reconsider the approach" },
      type: "guidance",
      workspace,
    });

    const pendingBefore = readPendingEvents(workspace);
    expect(pendingBefore).toHaveLength(1);

    await resolveWaveEvent({
      action: "reject",
      event_id: injected.event.id,
      reason: "Out of scope",
      workspace,
    });

    const pendingAfter = readPendingEvents(workspace);
    expect(pendingAfter).toHaveLength(0);
  });

  it("resolveWaveEvent pending_count matches readPendingEvents length after mixed resolutions", async () => {
    // Inject 3 events
    const e1 = await injectWaveEvent({
      payload: { description: "Task A" },
      type: "add_task",
      workspace,
    });
    const e2 = await injectWaveEvent({
      payload: { task_id: "task-02" },
      type: "skip_task",
      workspace,
    });
    const e3 = await injectWaveEvent({
      payload: { context: "Clarification" },
      type: "guidance",
      workspace,
    });

    // Apply first event
    const result1 = await resolveWaveEvent({ action: "apply", event_id: e1.event.id, workspace });
    expect(result1.pending_count).toBe(2);

    // Verify matches actual pending state
    const actualPending2 = readPendingEvents(workspace);
    expect(actualPending2).toHaveLength(2);

    // Reject second event
    const result2 = await resolveWaveEvent({
      action: "reject",
      event_id: e2.event.id,
      reason: "Task already handled",
      workspace,
    });
    expect(result2.pending_count).toBe(1);

    const actualPending1 = readPendingEvents(workspace);
    expect(actualPending1).toHaveLength(1);
    expect(actualPending1[0].id).toBe(e3.event.id);
  });
});

// 2. cross-tool: inject → get_messages(include_events) → resolve

describe("cross-tool: inject + get_messages(include_events) + resolve", () => {
  it("get_messages reflects pending events from inject, then zero after resolve", async () => {
    // Inject two events
    const e1 = await injectWaveEvent({
      payload: { description: "Task B" },
      type: "add_task",
      workspace,
    });
    const e2 = await injectWaveEvent({ payload: {}, type: "pause", workspace });

    // Messages with include_events should list both pending events
    const resultBefore = await getMessages({
      channel: "wave-001",
      include_events: true,
      workspace,
    });
    expect(resultBefore.events).toBeDefined();
    expect(resultBefore.events_count).toBe(2);
    const eventIds = resultBefore.events!.map((e) => e.id);
    expect(eventIds).toContain(e1.event.id);
    expect(eventIds).toContain(e2.event.id);
    expect(resultBefore.events!.every((e) => e.status === "pending")).toBe(true);

    // Resolve both events
    await resolveWaveEvent({ action: "apply", event_id: e1.event.id, workspace });
    await resolveWaveEvent({
      action: "reject",
      event_id: e2.event.id,
      reason: "Pausing deferred",
      workspace,
    });

    // Messages should now report no pending events
    const resultAfter = await getMessages({ channel: "wave-001", include_events: true, workspace });
    expect(resultAfter.events_count).toBe(0);
    expect(resultAfter.events).toEqual([]);
  });

  it("get_messages without include_events never includes event fields", async () => {
    await injectWaveEvent({ payload: { context: "Some guidance" }, type: "guidance", workspace });

    const result = await getMessages({ channel: "wave-001", workspace });
    expect(result.events).toBeUndefined();
    expect(result.events_count).toBeUndefined();
  });

  it("get_messages events field only returns pending events, not resolved ones", async () => {
    const e1 = await injectWaveEvent({
      payload: { description: "Keep pending" },
      type: "add_task",
      workspace,
    });
    const e2 = await injectWaveEvent({ payload: { task_id: "t1" }, type: "skip_task", workspace });

    // Resolve only e2
    await resolveWaveEvent({ action: "apply", event_id: e2.event.id, workspace });

    const result = await getMessages({ channel: "wave-001", include_events: true, workspace });
    expect(result.events_count).toBe(1);
    expect(result.events![0].id).toBe(e1.event.id);
    expect(result.events![0].status).toBe("pending");
  });
});

// 3. Concurrent resolution: second resolve on the same event must fail

describe("concurrent resolution: double-resolve on the same event", () => {
  it("second resolve throws 'already applied' when both calls are apply", async () => {
    const injected = await injectWaveEvent({
      payload: { description: "Race condition test" },
      type: "add_task",
      workspace,
    });

    // First resolve succeeds
    await resolveWaveEvent({ action: "apply", event_id: injected.event.id, workspace });

    // Second resolve must throw, not silently succeed
    await expect(
      resolveWaveEvent({ action: "apply", event_id: injected.event.id, workspace }),
    ).rejects.toThrow(`Event ${injected.event.id} is already applied`);
  });

  it("second resolve throws 'already rejected' when first rejected and second tries to apply", async () => {
    const injected = await injectWaveEvent({
      payload: { context: "Race condition reject" },
      type: "guidance",
      workspace,
    });

    await resolveWaveEvent({
      action: "reject",
      event_id: injected.event.id,
      reason: "Not applicable",
      workspace,
    });

    await expect(
      resolveWaveEvent({ action: "apply", event_id: injected.event.id, workspace }),
    ).rejects.toThrow(`Event ${injected.event.id} is already rejected`);
  });

  it("concurrent Promise.all calls — exactly one succeeds and one rejects", async () => {
    const injected = await injectWaveEvent({
      payload: { task_id: "task-01", wave: 2 },
      type: "reprioritize",
      workspace,
    });

    // Fire two resolve calls simultaneously — board lock ensures only one can proceed
    const results = await Promise.allSettled([
      resolveWaveEvent({ action: "apply", event_id: injected.event.id, workspace }),
      resolveWaveEvent({ action: "apply", event_id: injected.event.id, workspace }),
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

// 4. Resolution data persists to the events file

describe("resolution data persisted to events file after apply", () => {
  it("applied event has applied_at timestamp in the JSONL file", async () => {
    const injected = await injectWaveEvent({
      payload: { description: "Persist test" },
      type: "add_task",
      workspace,
    });

    const before = new Date().toISOString();
    await resolveWaveEvent({ action: "apply", event_id: injected.event.id, workspace });

    const all = readAllEvents(workspace);
    const resolved = all.find((e) => e.id === injected.event.id)!;
    expect(resolved.status).toBe("applied");
    expect(resolved.applied_at).toBeDefined();
    expect(new Date(resolved.applied_at!).getTime()).not.toBeNaN();
    expect(resolved.applied_at! >= before).toBe(true);
  });

  it("applied event stores the resolution object when provided", async () => {
    const injected = await injectWaveEvent({
      payload: { description: "Resolution object test" },
      type: "add_task",
      workspace,
    });

    const resolution = { plan_id: "plan-03", summary: "Planned", tasks: ["impl-01", "impl-02"] };

    await resolveWaveEvent({
      action: "apply",
      event_id: injected.event.id,
      resolution,
      workspace,
    });

    const all = readAllEvents(workspace);
    const resolved = all.find((e) => e.id === injected.event.id)!;
    expect(resolved.resolution).toEqual(resolution);
  });

  it("rejected event has rejection_reason in the JSONL file", async () => {
    const injected = await injectWaveEvent({
      payload: { context: "Reject persist test" },
      type: "guidance",
      workspace,
    });

    await resolveWaveEvent({
      action: "reject",
      event_id: injected.event.id,
      reason: "Does not apply to this wave",
      workspace,
    });

    const all = readAllEvents(workspace);
    const resolved = all.find((e) => e.id === injected.event.id)!;
    expect(resolved.status).toBe("rejected");
    expect(resolved.rejection_reason).toBe("Does not apply to this wave");
  });

  it("resolving one event does not mutate other events in the file", async () => {
    const e1 = await injectWaveEvent({
      payload: { description: "Mutate guard" },
      type: "add_task",
      workspace,
    });
    const e2 = await injectWaveEvent({ payload: {}, type: "pause", workspace });
    const e3 = await injectWaveEvent({
      payload: { task_id: "task-05" },
      type: "skip_task",
      workspace,
    });

    await resolveWaveEvent({ action: "apply", event_id: e2.event.id, workspace });

    const all = readAllEvents(workspace);
    const ev1 = all.find((e) => e.id === e1.event.id)!;
    const ev3 = all.find((e) => e.id === e3.event.id)!;

    expect(ev1.status).toBe("pending");
    expect(ev3.status).toBe("pending");
    expect(ev1.applied_at).toBeUndefined();
    expect(ev3.applied_at).toBeUndefined();
  });
});

// 5. Agent routing end-to-end: event type → correct agents in resolve result

describe("agent routing: resolveEventAgents contract via resolveWaveEvent", () => {
  it("add_task event resolves to canon-architect via full inject+resolve path", async () => {
    const injected = await injectWaveEvent({
      payload: { description: "Agent routing test" },
      type: "add_task",
      workspace,
    });

    const result = await resolveWaveEvent({
      action: "apply",
      event_id: injected.event.id,
      workspace,
    });

    expect(result.agents).toEqual(["canon-architect"]);
    expect(result.descriptions["canon-architect"]).toBeDefined();
    expect(typeof result.descriptions["canon-architect"]).toBe("string");
    expect(result.descriptions["canon-architect"].length).toBeGreaterThan(0);
  });

  it("guidance event resolves to empty agents via full inject+resolve path", async () => {
    const injected = await injectWaveEvent({
      payload: { context: "Please use a more functional approach" },
      type: "guidance",
      workspace,
    });

    const result = await resolveWaveEvent({
      action: "apply",
      event_id: injected.event.id,
      workspace,
    });

    expect(result.agents).toEqual([]);
    expect(result.descriptions).toEqual({});
  });

  it("pause event resolves to empty agents and reject also returns empty agents", async () => {
    const injected = await injectWaveEvent({
      payload: {},
      type: "pause",
      workspace,
    });

    const result = await resolveWaveEvent({
      action: "reject",
      event_id: injected.event.id,
      reason: "Will not pause now",
      workspace,
    });

    expect(result.agents).toEqual([]);
    expect(result.descriptions).toEqual({});
  });

  it("inject_context event resolves to empty agents", async () => {
    const injected = await injectWaveEvent({
      payload: { context: "Additional context for implementors" },
      type: "inject_context",
      workspace,
    });

    const result = await resolveWaveEvent({
      action: "apply",
      event_id: injected.event.id,
      workspace,
    });

    expect(result.agents).toEqual([]);
  });

  it("skip_task event resolves to empty agents", async () => {
    const injected = await injectWaveEvent({
      payload: { task_id: "task-07" },
      type: "skip_task",
      workspace,
    });

    const result = await resolveWaveEvent({
      action: "apply",
      event_id: injected.event.id,
      workspace,
    });

    expect(result.agents).toEqual([]);
  });
});

// 6. Return shape contract

describe("resolveWaveEvent return shape contract", () => {
  it("result always contains event_id, action, agents, descriptions, pending_count", async () => {
    const injected = await injectWaveEvent({
      payload: { task_id: "task-03", wave: 2 },
      type: "reprioritize",
      workspace,
    });

    const result = await resolveWaveEvent({
      action: "apply",
      event_id: injected.event.id,
      workspace,
    });

    expect(result.event_id).toBe(injected.event.id);
    expect(result.action).toBe("apply");
    expect(Array.isArray(result.agents)).toBe(true);
    expect(typeof result.descriptions).toBe("object");
    expect(typeof result.pending_count).toBe("number");
  });

  it("event_id in result matches the event_id passed in", async () => {
    const injected = await injectWaveEvent({
      payload: { context: "Shape contract test" },
      type: "guidance",
      workspace,
    });

    const result = await resolveWaveEvent({
      action: "reject",
      event_id: injected.event.id,
      reason: "Noted but deferred",
      workspace,
    });

    expect(result.event_id).toBe(injected.event.id);
    expect(result.action).toBe("reject");
  });
});
