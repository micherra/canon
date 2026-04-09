/**
 * git-log-parser.test.ts
 *
 * Tests for parseGitLog and isExcluded.
 */

import { describe, expect, test } from "vitest";
import { isExcluded } from "../git-intel-config.ts";
import { parseGitLog } from "../git-log-parser.ts";

// parseGitLog

describe("parseGitLog", () => {
  test("parses well-formed git log output into commit records", () => {
    const stdout = [
      "COMMIT:abc123 1700000000",
      "",
      "src/foo.ts",
      "src/bar.ts",
      "",
      "COMMIT:def456 1700001000",
      "",
      "src/baz.ts",
    ].join("\n");

    const records = parseGitLog(stdout);

    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      files: ["src/foo.ts", "src/bar.ts"],
      sha: "abc123",
      timestamp: 1700000000,
    });
    expect(records[1]).toEqual({
      files: ["src/baz.ts"],
      sha: "def456",
      timestamp: 1700001000,
    });
  });

  test("handles empty output — returns empty array", () => {
    expect(parseGitLog("")).toEqual([]);
    expect(parseGitLog("   \n  ")).toEqual([]);
  });

  test("handles commits with no files — skips them", () => {
    const stdout = [
      "COMMIT:abc123 1700000000",
      "",
      "",
      "COMMIT:def456 1700001000",
      "",
      "src/baz.ts",
    ].join("\n");

    const records = parseGitLog(stdout);
    expect(records).toHaveLength(1);
    expect(records[0].sha).toBe("def456");
  });

  test("handles malformed lines — skips without throwing", () => {
    const stdout = [
      "COMMIT:abc123 notanumber",
      "",
      "src/foo.ts",
      "",
      "COMMIT:def456 1700001000",
      "",
      "src/baz.ts",
    ].join("\n");

    // Should not throw; malformed header is skipped, valid commit kept
    expect(() => parseGitLog(stdout)).not.toThrow();
    const records = parseGitLog(stdout);
    // Only the valid commit should be returned
    expect(records).toHaveLength(1);
    expect(records[0].sha).toBe("def456");
  });

  test("trims whitespace from file paths", () => {
    const stdout = ["COMMIT:abc123 1700000000", "", "  src/foo.ts  "].join("\n");
    const records = parseGitLog(stdout);
    expect(records[0].files).toEqual(["src/foo.ts"]);
  });
});

// isExcluded

describe("isExcluded", () => {
  test("matches exact filename", () => {
    expect(isExcluded("package-lock.json", ["package-lock.json"])).toBe(true);
  });

  test("matches glob pattern against basename only — deep path", () => {
    expect(isExcluded("src/app/webpack.config.js", ["*.config.js"])).toBe(true);
  });

  test("does not match when basename differs from pattern", () => {
    // config.json does NOT match *.config.js
    expect(isExcluded("src/config.json", ["*.config.js"])).toBe(false);
  });

  test("matches *.config.ts against deeply nested file", () => {
    expect(isExcluded("mcp-server/src/vitest.config.ts", ["*.config.ts"])).toBe(true);
  });

  test("returns false when no patterns match", () => {
    expect(isExcluded("src/index.ts", ["*.config.js", "package-lock.json"])).toBe(false);
  });

  test("returns false for empty pattern list", () => {
    expect(isExcluded("src/index.ts", [])).toBe(false);
  });

  test("matches tsconfig*.json glob", () => {
    expect(isExcluded("tsconfig.base.json", ["tsconfig*.json"])).toBe(true);
    expect(isExcluded("src/tsconfig.build.json", ["tsconfig*.json"])).toBe(true);
  });

  test("does not match partial basename — pattern anchored", () => {
    // yarn.lock should not match package-lock.json pattern
    expect(isExcluded("yarn.lock", ["package-lock.json"])).toBe(false);
  });
});
