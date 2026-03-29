import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMetricsAccumulator,
  createJsonlLogger,
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

describe("createJsonlLogger", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "canon-events-test-"));
  });

  it("writes valid JSON lines to log.jsonl", async () => {
    const workspace = join(tmpDir, "workspace");
    const logger = createJsonlLogger(workspace);

    await logger("flow_started", {
      flowName: "epic",
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
    expect(first.flowName).toBe("epic");

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
