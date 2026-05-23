import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";

/**
 * Build a mock gitExecAsync that returns an ok ProcessResult with the given stdout.
 */
export function mockGitExecAsyncOk(stdout: string) {
  return vi.fn().mockResolvedValue({
    exitCode: 0,
    ok: true,
    stderr: "",
    stdout,
    timedOut: false,
  });
}

/**
 * Build a mock gitExecAsync that returns an error ProcessResult.
 */
export function mockGitExecAsyncFail(stderr = "fatal: not a git repository") {
  return vi.fn().mockResolvedValue({
    exitCode: 128,
    ok: false,
    stderr,
    stdout: "",
    timedOut: false,
  });
}

/**
 * Build a mock runShell that returns an ok ProcessResult with the given stdout.
 */
export function mockRunShellOk(stdout: string) {
  return vi.fn().mockReturnValue({
    exitCode: 0,
    ok: true,
    stderr: "",
    stdout,
    timedOut: false,
  });
}

/**
 * Build a mock runShell that returns an error ProcessResult.
 */
export function mockRunShellFail(stderr = "gh: command not found") {
  return vi.fn().mockReturnValue({
    exitCode: 1,
    ok: false,
    stderr,
    stdout: "",
    timedOut: false,
  });
}

/**
 * Set up a temporary directory with a `.canon` subdirectory for each test.
 * Resets vitest modules before each test and restores mocks after each test.
 * Returns a getter for the current tmpDir value.
 */
export function useTmpDir(prefix = "canon-pr-review-test-"): { get: () => string } {
  let tmpDir = "";
  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), prefix));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { force: true, recursive: true });
  });
  return { get: () => tmpDir };
}
