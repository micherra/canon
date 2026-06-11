/**
 * Tests for resolveProjectDir — MCP roots priority chain for project directory resolution.
 *
 * Covers:
 * - Priority 1: CANON_PROJECT_DIR absolute path wins when set
 * - CANON_PROJECT_DIR relative path is ignored (falls through)
 * - CANON_PROJECT_DIR empty string is ignored (falls through)
 * - Priority 2: MCP roots first root URI used when CANON_PROJECT_DIR absent
 * - Priority 3: cwd fallback when roots list is empty
 * - Priority 3: cwd fallback when listRoots throws
 * - file:// URI is converted to filesystem path
 *
 * Also covers resolveGitRoot:
 * - Returns git toplevel when gitExec succeeds
 * - Falls back to raw cwd when gitExec returns ok: false
 * - Falls back to raw cwd when gitExec throws
 */

import type { ProcessResult } from "@shared/lib/tool-result.ts";
import { describe, expect, it, vi } from "vitest";
import { resolveGitRoot, resolveProjectDir } from "../resolve-project-dir.ts";

// Helper: build a minimal ok ProcessResult
function makeProcessResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    ok: true,
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    duration_ms: 0,
    ...overrides,
  };
}

describe("resolveGitRoot", () => {
  const cwd = "/some/subdirectory/mcp-server";

  it("returns git toplevel when gitExec succeeds", () => {
    const gitFn = vi
      .fn()
      .mockReturnValue(makeProcessResult({ ok: true, stdout: "/some/subdirectory\n" }));
    const result = resolveGitRoot(cwd, gitFn);
    expect(result).toBe("/some/subdirectory");
    expect(gitFn).toHaveBeenCalledWith(["rev-parse", "--show-toplevel"], cwd);
  });

  it("trims trailing newline from git output", () => {
    const gitFn = vi.fn().mockReturnValue(makeProcessResult({ ok: true, stdout: "/repo/root\n" }));
    const result = resolveGitRoot(cwd, gitFn);
    expect(result).toBe("/repo/root");
  });

  it("falls back to raw cwd when gitExec returns ok: false", () => {
    const gitFn = vi
      .fn()
      .mockReturnValue(makeProcessResult({ ok: false, stdout: "", exitCode: 128 }));
    const result = resolveGitRoot(cwd, gitFn);
    expect(result).toBe(cwd);
  });

  it("falls back to raw cwd when gitExec throws", () => {
    const gitFn = vi.fn().mockImplementation(() => {
      throw new Error("git not found");
    });
    const result = resolveGitRoot(cwd, gitFn);
    expect(result).toBe(cwd);
  });

  it("returns git toplevel even when it equals cwd (already at root)", () => {
    const gitFn = vi.fn().mockReturnValue(makeProcessResult({ ok: true, stdout: `${cwd}\n` }));
    const result = resolveGitRoot(cwd, gitFn);
    expect(result).toBe(cwd);
  });
});

describe("resolveProjectDir", () => {
  const cwd = "/fallback/cwd";

  it("uses CANON_PROJECT_DIR when it is an absolute path", async () => {
    const listRoots = vi.fn().mockResolvedValue({ roots: [] });
    const result = await resolveProjectDir("/absolute/project/dir", listRoots, cwd);
    expect(result).toBe("/absolute/project/dir");
    expect(listRoots).not.toHaveBeenCalled();
  });

  it("ignores CANON_PROJECT_DIR when it is a relative path", async () => {
    const listRoots = vi.fn().mockResolvedValue({ roots: [{ uri: "file:///from/roots" }] });
    const result = await resolveProjectDir("./relative/path", listRoots, cwd);
    expect(result).toBe("/from/roots");
  });

  it("ignores CANON_PROJECT_DIR when it is empty string", async () => {
    const listRoots = vi.fn().mockResolvedValue({ roots: [{ uri: "file:///from/roots" }] });
    const result = await resolveProjectDir("", listRoots, cwd);
    expect(result).toBe("/from/roots");
  });

  it("ignores CANON_PROJECT_DIR when undefined", async () => {
    const listRoots = vi.fn().mockResolvedValue({ roots: [{ uri: "file:///from/roots" }] });
    const result = await resolveProjectDir(undefined, listRoots, cwd);
    expect(result).toBe("/from/roots");
  });

  it("parses file:// URI from MCP roots into a filesystem path", async () => {
    const listRoots = vi.fn().mockResolvedValue({
      roots: [{ name: "my-project", uri: "file:///Users/alice/my-project" }],
    });
    const result = await resolveProjectDir(undefined, listRoots, cwd);
    expect(result).toBe("/Users/alice/my-project");
  });

  it("uses cwd fallback when roots list is empty", async () => {
    const listRoots = vi.fn().mockResolvedValue({ roots: [] });
    const result = await resolveProjectDir(undefined, listRoots, cwd);
    expect(result).toBe(cwd);
  });

  it("uses cwd fallback when first root has no uri", async () => {
    const listRoots = vi.fn().mockResolvedValue({ roots: [{ name: "unnamed" }] });
    const result = await resolveProjectDir(undefined, listRoots, cwd);
    expect(result).toBe(cwd);
  });

  it("uses cwd fallback when listRoots throws", async () => {
    const listRoots = vi.fn().mockRejectedValue(new Error("roots not supported"));
    const result = await resolveProjectDir(undefined, listRoots, cwd);
    expect(result).toBe(cwd);
  });

  it("uses only the first root when multiple roots are present", async () => {
    const listRoots = vi.fn().mockResolvedValue({
      roots: [{ uri: "file:///first/project" }, { uri: "file:///second/project" }],
    });
    const result = await resolveProjectDir(undefined, listRoots, cwd);
    expect(result).toBe("/first/project");
  });

  // ── Defense-in-depth: explicit ${...} token reject for CANON_PROJECT_DIR ────
  it("ignores CANON_PROJECT_DIR when it is an unexpanded ${CLAUDE_PROJECT_DIR} token (falls through to roots)", async () => {
    const listRoots = vi.fn().mockResolvedValue({ roots: [{ uri: "file:///from/roots" }] });
    const result = await resolveProjectDir("${CLAUDE_PROJECT_DIR}", listRoots, cwd);
    expect(result).toBe("/from/roots");
  });

  it("ignores CANON_PROJECT_DIR when it contains an unexpanded token mid-path (falls through to roots)", async () => {
    const listRoots = vi.fn().mockResolvedValue({ roots: [{ uri: "file:///from/roots" }] });
    const result = await resolveProjectDir("/some/${VAR}/path", listRoots, cwd);
    expect(result).toBe("/from/roots");
  });

  it("still accepts CANON_PROJECT_DIR when it is a real absolute path (no token)", async () => {
    const listRoots = vi.fn().mockResolvedValue({ roots: [] });
    const result = await resolveProjectDir("/real/absolute/path", listRoots, cwd);
    expect(result).toBe("/real/absolute/path");
    expect(listRoots).not.toHaveBeenCalled();
  });
});
