import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isPathContained,
  isPathContainedViaResolver,
  isPathInWorktree,
} from "../worktree-guard.ts";

// isPathContained — pure path logic

describe("isPathContained", () => {
  it("returns true for a direct child path", () => {
    expect(isPathContained("/some/dir", "/some/dir/file.txt")).toBe(true);
  });

  it("returns true for a nested child path", () => {
    expect(isPathContained("/some/dir", "/some/dir/sub/deep/file.txt")).toBe(true);
  });

  it("returns false for parent path (..)", () => {
    expect(isPathContained("/some/dir", "/some")).toBe(false);
  });

  it("returns false for a sibling directory", () => {
    expect(isPathContained("/some/dir", "/some/other/file.txt")).toBe(false);
  });

  it("returns false for traversal attempt (../../../etc/passwd)", () => {
    // Even if constructed as a string, resolve normalises it
    expect(isPathContained("/some/dir", "/some/dir/../../../etc/passwd")).toBe(false);
  });

  it("returns false for an unrelated absolute path", () => {
    expect(isPathContained("/some/dir", "/etc/hosts")).toBe(false);
  });

  it("returns true for the container dir itself (same path)", () => {
    expect(isPathContained("/some/dir", "/some/dir")).toBe(true);
  });
});

// isPathInWorktree — async, filesystem-aware

describe("isPathInWorktree", () => {
  let tmpDir: string;
  let worktree: string;
  let outside: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "worktree-guard-test-"));
    worktree = join(tmpDir, "worktree");
    outside = join(tmpDir, "outside");

    // Create directories and a file inside the worktree
    await mkdir(worktree, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(worktree, "file.txt"), "hello");
    await writeFile(join(outside, "secret.txt"), "secret");
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("returns ok for a real file inside worktree", async () => {
    const result = await isPathInWorktree(join(worktree, "file.txt"), worktree);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contained).toBe(true);
    }
  });

  it("returns error for a file outside worktree", async () => {
    const result = await isPathInWorktree(join(outside, "secret.txt"), worktree);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("returns error for traversal attempt", async () => {
    // Logical traversal — path escapes via ..
    const result = await isPathInWorktree(join(worktree, "..", "outside", "secret.txt"), worktree);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("returns error for a non-existent path inside worktree", async () => {
    // The logical containment check passes, but realpath fails because file doesn't exist
    const result = await isPathInWorktree(join(worktree, "nonexistent.txt"), worktree);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("returns error for a symlink that escapes the worktree", async () => {
    // Create a symlink inside worktree that points to outside
    const symlinkPath = join(worktree, "escape-link.txt");
    await symlink(join(outside, "secret.txt"), symlinkPath);

    const result = await isPathInWorktree(symlinkPath, worktree);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toMatch(/symlink/i);
    }
  });

  it("returns ok result with ok: true and contained: true shape", async () => {
    const result = await isPathInWorktree(join(worktree, "file.txt"), worktree);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // TypeScript: contained should be exactly true (as const)
      const contained: true = result.contained;
      expect(contained).toBe(true);
    }
  });

  it("returns error result with ok: false shape", async () => {
    const result = await isPathInWorktree(join(outside, "secret.txt"), worktree);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.message).toBe("string");
      expect(result.message.length).toBeGreaterThan(0);
      expect(result.recoverable).toBe(false);
    }
  });

  it("returns symlink error for non-existent file whose parent dir is a symlink escape", async () => {
    // Create a symlink directory inside worktree pointing to outside/
    const symlinkDir = join(worktree, "symlink-dir");
    await symlink(outside, symlinkDir);

    const result = await isPathInWorktree(join(symlinkDir, "nonexistent.txt"), worktree);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toMatch(/symlink/i);
    }
  });

  it("returns generic error for non-existent file with a valid parent directory inside worktree", async () => {
    // Create a real subdirectory inside the worktree
    const existingSubdir = join(worktree, "existing-subdir");
    await mkdir(existingSubdir, { recursive: true });

    const result = await isPathInWorktree(join(existingSubdir, "nonexistent.txt"), worktree);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      // Parent is legitimate — error should NOT mention symlink
      expect(result.message).toMatch(/could not be resolved/i);
      expect(result.message).not.toMatch(/symlink/i);
    }
  });

  it("returns generic error when both file and parent directory do not exist", async () => {
    const result = await isPathInWorktree(
      join(worktree, "no-such-dir", "no-such-file.txt"),
      worktree,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      // Parent fallback also fails — falls through to generic error
      expect(result.message).toMatch(/could not be resolved/i);
      expect(result.message).not.toMatch(/symlink/i);
    }
  });
});

// isPathContainedViaResolver — symlink-safe containment composed over a
// caller-supplied resolver, for seam-injected callers (e.g.
// `reconcile_learnings`) that cannot call `node:fs/promises` `realpath`
// directly because their fs access is fully seam-injected.

describe("isPathContainedViaResolver", () => {
  let tmpDir: string;
  let worktree: string;
  let outside: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "worktree-guard-resolver-test-"));
    worktree = join(tmpDir, "worktree");
    outside = join(tmpDir, "outside");
    await mkdir(worktree, { recursive: true });
    await mkdir(outside, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("returns true for a real path inside the container, via the real resolver", async () => {
    const target = join(worktree, "sub");
    await mkdir(target);
    expect(await isPathContainedViaResolver(worktree, target, realpath)).toBe(true);
  });

  it("returns false for a symlink inside the container that resolves outside it", async () => {
    const escapeLink = join(worktree, "escape-link");
    await symlink(outside, escapeLink);
    expect(await isPathContainedViaResolver(worktree, escapeLink, realpath)).toBe(false);
  });

  it("returns false for a logical traversal, without ever calling the resolver", async () => {
    let called = false;
    const resolver = async (p: string) => {
      called = true;
      return p;
    };
    expect(
      await isPathContainedViaResolver(worktree, join(worktree, "..", "outside"), resolver),
    ).toBe(false);
    expect(called).toBe(false);
  });

  it("returns false (fails closed) when the resolver throws for a non-existent path", async () => {
    const resolver = async () => {
      throw new Error("ENOENT");
    };
    expect(await isPathContainedViaResolver(worktree, join(worktree, "nope"), resolver)).toBe(
      false,
    );
  });

  it("supports an identity resolver for fixture paths that never exist on real disk", async () => {
    const identity = async (p: string) => p;
    expect(await isPathContainedViaResolver("/fake/project", "/fake/project", identity)).toBe(true);
    expect(
      await isPathContainedViaResolver("/fake/project", "/fake/outside-project", identity),
    ).toBe(false);
  });
});
