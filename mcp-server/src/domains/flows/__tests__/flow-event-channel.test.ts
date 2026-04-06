/**
 * Tests for drainFlowEvents (ADR-012 / fe-02)
 *
 * Covers:
 * - Returns { effect: { type: "none" }, newWatermark: 0 } when no messages
 * - Malformed JSON is warned and skipped
 * - Malformed (valid JSON, invalid schema) is warned and skipped
 * - request_state: allowed insertion → produces insert effect
 * - request_state: not in allowed_insertions → no-op (none effect)
 * - request_state: allowed_insertions absent → no-op
 * - skip_ahead: reachable target → produces skip effect
 * - skip_ahead: unreachable target → no-op
 * - skip_ahead: target is current state → no-op (BFS from current, not yet "reached")
 * - escalate: always produces escalate effect
 * - escalate: propagates suggested_options
 * - First non-none effect wins; subsequent events are ignored for effect
 * - Watermark advances to max id seen even when all effects are none
 * - Watermark advances past the winning event id (not just first message)
 * - Multiple events, second produces the winning effect
 */

import { describe, expect, it, vi } from "vitest";
import type { FlowDefinition } from "../flow-schema.ts";
import { drainFlowEvents } from "../flow-event-channel.ts";
import type { ExecutionStore, MessageOutput } from "@domains/workspaces/execution-store.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(id: number, content: string): MessageOutput {
  return { id, channel: "flow-events", sender: "test", content, timestamp: "2026-01-01T00:00:00Z" };
}

function makeStore(
  messages: MessageOutput[],
): Pick<ExecutionStore, "getMessagesSinceId" | "appendEvent"> {
  return {
    getMessagesSinceId: vi.fn((_channel: string, _sinceId: number) => messages),
    appendEvent: vi.fn(),
  };
}

/** Minimal flow with a linear chain: start → middle → done */
function makeLinearFlow(allowedInsertions?: string[]): FlowDefinition {
  return {
    name: "test-flow",
    description: "test",
    allowed_insertions: allowedInsertions,
    states: {
      start: { type: "single", transitions: { done: "middle" } },
      middle: { type: "single", transitions: { done: "done" } },
      done: { type: "terminal" },
    },
  };
}

// ---------------------------------------------------------------------------
// No messages
// ---------------------------------------------------------------------------

describe("drainFlowEvents — no messages", () => {
  it("returns none effect and watermark 0 when channel is empty", () => {
    const store = makeStore([]);
    const result = drainFlowEvents({
      store: store as unknown as ExecutionStore,
      workspaceId: "ws1",
      currentStateId: "start",
      flowDef: makeLinearFlow(),
      watermark: 0,
    });
    expect(result.effect.type).toBe("none");
    expect(result.newWatermark).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Malformed messages
// ---------------------------------------------------------------------------

describe("drainFlowEvents — malformed messages", () => {
  it("skips invalid JSON and emits flow_event_skipped via store.appendEvent", () => {
    const store = makeStore([makeMsg(1, "not-json{{{")]);
    const result = drainFlowEvents({
      store: store as unknown as ExecutionStore,
      workspaceId: "ws1",
      currentStateId: "start",
      flowDef: makeLinearFlow(),
      watermark: 0,
    });
    expect(result.effect.type).toBe("none");
    expect(result.newWatermark).toBe(1);
    expect(store.appendEvent).toHaveBeenCalledWith(
      "flow_event_skipped",
      expect.objectContaining({ message_id: 1, reason: "invalid JSON" }),
    );
  });

  it("skips valid JSON that fails schema validation and emits flow_event_skipped via store.appendEvent", () => {
    const store = makeStore([makeMsg(2, JSON.stringify({ type: "unknown_event" }))]);
    const result = drainFlowEvents({
      store: store as unknown as ExecutionStore,
      workspaceId: "ws1",
      currentStateId: "start",
      flowDef: makeLinearFlow(),
      watermark: 0,
    });
    expect(result.effect.type).toBe("none");
    expect(result.newWatermark).toBe(2);
    expect(store.appendEvent).toHaveBeenCalledWith(
      "flow_event_skipped",
      expect.objectContaining({ message_id: 2, reason: "schema validation failed" }),
    );
  });
});

// ---------------------------------------------------------------------------
// request_state events
// ---------------------------------------------------------------------------

describe("drainFlowEvents — request_state", () => {
  it("produces insert effect when state_id is in allowed_insertions and exists in flow states", () => {
    const store = makeStore([
      makeMsg(10, JSON.stringify({ type: "request_state", state_id: "hotfix" })),
    ]);
    // hotfix must be defined in the flow's states for insert to be returned
    const flow: FlowDefinition = {
      ...makeLinearFlow(["hotfix", "patch"]),
      states: {
        ...makeLinearFlow(["hotfix", "patch"]).states,
        hotfix: { type: "single", transitions: { done: "done" } },
        patch: { type: "single", transitions: { done: "done" } },
      },
    };
    const result = drainFlowEvents({
      store: store as unknown as ExecutionStore,
      workspaceId: "ws1",
      currentStateId: "start",
      flowDef: flow,
      watermark: 0,
    });
    expect(result.effect).toEqual({ type: "insert", state_id: "hotfix" });
    expect(result.newWatermark).toBe(10);
  });

  it("returns none effect when state_id is not in allowed_insertions", () => {
    const store = makeStore([
      makeMsg(11, JSON.stringify({ type: "request_state", state_id: "not-allowed" })),
    ]);
    const flow = makeLinearFlow(["hotfix"]);
    const result = drainFlowEvents({
      store: store as unknown as ExecutionStore,
      workspaceId: "ws1",
      currentStateId: "start",
      flowDef: flow,
      watermark: 0,
    });
    expect(result.effect.type).toBe("none");
    expect(result.newWatermark).toBe(11);
  });

  it("returns none effect when allowed_insertions is absent", () => {
    const store = makeStore([
      makeMsg(12, JSON.stringify({ type: "request_state", state_id: "anything" })),
    ]);
    const flow = makeLinearFlow(undefined); // no allowed_insertions
    const result = drainFlowEvents({
      store: store as unknown as ExecutionStore,
      workspaceId: "ws1",
      currentStateId: "start",
      flowDef: flow,
      watermark: 0,
    });
    expect(result.effect.type).toBe("none");
    expect(result.newWatermark).toBe(12);
  });

  it("accepts optional reason field without error", () => {
    const store = makeStore([
      makeMsg(13, JSON.stringify({ type: "request_state", state_id: "hotfix", reason: "urgent" })),
    ]);
    const flow: FlowDefinition = {
      ...makeLinearFlow(["hotfix"]),
      states: {
        ...makeLinearFlow(["hotfix"]).states,
        hotfix: { type: "single", transitions: { done: "done" } },
      },
    };
    const result = drainFlowEvents({
      store: store as unknown as ExecutionStore,
      workspaceId: "ws1",
      currentStateId: "start",
      flowDef: flow,
      watermark: 0,
    });
    expect(result.effect).toEqual({ type: "insert", state_id: "hotfix" });
  });

  it("returns none effect when state_id is in allowed_insertions but does not exist in flow states", () => {
    // "ghost-state" is whitelisted but never defined in the flow's states map.
    // The system must not crash and must fall through to none (no actionable insert).
    const store = makeStore([
      makeMsg(14, JSON.stringify({ type: "request_state", state_id: "ghost-state" })),
    ]);
    const flow = makeLinearFlow(["ghost-state"]);
    // makeLinearFlow only defines start/middle/done — ghost-state is not in states
    const result = drainFlowEvents({
      store: store as unknown as ExecutionStore,
      workspaceId: "ws1",
      currentStateId: "start",
      flowDef: flow,
      watermark: 0,
    });
    expect(result.effect.type).toBe("none");
    expect(result.newWatermark).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// skip_ahead events
// ---------------------------------------------------------------------------

describe("drainFlowEvents — skip_ahead", () => {
  it("produces skip effect when target is reachable from currentStateId", () => {
    // start → middle → done; skip from start to done is reachable
    const store = makeStore([
      makeMsg(20, JSON.stringify({ type: "skip_ahead", target: "done", reason: "fast-path" })),
    ]);
    const result = drainFlowEvents({
      store: store as unknown as ExecutionStore,
      workspaceId: "ws1",
      currentStateId: "start",
      flowDef: makeLinearFlow(),
      watermark: 0,
    });
    expect(result.effect).toEqual({ type: "skip", target: "done", reason: "fast-path" });
    expect(result.newWatermark).toBe(20);
  });

  it("returns none effect when target is not reachable from currentStateId", () => {
    // done → start is backwards; not reachable from "done"
    const store = makeStore([
      makeMsg(21, JSON.stringify({ type: "skip_ahead", target: "start", reason: "test" })),
    ]);
    const result = drainFlowEvents({
      store: store as unknown as ExecutionStore,
      workspaceId: "ws1",
      currentStateId: "done",
      flowDef: makeLinearFlow(),
      watermark: 0,
    });
    expect(result.effect.type).toBe("none");
    expect(result.newWatermark).toBe(21);
  });

  it("returns none effect when target is current state (not forward reachable)", () => {
    // BFS from "start" over forward edges — "start" itself is not re-visited
    const store = makeStore([
      makeMsg(22, JSON.stringify({ type: "skip_ahead", target: "start", reason: "test" })),
    ]);
    const result = drainFlowEvents({
      store: store as unknown as ExecutionStore,
      workspaceId: "ws1",
      currentStateId: "start",
      flowDef: makeLinearFlow(),
      watermark: 0,
    });
    expect(result.effect.type).toBe("none");
    expect(result.newWatermark).toBe(22);
  });

  it("returns none effect when flowDef has no states", () => {
    const store = makeStore([
      makeMsg(23, JSON.stringify({ type: "skip_ahead", target: "anywhere", reason: "x" })),
    ]);
    const flow: FlowDefinition = { name: "empty", description: "empty" };
    const result = drainFlowEvents({
      store: store as unknown as ExecutionStore,
      workspaceId: "ws1",
      currentStateId: "start",
      flowDef: flow,
      watermark: 0,
    });
    expect(result.effect.type).toBe("none");
    expect(result.newWatermark).toBe(23);
  });

  it("handles branching transitions — reaches target via any path", () => {
    // Flow: start → (branch-a | branch-b) → done
    const flow: FlowDefinition = {
      name: "branching",
      description: "branching flow",
      states: {
        start: { type: "single", transitions: { a: "branch-a", b: "branch-b" } },
        "branch-a": { type: "single", transitions: { done: "done" } },
        "branch-b": { type: "single", transitions: { done: "done" } },
        done: { type: "terminal" },
      },
    };
    const store = makeStore([
      makeMsg(24, JSON.stringify({ type: "skip_ahead", target: "branch-b", reason: "prefer-b" })),
    ]);
    const result = drainFlowEvents({
      store: store as unknown as ExecutionStore,
      workspaceId: "ws1",
      currentStateId: "start",
      flowDef: flow,
      watermark: 0,
    });
    expect(result.effect).toEqual({ type: "skip", target: "branch-b", reason: "prefer-b" });
  });

  it("reaches target reachable only via on_success edge (BFS includes on_success)", () => {
    // Wave state uses on_success → cleanup; cleanup is not reachable via transitions alone.
    // on_success/on_failure are runtime-only fields not present in the TS schema type,
    // so we cast through unknown to attach them for this test.
    const flow = {
      name: "wave-with-on-success",
      description: "flow with on_success edge",
      states: {
        start: { type: "single", transitions: { next: "wave-work" } },
        "wave-work": { type: "wave", on_success: "cleanup" },
        cleanup: { type: "single", transitions: { done: "done" } },
        done: { type: "terminal" },
      },
    } as unknown as FlowDefinition;
    const store = makeStore([
      makeMsg(25, JSON.stringify({ type: "skip_ahead", target: "cleanup", reason: "skip-wave" })),
    ]);
    const result = drainFlowEvents({
      store: store as unknown as ExecutionStore,
      workspaceId: "ws1",
      currentStateId: "start",
      flowDef: flow,
      watermark: 0,
    });
    expect(result.effect).toEqual({ type: "skip", target: "cleanup", reason: "skip-wave" });
  });

  it("reaches target reachable only via on_failure edge (BFS includes on_failure)", () => {
    // Parallel state uses on_failure → rollback; rollback is not reachable via transitions alone.
    const flow = {
      name: "parallel-with-on-failure",
      description: "flow with on_failure edge",
      states: {
        start: { type: "single", transitions: { next: "parallel-work" } },
        "parallel-work": { type: "parallel", on_failure: "rollback" },
        rollback: { type: "single", transitions: { done: "done" } },
        done: { type: "terminal" },
      },
    } as unknown as FlowDefinition;
    const store = makeStore([
      makeMsg(26, JSON.stringify({ type: "skip_ahead", target: "rollback", reason: "skip-to-rollback" })),
    ]);
    const result = drainFlowEvents({
      store: store as unknown as ExecutionStore,
      workspaceId: "ws1",
      currentStateId: "start",
      flowDef: flow,
      watermark: 0,
    });
    expect(result.effect).toEqual({ type: "skip", target: "rollback", reason: "skip-to-rollback" });
  });
});

// ---------------------------------------------------------------------------
// escalate events
// ---------------------------------------------------------------------------

describe("drainFlowEvents — escalate", () => {
  it("always produces escalate effect", () => {
    const store = makeStore([
      makeMsg(30, JSON.stringify({ type: "escalate", message: "something is wrong" })),
    ]);
    const result = drainFlowEvents({
      store: store as unknown as ExecutionStore,
      workspaceId: "ws1",
      currentStateId: "start",
      flowDef: makeLinearFlow(),
      watermark: 0,
    });
    expect(result.effect).toEqual({ type: "escalate", message: "something is wrong" });
    expect(result.newWatermark).toBe(30);
  });

  it("propagates suggested_options when present", () => {
    const store = makeStore([
      makeMsg(31, JSON.stringify({
        type: "escalate",
        message: "choose one",
        suggested_options: ["option-a", "option-b"],
      })),
    ]);
    const result = drainFlowEvents({
      store: store as unknown as ExecutionStore,
      workspaceId: "ws1",
      currentStateId: "start",
      flowDef: makeLinearFlow(),
      watermark: 0,
    });
    expect(result.effect).toEqual({
      type: "escalate",
      message: "choose one",
      suggested_options: ["option-a", "option-b"],
    });
  });

  it("omits suggested_options field when absent", () => {
    const store = makeStore([
      makeMsg(32, JSON.stringify({ type: "escalate", message: "urgent" })),
    ]);
    const result = drainFlowEvents({
      store: store as unknown as ExecutionStore,
      workspaceId: "ws1",
      currentStateId: "start",
      flowDef: makeLinearFlow(),
      watermark: 0,
    });
    expect(result.effect.type).toBe("escalate");
    const effect = result.effect as { type: "escalate"; suggested_options?: string[] };
    expect(effect.suggested_options).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// First-wins logic & watermark advancement
// ---------------------------------------------------------------------------

describe("drainFlowEvents — first-wins and watermark", () => {
  it("first non-none effect wins; later events do not override it", () => {
    const store = makeStore([
      makeMsg(40, JSON.stringify({ type: "escalate", message: "first!" })),
      makeMsg(41, JSON.stringify({ type: "escalate", message: "second!" })),
    ]);
    const result = drainFlowEvents({
      store: store as unknown as ExecutionStore,
      workspaceId: "ws1",
      currentStateId: "start",
      flowDef: makeLinearFlow(),
      watermark: 0,
    });
    const effect = result.effect as { type: "escalate"; message: string };
    expect(effect.type).toBe("escalate");
    expect(effect.message).toBe("first!");
  });

  it("watermark advances to max id even when all effects are none", () => {
    const store = makeStore([
      makeMsg(50, JSON.stringify({ type: "request_state", state_id: "not-allowed" })),
      makeMsg(55, JSON.stringify({ type: "request_state", state_id: "also-not-allowed" })),
    ]);
    const flow = makeLinearFlow([]); // empty allowed_insertions
    const result = drainFlowEvents({
      store: store as unknown as ExecutionStore,
      workspaceId: "ws1",
      currentStateId: "start",
      flowDef: flow,
      watermark: 0,
    });
    expect(result.effect.type).toBe("none");
    expect(result.newWatermark).toBe(55);
  });

  it("watermark advances to max id seen even when winning event is not the last", () => {
    // First message wins (escalate), but we still see message id 61 and advance watermark
    const store = makeStore([
      makeMsg(60, JSON.stringify({ type: "escalate", message: "win" })),
      makeMsg(61, JSON.stringify({ type: "escalate", message: "lose" })),
    ]);
    const result = drainFlowEvents({
      store: store as unknown as ExecutionStore,
      workspaceId: "ws1",
      currentStateId: "start",
      flowDef: makeLinearFlow(),
      watermark: 0,
    });
    expect(result.newWatermark).toBe(61);
  });

  it("second event produces winning effect when first is no-op", () => {
    const store = makeStore([
      makeMsg(70, JSON.stringify({ type: "request_state", state_id: "not-allowed" })),
      makeMsg(71, JSON.stringify({ type: "escalate", message: "fallback-win" })),
    ]);
    const flow = makeLinearFlow([]); // empty — request_state is always no-op
    const result = drainFlowEvents({
      store: store as unknown as ExecutionStore,
      workspaceId: "ws1",
      currentStateId: "start",
      flowDef: flow,
      watermark: 0,
    });
    expect(result.effect).toEqual({ type: "escalate", message: "fallback-win" });
    expect(result.newWatermark).toBe(71);
  });

  it("passes watermark to getMessagesSinceId correctly", () => {
    const store = makeStore([]);
    const spy = store.getMessagesSinceId as ReturnType<typeof vi.fn>;
    drainFlowEvents({
      store: store as unknown as ExecutionStore,
      workspaceId: "ws1",
      currentStateId: "start",
      flowDef: makeLinearFlow(),
      watermark: 99,
    });
    expect(spy).toHaveBeenCalledWith("flow-events", 99);
  });
});
