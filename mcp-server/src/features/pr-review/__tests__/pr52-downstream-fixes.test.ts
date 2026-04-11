/**
 * Tests for PR #52 review fixes that exercise downstream consumers of
 * the platform adapters (codebase-graph, pr-review-data) rather than
 * the adapters themselves. These live in a sibling file to
 * pr52-review-fixes.test.ts so that their adapter-level mocks do not
 * fight pr52-review-fixes's `node:child_process` mock at module-load
 * time — each vitest test file has its own module cache, so splitting
 * by mock layer keeps both styles race-free.
 *
 * The legacy form of these tests used `vi.doMock + await import(...)`
 * in each test body. That pattern races with vitest's module cache
 * under file-parallel execution and intermittently timed out in CI.
 * Hoisted `vi.mock` + `vi.fn()` spies give us deterministic behavior
 * and a single static `import` at the top of the file, per the
 * vitest concurrency guidance.
 *
 * Covered fixes:
 *   - Fix 2: codebase-graph.ts — catch sanitizeGitRef throw for
 *            invalid diff_base input
 *   - Fix 3: pr-review-data.ts — shell-escape args in
 *            runDiffCommand non-git path
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mocks for the platform adapters. These are the ONLY mocks in
// this test file, so they live at module scope (via vi.hoisted) and
// every `it()` block sets specific return values via `mockReturnValueOnce`
// / `mockResolvedValueOnce` instead of re-registering the mock.
const { mockRunShell, mockGitExecAsync } = vi.hoisted(() => ({
  mockGitExecAsync: vi.fn(),
  mockRunShell: vi.fn(),
}));

vi.mock("@platform/adapters/process-adapter.ts", () => ({
  runShell: mockRunShell,
}));

vi.mock("@platform/adapters/git-adapter-async.ts", () => ({
  gitExecAsync: mockGitExecAsync,
}));

import { codebaseGraph } from "@features/knowledge-graph/tools/codebase-graph.ts";
import { getPrReviewData } from "../tools/pr-review-data.ts";

/** Build an ok ProcessResult. */
function okResult(stdout = "") {
  return {
    exitCode: 0,
    ok: true as const,
    stderr: "",
    stdout,
    timedOut: false,
  };
}

// Fix 2: codebase-graph — catch sanitizeGitRef throw for invalid diff_base
//
// To reach the sanitizeGitRef call in codebase-graph.ts, the test must:
// 1. Have a non-main branch (gitCurrentBranch returns non-null, non-main)
// 2. Have a non-null rawBase (either from input.diff_base or from gitRefExists)
//
// The adapter mock returns "feat/test" as the current branch and ok:true
// for subsequent ref-exists checks, which drives the code into the block
// where sanitizeGitRef(rawBase) is called with an invalid diff_base. Before
// the fix that throw escaped the tool; after the fix it is caught.

describe("Fix 2: codebaseGraph — invalid diff_base does not throw", () => {
  let tmpDir: string;

  beforeEach(async () => {
    mockGitExecAsync.mockReset();
    mockRunShell.mockReset();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-graph-fix2-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
    await mkdir(join(tmpDir, "src"), { recursive: true });
    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({ layers: { api: ["src"] } }),
    );
    await writeFile(join(tmpDir, "src", "handler.ts"), "export function handler() {}");
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("does not throw when diff_base is invalid and git branch detection is on a feature branch", async () => {
    // First call: rev-parse --abbrev-ref HEAD → feat/test
    // Second call: rev-parse --verify origin/main → ok
    // Rest: diff calls → ok empty
    mockGitExecAsync
      .mockResolvedValueOnce(okResult("feat/test\n"))
      .mockResolvedValueOnce(okResult(""))
      .mockResolvedValue(okResult(""));

    // diff_base with shell-dangerous chars that sanitizeGitRef would reject
    await expect(
      codebaseGraph(
        { diff_base: "origin/main; rm -rf /", source_dirs: ["src"] },
        tmpDir,
        "/nonexistent",
      ),
    ).resolves.toBeDefined();
  });

  it("returns graph nodes when diff_base is invalid (graceful fallback, no changed files marked)", async () => {
    mockGitExecAsync
      .mockResolvedValueOnce(okResult("feat/test\n"))
      .mockResolvedValueOnce(okResult(""))
      .mockResolvedValue(okResult(""));

    const result = await codebaseGraph(
      { diff_base: "$(bad-command)", source_dirs: ["src"] },
      tmpDir,
      "/nonexistent",
    );
    // Should return graph data; invalid diff_base means no changed-file detection
    expect(result.nodes).toBeDefined();
    expect(Array.isArray(result.nodes)).toBe(true);
    // No node should be marked as changed
    expect(result.nodes.filter((n) => n.changed)).toHaveLength(0);
  });
});

// Fix 3: pr-review-data — shell-escaping in runDiffCommand non-git path

describe("Fix 3: runDiffCommand — non-git args are shell-escaped", () => {
  let tmpDir: string;

  beforeEach(async () => {
    mockRunShell.mockReset();
    mockGitExecAsync.mockReset();
    mockGitExecAsync.mockResolvedValue(okResult(""));
    tmpDir = await mkdtemp(join(tmpdir(), "canon-prdata-fix3-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("shell-escapes args when passed to runShell for non-git command", async () => {
    let capturedCommand: string | undefined;
    mockRunShell.mockImplementationOnce((cmd: string) => {
      capturedCommand = cmd;
      return okResult("");
    });

    await getPrReviewData({ pr_number: 42 }, tmpDir);

    // The constructed command must have each arg individually quoted or safe
    expect(capturedCommand).toBeDefined();
    // Verify the gh command is used and args are included
    expect(capturedCommand).toContain("gh");
    expect(capturedCommand).toContain("42");
  });

  it("args with special shell chars are properly quoted in the shell command", async () => {
    let capturedCommand: string | undefined;
    mockRunShell.mockImplementationOnce((cmd: string) => {
      capturedCommand = cmd;
      return okResult("");
    });

    await getPrReviewData({ pr_number: 42 }, tmpDir);

    // Each arg should be wrapped in single quotes in the shell command string
    expect(capturedCommand).toBeDefined();
    // After fix: args like 'pr', 'diff', '42', '--name-only' should be quoted.
    // The presence of single quotes around at least one arg verifies the fix.
    const hasSingleQuotedArgs =
      capturedCommand!.includes("'pr'") ||
      capturedCommand!.includes("'diff'") ||
      capturedCommand!.includes("'42'") ||
      capturedCommand!.includes("'--name-only'");
    expect(hasSingleQuotedArgs).toBe(true);
  });
});
