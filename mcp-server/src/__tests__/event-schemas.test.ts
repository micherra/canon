import { describe, expect, it } from "vitest";
import { EventPayloadSchemas, validateEventPayload } from "../orchestration/events.ts";

// Type-level check: stuck_detected is in FlowEventType
// This test verifies the union at runtime by checking the schema map.

describe("FlowEventType — stuck_detected", () => {
  it("includes stuck_detected in EventPayloadSchemas keys", () => {
    expect("stuck_detected" in EventPayloadSchemas).toBe(true);
  });
});

// EventPayloadSchemas — each event type has a schema matching its shape

describe("EventPayloadSchemas", () => {
  it("state_entered schema validates correct payload", () => {
    const result = EventPayloadSchemas.state_entered.safeParse({
      iterationCount: 1,
      stateId: "build",
      stateType: "implementation",
      timestamp: "2026-04-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("state_entered schema validates with optional correlation_id", () => {
    const result = EventPayloadSchemas.state_entered.safeParse({
      correlation_id: "corr-abc-123",
      iterationCount: 1,
      stateId: "build",
      stateType: "implementation",
      timestamp: "2026-04-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("state_completed schema validates correct payload", () => {
    const result = EventPayloadSchemas.state_completed.safeParse({
      artifacts: ["summary.md"],
      duration_ms: 5000,
      result: "DONE",
      stateId: "build",
      timestamp: "2026-04-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("agent_spawned schema validates correct payload", () => {
    const result = EventPayloadSchemas.agent_spawned.safeParse({
      agent: "canon-implementor",
      model: "claude-sonnet-4-6",
      stateId: "build",
      timestamp: "2026-04-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("transition_evaluated schema validates correct payload", () => {
    const result = EventPayloadSchemas.transition_evaluated.safeParse({
      nextState: "review",
      normalizedCondition: "done",
      stateId: "build",
      statusKeyword: "done",
      timestamp: "2026-04-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("hitl_triggered schema validates correct payload", () => {
    const result = EventPayloadSchemas.hitl_triggered.safeParse({
      reason: "iteration limit exceeded",
      stateId: "build",
      timestamp: "2026-04-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("flow_started schema validates correct payload", () => {
    const result = EventPayloadSchemas.flow_started.safeParse({
      flowName: "epic",
      task: "build feature",
      tier: "t2",
      timestamp: "2026-04-01T00:00:00Z",
      workspace: "/tmp/ws",
    });
    expect(result.success).toBe(true);
  });

  it("flow_completed schema validates correct payload", () => {
    const result = EventPayloadSchemas.flow_completed.safeParse({
      concerns: [],
      duration_ms: 12000,
      flowName: "epic",
      skipped: [],
      task: "build feature",
      timestamp: "2026-04-01T00:00:00Z",
      totalSpawns: 5,
    });
    expect(result.success).toBe(true);
  });

  it("board_updated schema validates correct payload", () => {
    const result = EventPayloadSchemas.board_updated.safeParse({
      action: "enter_state",
      timestamp: "2026-04-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("wave_event_injected schema validates correct payload", () => {
    const result = EventPayloadSchemas.wave_event_injected.safeParse({
      eventId: "evt-001",
      eventType: "guidance",
      timestamp: "2026-04-01T00:00:00Z",
      workspace: "/tmp/ws",
    });
    expect(result.success).toBe(true);
  });

  it("wave_event_resolved schema validates correct payload", () => {
    const result = EventPayloadSchemas.wave_event_resolved.safeParse({
      action: "apply",
      eventId: "evt-001",
      eventType: "guidance",
      timestamp: "2026-04-01T00:00:00Z",
      workspace: "/tmp/ws",
    });
    expect(result.success).toBe(true);
  });

  it("stuck_detected schema validates correct payload", () => {
    const result = EventPayloadSchemas.stuck_detected.safeParse({
      comparison: {
        current: { status: "blocked" },
        previous: { status: "blocked" },
      },
      iteration_count: 3,
      reason: "Status did not change between iterations",
      stateId: "build",
      strategy: "same_status_twice",
      timestamp: "2026-04-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });
});

// correlation_id — optional field present on all event shapes

describe("correlation_id optional field", () => {
  const allEventTypes: Array<keyof typeof EventPayloadSchemas> = [
    "state_entered",
    "state_completed",
    "agent_spawned",
    "transition_evaluated",
    "hitl_triggered",
    "flow_started",
    "flow_completed",
    "board_updated",
    "wave_event_injected",
    "wave_event_resolved",
    "stuck_detected",
  ];

  it("each event schema accepts correlation_id as an optional string", () => {
    // Provide minimal valid payloads for each event type with correlation_id
    const minimalPayloads: Record<string, Record<string, unknown>> = {
      agent_spawned: {
        agent: "a",
        correlation_id: "c1",
        model: "m",
        stateId: "s",
        timestamp: "2026-01-01T00:00:00Z",
      },
      board_updated: { action: "a", correlation_id: "c1", timestamp: "2026-01-01T00:00:00Z" },
      flow_completed: {
        concerns: [],
        correlation_id: "c1",
        duration_ms: 0,
        flowName: "f",
        skipped: [],
        task: "t",
        timestamp: "2026-01-01T00:00:00Z",
        totalSpawns: 0,
      },
      flow_started: {
        correlation_id: "c1",
        flowName: "f",
        task: "t",
        tier: "t1",
        timestamp: "2026-01-01T00:00:00Z",
        workspace: "/w",
      },
      hitl_triggered: {
        correlation_id: "c1",
        reason: "r",
        stateId: "s",
        timestamp: "2026-01-01T00:00:00Z",
      },
      state_completed: {
        artifacts: [],
        correlation_id: "c1",
        duration_ms: 0,
        result: "DONE",
        stateId: "s",
        timestamp: "2026-01-01T00:00:00Z",
      },
      state_entered: {
        correlation_id: "c1",
        iterationCount: 0,
        stateId: "s",
        stateType: "t",
        timestamp: "2026-01-01T00:00:00Z",
      },
      stuck_detected: {
        comparison: { current: {}, previous: {} },
        correlation_id: "c1",
        iteration_count: 1,
        reason: "r",
        stateId: "s",
        strategy: "st",
        timestamp: "2026-01-01T00:00:00Z",
      },
      transition_evaluated: {
        correlation_id: "c1",
        nextState: "n",
        normalizedCondition: "done",
        stateId: "s",
        statusKeyword: "done",
        timestamp: "2026-01-01T00:00:00Z",
      },
      wave_event_injected: {
        correlation_id: "c1",
        eventId: "e",
        eventType: "t",
        timestamp: "2026-01-01T00:00:00Z",
        workspace: "/w",
      },
      wave_event_resolved: {
        action: "apply",
        correlation_id: "c1",
        eventId: "e",
        eventType: "t",
        timestamp: "2026-01-01T00:00:00Z",
        workspace: "/w",
      },
    };

    for (const eventType of allEventTypes) {
      const payload = minimalPayloads[eventType];
      const result = EventPayloadSchemas[eventType].safeParse(payload);
      expect(result.success, `${eventType} should accept correlation_id`).toBe(true);
    }
  });

  it("each event schema accepts payloads without correlation_id (field is optional)", () => {
    // Verify that correlation_id is not required (already tested implicitly above,
    // but explicit test for clarity)
    const result = EventPayloadSchemas.state_entered.safeParse({
      iterationCount: 1,
      stateId: "build",
      stateType: "implementation",
      timestamp: "2026-04-01T00:00:00Z",
      // no correlation_id
    });
    expect(result.success).toBe(true);
  });
});

// validateEventPayload — return-value based validation (errors-are-values)

describe("validateEventPayload", () => {
  it("returns { valid: true } for a correct state_entered payload", () => {
    const result = validateEventPayload("state_entered", {
      iterationCount: 1,
      stateId: "build",
      stateType: "implementation",
      timestamp: "2026-04-01T00:00:00Z",
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it("returns { valid: false, errors } when a required field is missing", () => {
    const result = validateEventPayload("state_entered", {
      // missing stateId, stateType, iterationCount
      timestamp: "2026-04-01T00:00:00Z",
    });
    expect(result.valid).toBe(false);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it("returns { valid: false, errors } for wrong field type", () => {
    const result = validateEventPayload("state_entered", {
      iterationCount: "not-a-number", // should be number
      stateId: "build",
      stateType: "implementation",
      timestamp: "2026-04-01T00:00:00Z",
    });
    expect(result.valid).toBe(false);
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it("returns { valid: true } for an unknown event type (forward-compatible)", () => {
    const result = validateEventPayload("future_event_type_unknown", {
      data: 42,
      some: "payload",
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it("returns { valid: true } for a correct stuck_detected payload", () => {
    const result = validateEventPayload("stuck_detected", {
      comparison: {
        current: { output: "same" },
        previous: { output: "same" },
      },
      iteration_count: 5,
      reason: "Output did not change",
      stateId: "review",
      strategy: "no_progress",
      timestamp: "2026-04-01T00:00:00Z",
    });
    expect(result.valid).toBe(true);
  });

  it("returns { valid: false, errors } for stuck_detected with wrong shape (Risk #2 regression)", () => {
    const result = validateEventPayload("stuck_detected", {
      stateId: "review",
      // missing strategy, reason, iteration_count, comparison, timestamp
    });
    expect(result.valid).toBe(false);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it("does not throw for any input — always returns a value (errors-are-values)", () => {
    expect(() => validateEventPayload("state_entered", {})).not.toThrow();
    expect(() =>
      validateEventPayload("stuck_detected", null as unknown as Record<string, unknown>),
    ).not.toThrow();
    expect(() => validateEventPayload("unknown_type", {})).not.toThrow();
  });
});
