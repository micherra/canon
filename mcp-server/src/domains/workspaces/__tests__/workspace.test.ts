import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSlugCollision, generateSlug, initWorkspace, sanitizeBranch } from "../workspace.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "workspace-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { force: true, recursive: true });
});

// sanitizeBranch

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

// generateSlug

describe("generateSlug", () => {
  it("converts a basic task to a slug", () => {
    expect(generateSlug("Add user login")).toBe("add-user-login");
  });

  it("strips special characters", () => {
    expect(generateSlug("Fix bug #123!")).toBe("fix-bug-123");
  });

  it("truncates long task names to at most 72 characters", () => {
    const long = "word ".repeat(20);
    const result = generateSlug(long);
    expect(result.length).toBeLessThanOrEqual(72);
  });

  it("truncates at word boundary (last hyphen before limit)", () => {
    // 15 chars each: "averylongword-" × 5 = 75 chars before truncation
    const input = "averylongword averylongword averylongword averylongword averylongword";
    const result = generateSlug(input);
    expect(result.length).toBeLessThanOrEqual(72);
    expect(result).not.toMatch(/-$/);
  });

  it("does not leave a trailing hyphen after truncation", () => {
    // Construct a string that would produce a hyphen right at position 72
    const input = "a".repeat(72);
    const result = generateSlug(input);
    expect(result).not.toMatch(/-$/);
  });

  it("falls back to hard truncation when no hyphen in first 72 chars", () => {
    // 80 lowercase letters with no spaces — no hyphens after sanitization
    const input = "a".repeat(80);
    const result = generateSlug(input);
    expect(result).toBe("a".repeat(72));
  });

  it("handles multiple spaces and hyphens", () => {
    expect(generateSlug("too   many---hyphens")).toBe("too-many-hyphens");
  });

  it("trims leading and trailing hyphens", () => {
    expect(generateSlug(" -hello- ")).toBe("hello");
  });
});

// checkSlugCollision

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

// initWorkspace

describe("initWorkspace", () => {
  it("creates all subdirectories", async () => {
    const ws = await initWorkspace(tmpDir, "my-branch");
    const expected = ["artifacts", "plans", "reviews", "transcripts"];
    await Promise.all(
      expected.map((dir) =>
        expect(access(path.join(ws, dir)).then(() => true)).resolves.toBe(true),
      ),
    );
  });

  it("does not create research/, handoffs/, or decisions/ directories", async () => {
    const ws = await initWorkspace(tmpDir, "my-branch-dead-dirs");
    await Promise.all(
      ["research", "handoffs", "decisions"].map((dir) =>
        expect(access(path.join(ws, dir)).then(() => true)).rejects.toThrow(),
      ),
    );
  });

  it("creates the artifacts/ subdirectory", async () => {
    const ws = await initWorkspace(tmpDir, "my-branch-artifacts");
    await expect(access(path.join(ws, "artifacts")).then(() => true)).resolves.toBe(true);
  });

  it("does not create a notes/ directory", async () => {
    const ws = await initWorkspace(tmpDir, "my-branch-no-notes");
    await expect(access(path.join(ws, "notes")).then(() => true)).rejects.toThrow();
  });

  it("returns the workspace path", async () => {
    const ws = await initWorkspace(tmpDir, "test-branch");
    expect(ws).toBe(path.join(tmpDir, ".canon", "workspaces", "test-branch"));
  });
});
