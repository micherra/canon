/**
 * TDD tests for S2 — workspace mutex wired into init_workspace.
 *
 * Uses real SQLite (same pattern as init-workspace.test.ts — no complex mocks).
 *
 * Tests:
 * 1. Single init → .lock present after creation.
 * 2. Sequential double-init on one workspace → second returns lock_gated with first owner.
 * 3. Init over a stale .lock → proceeds normally (reclaimed).
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_LOCK_TTL_MS } from "../workspace-lock.ts";
import { initWorkspaceFlow } from "../../tools/init-workspace.ts";

// ---------------------------------------------------------------------------
// Fixture — real temp dirs, no mocks (matches init-workspace.test.ts pattern)
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "init-ws-lock-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
});

const baseInput = {
  base_commit: "abc1234",
  branch: "test-branch",
  flow_name: "test-flow",
  task: "lock test task",
  tier: "small" as const,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("init_workspace lock wiring (S2)", () => {
  // Test 1: single init → .lock present after creation
  it("creates a .lock file in the workspace after a successful init", async () => {
    const projectDir = makeTmpProjectDir();
    const result = await initWorkspaceFlow(
      { ...baseInput, session_id: "session-001", job_id: "job-001" },
      projectDir,
      "/fake/plugin",
    );

    expect(result.created).toBe(true);
    expect(result.workspace).toBeTruthy();

    const lockPath = join(result.workspace, ".lock");
    expect(existsSync(lockPath)).toBe(true);
  });

  // Test 2: sequential double-init on one workspace → second returns lock_gated
  it("returns lock_gated with first owner when a second session tries to init on the same workspace", async () => {
    const projectDir = makeTmpProjectDir();

    // First init — acquires the lock
    const result1 = await initWorkspaceFlow(
      { ...baseInput, session_id: "session-001", job_id: "job-001" },
      projectDir,
      "/fake/plugin",
    );
    expect(result1.created).toBe(true);

    // Second init — same task, same branch → same slug → same candidate workspace
    // Different session_id → should be gated
    const result2 = await initWorkspaceFlow(
      { ...baseInput, session_id: "session-002", job_id: "job-002" },
      projectDir,
      "/fake/plugin",
    );

    expect(result2.lock_gated).toBe(true);
    expect(result2.lock_owner).toBeDefined();
    expect(result2.lock_owner?.session_id).toBe("session-001");
    // workspace must be empty so caller knows not to proceed
    expect(result2.workspace).toBe("");
  });

  // Test 3: init over a stale .lock → proceeds normally (reclaimed)
  it("proceeds normally when a stale .lock exists (reclaim)", async () => {
    const projectDir = makeTmpProjectDir();

    // First init to discover the workspace path
    const result1 = await initWorkspaceFlow(
      { ...baseInput, session_id: "session-001", job_id: "job-001" },
      projectDir,
      "/fake/plugin",
    );
    expect(result1.created).toBe(true);

    // Overwrite the lock with a stale one (started_at > 2h ago)
    const staleLock = {
      job_id: "old-job",
      pid: process.pid,
      session_id: "session-old",
      started_at: new Date(Date.now() - DEFAULT_LOCK_TTL_MS - 5000).toISOString(),
    };
    writeFileSync(join(result1.workspace, ".lock"), JSON.stringify(staleLock), "utf-8");

    // Second init from a different session — same task/branch → resumes same workspace
    // The stale lock should be reclaimed and the init should proceed
    const result2 = await initWorkspaceFlow(
      { ...baseInput, session_id: "session-002", job_id: "job-002" },
      projectDir,
      "/fake/plugin",
    );

    // Must NOT be gated — the stale lock was reclaimed
    expect(result2.lock_gated).toBeFalsy();
    expect(result2.workspace).toBeTruthy();
  });
});
