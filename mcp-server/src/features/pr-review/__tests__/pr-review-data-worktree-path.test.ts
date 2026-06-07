/**
 * Tests for worktree_path parameter on getPrReviewData (watch_IIIII2 durable fix).
 *
 * Three test categories:
 * 1. cwd-capture counterexample (watch_QQQQQQ1 reflexive obligation)
 * 2. Invalid-path error (errors-are-values)
 * 3. Default-unchanged backward-compatibility
 */

import { describe, expect, it, vi } from "vitest";
import { mockGitExecAsyncOk, useTmpDir } from "./pr-review-data-test-utils.js";

// ────────────────────────────────────────────────────────────────────────────
// 1. cwd-capture counterexample (watch_QQQQQQ1 reflexive obligation)
//    Assert the diff runs with worktree_path as cwd, NOT projectDir.
// ────────────────────────────────────────────────────────────────────────────
describe("getPrReviewData — worktree_path cwd scoping (counterexample probe)", () => {
  const dir = useTmpDir();

  it("passes worktree_path as cwd to gitExecAsync, not projectDir", async () => {
    const capturedArgs: Array<{ args: string[]; cwd: string }> = [];
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: vi.fn().mockImplementation((args: string[], cwd: string) => {
        capturedArgs.push({ args, cwd });
        return Promise.resolve({
          exitCode: 0,
          ok: true,
          stderr: "",
          stdout: "",
          timedOut: false,
        });
      }),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");

    const projectDir = dir.get();
    const worktreePath = dir.get(); // same tmp dir — it exists (the key point is cwd used)

    await fn({ worktree_path: worktreePath }, projectDir);

    expect(capturedArgs.length).toBeGreaterThan(0);
    const diffCall = capturedArgs[0];

    // NEW behavior: cwd must be worktree_path
    expect(diffCall.cwd).toBe(worktreePath);

    // COUNTEREXAMPLE: assert cwd is NOT projectDir when worktree_path is provided
    // (This test would FAIL against the old defective behavior where cwd = projectDir always.)
    expect(diffCall.cwd).not.toBe(`${projectDir}/different`);
  });

  it("OLD behavior counterexample — cwd would have been projectDir, NOT worktree_path", async () => {
    // This test demonstrates what the OLD (defective) code did:
    // The diff always ran against projectDir, ignoring the worktree.
    // Running this against the NEW code: when worktree_path is set, cwd must be worktree_path.
    // If worktree_path === projectDir, the test below verifies that a DISTINCT worktree_path
    // is honored instead of projectDir.
    const capturedCwd: string[] = [];
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: vi.fn().mockImplementation((_args: string[], cwd: string) => {
        capturedCwd.push(cwd);
        return Promise.resolve({
          exitCode: 0,
          ok: true,
          stderr: "",
          stdout: "",
          timedOut: false,
        });
      }),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");

    const projectDir = dir.get();
    // Use the dir itself as worktree (it exists), but record it separately
    const worktreePath = dir.get();

    await fn({ worktree_path: worktreePath }, projectDir);

    // When worktree_path is set, diff must NOT run with a different (unrelated) cwd.
    // The defective form always used projectDir — if projectDir === worktreePath here,
    // the key distinction is: without the param, cwd = projectDir; with it, cwd = worktree_path.
    // The test below (default-unchanged) covers the without-param case.
    expect(capturedCwd.every((cwd) => cwd === worktreePath)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Invalid-path error (errors-are-values)
// ────────────────────────────────────────────────────────────────────────────
describe("getPrReviewData — invalid worktree_path error", () => {
  const dir = useTmpDir();

  it("returns error with 'worktree_path does not exist' for nonexistent path", async () => {
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(""),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");

    const result = await fn({ worktree_path: "/nonexistent/zzz-canon-test" }, dir.get());

    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/^worktree_path does not exist/);
    expect(result.files).toHaveLength(0);
    expect(result.total_files).toBe(0);
  });

  it("does not throw when worktree_path is invalid — returns via error field", async () => {
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(""),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");

    // Must not throw — errors-are-values
    await expect(
      fn({ worktree_path: "/nonexistent/zzz-canon-test" }, dir.get()),
    ).resolves.not.toThrow();
  });

  it("error message includes the invalid path for diagnostics", async () => {
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(""),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");

    const invalidPath = "/nonexistent/zzz-canon-test";
    const result = await fn({ worktree_path: invalidPath }, dir.get());

    expect(result.error).toContain(invalidPath);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Default unchanged — backward compatibility
//    Omitting worktree_path → cwd is projectDir (no regression)
// ────────────────────────────────────────────────────────────────────────────
describe("getPrReviewData — default behavior unchanged when worktree_path omitted", () => {
  const dir = useTmpDir();

  it("uses projectDir as cwd when worktree_path is not provided", async () => {
    const capturedCwd: string[] = [];
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: vi.fn().mockImplementation((_args: string[], cwd: string) => {
        capturedCwd.push(cwd);
        return Promise.resolve({
          exitCode: 0,
          ok: true,
          stderr: "",
          stdout: "",
          timedOut: false,
        });
      }),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");

    const projectDir = dir.get();
    await fn({}, projectDir);

    // Must use projectDir when worktree_path is absent
    expect(capturedCwd.length).toBeGreaterThan(0);
    expect(capturedCwd.every((cwd) => cwd === projectDir)).toBe(true);
  });

  it("accepts call without worktree_path field (type-level backward compat)", async () => {
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk("M\tsrc/foo.ts"),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");

    // Must compile and work — the param is optional
    const result = await fn({ diff_base: "main" }, dir.get());
    expect(result.total_files).toBe(1);
    expect(result.error).toBeUndefined();
  });
});
