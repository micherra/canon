import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, access } from "fs/promises";
import path from "path";
import os from "os";
import {
  sanitizeBranch,
  generateSlug,
  checkSlugCollision,
  initWorkspace,
  acquireLock,
  releaseLock,
  writeSession,
} from "../orchestration/workspace.ts";
import type { Session } from "../orchestration/flow-schema.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "workspace-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// sanitizeBranch
// ---------------------------------------------------------------------------

describe("sanitizeBranch", () => {
  it("replaces slashes with double hyphens", () => {
    expect(sanitizeBranch("feature/my-branch")).toBe("feature--my-branch");
  });

  it("replaces spaces with hyphens", () => {
    expect(sanitizeBranch("my cool branch")).toBe("my-cool-branch");
  });

  it("strips special characters", () => {
    expect(sanitizeBranch("feat@#$%ure")).toBe("feature");
  });

  it("lowercases the result", () => {
    expect(sanitizeBranch("Feature/UPPER")).toBe("feature--upper");
  });

  it("truncates to 80 characters", () => {
    const long = "a".repeat(100);
    expect(sanitizeBranch(long)).toHaveLength(80);
  });
});

// ---------------------------------------------------------------------------
// generateSlug
// ---------------------------------------------------------------------------

describe("generateSlug", () => {
  it("converts a basic task to a slug", () => {
    expect(generateSlug("Add user login")).toBe("add-user-login");
  });

  it("strips special characters", () => {
    expect(generateSlug("Fix bug #123!")).toBe("fix-bug-123");
  });

  it("truncates to 40 characters", () => {
    const long = "word ".repeat(20);
    expect(generateSlug(long).length).toBeLessThanOrEqual(40);
  });

  it("handles multiple spaces and hyphens", () => {
    expect(generateSlug("too   many---hyphens")).toBe("too-many-hyphens");
  });

  it("trims leading and trailing hyphens", () => {
    expect(generateSlug(" -hello- ")).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// checkSlugCollision
// ---------------------------------------------------------------------------

describe("checkSlugCollision", () => {
  it("returns original slug when no collision", async () => {
    const parentDir = tmpDir;
    const result = await checkSlugCollision(parentDir, "my-feature");
    expect(result).toBe("my-feature");
  });

  it("appends -2 suffix on first collision", async () => {
    const parentDir = tmpDir;
    await mkdir(path.join(parentDir, "my-feature"), { recursive: true });
    const result = await checkSlugCollision(parentDir, "my-feature");
    expect(result).toBe("my-feature-2");
  });

  it("increments suffix for multiple collisions", async () => {
    const parentDir = tmpDir;
    await mkdir(path.join(parentDir, "slug"), { recursive: true });
    await mkdir(path.join(parentDir, "slug-2"), { recursive: true });
    await mkdir(path.join(parentDir, "slug-3"), { recursive: true });
    const result = await checkSlugCollision(parentDir, "slug");
    expect(result).toBe("slug-4");
  });
});

// ---------------------------------------------------------------------------
// initWorkspace
// ---------------------------------------------------------------------------

describe("initWorkspace", () => {
  it("creates all subdirectories", async () => {
    const ws = await initWorkspace(tmpDir, "my-branch");
    const expected = ["research", "decisions", "plans", "reviews"];
    for (const dir of expected) {
      await expect(
        access(path.join(ws, dir)).then(() => true),
      ).resolves.toBe(true);
    }
  });

  it("does not create a notes/ directory", async () => {
    const ws = await initWorkspace(tmpDir, "my-branch-no-notes");
    await expect(
      access(path.join(ws, "notes")).then(() => true),
    ).rejects.toThrow();
  });

  it("returns the workspace path", async () => {
    const ws = await initWorkspace(tmpDir, "test-branch");
    expect(ws).toBe(
      path.join(tmpDir, ".canon", "workspaces", "test-branch"),
    );
  });
});

// ---------------------------------------------------------------------------
// writeSession
// ---------------------------------------------------------------------------

describe("writeSession", () => {
  it("writes session.json to the workspace", async () => {
    const ws = await initWorkspace(tmpDir, "session-test");
    const session: Session = {
      branch: "main",
      sanitized: "main",
      created: "2026-01-01T00:00:00.000Z",
      task: "test task",
      tier: "small",
      flow: "quick-fix",
      slug: "test-task",
      status: "active",
    };
    await writeSession(ws, session);
    const raw = await readFile(path.join(ws, "session.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.branch).toBe("main");
    expect(parsed.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// acquireLock / releaseLock
// ---------------------------------------------------------------------------

describe("acquireLock / releaseLock", () => {
  it("acquires lock when no lock exists", async () => {
    const ws = await initWorkspace(tmpDir, "lock-test");
    const result = await acquireLock(ws);
    expect(result.acquired).toBe(true);
    // Lock file should exist
    const raw = await readFile(path.join(ws, ".lock"), "utf-8");
    const lock = JSON.parse(raw);
    expect(lock.pid).toBe(process.pid);
  });

  it("fails to acquire when a fresh lock exists from a live process", async () => {
    const ws = await initWorkspace(tmpDir, "lock-fresh");
    // Use current process PID so liveness check passes
    const lockData = {
      pid: process.pid,
      started: new Date().toISOString(),
    };
    await writeFile(
      path.join(ws, ".lock"),
      JSON.stringify(lockData),
      "utf-8",
    );
    const result = await acquireLock(ws);
    expect(result.acquired).toBe(false);
    expect(result.reason).toContain("Another build is active");
  });

  it("removes lock from dead process and re-acquires", async () => {
    const ws = await initWorkspace(tmpDir, "lock-dead-pid");
    // Use a PID that is almost certainly not running
    const lockData = {
      pid: 2147483647,
      started: new Date().toISOString(),
    };
    await writeFile(
      path.join(ws, ".lock"),
      JSON.stringify(lockData),
      "utf-8",
    );
    const result = await acquireLock(ws);
    expect(result.acquired).toBe(true);
  });

  it("removes stale lock and re-acquires", async () => {
    const ws = await initWorkspace(tmpDir, "lock-stale");
    const staleDate = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3 hours ago
    const lockData = {
      pid: 99999,
      started: staleDate.toISOString(),
    };
    await writeFile(
      path.join(ws, ".lock"),
      JSON.stringify(lockData),
      "utf-8",
    );
    const result = await acquireLock(ws);
    expect(result.acquired).toBe(true);
    // New lock should have current pid
    const raw = await readFile(path.join(ws, ".lock"), "utf-8");
    const newLock = JSON.parse(raw);
    expect(newLock.pid).toBe(process.pid);
  });

  it("releaseLock removes the lock file", async () => {
    const ws = await initWorkspace(tmpDir, "lock-release");
    await acquireLock(ws);
    await releaseLock(ws);
    await expect(
      access(path.join(ws, ".lock")).then(() => true),
    ).rejects.toThrow();
  });

  it("releaseLock does not throw when no lock exists", async () => {
    const ws = await initWorkspace(tmpDir, "lock-noop");
    await expect(releaseLock(ws)).resolves.toBeUndefined();
  });

  it("releaseLock does not remove lock owned by another process", async () => {
    const ws = await initWorkspace(tmpDir, "lock-foreign");
    const foreignLock = {
      pid: 2147483646, // A PID that is not ours
      started: new Date().toISOString(),
    };
    await writeFile(
      path.join(ws, ".lock"),
      JSON.stringify(foreignLock),
      "utf-8",
    );
    await releaseLock(ws);
    // Lock should still exist
    const raw = await readFile(path.join(ws, ".lock"), "utf-8");
    const lock = JSON.parse(raw);
    expect(lock.pid).toBe(2147483646);
  });

  it("releaseLock removes corrupt lock file", async () => {
    const ws = await initWorkspace(tmpDir, "lock-corrupt");
    await writeFile(path.join(ws, ".lock"), "NOT JSON", "utf-8");
    await releaseLock(ws);
    await expect(
      access(path.join(ws, ".lock")).then(() => true),
    ).rejects.toThrow();
  });
});
