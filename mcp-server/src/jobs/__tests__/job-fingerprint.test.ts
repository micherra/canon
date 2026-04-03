import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoist mocks before module imports
// ---------------------------------------------------------------------------

vi.mock("../../adapters/git-adapter-async.ts", () => ({
  gitExecAsync: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { computeJobFingerprint } from "../job-fingerprint.ts";
import { gitExecAsync } from "../../adapters/git-adapter-async.ts";
import { readFile } from "node:fs/promises";

const mockGitExecAsync = vi.mocked(gitExecAsync);
const mockReadFile = vi.mocked(readFile);

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// computeJobFingerprint — happy path
// ---------------------------------------------------------------------------

describe("computeJobFingerprint — happy path", () => {
  it("returns a 64-char hex string in a git repo", async () => {
    mockGitExecAsync.mockResolvedValueOnce({
      ok: true,
      stdout: "abc123def456abc123def456abc123def456abc123\n",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      duration_ms: 5,
    });
    mockReadFile.mockResolvedValueOnce('{"layers": {}}' as unknown as never);

    const result = await computeJobFingerprint({ projectDir: "/project" });
    expect(result).not.toBeNull();
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("passes rev-parse HEAD to gitExecAsync", async () => {
    mockGitExecAsync.mockResolvedValueOnce({
      ok: true,
      stdout: "deadbeef\n",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      duration_ms: 3,
    });
    mockReadFile.mockResolvedValueOnce("{}" as unknown as never);

    await computeJobFingerprint({ projectDir: "/my/project" });
    expect(mockGitExecAsync).toHaveBeenCalledWith(["rev-parse", "HEAD"], "/my/project");
  });
});

// ---------------------------------------------------------------------------
// computeJobFingerprint — determinism
// ---------------------------------------------------------------------------

describe("computeJobFingerprint — determinism", () => {
  it("same inputs produce same fingerprint", async () => {
    const mockResult = {
      ok: true as const,
      stdout: "abcdef1234567890abcdef1234567890abcdef12\n",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      duration_ms: 4,
    };

    mockGitExecAsync.mockResolvedValue(mockResult);
    mockReadFile.mockResolvedValue('{"version": 1}' as unknown as never);

    const first = await computeJobFingerprint({ projectDir: "/repo", sourceDirs: ["src", "lib"] });
    const second = await computeJobFingerprint({ projectDir: "/repo", sourceDirs: ["src", "lib"] });
    expect(first).toBe(second);
  });

  it("different sourceDirs produce different fingerprints", async () => {
    const mockResult = {
      ok: true as const,
      stdout: "abcdef1234567890abcdef1234567890abcdef12\n",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      duration_ms: 4,
    };

    mockGitExecAsync.mockResolvedValue(mockResult);
    mockReadFile.mockResolvedValue('{"version": 1}' as unknown as never);

    const withSrc = await computeJobFingerprint({ projectDir: "/repo", sourceDirs: ["src"] });
    const withLib = await computeJobFingerprint({ projectDir: "/repo", sourceDirs: ["lib"] });
    expect(withSrc).not.toBe(withLib);
  });

  it("sourceDirs order does not matter (sorted)", async () => {
    const mockResult = {
      ok: true as const,
      stdout: "abcdef1234567890abcdef1234567890abcdef12\n",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      duration_ms: 4,
    };

    mockGitExecAsync.mockResolvedValue(mockResult);
    mockReadFile.mockResolvedValue("{}" as unknown as never);

    const abOrder = await computeJobFingerprint({ projectDir: "/repo", sourceDirs: ["a", "b"] });
    const baOrder = await computeJobFingerprint({ projectDir: "/repo", sourceDirs: ["b", "a"] });
    expect(abOrder).toBe(baOrder);
  });

  it("different git HEAD produces different fingerprint", async () => {
    mockGitExecAsync
      .mockResolvedValueOnce({
        ok: true,
        stdout: "aaaaaa\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        duration_ms: 3,
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: "bbbbbb\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        duration_ms: 3,
      });
    mockReadFile.mockResolvedValue("{}" as unknown as never);

    const fp1 = await computeJobFingerprint({ projectDir: "/repo" });
    const fp2 = await computeJobFingerprint({ projectDir: "/repo" });
    expect(fp1).not.toBe(fp2);
  });
});

// ---------------------------------------------------------------------------
// computeJobFingerprint — null when not in a git repo
// ---------------------------------------------------------------------------

describe("computeJobFingerprint — null when not in a git repo", () => {
  it("returns null when gitExecAsync returns ok: false", async () => {
    mockGitExecAsync.mockResolvedValueOnce({
      ok: false,
      stdout: "",
      stderr: "fatal: not a git repository",
      exitCode: 128,
      timedOut: false,
      duration_ms: 2,
    });

    const result = await computeJobFingerprint({ projectDir: "/not-a-git-repo" });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeJobFingerprint — missing config.json
// ---------------------------------------------------------------------------

describe("computeJobFingerprint — missing config.json", () => {
  it("returns a fingerprint even when config.json does not exist", async () => {
    mockGitExecAsync.mockResolvedValueOnce({
      ok: true,
      stdout: "deadbeef\n",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      duration_ms: 3,
    });
    mockReadFile.mockRejectedValueOnce(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );

    const result = await computeJobFingerprint({ projectDir: "/project" });
    expect(result).not.toBeNull();
    expect(result).toHaveLength(64);
  });
});
