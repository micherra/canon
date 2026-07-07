/**
 * parse-summary.test.ts — parseSummary pure function
 *
 * Tests:
 * - Parses a normal summary line
 * - Parses when preceded by a large blob (last-line scan)
 * - Returns sane fallback values on malformed input
 */

import { describe, expect, it } from "vitest";
import { parseSummary } from "../services/eval-runner.ts";

describe("parseSummary", () => {
  it("parses a normal summary line", () => {
    const stdout =
      "PASS  case-1\nPASS  case-2\nFAIL  case-3\nTotal: 3 | Passed: 2 | Failed: 1 | Errors: 0 | Skipped: 0";
    expect(parseSummary(stdout)).toEqual({ errors: 0, failed: 1, passed: 2, total: 3 });
  });

  it("parses when preceded by a large blob (last-line scan)", () => {
    // Generate ~512KB of garbage before the summary line
    const noise = "x".repeat(512_000);
    const stdout = `${noise}\nPASS  case-1\nTotal: 18 | Passed: 15 | Failed: 2 | Errors: 1 | Skipped: 0`;
    const result = parseSummary(stdout);
    expect(result).toEqual({ errors: 1, failed: 2, passed: 15, total: 18 });
  });

  it("returns zeros for malformed input with no summary line", () => {
    const result = parseSummary("no summary here");
    expect(result).toEqual({ errors: 0, failed: 0, passed: 0, total: 0 });
  });

  it("returns zeros for empty string", () => {
    expect(parseSummary("")).toEqual({ errors: 0, failed: 0, passed: 0, total: 0 });
  });

  it("handles trailing whitespace in summary line", () => {
    const stdout = "Total: 5 | Passed: 4 | Failed: 1 | Errors: 0 | Skipped: 0   ";
    expect(parseSummary(stdout)).toEqual({ errors: 0, failed: 1, passed: 4, total: 5 });
  });

  it("picks the LAST summary line when multiple exist (512KB truncation scenario)", () => {
    // Simulates stdout where an early partial run emitted a summary before truncation
    const stdout = [
      "Total: 5 | Passed: 3 | Failed: 2 | Errors: 0 | Skipped: 0",
      "PASS  case-extra",
      "Total: 6 | Passed: 4 | Failed: 2 | Errors: 0 | Skipped: 0",
    ].join("\n");
    // Should pick the last one
    expect(parseSummary(stdout)).toEqual({ errors: 0, failed: 2, passed: 4, total: 6 });
  });

  it("handles all-pass scenario", () => {
    const stdout = "Total: 13 | Passed: 13 | Failed: 0 | Errors: 0 | Skipped: 0";
    expect(parseSummary(stdout)).toEqual({ errors: 0, failed: 0, passed: 13, total: 13 });
  });

  it("handles all-fail scenario", () => {
    const stdout = "Total: 3 | Passed: 0 | Failed: 3 | Errors: 0 | Skipped: 0";
    expect(parseSummary(stdout)).toEqual({ errors: 0, failed: 3, passed: 0, total: 3 });
  });

  it("captures a nonzero Errors count (the Codex P1 gap)", () => {
    const stdout = "Total: 1 | Passed: 0 | Failed: 0 | Errors: 2 | Skipped: 0";
    expect(parseSummary(stdout)).toEqual({ errors: 2, failed: 0, passed: 0, total: 1 });
  });

  it("malformed input defaults errors to 0", () => {
    expect(parseSummary("garbage, no summary line here")).toEqual({
      errors: 0,
      failed: 0,
      passed: 0,
      total: 0,
    });
  });
});
