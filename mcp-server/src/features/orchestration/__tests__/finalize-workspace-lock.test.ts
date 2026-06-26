/**
 * TDD tests for S3 — releaseLock wired into finalize_workspace.
 *
 * Tests:
 * 1. finalize removes the .lock file for the owning session.
 * 2. Second finalize does not error (released:false — .lock already gone).
 * 3. finalize does not delete a .lock owned by a different session_id.
 *
 * Pattern: create a workspace dir manually + logStep to seed journal, then
 * write the .lock explicitly, then call finalizeWorkspace — matches the
 * pattern used in orchestration-journal-worktree.test.ts.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock git-adapter to prevent actual git calls during workspace archive steps.
vi.mock("@platform/adapters/git-adapter.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("@platform/adapters/git-adapter.ts")>();
  return {
    ...original,
    gitExec: vi.fn().mockReturnValue({
      duration_ms: 5,
      exitCode: 0,
      ok: true,
      stderr: "",
      stdout: "",
      timedOut: false,
    }),
  };
});

import { acquireLock, releaseLock } from "../services/workspace-lock.ts";
import { finalizeWorkspace, logStep } from "../tools/orchestration-journal.ts";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "finalize-lock-test-"));
  tmpDirs.push(dir);
  // Create a minimal workspace layout
  mkdirSync(join(dir, "plans"), { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

/**
 * Seed a workspace with a single completed step so that finalizeWorkspace
 * returns ok:true (and also has a chance to run the lock release).
 */
async function seedCompletedJournal(workspace: string): Promise<void> {
  const artifactPath = join(workspace, "plans", "DESIGN.md");
  writeFileSync(artifactPath, "# Design\n");
  await logStep({
    agent_id: "test-agent",
    artifacts_expected: ["plans/DESIGN.md"],
    status: "completed",
    step_id: "design",
    workspace,
    projectDir: process.cwd(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("finalize_workspace lock release (S3)", () => {
  // Test 1: finalize removes the .lock file for the owning session.
  it("removes the .lock file when session_id matches", async () => {
    const workspace = makeTmpWorkspace();
    await seedCompletedJournal(workspace);

    // Acquire a lock as session-001
    acquireLock(workspace, { session_id: "session-001", job_id: "job-001" });
    expect(existsSync(join(workspace, ".lock"))).toBe(true);

    // Finalize with the same session_id — should release the lock
    const result = await finalizeWorkspace({
      projectDir: process.cwd(),
      session_id: "session-001",
      workspace,
    });

    expect(result.ok).toBe(true);
    // .lock must be gone
    expect(existsSync(join(workspace, ".lock"))).toBe(false);
    if (result.ok) {
      expect(result.lock_released).toBe(true);
    }
  });

  // Test 2: Second finalize does not error — released:false when .lock already gone.
  it("returns lock_released:false and no error when .lock already absent", async () => {
    const workspace = makeTmpWorkspace();
    await seedCompletedJournal(workspace);

    // No lock acquired — finalize should succeed with released:false
    const result = await finalizeWorkspace({
      projectDir: process.cwd(),
      session_id: "session-001",
      workspace,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.lock_released).toBe(false);
    }
    // Calling releaseLock directly a second time is also idempotent — no throw
    expect(() => releaseLock(workspace, { session_id: "session-001" })).not.toThrow();
    const r = releaseLock(workspace, { session_id: "session-001" });
    expect(r.released).toBe(false);
  });

  // Test 3: finalize does not delete a .lock owned by a different session_id.
  it("does not delete a .lock owned by a different session", async () => {
    const workspace = makeTmpWorkspace();
    await seedCompletedJournal(workspace);

    // Acquire lock as session-owner
    acquireLock(workspace, { session_id: "session-owner", job_id: "job-owner" });
    const lockPath = join(workspace, ".lock");
    expect(existsSync(lockPath)).toBe(true);

    // Finalize from a different session — should NOT delete the lock
    const result = await finalizeWorkspace({
      projectDir: process.cwd(),
      session_id: "session-other",
      workspace,
    });

    // The lock should still be there (not our lock)
    expect(existsSync(lockPath)).toBe(true);
    if (result.ok) {
      expect(result.lock_released).toBe(false);
    }
  });
});
