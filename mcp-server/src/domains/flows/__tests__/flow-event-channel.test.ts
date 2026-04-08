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

import type { ExecutionStore, MessageOutput } from "@domains/workspaces/execution-store.ts";
import { describe, expect, it, vi } from "vitest";
import type { FlowDefinition } from "../flow-definition-schemas.ts";
import { drainFlowEvents } from "../flow-event-channel.ts";

function makeMsg(id: number, content: string): MessageOutput {
  return { channel: "flow-events", content, id, sender: "test", timestamp: "2026-01-01T00:00:00Z" };
}

function makeStore(
  messages: MessageOutput[],
): Pick<ExecutionStore, "getMessagesSinceId" | "appendEvent"> {
  return {
    appendEvent: vi.fn(),
    getMessagesSinceId: vi.fn((_channel: string, _sinceId: number) => messages),
  };
}

/** Minimal flow with a linear chain: start → middle → done */
function makeLinearFlow(allowedInsertions?: string[]): FlowDefinition {
  return {
    allowed_insertions: allowedInsertions,
    description: "test",
    name: "test-flow",
    states: {
      done: { type: "terminal" },
      middle: { transitions: { done: "done" }, type: "single" },
      start: { transitions: { done: "middle" }, type: "single" },
    },
  };
}

describe("drainFlowEvents — no messages", () => {
  it("returns none effect and watermark 0 when channel is empty", () => {
    const store = makeStore([]);
    const result = drainFlowEvents({
      currentStateId: "start",
      flowDef: makeLinearFlow(),
      store: store,
      watermark: 0,
    });
    expect(result.effect.type).toBe("none");
    expect(result.newWatermark).toBe(0);
  });
});

describe("drainFlowEvents — malformed messages", () => {
  it("skips invalid JSON and emits flow_event_skipped via store.appendEvent", () => {
    const store = makeStore([makeMsg(1, "not-json{{{")]);
    const result = drainFlowEvents({
      currentStateId: "start",
      flowDef: makeLinearFlow(),
      store: store,
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
      currentStateId: "start",
      flowDef: makeLinearFlow(),
      store: store,
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

describe("drainFlowEvents — request_state", () => {
  it("produces insert effect when state_id is in allowed_insertions and exists in flow states", () => {
    const store = makeStore([
      makeMsg(10, JSON.stringify({ state_id: "hotfix", type: "request_state" })),
    ]);
    // hotfix must be defined in the flow's states for insert to be returned
    const flow: FlowDefinition = {
      ...makeLinearFlow(["hotfix", "patch"]),
      states: {
        ...makeLinearFlow(["hotfix", "patch"]).states,
        hotfix: { transitions: { done: "done" }, type: "single" },
        patch: { transitions: { done: "done" }, type: "single" },
      },
    };
    const result = drainFlowEvents({
      currentStateId: "start",
      flowDef: flow,
      store: store,
      watermark: 0,
    });
    expect(result.effect).toEqual({ state_id: "hotfix", type: "insert" });
    expect(result.newWatermark).toBe(10);
  });

  it("returns none effect when state_id is not in allowed_insertions", () => {
    const store = makeStore([
      makeMsg(11, JSON.stringify({ state_id: "not-allowed", type: "request_state" })),
    ]);
    const flow = makeLinearFlow(["hotfix"]);
    const result = drainFlowEvents({
      currentStateId: "start",
      flowDef: flow,
      store: store,
      watermark: 0,
    });
    expect(result.effect.type).toBe("none");
    expect(result.newWatermark).toBe(11);
  });

  it("returns none effect when allowed_insertions is absent", () => {
    const store = makeStore([
      makeMsg(12, JSON.stringify({ state_id: "anything", type: "request_state" })),
    ]);
    const flow = makeLinearFlow(undefined); // no allowed_insertions
    const result = drainFlowEvents({
      currentStateId: "start",
      flowDef: flow,
      store: store,
      watermark: 0,
    });
    expect(result.effect.type).toBe("none");
    expect(result.newWatermark).toBe(12);
  });

  it("accepts optional reason field without error", () => {
    const store = makeStore([
      makeMsg(13, JSON.stringify({ reason: "urgent", state_id: "hotfix", type: "request_state" })),
    ]);
    const flow: FlowDefinition = {
      ...makeLinearFlow(["hotfix"]),
      states: {
        ...makeLinearFlow(["hotfix"]).states,
        hotfix: { transitions: { done: "done" }, type: "single" },
      },
    };
    const result = drainFlowEvents({
      currentStateId: "start",
      flowDef: flow,
      store: store,
      watermark: 0,
    });
    expect(result.effect).toEqual({ state_id: "hotfix", type: "insert" });
  });

  it("returns none effect when state_id is in allowed_insertions but does not exist in flow states", () => {
    // "ghost-state" is whitelisted but never defined in the flow's states map.
    // The system must not crash and must fall through to none (no actionable insert).
    const store = makeStore([
      makeMsg(14, JSON.stringify({ state_id: "ghost-state", type: "request_state" })),
    ]);
    const flow = makeLinearFlow(["ghost-state"]);
    // makeLinearFlow only defines start/middle/done — ghost-state is not in states
    const result = drainFlowEvents({
      currentStateId: "start",
      flowDef: flow,
      store: store,
      watermark: 0,
    });
    expect(result.effect.type).toBe("none");
    expect(result.newWatermark).toBe(14);
  });
});

describe("drainFlowEvents — skip_ahead", () => {
  it("produces skip effect when target is reachable from currentStateId", () => {
    // start → middle → done; skip from start to done is reachable
    const store = makeStore([
      makeMsg(20, JSON.stringify({ reason: "fast-path", target: "done", type: "skip_ahead" })),
    ]);
    const result = drainFlowEvents({
      currentStateId: "start",
      flowDef: makeLinearFlow(),
      store: store,
      watermark: 0,
    });
    expect(result.effect).toEqual({ reason: "fast-path", target: "done", type: "skip" });
    expect(result.newWatermark).toBe(20);
  });

  it("returns none effect when target is not reachable from currentStateId", () => {
    // done → start is backwards; not reachable from "done"
    const store = makeStore([
      makeMsg(21, JSON.stringify({ reason: "test", target: "start", type: "skip_ahead" })),
    ]);
    const result = drainFlowEvents({
      currentStateId: "done",
      flowDef: makeLinearFlow(),
      store: store,
      watermark: 0,
    });
    expect(result.effect.type).toBe("none");
    expect(result.newWatermark).toBe(21);
  });

  it("returns none effect when target is current state (not forward reachable)", () => {
    // BFS from "start" over forward edges — "start" itself is not re-visited
    const store = makeStore([
      makeMsg(22, JSON.stringify({ reason: "test", target: "start", type: "skip_ahead" })),
    ]);
    const result = drainFlowEvents({
      currentStateId: "start",
      flowDef: makeLinearFlow(),
      store: store,
      watermark: 0,
    });
    expect(result.effect.type).toBe("none");
    expect(result.newWatermark).toBe(22);
  });

  it("returns none effect when flowDef has no states", () => {
    const store = makeStore([
      makeMsg(23, JSON.stringify({ reason: "x", target: "anywhere", type: "skip_ahead" })),
    ]);
    const flow: FlowDefinition = { description: "empty", name: "empty" };
    const result = drainFlowEvents({
      currentStateId: "start",
      flowDef: flow,
      store: store,
      watermark: 0,
    });
    expect(result.effect.type).toBe("none");
    expect(result.newWatermark).toBe(23);
  });

  it("handles branching transitions — reaches target via any path", () => {
    // Flow: start → (branch-a | branch-b) → done
    const flow: FlowDefinition = {
      description: "branching flow",
      name: "branching",
      states: {
        "branch-a": { transitions: { done: "done" }, type: "single" },
        "branch-b": { transitions: { done: "done" }, type: "single" },
        done: { type: "terminal" },
        start: { transitions: { a: "branch-a", b: "branch-b" }, type: "single" },
      },
    };
    const store = makeStore([
      makeMsg(24, JSON.stringify({ reason: "prefer-b", target: "branch-b", type: "skip_ahead" })),
    ]);
    const result = drainFlowEvents({
      currentStateId: "start",
      flowDef: flow,
      store: store,
      watermark: 0,
    });
    expect(result.effect).toEqual({ reason: "prefer-b", target: "branch-b", type: "skip" });
  });

  it("reaches target reachable only via on_success edge (BFS includes on_success)", () => {
    // Wave state uses on_success → cleanup; cleanup is not reachable via transitions alone.
    // on_success/on_failure are runtime-only fields not present in the TS schema type,
    // so we cast through unknown to attach them for this test.
    const flow = {
      description: "flow with on_success edge",
      name: "wave-with-on-success",
      states: {
        cleanup: { transitions: { done: "done" }, type: "single" },
        done: { type: "terminal" },
        start: { transitions: { next: "wave-work" }, type: "single" },
        "wave-work": { on_success: "cleanup", type: "wave" },
      },
    } as unknown as FlowDefinition;
    const store = makeStore([
      makeMsg(25, JSON.stringify({ reason: "skip-wave", target: "cleanup", type: "skip_ahead" })),
    ]);
    const result = drainFlowEvents({
      currentStateId: "start",
      flowDef: flow,
      store: store,
      watermark: 0,
    });
    expect(result.effect).toEqual({ reason: "skip-wave", target: "cleanup", type: "skip" });
  });

  it("reaches target reachable only via on_failure edge (BFS includes on_failure)", () => {
    // Parallel state uses on_failure → rollback; rollback is not reachable via transitions alone.
    const flow = {
      description: "flow with on_failure edge",
      name: "parallel-with-on-failure",
      states: {
        done: { type: "terminal" },
        "parallel-work": { on_failure: "rollback", type: "parallel" },
        rollback: { transitions: { done: "done" }, type: "single" },
        start: { transitions: { next: "parallel-work" }, type: "single" },
      },
    } as unknown as FlowDefinition;
    const store = makeStore([
      makeMsg(
        26,
        JSON.stringify({ reason: "skip-to-rollback", target: "rollback", type: "skip_ahead" }),
      ),
    ]);
    const result = drainFlowEvents({
      currentStateId: "start",
      flowDef: flow,
      store: store,
      watermark: 0,
    });
    expect(result.effect).toEqual({ reason: "skip-to-rollback", target: "rollback", type: "skip" });
  });
});

describe("drainFlowEvents — escalate", () => {
  it("always produces escalate effect", () => {
    const store = makeStore([
      makeMsg(30, JSON.stringify({ message: "something is wrong", type: "escalate" })),
    ]);
    const result = drainFlowEvents({
      currentStateId: "start",
      flowDef: makeLinearFlow(),
      store: store,
      watermark: 0,
    });
    expect(result.effect).toEqual({ message: "something is wrong", type: "escalate" });
    expect(result.newWatermark).toBe(30);
  });

  it("propagates suggested_options when present", () => {
    const store = makeStore([
      makeMsg(
        31,
        JSON.stringify({
          message: "choose one",
          suggested_options: ["option-a", "option-b"],
          type: "escalate",
        }),
      ),
    ]);
    const result = drainFlowEvents({
      currentStateId: "start",
      flowDef: makeLinearFlow(),
      store: store,
      watermark: 0,
    });
    expect(result.effect).toEqual({
      message: "choose one",
      suggested_options: ["option-a", "option-b"],
      type: "escalate",
    });
  });

  it("omits suggested_options field when absent", () => {
    const store = makeStore([makeMsg(32, JSON.stringify({ message: "urgent", type: "escalate" }))]);
    const result = drainFlowEvents({
      currentStateId: "start",
      flowDef: makeLinearFlow(),
      store: store,
      watermark: 0,
    });
    expect(result.effect.type).toBe("escalate");
    const effect = result.effect as { type: "escalate"; suggested_options?: string[] };
    expect(effect.suggested_options).toBeUndefined();
  });
});

describe("drainFlowEvents — first-wins and watermark", () => {
  it("first non-none effect wins; later events do not override it", () => {
    const store = makeStore([
      makeMsg(40, JSON.stringify({ message: "first!", type: "escalate" })),
      makeMsg(41, JSON.stringify({ message: "second!", type: "escalate" })),
    ]);
    const result = drainFlowEvents({
      currentStateId: "start",
      flowDef: makeLinearFlow(),
      store: store,
      watermark: 0,
    });
    const effect = result.effect as { type: "escalate"; message: string };
    expect(effect.type).toBe("escalate");
    expect(effect.message).toBe("first!");
  });

  it("watermark advances to max id even when all effects are none", () => {
    const store = makeStore([
      makeMsg(50, JSON.stringify({ state_id: "not-allowed", type: "request_state" })),
      makeMsg(55, JSON.stringify({ state_id: "also-not-allowed", type: "request_state" })),
    ]);
    const flow = makeLinearFlow([]); // empty allowed_insertions
    const result = drainFlowEvents({
      currentStateId: "start",
      flowDef: flow,
      store: store,
      watermark: 0,
    });
    expect(result.effect.type).toBe("none");
    expect(result.newWatermark).toBe(55);
  });

  it("watermark advances to max id seen even when winning event is not the last", () => {
    // First message wins (escalate), but we still see message id 61 and advance watermark
    const store = makeStore([
      makeMsg(60, JSON.stringify({ message: "win", type: "escalate" })),
      makeMsg(61, JSON.stringify({ message: "lose", type: "escalate" })),
    ]);
    const result = drainFlowEvents({
      currentStateId: "start",
      flowDef: makeLinearFlow(),
      store: store,
      watermark: 0,
    });
    expect(result.newWatermark).toBe(61);
  });

  it("second event produces winning effect when first is no-op", () => {
    const store = makeStore([
      makeMsg(70, JSON.stringify({ state_id: "not-allowed", type: "request_state" })),
      makeMsg(71, JSON.stringify({ message: "fallback-win", type: "escalate" })),
    ]);
    const flow = makeLinearFlow([]); // empty — request_state is always no-op
    const result = drainFlowEvents({
      currentStateId: "start",
      flowDef: flow,
      store: store,
      watermark: 0,
    });
    expect(result.effect).toEqual({ message: "fallback-win", type: "escalate" });
    expect(result.newWatermark).toBe(71);
  });

  it("passes watermark to getMessagesSinceId correctly", () => {
    const store = makeStore([]);
    const spy = store.getMessagesSinceId as ReturnType<typeof vi.fn>;
    drainFlowEvents({
      currentStateId: "start",
      flowDef: makeLinearFlow(),
      store: store,
      watermark: 99,
    });
    expect(spy).toHaveBeenCalledWith("flow-events", 99);
  });
});
