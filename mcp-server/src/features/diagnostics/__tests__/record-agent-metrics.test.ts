/**
 * Tests for record-agent-metrics.ts
 *
 * Covers:
 * - Writes tool_calls and turns to execution_states.metrics
 * - Merges with pre-existing metrics (e.g., duration_ms set by orchestrator)
 * - Returns INVALID_INPUT error when no metric fields provided
 * - Returns appropriate error for non-existent state_id
 * - Calling twice overwrites agent fields but preserves orchestrator fields
 * - MCP metrics schema in record_agent_metrics accepts the widened fields
 * - Optional stage dimension: namespaces counters under metrics.stage_metrics[stage],
 *   append-merges across sequential stage calls, and leaves the no-stage flat path
 *   byte-unchanged (topology C, G3)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, describe, expect, it } from "vitest";
import { recordAgentMetrics } from "../tools/record-agent-metrics.ts";

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "record-agent-metrics-test-"));
  tmpDirs.push(dir);
  return dir;
}

function setupWorkspace(workspace: string, stateId = "build"): void {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();
  store.initExecution({
    base_commit: "abc123",
    branch: "feat/test",
    created: now,
    current_state: stateId,
    entry: stateId,
    flow: "test-flow",
    flow_name: "test-flow",
    last_updated: now,
    sanitized: "feat-test",
    slug: "test-slug",
    started: now,
    task: "test task",
    tier: "medium",
  });
  store.upsertState(stateId, { entries: 1, status: "in_progress" });
}

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
});

// Basic writes

describe("recordAgentMetrics — basic writes", () => {
  it("writes tool_calls and turns to execution_states.metrics", async () => {
    const workspace = makeTmpWorkspace();
    setupWorkspace(workspace, "build");

    const result = await recordAgentMetrics({
      state_id: "build",
      tool_calls: 5,
      turns: 3,
      workspace,
    });

    assertOk(result);
    expect(result.recorded).toEqual({ tool_calls: 5, turns: 3 });

    // Verify the store was actually updated
    const store = getExecutionStore(workspace);
    const state = store.getState("build");
    expect(state).not.toBeNull();
    expect(state!.metrics).toBeDefined();
    expect(state!.metrics!.tool_calls).toBe(5);
    expect(state!.metrics!.turns).toBe(3);
  });

  it("writes orientation_calls when provided", async () => {
    const workspace = makeTmpWorkspace();
    setupWorkspace(workspace, "implement");

    const result = await recordAgentMetrics({
      orientation_calls: 8,
      state_id: "implement",
      workspace,
    });

    assertOk(result);
    expect(result.recorded).toEqual({ orientation_calls: 8 });

    const store = getExecutionStore(workspace);
    const state = store.getState("implement");
    expect(state!.metrics!.orientation_calls).toBe(8);
  });
});

// Merge with existing metrics

describe("recordAgentMetrics — merge with pre-existing metrics", () => {
  it("merges agent fields with pre-existing orchestrator metrics", async () => {
    const workspace = makeTmpWorkspace();
    setupWorkspace(workspace, "build");

    // Simulate orchestrator having set duration_ms and model
    const store = getExecutionStore(workspace);
    store.upsertState("build", {
      entries: 1,
      metrics: {
        duration_ms: 12345,
        model: "claude-sonnet",
        spawns: 1,
      },
      status: "in_progress",
    });

    // Agent now records its own metrics
    const result = await recordAgentMetrics({
      state_id: "build",
      tool_calls: 10,
      turns: 5,
      workspace,
    });

    assertOk(result);

    const state = store.getState("build");
    const metrics = state!.metrics!;

    // Orchestrator fields preserved
    expect(metrics.duration_ms).toBe(12345);
    expect(metrics.spawns).toBe(1);
    expect(metrics.model).toBe("claude-sonnet");

    // Agent fields added
    expect(metrics.tool_calls).toBe(10);
    expect(metrics.turns).toBe(5);
  });

  it("calling twice overwrites agent fields but preserves orchestrator fields", async () => {
    const workspace = makeTmpWorkspace();
    setupWorkspace(workspace, "build");

    const store = getExecutionStore(workspace);
    store.upsertState("build", {
      entries: 1,
      metrics: {
        duration_ms: 9999,
        model: "claude-opus",
        spawns: 2,
      },
      status: "in_progress",
    });

    // First call
    await recordAgentMetrics({
      state_id: "build",
      tool_calls: 3,
      turns: 2,
      workspace,
    });

    // Second call — overwrites previous agent values
    const result = await recordAgentMetrics({
      state_id: "build",
      tool_calls: 7,
      turns: 4,
      workspace,
    });

    assertOk(result);

    const state = store.getState("build");
    const metrics = state!.metrics!;

    // Orchestrator fields still intact
    expect(metrics.duration_ms).toBe(9999);
    expect(metrics.spawns).toBe(2);
    expect(metrics.model).toBe("claude-opus");

    // Latest agent values win
    expect(metrics.tool_calls).toBe(7);
    expect(metrics.turns).toBe(4);
  });
});

describe("recordAgentMetrics — validation errors", () => {
  it("returns INVALID_INPUT when no metric fields are provided", async () => {
    const workspace = makeTmpWorkspace();
    setupWorkspace(workspace, "build");

    const result = await recordAgentMetrics({
      state_id: "build",
      workspace,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("returns INVALID_INPUT for non-existent state_id", async () => {
    const workspace = makeTmpWorkspace();
    setupWorkspace(workspace, "build");

    const result = await recordAgentMetrics({
      state_id: "nonexistent_state",
      tool_calls: 5,
      workspace,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });
});

// stage dimension (topology C, G3)

describe("recordAgentMetrics — stage dimension", () => {
  it("namespaces counters under metrics.stage_metrics[stage] when stage is provided", async () => {
    const workspace = makeTmpWorkspace();
    setupWorkspace(workspace, "review");

    const result = await recordAgentMetrics({
      stage: "1.5",
      state_id: "review",
      tool_calls: 12,
      workspace,
    });

    assertOk(result);

    const store = getExecutionStore(workspace);
    const state = store.getState("review");
    expect(state!.metrics!.stage_metrics).toEqual({ "1.5": { tool_calls: 12 } });
  });

  it("two sequential stage calls both persist without clobbering", async () => {
    const workspace = makeTmpWorkspace();
    setupWorkspace(workspace, "review");

    await recordAgentMetrics({ stage: "1", state_id: "review", tool_calls: 4, workspace });
    const result = await recordAgentMetrics({
      stage: "2",
      state_id: "review",
      tool_calls: 9,
      workspace,
    });

    assertOk(result);

    const store = getExecutionStore(workspace);
    const state = store.getState("review");
    expect(state!.metrics!.stage_metrics).toEqual({
      "1": { tool_calls: 4 },
      "2": { tool_calls: 9 },
    });
  });

  it("no-stage call preserves today's flat behavior and orchestrator fields", async () => {
    const workspace = makeTmpWorkspace();
    setupWorkspace(workspace, "review");

    const store = getExecutionStore(workspace);
    store.upsertState("review", {
      entries: 1,
      metrics: { duration_ms: 5000, model: "claude-opus", spawns: 1 },
      status: "in_progress",
    });

    const result = await recordAgentMetrics({
      state_id: "review",
      tool_calls: 6,
      turns: 2,
      workspace,
    });

    assertOk(result);

    const state = store.getState("review");
    const metrics = state!.metrics!;
    expect(metrics.duration_ms).toBe(5000);
    expect(metrics.spawns).toBe(1);
    expect(metrics.model).toBe("claude-opus");
    expect(metrics.tool_calls).toBe(6);
    expect(metrics.turns).toBe(2);
    expect(metrics.stage_metrics).toBeUndefined();
  });

  it("returns INVALID_INPUT when stage is an empty string", async () => {
    const workspace = makeTmpWorkspace();
    setupWorkspace(workspace, "review");

    const result = await recordAgentMetrics({
      stage: "",
      state_id: "review",
      tool_calls: 3,
      workspace,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("still requires at least one counter field when only stage is given", async () => {
    const workspace = makeTmpWorkspace();
    setupWorkspace(workspace, "review");

    const result = await recordAgentMetrics({
      stage: "1",
      state_id: "review",
      workspace,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });
});
