import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FlowEventBus,
  createMetricsAccumulator,
  createJsonlLogger,
} from "../orchestration/events.js";
import type { FlowEventMap } from "../orchestration/events.js";

describe("FlowEventBus", () => {
  let bus: FlowEventBus;

  beforeEach(() => {
    bus = new FlowEventBus();
  });

  it("emits and receives state_entered events", () => {
    const received: FlowEventMap["state_entered"][] = [];
    bus.on("state_entered", (event) => received.push(event));

    const event: FlowEventMap["state_entered"] = {
      stateId: "review",
      stateType: "agent",
      timestamp: "2026-03-22T00:00:00Z",
      iterationCount: 1,
    };
    bus.emit("state_entered", event);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(event);
  });

  it("emits and receives agent_spawned events", () => {
    const received: FlowEventMap["agent_spawned"][] = [];
    bus.on("agent_spawned", (event) => received.push(event));

    bus.emit("agent_spawned", {
      stateId: "build",
      agent: "canon-implementor",
      role: "builder",
      model: "opus",
      timestamp: "2026-03-22T00:00:01Z",
    });

    expect(received).toHaveLength(1);
    expect(received[0].agent).toBe("canon-implementor");
  });

  it("does not cross-deliver between event types", () => {
    const stateEvents: unknown[] = [];
    const spawnEvents: unknown[] = [];
    bus.on("state_entered", (e) => stateEvents.push(e));
    bus.on("agent_spawned", (e) => spawnEvents.push(e));

    bus.emit("state_entered", {
      stateId: "s1",
      stateType: "agent",
      timestamp: "2026-03-22T00:00:00Z",
      iterationCount: 0,
    });

    expect(stateEvents).toHaveLength(1);
    expect(spawnEvents).toHaveLength(0);
  });
});

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
      flowName: "deep-build",
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

describe("createJsonlLogger", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "canon-events-test-"));
  });

  it("writes valid JSON lines to log.jsonl", async () => {
    const workspace = join(tmpDir, "workspace");
    const logger = createJsonlLogger(workspace);

    await logger("flow_started", {
      flowName: "deep-build",
      task: "implement feature",
      tier: "t2",
      workspace,
      timestamp: "2026-03-22T00:00:00Z",
    });

    await logger("agent_spawned", {
      stateId: "build",
      agent: "implementor",
      model: "opus",
      timestamp: "2026-03-22T00:00:01Z",
    });

    const content = readFileSync(join(workspace, "log.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    expect(first.type).toBe("flow_started");
    expect(first.timestamp).toBe("2026-03-22T00:00:00Z");
    expect(first.flowName).toBe("deep-build");

    const second = JSON.parse(lines[1]);
    expect(second.type).toBe("agent_spawned");
    expect(second.agent).toBe("implementor");

    rmSync(tmpDir, { recursive: true });
  });

  it("appends multiple entries to the same file", async () => {
    const workspace = join(tmpDir, "ws2");
    const logger = createJsonlLogger(workspace);

    for (let i = 0; i < 5; i++) {
      await logger("board_updated", {
        action: `update-${i}`,
        timestamp: `2026-03-22T00:00:0${i}Z`,
      });
    }

    const content = readFileSync(join(workspace, "log.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(5);

    lines.forEach((line, i) => {
      const parsed = JSON.parse(line);
      expect(parsed.action).toBe(`update-${i}`);
      expect(parsed.type).toBe("board_updated");
    });

    rmSync(tmpDir, { recursive: true });
  });
});
