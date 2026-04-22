/**
 * Tests for post-event.ts
 *
 * Covers:
 * - Happy path: start event is logged and retrievable
 * - Happy path: complete event with artifacts is logged correctly
 * - WORKSPACE_NOT_FOUND error for invalid workspace path
 * - INVALID_INPUT error for empty agent string
 * - INVALID_INPUT error for empty detail string
 * - EventPayloadSchemas["agent_activity"] validates correct payloads
 * - EventPayloadSchemas["agent_activity"] rejects invalid payloads
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventPayloadSchemas } from "@domains/messages/events.ts";
import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, describe, expect, it } from "vitest";
import { postEvent } from "../tools/post-event.ts";

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "post-event-test-"));
  tmpDirs.push(dir);
  return dir;
}

function setupWorkspace(workspace: string): void {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();
  store.initExecution({
    base_commit: "abc123",
    branch: "feat/test",
    created: now,
    current_state: "implement",
    entry: "implement",
    flow: "test-flow",
    flow_name: "test-flow",
    last_updated: now,
    sanitized: "feat-test",
    slug: "test-slug",
    started: now,
    task: "test task",
    tier: "medium",
  });
}

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
});

// Happy path tests

describe("postEvent — happy path start event", () => {
  it("logs a start event and it appears in getEvents", async () => {
    const workspace = makeTmpWorkspace();
    setupWorkspace(workspace);

    const result = await postEvent({
      action: "start",
      agent: "implementor",
      detail: "Starting implementation of post_event tool",
      workspace,
    });

    assertOk(result);
    expect(result.logged).toBe(true);
    expect(result.event_type).toBe("agent_activity");

    // Verify the event was written to the store
    const store = getExecutionStore(workspace);
    const events = store.getEvents({ type: "agent_activity" });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("agent_activity");
    expect(events[0].payload.agent).toBe("implementor");
    expect(events[0].payload.action).toBe("start");
    expect(events[0].payload.detail).toBe("Starting implementation of post_event tool");
    expect(typeof events[0].payload.timestamp).toBe("string");
  });
});

describe("postEvent — happy path complete event with artifacts", () => {
  it("logs a complete event with artifacts in payload", async () => {
    const workspace = makeTmpWorkspace();
    setupWorkspace(workspace);

    const result = await postEvent({
      action: "complete",
      agent: "implementor",
      artifacts: [
        "mcp-server/src/features/orchestration/tools/post-event.ts",
        "mcp-server/src/features/orchestration/__tests__/post-event.test.ts",
      ],
      detail: "Completed implementation of post_event tool",
      workspace,
    });

    assertOk(result);
    expect(result.logged).toBe(true);
    expect(result.event_type).toBe("agent_activity");

    const store = getExecutionStore(workspace);
    const events = store.getEvents({ type: "agent_activity" });
    expect(events).toHaveLength(1);
    expect(events[0].payload.action).toBe("complete");
    expect(events[0].payload.artifacts).toEqual([
      "mcp-server/src/features/orchestration/tools/post-event.ts",
      "mcp-server/src/features/orchestration/__tests__/post-event.test.ts",
    ]);
  });

  it("does not include artifacts field when artifacts array is empty", async () => {
    const workspace = makeTmpWorkspace();
    setupWorkspace(workspace);

    await postEvent({
      action: "complete",
      agent: "implementor",
      artifacts: [],
      detail: "Completed with no artifacts",
      workspace,
    });

    const store = getExecutionStore(workspace);
    const events = store.getEvents({ type: "agent_activity" });
    expect(events).toHaveLength(1);
    expect(events[0].payload.artifacts).toBeUndefined();
  });
});

// Error cases

describe("postEvent — WORKSPACE_NOT_FOUND", () => {
  it("returns WORKSPACE_NOT_FOUND for a non-existent workspace path", async () => {
    const result = await postEvent({
      action: "start",
      agent: "implementor",
      detail: "Starting something",
      workspace: "/tmp/does-not-exist-post-event-test-xyz-12345",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
    }
  });
});

describe("postEvent — INVALID_INPUT for empty agent", () => {
  it("returns INVALID_INPUT when agent is empty string", async () => {
    const workspace = makeTmpWorkspace();
    setupWorkspace(workspace);

    const result = await postEvent({
      action: "start",
      agent: "",
      detail: "Some detail",
      workspace,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("agent");
    }
  });

  it("returns INVALID_INPUT when agent is whitespace only", async () => {
    const workspace = makeTmpWorkspace();
    setupWorkspace(workspace);

    const result = await postEvent({
      action: "start",
      agent: "   ",
      detail: "Some detail",
      workspace,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });
});

describe("postEvent — INVALID_INPUT for empty detail", () => {
  it("returns INVALID_INPUT when detail is empty string", async () => {
    const workspace = makeTmpWorkspace();
    setupWorkspace(workspace);

    const result = await postEvent({
      action: "complete",
      agent: "implementor",
      detail: "",
      workspace,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("detail");
    }
  });
});

// Schema validation tests

describe("EventPayloadSchemas.agent_activity", () => {
  it("validates a correct agent_activity payload", () => {
    const schema = EventPayloadSchemas.agent_activity;
    const result = schema.safeParse({
      action: "start",
      agent: "implementor",
      detail: "Starting task",
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it("validates a payload with optional artifacts and correlation_id", () => {
    const schema = EventPayloadSchemas.agent_activity;
    const result = schema.safeParse({
      action: "complete",
      agent: "researcher",
      artifacts: ["plans/DESIGN.md"],
      correlation_id: "corr-123",
      detail: "Completed research",
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid action value", () => {
    const schema = EventPayloadSchemas.agent_activity;
    const result = schema.safeParse({
      action: "in_progress",
      agent: "implementor",
      detail: "Doing something",
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it("rejects payload missing required agent field", () => {
    const schema = EventPayloadSchemas.agent_activity;
    const result = schema.safeParse({
      action: "start",
      detail: "Doing something",
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it("rejects payload missing required detail field", () => {
    const schema = EventPayloadSchemas.agent_activity;
    const result = schema.safeParse({
      action: "start",
      agent: "implementor",
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });
});
