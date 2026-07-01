/**
 * Unit tests for isSafeProjectDirInput (allow-list path-injection barrier).
 *
 * Strategy: red-green TDD — this test file was written before the implementation.
 * Tests cover every CodeQL-relevant rejection class (empty, over-length, NUL,
 * control char, relative, traversal) and the accept case for a legitimate project dir.
 * See docs/adr/0029-untrusted-project-dir-path-injection-allowlist.md for the rationale.
 */

import { describe, expect, it } from "vitest";
import { isSafeProjectDirInput } from "../safe-project-dir.ts";

describe("isSafeProjectDirInput", () => {
  // ── Reject cases ──────────────────────────────────────────────────────────

  it("rejects empty string", () => {
    expect(isSafeProjectDirInput("")).toBe(false);
  });

  it("rejects a string longer than 4096 characters", () => {
    const overLength = `/a${"x".repeat(4096)}`;
    expect(isSafeProjectDirInput(overLength)).toBe(false);
  });

  it("rejects a string containing a NUL byte", () => {
    expect(isSafeProjectDirInput("/valid/path\x00evil")).toBe(false);
  });

  it("rejects a string containing a control character (\\x01)", () => {
    expect(isSafeProjectDirInput("/a\x01b")).toBe(false);
  });

  it("rejects a relative path (no leading slash)", () => {
    expect(isSafeProjectDirInput("relative/dir")).toBe(false);
  });

  it("rejects a dot-relative path (./x)", () => {
    expect(isSafeProjectDirInput("./x")).toBe(false);
  });

  it("rejects a parent-relative path (../x)", () => {
    expect(isSafeProjectDirInput("../x")).toBe(false);
  });

  it("rejects an absolute path containing a .. segment (/a/../b)", () => {
    expect(isSafeProjectDirInput("/a/../b")).toBe(false);
  });

  it("rejects an absolute path with a leading .. traversal (/../etc)", () => {
    expect(isSafeProjectDirInput("/../etc/passwd")).toBe(false);
  });

  it("rejects an absolute path with a trailing .. segment (/a/b/..)", () => {
    expect(isSafeProjectDirInput("/a/b/..")).toBe(false);
  });

  // ── Windows fwd-slash traversal (Codex P2 on PR #436) ───────────────────────
  // Node on Windows accepts both `/` and `\` as separators, but the old guard
  // split only on `node:path`'s platform `sep` (`/` on POSIX). A backslash-delimited
  // ".." segment inside an otherwise POSIX-absolute path isolates the vuln on any
  // CI runner: the OLD code (split on "/" only) does NOT isolate the ".." segment
  // and accepts (vuln); the NEW code (split on both) isolates it and rejects.

  it("rejects a backslash-delimited .. segment inside a POSIX-absolute path (/safe\\..\\outside)", () => {
    expect(isSafeProjectDirInput("/safe\\..\\outside")).toBe(false);
  });

  it("rejects mixed forward/backslash separators around a .. segment (/foo/..\\bar)", () => {
    expect(isSafeProjectDirInput("/foo/..\\bar")).toBe(false);
  });

  // ── Accept cases ──────────────────────────────────────────────────────────

  it("accepts a clean absolute path (/Users/x/project)", () => {
    expect(isSafeProjectDirInput("/Users/x/project")).toBe(true);
  });

  it("accepts a clean absolute path in /private/tmp (/private/tmp/canon-test)", () => {
    expect(isSafeProjectDirInput("/private/tmp/canon-test")).toBe(true);
  });

  it("accepts a root-level path (/)", () => {
    // Single slash is absolute and contains no traversal — should pass the barrier.
    // The caller (existsSync/statSync) will reject non-directory inputs separately.
    expect(isSafeProjectDirInput("/")).toBe(true);
  });

  it("accepts a deep absolute path with no traversal", () => {
    expect(isSafeProjectDirInput("/home/user/code/my-project")).toBe(true);
  });

  it("accepts a segment that merely contains '..' as a substring, not a standalone segment (/foo/a..b)", () => {
    expect(isSafeProjectDirInput("/foo/a..b")).toBe(true);
  });
});
