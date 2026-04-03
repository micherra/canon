import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, access } from "fs/promises";
import path from "path";
import os from "os";
import {
  sanitizeBranch,
  generateSlug,
  checkSlugCollision,
  initWorkspace,
} from "../orchestration/workspace.ts";

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
    const expected = ["research", "decisions", "plans", "reviews", "transcripts", "handoffs"];
    for (const dir of expected) {
      await expect(access(path.join(ws, dir)).then(() => true)).resolves.toBe(true);
    }
  });

  it("does not create a notes/ directory", async () => {
    const ws = await initWorkspace(tmpDir, "my-branch-no-notes");
    await expect(access(path.join(ws, "notes")).then(() => true)).rejects.toThrow();
  });

  it("returns the workspace path", async () => {
    const ws = await initWorkspace(tmpDir, "test-branch");
    expect(ws).toBe(
      path.join(tmpDir, ".canon", "workspaces", "test-branch"),
    );
  });
});

