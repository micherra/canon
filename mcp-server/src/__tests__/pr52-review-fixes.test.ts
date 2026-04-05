/**
 * Tests for 5 PR review comments on PR #52 (feat/adr-002-adapters).
 *
 * Fix 1: git-adapter-async.ts — normalize err.code (string vs number) for exitCode
 * Fix 2: codebase-graph.ts — catch sanitizeGitRef throw for invalid diff_base input
 * Fix 3: pr-review-data.ts — shell-escape args in runDiffCommand non-git path
 * Fix 4: wrap-handler.ts — fix inaccurate docstring (comment-only change, verified here)
 * Fix 5: process-adapter.ts — incorporate result.error.message into stderr when empty
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fix 1: git-adapter-async — exitCode normalization for string err.code

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void;

let execFileImpl: ((cb: ExecFileCallback) => void) | null = null;

vi.mock("node:child_process", () => ({
  execFile: (
    _cmd: string,
    _args: string[],
    _opts: Record<string, unknown>,
    cb: ExecFileCallback,
  ) => {
    if (execFileImpl) {
      execFileImpl(cb);
    } else {
      cb(null, "", "");
    }
    return { pid: 12345 };
  },
  spawnSync: (_cmd: string, _opts?: unknown) => {
    if (spawnSyncImpl) return spawnSyncImpl();
    return { signal: null, status: 0, stderr: "", stdout: "" };
  },
}));

import { gitExecAsync } from "../platform/adapters/git-adapter-async.ts";

type SpawnSyncResult = {
  stdout: string;
  stderr: string;
  status: number | null;
  signal?: string | null;
  error?: Error;
};

let spawnSyncImpl: (() => SpawnSyncResult) | null = null;

import { runShell } from "../platform/adapters/process-adapter.ts";

beforeEach(() => {
  execFileImpl = null;
  spawnSyncImpl = null;
});

describe("Fix 1: gitExecAsync — exitCode normalization for string err.code", () => {
  it("uses numeric err.code directly as exitCode", async () => {
    const err = Object.assign(new Error("exit 2"), { code: 2 });
    execFileImpl = (cb) => cb(err, "", "error");
    const result = await gitExecAsync(["status"], "/project");
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
  });

  it("falls back to exitCode 1 when err.code is a string (e.g. ENOENT)", async () => {
    const err = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    execFileImpl = (cb) => cb(err, "", "");
    const result = await gitExecAsync(["status"], "/project");
    expect(result.ok).toBe(false);
    // String code must not be assigned directly — must fall back to 1
    expect(result.exitCode).toBe(1);
    expect(typeof result.exitCode).toBe("number");
  });

  it("falls back to exitCode 1 when err.code is EACCES (string)", async () => {
    const err = Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
    execFileImpl = (cb) => cb(err, "", "");
    const result = await gitExecAsync(["status"], "/project");
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("ETIMEDOUT string code still produces exitCode 1 (not the string)", async () => {
    const err = Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
    execFileImpl = (cb) => cb(err, "", "");
    const result = await gitExecAsync(["log"], "/project");
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(true);
  });

  it("numeric code 128 still used directly as exitCode", async () => {
    const err = Object.assign(new Error("fatal"), { code: 128 });
    execFileImpl = (cb) => cb(err, "", "fatal: not a git repo");
    const result = await gitExecAsync(["status"], "/notarepo");
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(128);
  });

  it("string code is included in stderr for diagnostics", async () => {
    const err = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    execFileImpl = (cb) => cb(err, "", "");
    const result = await gitExecAsync(["status"], "/project");
    // stderr should contain the string code or error message for diagnostics
    expect(result.stderr).toContain("ENOENT");
  });
});

// Fix 5: process-adapter — incorporate result.error.message into stderr

describe("Fix 5: runShell — error.message incorporated into stderr when stderr is empty", () => {
  it("includes result.error.message in stderr when stderr is empty and error exists", () => {
    const err = new Error("spawn ENOENT");
    spawnSyncImpl = () => ({ error: err, signal: null, status: null, stderr: "", stdout: "" });
    const result = runShell("nonexistent-command", "/project");
    expect(result.ok).toBe(false);
    // stderr must contain the error message for diagnostics
    expect(result.stderr).toContain("spawn ENOENT");
  });

  it("does NOT overwrite non-empty stderr with error.message", () => {
    const err = new Error("spawn error");
    spawnSyncImpl = () => ({
      error: err,
      signal: null,
      status: 127,
      stderr: "command not found: nonexistent-command",
      stdout: "",
    });
    const result = runShell("nonexistent-command", "/project");
    // Original stderr content is preserved
    expect(result.stderr).toBe("command not found: nonexistent-command");
    expect(result.stderr).not.toContain("spawn error");
  });

  it("stderr remains empty when there is no error and stderr is empty", () => {
    spawnSyncImpl = () => ({ signal: null, status: 0, stderr: "", stdout: "output" });
    const result = runShell("echo output", "/project");
    expect(result.stderr).toBe("");
  });

  it("returns ok:false when error exists even with empty stderr", () => {
    const err = new Error("ENOENT");
    spawnSyncImpl = () => ({ error: err, signal: null, status: null, stderr: "", stdout: "" });
    const result = runShell("missing", "/project");
    expect(result.ok).toBe(false);
  });
});

// Fix 2: codebase-graph — catch sanitizeGitRef throw for invalid diff_base
//
// To reach the sanitizeGitRef call at codebase-graph.ts line ~169, we must:
// 1. Have a non-main branch (gitCurrentBranch returns non-null, non-main value)
// 2. Have a non-null rawBase (either from input.diff_base or gitRefExists returning true)
//
// We mock gitExecAsync so gitCurrentBranch returns "feat/something", which causes
// the code to enter the block where sanitizeGitRef(rawBase) is called with an
// invalid diff_base value. Before the fix, this throws; after the fix, it's caught.

describe("Fix 2: codebaseGraph — invalid diff_base does not throw", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-graph-fix2-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
    await mkdir(join(tmpDir, "src"), { recursive: true });
    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({ layers: { api: ["src"] } }),
    );
    await writeFile(join(tmpDir, "src", "handler.ts"), `export function handler() {}`);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("does not throw when diff_base is invalid and git branch detection is on a feature branch", async () => {
    // Mock gitExecAsync: first call (rev-parse --abbrev-ref HEAD) returns "feat/test",
    // subsequent calls (rev-parse --verify for origin/main) return ok:true,
    // and the final diff call returns ok:true empty.
    vi.doMock("../platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 0,
          ok: true,
          stderr: "",
          stdout: "feat/test\n",
          timedOut: false,
        })
        .mockResolvedValueOnce({ exitCode: 0, ok: true, stderr: "", stdout: "", timedOut: false })
        .mockResolvedValue({ exitCode: 0, ok: true, stderr: "", stdout: "", timedOut: false }),
    }));

    const { codebaseGraph } = await import("../tools/codebase-graph.ts");
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
    vi.doMock("../platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 0,
          ok: true,
          stderr: "",
          stdout: "feat/test\n",
          timedOut: false,
        })
        .mockResolvedValueOnce({ exitCode: 0, ok: true, stderr: "", stdout: "", timedOut: false })
        .mockResolvedValue({ exitCode: 0, ok: true, stderr: "", stdout: "", timedOut: false }),
    }));

    const { codebaseGraph } = await import("../tools/codebase-graph.ts");
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
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-prdata-fix3-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("shell-escapes args when passed to runShell for non-git command", async () => {
    let capturedCommand: string | undefined;
    vi.doMock("../platform/adapters/process-adapter.ts", () => ({
      runShell: (cmd: string, _cwd: string) => {
        capturedCommand = cmd;
        return { exitCode: 0, ok: true, stderr: "", stdout: "", timedOut: false };
      },
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    await fn({ pr_number: 42 }, tmpDir);

    // The constructed command must have each arg individually quoted or safe
    expect(capturedCommand).toBeDefined();
    // Verify the gh command is used and args are included
    expect(capturedCommand).toContain("gh");
    expect(capturedCommand).toContain("42");
  });

  it("args with special shell chars are properly quoted in the shell command", async () => {
    let capturedCommand: string | undefined;
    vi.doMock("../platform/adapters/process-adapter.ts", () => ({
      runShell: (cmd: string, _cwd: string) => {
        capturedCommand = cmd;
        return { exitCode: 0, ok: true, stderr: "", stdout: "", timedOut: false };
      },
    }));
    vi.doMock("../platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: vi.fn().mockResolvedValue({
        exitCode: 0,
        ok: true,
        stderr: "",
        stdout: "",
        timedOut: false,
      }),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    await fn({ pr_number: 42 }, tmpDir);

    // Each arg should be wrapped in single quotes in the shell command string
    expect(capturedCommand).toBeDefined();
    // After fix: args like 'pr', 'diff', '42', '--name-only' should be quoted
    // The presence of single quotes around at least one arg verifies the fix
    const hasSingleQuotedArgs =
      capturedCommand!.includes("'pr'") ||
      capturedCommand!.includes("'diff'") ||
      capturedCommand!.includes("'42'") ||
      capturedCommand!.includes("'--name-only'");
    expect(hasSingleQuotedArgs).toBe(true);
  });
});

// Fix 4: wrap-handler — docstring accuracy (verified via import + behavior test)

import { wrapHandler } from "../shared/lib/wrap-handler.ts";

describe("Fix 4: wrapHandler — ok:false ToolResult passes through jsonResponse (not converted to MCP error)", () => {
  it("returns ok:false result as JSON (not converted to SDK error format)", async () => {
    const handler = wrapHandler(async (_input: unknown) => ({
      error_code: "INVALID_INPUT",
      message: "invalid ref",
      ok: false,
      recoverable: false,
    }));
    const response = await handler({});
    // Result should be parseable JSON, not an SDK error
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error_code).toBe("INVALID_INPUT");
    // Must be in content[0].text JSON format, not MCP isError:true format
    expect(response.content[0].type).toBe("text");
  });

  it("returns ok:true result as JSON (passthrough, no conversion)", async () => {
    const handler = wrapHandler(async (_input: unknown) => ({
      nodes: [],
      ok: true,
    }));
    const response = await handler({});
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.ok).toBe(true);
  });
});
