import { describe, expect, it } from "vitest";
import { createMetricsAccumulator, validateEventPayload } from "../events.ts";

describe("validateEventPayload — cliff_detected", () => {
  const validPayload = {
    incomplete_step_ids: ["implement", "review"],
    missing_count: 2,
    needs_recovery: true,
    partial_count: 1,
    source: "resume",
    timestamp: new Date().toISOString(),
  };

  it("returns { valid: true } for a well-formed cliff_detected payload", () => {
    expect(validateEventPayload("cliff_detected", validPayload)).toEqual({ valid: true });
  });

  it("returns { valid: true } when correlation_id is present", () => {
    expect(
      validateEventPayload("cliff_detected", { ...validPayload, correlation_id: "corr-1" }),
    ).toEqual({ valid: true });
  });

  it("returns { valid: false } with errors when source is missing", () => {
    const { source, ...withoutSource } = validPayload;
    const result = validateEventPayload("cliff_detected", withoutSource);
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect((result.errors ?? []).length).toBeGreaterThan(0);
  });

  it("returns { valid: false } when needs_recovery is not the literal true", () => {
    const result = validateEventPayload("cliff_detected", {
      ...validPayload,
      needs_recovery: false,
    });
    expect(result.valid).toBe(false);
  });

  it("returns { valid: false } when source is not an allowed enum value", () => {
    const result = validateEventPayload("cliff_detected", { ...validPayload, source: "other" });
    expect(result.valid).toBe(false);
  });
});

describe("createMetricsAccumulator", () => {
  it("tracks spawns on agent_spawned events", () => {
    const { handler, getMetrics } = createMetricsAccumulator();

    handler("agent_spawned", {
      agent: "implementor",
      model: "opus",
      stateId: "build",
      timestamp: "2026-03-22T00:00:00Z",
    });
    handler("agent_spawned", {
      agent: "tester",
      model: "sonnet",
      stateId: "build",
      timestamp: "2026-03-22T00:00:01Z",
    });
    handler("agent_spawned", {
      agent: "reviewer",
      model: "opus",
      stateId: "review",
      timestamp: "2026-03-22T00:00:02Z",
    });

    const metrics = getMetrics();
    expect(metrics.totalSpawns).toBe(3);
    expect(metrics.perState.build.spawns).toBe(2);
    expect(metrics.perState.review.spawns).toBe(1);
  });

  it("tracks duration on state_completed events", () => {
    const { handler, getMetrics } = createMetricsAccumulator();

    handler("state_completed", {
      artifacts: [],
      duration_ms: 5000,
      result: "DONE",
      stateId: "build",
      timestamp: "2026-03-22T00:00:05Z",
    });
    handler("state_completed", {
      artifacts: ["review.md"],
      duration_ms: 3000,
      result: "DONE",
      stateId: "review",
      timestamp: "2026-03-22T00:00:08Z",
    });

    const metrics = getMetrics();
    expect(metrics.totalDuration).toBe(8000);
    expect(metrics.perState.build.duration_ms).toBe(5000);
    expect(metrics.perState.review.duration_ms).toBe(3000);
  });

  it("ignores unrelated event types", () => {
    const { handler, getMetrics } = createMetricsAccumulator();

    handler("flow_started", {
      flowName: "epic",
      task: "build feature",
      tier: "t2",
      timestamp: "2026-03-22T00:00:00Z",
      workspace: "/tmp/ws",
    });

    const metrics = getMetrics();
    expect(metrics.totalSpawns).toBe(0);
    expect(metrics.totalDuration).toBe(0);
    expect(Object.keys(metrics.perState)).toHaveLength(0);
  });
});
