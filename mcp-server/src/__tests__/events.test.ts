import { describe, it, expect } from "vitest";
import {
  createMetricsAccumulator,
} from "../orchestration/events.ts";

describe("createMetricsAccumulator", () => {
  it("tracks spawns on agent_spawned events", () => {
    const { handler, getMetrics } = createMetricsAccumulator();

    handler("agent_spawned", {
      stateId: "build",
      agent: "implementor",
      model: "opus",
      timestamp: "2026-03-22T00:00:00Z",
    });
    handler("agent_spawned", {
      stateId: "build",
      agent: "tester",
      model: "sonnet",
      timestamp: "2026-03-22T00:00:01Z",
    });
    handler("agent_spawned", {
      stateId: "review",
      agent: "reviewer",
      model: "opus",
      timestamp: "2026-03-22T00:00:02Z",
    });

    const metrics = getMetrics();
    expect(metrics.totalSpawns).toBe(3);
    expect(metrics.perState["build"].spawns).toBe(2);
    expect(metrics.perState["review"].spawns).toBe(1);
  });

  it("tracks duration on state_completed events", () => {
    const { handler, getMetrics } = createMetricsAccumulator();

    handler("state_completed", {
      stateId: "build",
      result: "DONE",
      duration_ms: 5000,
      artifacts: [],
      timestamp: "2026-03-22T00:00:05Z",
    });
    handler("state_completed", {
      stateId: "review",
      result: "DONE",
      duration_ms: 3000,
      artifacts: ["review.md"],
      timestamp: "2026-03-22T00:00:08Z",
    });

    const metrics = getMetrics();
    expect(metrics.totalDuration).toBe(8000);
    expect(metrics.perState["build"].duration_ms).toBe(5000);
    expect(metrics.perState["review"].duration_ms).toBe(3000);
  });

  it("ignores unrelated event types", () => {
    const { handler, getMetrics } = createMetricsAccumulator();

    handler("flow_started", {
      flowName: "epic",
      task: "build feature",
      tier: "t2",
      workspace: "/tmp/ws",
      timestamp: "2026-03-22T00:00:00Z",
    });

    const metrics = getMetrics();
    expect(metrics.totalSpawns).toBe(0);
    expect(metrics.totalDuration).toBe(0);
    expect(Object.keys(metrics.perState)).toHaveLength(0);
  });
});
