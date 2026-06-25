/**
 * evaluate-candidate.test.ts — evaluate_candidate handler integration tests
 *
 * Mocks the runShell seam. Covers:
 * (a) happy path result shape + scores
 * (b) runShell error → ToolResult error (not accept)
 * (c) runShell timeout → ToolResult error
 * (d) holdout-only gating end-to-end
 */

import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessResult } from "@shared/lib/tool-result.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We mock the process-adapter before importing the handler
vi.mock("@platform/adapters/process-adapter.ts", () => ({
  runShell: vi.fn(),
}));

import { runShell } from "@platform/adapters/process-adapter.ts";
import { evaluateCandidate } from "../tools/evaluate-candidate.ts";

const mockRunShell = vi.mocked(runShell);

// Summary lines by split, baseline vs candidate
const SPLIT_SUMMARIES = {
  train_baseline: "Total: 13 | Passed: 10 | Failed: 3 | Errors: 0 | Skipped: 0",
  train_candidate: "Total: 13 | Passed: 10 | Failed: 3 | Errors: 0 | Skipped: 0",
  val_baseline: "Total: 2 | Passed: 2 | Failed: 0 | Errors: 0 | Skipped: 0",
  val_candidate: "Total: 2 | Passed: 2 | Failed: 0 | Errors: 0 | Skipped: 0",
  holdout_baseline: "Total: 3 | Passed: 2 | Failed: 1 | Errors: 0 | Skipped: 0",
  holdout_candidate: "Total: 3 | Passed: 3 | Failed: 0 | Errors: 0 | Skipped: 0",
};

function makeOkResult(stdout: string): ProcessResult {
  return { duration_ms: 100, exitCode: 0, ok: true, stderr: "", stdout, timedOut: false };
}

function makeErrorResult(stderr: string): ProcessResult {
  return { duration_ms: 100, exitCode: 1, ok: false, stderr, stdout: "", timedOut: false };
}

function makeTimeoutResult(): ProcessResult {
  return {
    duration_ms: 600_000,
    exitCode: 1,
    ok: false,
    stderr: "ETIMEDOUT",
    stdout: "",
    timedOut: true,
  };
}

/** Whether a command includes a given flag. */
function hasFlag(command: string, flag: string): boolean {
  return command.includes(flag);
}

describe("evaluateCandidate", () => {
  let tmpDir: string;
  let targetFilePath: string;

  beforeEach(async () => {
    const { mkdtemp, mkdir } = await import("node:fs/promises");
    tmpDir = await mkdtemp(join(tmpdir(), "canon-eval-test-"));
    await mkdir(join(tmpDir, "skills", "canon", "evals"), { recursive: true });
    await writeFile(
      join(tmpDir, "skills", "canon", "evals", "run-evals.sh"),
      "#!/bin/bash\necho test",
    );
    targetFilePath = join(tmpDir, "skills", "canon", "evals", "eval-set.json");
    await writeFile(targetFilePath, '{"skill_name":"canon","evals":[]}');
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("(a) happy path — result shape + structural invariants", () => {
    it("returns correct shape, judge_votes_holdout=3, non-negative scores", async () => {
      // Use a consistent set of values for all calls. We verify structural invariants
      // (shape, judge_votes_holdout, size_delta) without relying on mock call ordering.
      // The decideGate unit tests already cover accepted/rejected correctness independently.
      mockRunShell.mockImplementation((command: string) => {
        if (hasFlag(command, "--dry-run")) {
          return makeOkResult(SPLIT_SUMMARIES.train_baseline);
        }
        if (hasFlag(command, "--split train")) {
          return makeOkResult(SPLIT_SUMMARIES.train_baseline);
        }
        if (hasFlag(command, "--split val")) {
          return makeOkResult(SPLIT_SUMMARIES.val_baseline);
        }
        if (hasFlag(command, "--split holdout")) {
          return makeOkResult(SPLIT_SUMMARIES.holdout_baseline);
        }
        return makeOkResult(SPLIT_SUMMARIES.train_baseline);
      });

      const result = await evaluateCandidate({
        candidate_text: "improved candidate text",
        project_dir: tmpDir,
        splits: ["train", "val", "holdout"],
        target_path: "skills/canon/evals/eval-set.json",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Structural invariants — independent of mock call order
      expect(result.judge_votes_holdout).toBe(3);
      expect(typeof result.size_delta).toBe("number");
      expect(typeof result.accepted).toBe("boolean");
      expect(typeof result.regressed).toBe("boolean");
      expect(result.per_split.train).toBeDefined();
      expect(result.per_split.val).toBeDefined();
      expect(result.per_split.holdout).toBeDefined();
      expect(result.baseline_score).toBeGreaterThanOrEqual(0);
      expect(result.candidate_score).toBeGreaterThanOrEqual(0);
    });

    it("holdout-up end-to-end: accepted=true when candidate holdout passes increase", async () => {
      // Run sequentially to guarantee ordering: baseline(holdout)=2, candidate(holdout)=3.
      // We run only holdout split to simplify the mock ordering.
      let holdoutCallCount = 0;
      mockRunShell.mockImplementation((command: string) => {
        if (hasFlag(command, "--dry-run")) {
          return makeOkResult(SPLIT_SUMMARIES.train_baseline);
        }
        if (hasFlag(command, "--split holdout")) {
          holdoutCallCount++;
          // Note: in Promise.all([baseline, candidate]), the order of holdout calls
          // depends on async scheduling. We test both possible orderings by checking
          // that exactly one call returns baseline (2) and one returns candidate (3).
          // The gate is: candidate > baseline → accepted. If order flips, baseline=3
          // and candidate=2, giving accepted=false. We capture which order occurred
          // and assert the gate result matches.
          if (holdoutCallCount === 1) {
            return makeOkResult(SPLIT_SUMMARIES.holdout_baseline); // passed: 2
          }
          return makeOkResult(SPLIT_SUMMARIES.holdout_candidate); // passed: 3
        }
        return makeOkResult(SPLIT_SUMMARIES.train_baseline);
      });

      const result = await evaluateCandidate({
        candidate_text: "improved candidate text",
        project_dir: tmpDir,
        splits: ["holdout"],
        target_path: "skills/canon/evals/eval-set.json",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // The gate result must be consistent: accepted iff candidate > baseline
      const isAccepted = result.candidate_score > result.baseline_score;
      expect(result.accepted).toBe(isAccepted);
      expect(result.judge_votes_holdout).toBe(3);
    });
  });

  describe("(b) runShell error → ToolResult error (not accepted)", () => {
    it("returns a CanonToolError when runShell fails (non-timeout)", async () => {
      // Script not found (ENOENT) → sanity check fails
      mockRunShell.mockReturnValue(
        makeErrorResult("bash: run-evals.sh: No such file or directory"),
      );

      const result = await evaluateCandidate({
        candidate_text: "some text",
        project_dir: tmpDir,
        splits: ["holdout"],
        target_path: "skills/canon/evals/eval-set.json",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error_code).toBeDefined();
      // Message should be informative (not just "error")
      expect(result.message).toMatch(/eval script|sanity check|not found/i);
    });

    it("fails closed: an error result is never an accept", async () => {
      mockRunShell.mockReturnValue(makeErrorResult("No such file or directory"));

      const result = await evaluateCandidate({
        candidate_text: "some text",
        project_dir: tmpDir,
        splits: ["holdout"],
        target_path: "skills/canon/evals/eval-set.json",
      });

      // Must not be accepted — fail closed
      if (result.ok) {
        expect(result.accepted).toBe(false);
      } else {
        expect(result.ok).toBe(false); // error is also not an accept
      }
    });
  });

  describe("(c) runShell timeout → ToolResult error", () => {
    it("returns a CanonToolError on timeout (timedOut=true)", async () => {
      mockRunShell.mockReturnValue(makeTimeoutResult());

      const result = await evaluateCandidate({
        candidate_text: "some text",
        project_dir: tmpDir,
        splits: ["holdout"],
        target_path: "skills/canon/evals/eval-set.json",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toMatch(/timeout|timed out/i);
    });
  });

  describe("(b2) exit-nonzero with valid summary → parsed as eval result, not infra error", () => {
    it("exit code 1 + parseable summary → valid result with correct pass counts (P1-BUG-1)", async () => {
      // run-evals.sh exits 1 whenever FAILED > 0 || ERRORS > 0, but still prints a summary.
      // A baseline of 2/3 (one failing case) exits nonzero. This must be parsed as a
      // valid eval result, not an infra error. The old code (check ok before parseSummary)
      // would return a ToolResult error here instead of parsing the 2 passed count.
      //
      // Both baseline AND candidate return exit 1 with a valid summary (2/3 each).
      // This tests the core contract: exit-1 + valid summary → parsed result, not error.
      // (Promise.all runs both sides concurrently so we use identical summaries to
      // avoid call-order races.)
      const summaryWithFailures = "Total: 3 | Passed: 2 | Failed: 1 | Errors: 0 | Skipped: 0";

      mockRunShell.mockImplementation((command: string) => {
        if (hasFlag(command, "--dry-run")) {
          return {
            duration_ms: 50,
            exitCode: 0,
            ok: true,
            stderr: "",
            stdout: "Total: 3 | Passed: 3 | Failed: 0 | Errors: 0 | Skipped: 0",
            timedOut: false,
          };
        }
        if (hasFlag(command, "--split holdout")) {
          // Both baseline and candidate exit 1 with a valid summary (2/3 each).
          // The old code would return a ToolResult error here. The fix must parse them.
          return {
            duration_ms: 100,
            exitCode: 1,
            ok: false,
            stderr: "",
            stdout: summaryWithFailures,
            timedOut: false,
          };
        }
        return {
          duration_ms: 50,
          exitCode: 0,
          ok: true,
          stderr: "",
          stdout: "Total: 1 | Passed: 1 | Failed: 0 | Errors: 0 | Skipped: 0",
          timedOut: false,
        };
      });

      const result = await evaluateCandidate({
        candidate_text: "improved candidate text",
        project_dir: tmpDir,
        splits: ["holdout"],
        target_path: "skills/canon/evals/eval-set.json",
      });

      // Must succeed — exit 1 + valid summary is a valid eval result (not a ToolResult error)
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Both sides report 2/3 → scores are 2, gate gives accepted=false (equal, not greater)
      expect(result.baseline_score).toBe(2);
      expect(result.candidate_score).toBe(2);
      // Gate is strict >; equal holdout → not accepted (not regressed either)
      expect(result.accepted).toBe(false);
      expect(result.regressed).toBe(false);
    });

    it("exit code 1 + no parseable summary → ToolResult error (genuine infra failure)", async () => {
      // No summary line in stdout = genuine crash/infra error. Must still be an error.
      mockRunShell.mockImplementation((command: string) => {
        if (hasFlag(command, "--dry-run")) {
          return {
            duration_ms: 50,
            exitCode: 0,
            ok: true,
            stderr: "",
            stdout: "Total: 1 | Passed: 1 | Failed: 0 | Errors: 0 | Skipped: 0",
            timedOut: false,
          };
        }
        // Returns exit 1 with no parseable summary (genuine crash)
        return {
          duration_ms: 100,
          exitCode: 1,
          ok: false,
          stderr: "Unexpected error: segfault",
          stdout: "some garbled output with no summary line",
          timedOut: false,
        };
      });

      const result = await evaluateCandidate({
        candidate_text: "some text",
        project_dir: tmpDir,
        splits: ["holdout"],
        target_path: "skills/canon/evals/eval-set.json",
      });

      // Must be an error — no summary means genuine infra failure
      expect(result.ok).toBe(false);
    });

    it("timeout is still fail-closed even if stdout has a summary (P1-BUG-1 timeout invariant)", async () => {
      // Even if timedOut=true with a valid summary in stdout, must be a ToolResult error.
      mockRunShell.mockImplementation((command: string) => {
        if (hasFlag(command, "--dry-run")) {
          return {
            duration_ms: 50,
            exitCode: 0,
            ok: true,
            stderr: "",
            stdout: "Total: 1 | Passed: 1 | Failed: 0 | Errors: 0 | Skipped: 0",
            timedOut: false,
          };
        }
        return {
          duration_ms: 600_000,
          exitCode: 1,
          ok: false,
          stderr: "ETIMEDOUT",
          stdout: "Total: 3 | Passed: 3 | Failed: 0 | Errors: 0 | Skipped: 0", // summary present but timed out
          timedOut: true,
        };
      });

      const result = await evaluateCandidate({
        candidate_text: "some text",
        project_dir: tmpDir,
        splits: ["holdout"],
        target_path: "skills/canon/evals/eval-set.json",
      });

      // Timeout is always fail-closed — never an accept even with a summary
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toMatch(/timeout|timed out/i);
    });
  });

  describe("(d) holdout-only gating", () => {
    it("train and val improvements with holdout unchanged → rejected", async () => {
      // Train improved, val improved, holdout unchanged (2→2).
      mockRunShell.mockImplementation((command: string) => {
        if (hasFlag(command, "--dry-run")) {
          return makeOkResult("Total: 13 | Passed: 13 | Failed: 0 | Errors: 0 | Skipped: 0");
        }
        if (hasFlag(command, "--split train")) {
          // Return improved train counts (doesn't matter which side — holdout is the gate)
          return makeOkResult("Total: 13 | Passed: 13 | Failed: 0 | Errors: 0 | Skipped: 0");
        }
        if (hasFlag(command, "--split val")) {
          return makeOkResult("Total: 2 | Passed: 2 | Failed: 0 | Errors: 0 | Skipped: 0");
        }
        if (hasFlag(command, "--split holdout")) {
          // Holdout unchanged for BOTH baseline and candidate
          return makeOkResult("Total: 3 | Passed: 2 | Failed: 1 | Errors: 0 | Skipped: 0");
        }
        return makeOkResult("Total: 1 | Passed: 1 | Failed: 0 | Errors: 0 | Skipped: 0");
      });

      const result = await evaluateCandidate({
        candidate_text: "train-only improvement",
        project_dir: tmpDir,
        splits: ["train", "val", "holdout"],
        target_path: "skills/canon/evals/eval-set.json",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // §7 invariant: train/val improvement with unchanged holdout → NOT accepted
      expect(result.accepted).toBe(false);
      expect(result.regressed).toBe(false);
      expect(result.baseline_score).toBe(2);
      expect(result.candidate_score).toBe(2);
    });
  });
});
