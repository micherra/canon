/**
 * Tests for post-message.ts (post_message tool)
 *
 * Covers:
 * - Happy path: registered `live` workspace → id + timestamp, message land in
 *   the per-workspace orchestration.db `messages` table via appendMessage
 * - Happy path: registered `finalized_on_disk` workspace still accepts posts
 * - INVALID_INPUT: relative workspace / empty sender / empty content
 * - WORKSPACE_NOT_FOUND: workspace not in the active_workspaces registry
 * - WORKSPACE_NOT_FOUND: workspace registered but status='reaped'
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { evictDriftDbForScope, getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, describe, expect, it } from "vitest";
import { postMessage } from "../tools/post-message.ts";

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

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) {
    evictDriftDbForScope(dir);
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
});

describe("postMessage — happy path", () => {
  it("registered live workspace: logs a message and returns id + timestamp", async () => {
    const workspace = makeTmpDir("post-message-ws-");
    const projectDir = makeTmpDir("post-message-proj-");
    setupWorkspace(workspace);
    getDriftDb(projectDir)
      .getActiveWorkspaces()
      .register({ slug: "test-slug", workspace_path: workspace });

    const result = await postMessage(
      { content: "starting implementation", sender: "engineer", workspace },
      projectDir,
    );

    assertOk(result);
    expect(result.logged).toBe(true);
    expect(typeof result.id).toBe("number");
    expect(typeof result.timestamp).toBe("string");

    const messages = getExecutionStore(workspace).getMessagesSinceId(workspace, 0);
    expect(messages).toHaveLength(1);
    expect(messages[0].sender).toBe("engineer");
    expect(messages[0].content).toBe("starting implementation");
    expect(messages[0].channel).toBe(workspace);
  });

  it("registered finalized_on_disk workspace still accepts posts", async () => {
    const workspace = makeTmpDir("post-message-ws-");
    const projectDir = makeTmpDir("post-message-proj-");
    setupWorkspace(workspace);
    const dao = getDriftDb(projectDir).getActiveWorkspaces();
    dao.register({ slug: "test-slug", workspace_path: workspace });
    dao.markFinalized(workspace);

    const result = await postMessage(
      { content: "post-finalize note", sender: "orchestrator", workspace },
      projectDir,
    );

    assertOk(result);
    expect(result.logged).toBe(true);
  });
});

describe("postMessage — INVALID_INPUT", () => {
  it("rejects a relative workspace path", async () => {
    const projectDir = makeTmpDir("post-message-proj-");
    const result = await postMessage(
      { content: "hi", sender: "engineer", workspace: "relative/path" },
      projectDir,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("absolute");
    }
  });

  it("rejects an empty sender", async () => {
    const workspace = makeTmpDir("post-message-ws-");
    const projectDir = makeTmpDir("post-message-proj-");
    setupWorkspace(workspace);
    getDriftDb(projectDir)
      .getActiveWorkspaces()
      .register({ slug: "test-slug", workspace_path: workspace });

    const result = await postMessage({ content: "hi", sender: "", workspace }, projectDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("sender");
    }
  });

  it("rejects an empty content", async () => {
    const workspace = makeTmpDir("post-message-ws-");
    const projectDir = makeTmpDir("post-message-proj-");
    setupWorkspace(workspace);
    getDriftDb(projectDir)
      .getActiveWorkspaces()
      .register({ slug: "test-slug", workspace_path: workspace });

    const result = await postMessage({ content: "   ", sender: "engineer", workspace }, projectDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("content");
    }
  });
});

describe("postMessage — registry gate", () => {
  it("returns WORKSPACE_NOT_FOUND when the workspace is not registered", async () => {
    const workspace = makeTmpDir("post-message-ws-");
    const projectDir = makeTmpDir("post-message-proj-");
    setupWorkspace(workspace);
    // No register() call — workspace exists on disk but is absent from the registry.

    const result = await postMessage({ content: "hi", sender: "engineer", workspace }, projectDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
    }
  });

  it("returns WORKSPACE_NOT_FOUND when the workspace status is reaped", async () => {
    const workspace = makeTmpDir("post-message-ws-");
    const projectDir = makeTmpDir("post-message-proj-");
    setupWorkspace(workspace);
    const dao = getDriftDb(projectDir).getActiveWorkspaces();
    dao.register({ slug: "test-slug", workspace_path: workspace });
    dao.markReaped(workspace);

    const result = await postMessage({ content: "hi", sender: "engineer", workspace }, projectDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
    }
  });
});
