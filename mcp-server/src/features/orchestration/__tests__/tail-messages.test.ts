/**
 * Tests for tail-messages.ts (tail_messages tool)
 *
 * Covers:
 * - Incremental tail across two "connections" (writer posts via appendMessage
 *   directly, then a second call to tailMessages sees only the new rows)
 * - last_id advances to the max returned id (or stays at since_id when none returned)
 * - peer_lock null when no lock file present, populated when one is
 * - INVALID_INPUT on negative since_id
 * - default since_id=0 returns all messages
 * - registry gate rejects unknown + reaped workspaces
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { evictDriftDbForScope, getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, describe, expect, it } from "vitest";
import { acquireLock } from "../services/workspace-lock.ts";
import { tailMessages } from "../tools/tail-messages.ts";

let tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
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

function registerLive(projectDir: string, workspace: string): void {
  getDriftDb(projectDir)
    .getActiveWorkspaces()
    .register({ slug: "test-slug", workspace_path: workspace });
}

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) {
    evictDriftDbForScope(dir);
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
});

describe("tailMessages — happy path", () => {
  it("default since_id=0 returns all messages in ascending id order", async () => {
    const workspace = makeTmpDir("tail-messages-ws-");
    const projectDir = makeTmpDir("tail-messages-proj-");
    setupWorkspace(workspace);
    registerLive(projectDir, workspace);

    const store = getExecutionStore(workspace);
    store.appendMessage(workspace, "engineer", "msg1");
    store.appendMessage(workspace, "reviewer", "msg2");

    const result = await tailMessages({ workspace }, projectDir);
    assertOk(result);
    expect(result.messages).toHaveLength(2);
    expect(result.messages.map((m) => m.content)).toEqual(["msg1", "msg2"]);
    expect(result.last_id).toBe(result.messages[1].id);
  });

  it("incremental tail: a second call with since_id sees only new messages", async () => {
    const workspace = makeTmpDir("tail-messages-ws-");
    const projectDir = makeTmpDir("tail-messages-proj-");
    setupWorkspace(workspace);
    registerLive(projectDir, workspace);

    const store = getExecutionStore(workspace);
    store.appendMessage(workspace, "engineer", "msg1");

    const first = await tailMessages({ workspace }, projectDir);
    assertOk(first);
    expect(first.messages).toHaveLength(1);

    store.appendMessage(workspace, "reviewer", "msg2");
    store.appendMessage(workspace, "reviewer", "msg3");

    const second = await tailMessages({ since_id: first.last_id, workspace }, projectDir);
    assertOk(second);
    expect(second.messages.map((m) => m.content)).toEqual(["msg2", "msg3"]);
    expect(second.last_id).toBeGreaterThan(first.last_id);
  });

  it("last_id stays at since_id when no new messages are returned", async () => {
    const workspace = makeTmpDir("tail-messages-ws-");
    const projectDir = makeTmpDir("tail-messages-proj-");
    setupWorkspace(workspace);
    registerLive(projectDir, workspace);

    const result = await tailMessages({ since_id: 42, workspace }, projectDir);
    assertOk(result);
    expect(result.messages).toHaveLength(0);
    expect(result.last_id).toBe(42);
  });

  it("peer_lock is null when no .lock file is present", async () => {
    const workspace = makeTmpDir("tail-messages-ws-");
    const projectDir = makeTmpDir("tail-messages-proj-");
    setupWorkspace(workspace);
    registerLive(projectDir, workspace);

    const result = await tailMessages({ workspace }, projectDir);
    assertOk(result);
    expect(result.peer_lock).toBeNull();
  });

  it("peer_lock is populated when a .lock file exists (liveness)", async () => {
    const workspace = makeTmpDir("tail-messages-ws-");
    const projectDir = makeTmpDir("tail-messages-proj-");
    setupWorkspace(workspace);
    registerLive(projectDir, workspace);
    acquireLock(workspace, { job_id: "job1", session_id: "sess1" });

    const result = await tailMessages({ workspace }, projectDir);
    assertOk(result);
    expect(result.peer_lock).not.toBeNull();
    expect(result.peer_lock?.session_id).toBe("sess1");
    expect(result.peer_lock?.job_id).toBe("job1");
  });
});

describe("tailMessages — INVALID_INPUT", () => {
  it("rejects a relative workspace path", async () => {
    const projectDir = makeTmpDir("tail-messages-proj-");
    const result = await tailMessages({ workspace: "relative/path" }, projectDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("absolute");
    }
  });

  it("rejects a negative since_id", async () => {
    const workspace = makeTmpDir("tail-messages-ws-");
    const projectDir = makeTmpDir("tail-messages-proj-");
    setupWorkspace(workspace);
    registerLive(projectDir, workspace);

    const result = await tailMessages({ since_id: -1, workspace }, projectDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("rejects a non-integer since_id", async () => {
    const workspace = makeTmpDir("tail-messages-ws-");
    const projectDir = makeTmpDir("tail-messages-proj-");
    setupWorkspace(workspace);
    registerLive(projectDir, workspace);

    const result = await tailMessages({ since_id: 1.5, workspace }, projectDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });
});

describe("tailMessages — registry gate", () => {
  it("returns WORKSPACE_NOT_FOUND when the workspace is not registered", async () => {
    const workspace = makeTmpDir("tail-messages-ws-");
    const projectDir = makeTmpDir("tail-messages-proj-");
    setupWorkspace(workspace);

    const result = await tailMessages({ workspace }, projectDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
    }
  });

  it("returns WORKSPACE_NOT_FOUND when the workspace status is reaped", async () => {
    const workspace = makeTmpDir("tail-messages-ws-");
    const projectDir = makeTmpDir("tail-messages-proj-");
    setupWorkspace(workspace);
    const dao = getDriftDb(projectDir).getActiveWorkspaces();
    dao.register({ slug: "test-slug", workspace_path: workspace });
    dao.markReaped(workspace);

    const result = await tailMessages({ workspace }, projectDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
    }
  });
});
