import { describe, expect, it } from "vitest";
import { EventPayloadSchemas, validateEventPayload } from "../orchestration/events.ts";

// ---------------------------------------------------------------------------
// Type-level check: stuck_detected is in FlowEventType
// ---------------------------------------------------------------------------
// This test verifies the union at runtime by checking the schema map.

describe("FlowEventType — stuck_detected", () => {
  it("includes stuck_detected in EventPayloadSchemas keys", () => {
    expect("stuck_detected" in EventPayloadSchemas).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// EventPayloadSchemas — each event type has a schema matching its shape
// ---------------------------------------------------------------------------

describe("EventPayloadSchemas", () => {
  it("state_entered schema validates correct payload", () => {
    const result = EventPayloadSchemas.state_entered.safeParse({
      stateId: "build",
      stateType: "implementation",
      timestamp: "2026-04-01T00:00:00Z",
      iterationCount: 1,
    });
    expect(result.success).toBe(true);
  });

  it("state_entered schema validates with optional correlation_id", () => {
    const result = EventPayloadSchemas.state_entered.safeParse({
      stateId: "build",
      stateType: "implementation",
      timestamp: "2026-04-01T00:00:00Z",
      iterationCount: 1,
      correlation_id: "corr-abc-123",
    });
    expect(result.success).toBe(true);
  });

  it("state_completed schema validates correct payload", () => {
    const result = EventPayloadSchemas.state_completed.safeParse({
      stateId: "build",
      result: "DONE",
      duration_ms: 5000,
      artifacts: ["summary.md"],
      timestamp: "2026-04-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("agent_spawned schema validates correct payload", () => {
    const result = EventPayloadSchemas.agent_spawned.safeParse({
      stateId: "build",
      agent: "canon-implementor",
      model: "claude-sonnet-4-6",
      timestamp: "2026-04-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("transition_evaluated schema validates correct payload", () => {
    const result = EventPayloadSchemas.transition_evaluated.safeParse({
      stateId: "build",
      statusKeyword: "done",
      normalizedCondition: "done",
      nextState: "review",
      timestamp: "2026-04-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("hitl_triggered schema validates correct payload", () => {
    const result = EventPayloadSchemas.hitl_triggered.safeParse({
      stateId: "build",
      reason: "iteration limit exceeded",
      timestamp: "2026-04-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("flow_started schema validates correct payload", () => {
    const result = EventPayloadSchemas.flow_started.safeParse({
      flowName: "epic",
      task: "build feature",
      tier: "t2",
      workspace: "/tmp/ws",
      timestamp: "2026-04-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("flow_completed schema validates correct payload", () => {
    const result = EventPayloadSchemas.flow_completed.safeParse({
      flowName: "epic",
      task: "build feature",
      concerns: [],
      skipped: [],
      duration_ms: 12000,
      totalSpawns: 5,
      timestamp: "2026-04-01T00:00:00Z",
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
      workspace: "/tmp/ws",
      timestamp: "2026-04-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("wave_event_resolved schema validates correct payload", () => {
    const result = EventPayloadSchemas.wave_event_resolved.safeParse({
      eventId: "evt-001",
      eventType: "guidance",
      action: "apply",
      workspace: "/tmp/ws",
      timestamp: "2026-04-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("stuck_detected schema validates correct payload", () => {
    const result = EventPayloadSchemas.stuck_detected.safeParse({
      stateId: "build",
      strategy: "same_status_twice",
      reason: "Status did not change between iterations",
      iteration_count: 3,
      comparison: {
        previous: { status: "blocked" },
        current: { status: "blocked" },
      },
      timestamp: "2026-04-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// correlation_id — optional field present on all event shapes
// ---------------------------------------------------------------------------

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
      state_entered: {
        stateId: "s",
        stateType: "t",
        timestamp: "2026-01-01T00:00:00Z",
        iterationCount: 0,
        correlation_id: "c1",
      },
      state_completed: {
        stateId: "s",
        result: "DONE",
        duration_ms: 0,
        artifacts: [],
        timestamp: "2026-01-01T00:00:00Z",
        correlation_id: "c1",
      },
      agent_spawned: { stateId: "s", agent: "a", model: "m", timestamp: "2026-01-01T00:00:00Z", correlation_id: "c1" },
      transition_evaluated: {
        stateId: "s",
        statusKeyword: "done",
        normalizedCondition: "done",
        nextState: "n",
        timestamp: "2026-01-01T00:00:00Z",
        correlation_id: "c1",
      },
      hitl_triggered: { stateId: "s", reason: "r", timestamp: "2026-01-01T00:00:00Z", correlation_id: "c1" },
      flow_started: {
        flowName: "f",
        task: "t",
        tier: "t1",
        workspace: "/w",
        timestamp: "2026-01-01T00:00:00Z",
        correlation_id: "c1",
      },
      flow_completed: {
        flowName: "f",
        task: "t",
        concerns: [],
        skipped: [],
        duration_ms: 0,
        totalSpawns: 0,
        timestamp: "2026-01-01T00:00:00Z",
        correlation_id: "c1",
      },
      board_updated: { action: "a", timestamp: "2026-01-01T00:00:00Z", correlation_id: "c1" },
      wave_event_injected: {
        eventId: "e",
        eventType: "t",
        workspace: "/w",
        timestamp: "2026-01-01T00:00:00Z",
        correlation_id: "c1",
      },
      wave_event_resolved: {
        eventId: "e",
        eventType: "t",
        action: "apply",
        workspace: "/w",
        timestamp: "2026-01-01T00:00:00Z",
        correlation_id: "c1",
      },
      stuck_detected: {
        stateId: "s",
        strategy: "st",
        reason: "r",
        iteration_count: 1,
        comparison: { previous: {}, current: {} },
        timestamp: "2026-01-01T00:00:00Z",
        correlation_id: "c1",
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
      stateId: "build",
      stateType: "implementation",
      timestamp: "2026-04-01T00:00:00Z",
      iterationCount: 1,
      // no correlation_id
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateEventPayload — return-value based validation (errors-are-values)
// ---------------------------------------------------------------------------

describe("validateEventPayload", () => {
  it("returns { valid: true } for a correct state_entered payload", () => {
    const result = validateEventPayload("state_entered", {
      stateId: "build",
      stateType: "implementation",
      timestamp: "2026-04-01T00:00:00Z",
      iterationCount: 1,
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
      stateId: "build",
      stateType: "implementation",
      timestamp: "2026-04-01T00:00:00Z",
      iterationCount: "not-a-number", // should be number
    });
    expect(result.valid).toBe(false);
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it("returns { valid: true } for an unknown event type (forward-compatible)", () => {
    const result = validateEventPayload("future_event_type_unknown", {
      some: "payload",
      data: 42,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it("returns { valid: true } for a correct stuck_detected payload", () => {
    const result = validateEventPayload("stuck_detected", {
      stateId: "review",
      strategy: "no_progress",
      reason: "Output did not change",
      iteration_count: 5,
      comparison: {
        previous: { output: "same" },
        current: { output: "same" },
      },
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
    expect(() => validateEventPayload("stuck_detected", null as unknown as Record<string, unknown>)).not.toThrow();
    expect(() => validateEventPayload("unknown_type", {})).not.toThrow();
  });
});
