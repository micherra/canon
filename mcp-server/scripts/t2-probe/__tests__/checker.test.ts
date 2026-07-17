/**
 * checker.test.ts — hermetic unit tests for the T2 probe checker driver.
 *
 * The shell/model boundary (`runShell`) is injected via `shellRunner`, never
 * a real subprocess or model call — see mocking-boundaries primer ("mock at
 * the system boundary, not the class boundary").
 */

import type { ProcessResult } from "@shared/lib/tool-result.ts";
import { describe, expect, it } from "vitest";
import * as checkerModule from "../checker.ts";
import { runCheckerOnDiff } from "../checker.ts";

const FAKE_DIFF = "diff --git a/src/foo.ts b/src/foo.ts\n+const d = 1;\n";
const FAKE_RUBRIC_PATH = new URL("../rubric.md", import.meta.url).pathname;

function processResult(overrides: Partial<ProcessResult>): ProcessResult {
  return {
    duration_ms: 1,
    exitCode: 0,
    ok: true,
    stderr: "",
    stdout: "",
    timedOut: false,
    ...overrides,
  };
}

describe("runCheckerOnDiff — fail-open forced-error path (dc-02)", () => {
  it("returns empty findings + failed_open:true on non-zero exit, never throws", () => {
    const shellRunner = () => processResult({ exitCode: 1, ok: false, stderr: "boom" });

    expect(() => {
      const result = runCheckerOnDiff(FAKE_DIFF, FAKE_RUBRIC_PATH, { shellRunner });
      expect(result).toEqual({ failed_open: true, findings: [] });
    }).not.toThrow();
  });

  it("returns empty findings + failed_open:true when the injected shellRunner itself throws, never propagates", () => {
    const shellRunner = (): never => {
      throw new Error("hostile/buggy runner exploded");
    };

    expect(() => {
      const result = runCheckerOnDiff(FAKE_DIFF, FAKE_RUBRIC_PATH, { shellRunner });
      expect(result).toEqual({ failed_open: true, findings: [] });
    }).not.toThrow();
  });

  it("returns empty findings + failed_open:true on timeout", () => {
    const shellRunner = () => processResult({ exitCode: 1, ok: false, timedOut: true });

    const result = runCheckerOnDiff(FAKE_DIFF, FAKE_RUBRIC_PATH, { shellRunner });

    expect(result).toEqual({ failed_open: true, findings: [] });
  });

  it("returns empty findings + failed_open:true on empty stdout", () => {
    const shellRunner = () => processResult({ ok: true, stdout: "" });

    const result = runCheckerOnDiff(FAKE_DIFF, FAKE_RUBRIC_PATH, { shellRunner });

    expect(result).toEqual({ failed_open: true, findings: [] });
  });

  it("returns empty findings + failed_open:true when stdout has no delimiters", () => {
    const shellRunner = () => processResult({ ok: true, stdout: "I refuse to follow the format." });

    const result = runCheckerOnDiff(FAKE_DIFF, FAKE_RUBRIC_PATH, { shellRunner });

    expect(result).toEqual({ failed_open: true, findings: [] });
  });

  it("returns empty findings + failed_open:true when the rubric file cannot be read", () => {
    const shellRunner = () => processResult({ ok: true, stdout: "should never be called" });

    const result = runCheckerOnDiff(FAKE_DIFF, "/nonexistent/rubric.md", { shellRunner });

    expect(result).toEqual({ failed_open: true, findings: [] });
  });
});

describe("runCheckerOnDiff — delimiter parse happy path", () => {
  it("parses a well-formed VERDICT block with 2 findings", () => {
    const stdout = `Some reasoning about the diff.
---VERDICT---
VERDICT: FINDINGS
SUMMARY: 2 misses found.
FINDINGS:
- file_path: src/foo.ts
  line: 2
  description: "Variable \`d\` should be renamed to \`durationMs\`."
- file_path: src/bar.ts
  line: 10
  description: "Unused import left in place."
---END_VERDICT---
`;
    const shellRunner = () => processResult({ ok: true, stdout });

    const result = runCheckerOnDiff(FAKE_DIFF, FAKE_RUBRIC_PATH, { shellRunner });

    expect(result.failed_open).toBe(false);
    expect(result.findings).toEqual([
      { description: "Variable `d` should be renamed to `durationMs`.", file_path: "src/foo.ts", line: 2 },
      { description: "Unused import left in place.", file_path: "src/bar.ts", line: 10 },
    ]);
  });

  it("parses a well-formed VERDICT block with zero findings (PASS)", () => {
    const stdout = `---VERDICT---
VERDICT: PASS
SUMMARY: No misses found.
FINDINGS:
---END_VERDICT---
`;
    const shellRunner = () => processResult({ ok: true, stdout });

    const result = runCheckerOnDiff(FAKE_DIFF, FAKE_RUBRIC_PATH, { shellRunner });

    expect(result).toEqual({ failed_open: false, findings: [] });
  });
});

describe("runCheckerOnDiff — malformed verdict (P2(c) / dc-06)", () => {
  it("returns failed_open:true when delimiters are present but the FINDINGS section is absent", () => {
    const stdout = `---VERDICT---
VERDICT: PASS
SUMMARY: No misses found.
---END_VERDICT---
`;
    const shellRunner = () => processResult({ ok: true, stdout });

    const result = runCheckerOnDiff(FAKE_DIFF, FAKE_RUBRIC_PATH, { shellRunner });

    expect(result).toEqual({ failed_open: true, findings: [] });
  });

  it("returns failed_open:true when the FINDINGS header is renamed (e.g. singular FINDING:)", () => {
    const stdout = `---VERDICT---
VERDICT: FINDINGS
SUMMARY: 1 miss found.
FINDING:
- file_path: src/foo.ts
  line: 2
  description: "Should be renamed."
---END_VERDICT---
`;
    const shellRunner = () => processResult({ ok: true, stdout });

    const result = runCheckerOnDiff(FAKE_DIFF, FAKE_RUBRIC_PATH, { shellRunner });

    expect(result).toEqual({ failed_open: true, findings: [] });
  });
});

describe("advisory invariant", () => {
  it("exports no function that returns a pass/fail gate signal — only findings + failed_open", () => {
    const exportedNames = Object.keys(checkerModule);
    for (const name of exportedNames) {
      const value = (checkerModule as Record<string, unknown>)[name];
      if (typeof value === "function") {
        // The only function export is runCheckerOnDiff, and its return shape
        // is asserted above to be { findings, failed_open } — never a bare
        // boolean/verdict gate value.
        expect(name).toBe("runCheckerOnDiff");
      }
    }
  });
});
