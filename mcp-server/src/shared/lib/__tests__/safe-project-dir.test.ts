/**
 * Unit tests for isSafeProjectDirInput (allow-list path-injection barrier).
 *
 * Strategy: red-green TDD — this test file was written before the implementation.
 * Tests cover every CodeQL-relevant rejection class (empty, over-length, NUL,
 * control char, relative, traversal) and the accept case for a legitimate project dir.
 * See docs/adr/0028-untrusted-project-dir-path-injection-allowlist.md for the rationale.
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
});
