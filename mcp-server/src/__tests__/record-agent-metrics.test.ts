/**
 * Tests for record-agent-metrics.ts
 *
 * Covers:
 * - Writes tool_calls and turns to execution_states.metrics
 * - Merges with pre-existing metrics (e.g., duration_ms set by orchestrator)
 * - Returns INVALID_INPUT error when no metric fields provided
 * - Returns appropriate error for non-existent state_id
 * - Calling twice overwrites agent fields but preserves orchestrator fields
 * - MCP metrics schema in report_result accepts the widened fields
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearStoreCache, getExecutionStore } from "../orchestration/execution-store.ts";
import { recordAgentMetrics } from "../tools/record-agent-metrics.ts";
import { assertOk } from "../utils/tool-result.ts";

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

// MCP schema widening — report_result accepts widened fields

describe("MCP metrics schema widening", () => {
  it("reportResult metrics schema accepts widened agent performance fields", async () => {
    // This test verifies that the Zod schema in index.ts accepts the new fields.
    // We test this indirectly by calling reportResult with the new fields and
    // confirming it succeeds rather than throwing a Zod validation error.
    // The actual behavior test is in the broadened schema acceptance.
    const { reportResult } = await import("../tools/report-result.ts");
    const { getExecutionStore: getStore, clearStoreCache: clearCache } = await import(
      "../orchestration/execution-store.ts"
    );

    const ws = makeTmpWorkspace();
    const store = getStore(ws);
    const now = new Date().toISOString();
    store.initExecution({
      base_commit: "abc123",
      branch: "feat/test",
      created: now,
      current_state: "build",
      entry: "build",
      flow: "test-flow",
      flow_name: "test-flow",
      last_updated: now,
      sanitized: "feat-test",
      slug: "test-slug",
      started: now,
      task: "test task",
      tier: "medium",
    });
    store.upsertState("build", { entries: 1, status: "in_progress" });
    store.upsertState("done", { entries: 0, status: "pending" });

    const flow = {
      description: "test",
      entry: "build",
      name: "test-flow",
      spawn_instructions: {},
      states: {
        build: { transitions: { done: "done" }, type: "single" as const },
        done: { type: "terminal" as const },
      },
    };

    // Should not throw — widened metrics fields are accepted
    const result = await reportResult({
      flow,
      metrics: {
        duration_ms: 1000,
        model: "claude-sonnet",
        orientation_calls: 10,
        spawns: 1,
        tool_calls: 42,
        turns: 7,
      },
      state_id: "build",
      status_keyword: "done",
      workspace: ws,
    });

    assertOk(result);

    // Verify the metrics were stored
    const state = store.getState("build");
    expect(state!.metrics!.tool_calls).toBe(42);
    expect(state!.metrics!.orientation_calls).toBe(10);
    expect(state!.metrics!.turns).toBe(7);

    clearCache();
  });
});
