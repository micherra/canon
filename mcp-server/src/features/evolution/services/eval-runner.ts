/**
 * eval-runner.ts — Eval harness invocation and scoring services.
 *
 * ADR-002: imports runShell from @platform/adapters/process-adapter.ts only.
 * NEVER imports node:child_process directly.
 *
 * Exports:
 * - parseSummary(stdout): { passed, failed, total } — pure, last-line scan
 * - decideGate(perSplit): { accepted, regressed } — pure, HOLDOUT ONLY (§7)
 * - runSplit(tmpDir, split, opts): ProcessResult — calls runShell with explicit timeout
 * - PerSplit — type for per-split pass counts
 */

import { join } from "node:path";
import { runShell } from "@platform/adapters/process-adapter.ts";
import type { ProcessResult } from "@shared/lib/tool-result.ts";

/** Explicit timeout for eval runs — 10 minutes. The default 30s is too short. */
const EVAL_TIMEOUT_MS = 600_000;

/** Summary regex — captures Total, Passed, Failed counts from run-evals.sh output. */
const SUMMARY_RE =
  /Total:\s*(\d+)\s*\|\s*Passed:\s*(\d+)\s*\|\s*Failed:\s*(\d+)\s*\|\s*Errors:\s*\d+\s*\|\s*Skipped:\s*\d+/g;

/** Per-split scoring record. */
type SplitScore = {
  baseline_passed: number;
  candidate_passed: number;
  total: number;
};

/** Full per-split scoring record covering all three splits. */
export type PerSplit = {
  holdout: SplitScore;
  train: SplitScore;
  val: SplitScore;
};

/** Options for runSplit. */
type RunSplitOpts = {
  /** Number of judge votes. Default 1. Holdout gate should use 3. */
  judgeVotes?: number;
  /** Whether to pass --dry-run (skips real LLM calls). */
  dryRun?: boolean;
  /** Optional --filter substring for cheap subset runs. */
  filter?: string;
  /** Whether to pass --structured-judge. Default true for gate runs. */
  structuredJudge?: boolean;
};

/**
 * parseSummary — pure function.
 *
 * Parses the `Total: N | Passed: N | Failed: N | Errors: N | Skipped: N` summary
 * line from run-evals.sh stdout. Scans from the END to tolerate 512KB truncation
 * (the last summary line is the authoritative one).
 *
 * Returns { passed: 0, failed: 0, total: 0 } for malformed or empty input.
 */
export function parseSummary(stdout: string): { passed: number; failed: number; total: number } {
  // Reset lastIndex before scanning (regex has global flag)
  SUMMARY_RE.lastIndex = 0;

  let lastMatch: RegExpExecArray | null = null;

  // Scan the whole string — the last match wins (tolerates 512KB prefix garbage)
  let match = SUMMARY_RE.exec(stdout);
  while (match !== null) {
    lastMatch = match;
    match = SUMMARY_RE.exec(stdout);
  }

  if (!lastMatch) {
    return { failed: 0, passed: 0, total: 0 };
  }

  return {
    failed: parseInt(lastMatch[3], 10),
    passed: parseInt(lastMatch[2], 10),
    total: parseInt(lastMatch[1], 10),
  };
}

/**
 * decideGate — pure function. §7 evolution hard gate.
 *
 * Accept iff candidate_holdout_passed > baseline_holdout_passed (strict greater-than).
 * Train and val are NEVER read here — this is a non-negotiable anti-overfitting guard.
 */
export function decideGate(perSplit: PerSplit): { accepted: boolean; regressed: boolean } {
  const h = perSplit.holdout;
  return {
    accepted: h.candidate_passed > h.baseline_passed,
    regressed: h.candidate_passed < h.baseline_passed,
  };
}

/**
 * runSplit — runs run-evals.sh for a given split in the temp directory.
 *
 * Constructs the command with:
 * - --split <split>
 * - --structured-judge (always for gate runs)
 * - --judge-votes <N>
 * - optional --filter
 * - optional --dry-run
 *
 * Uses an explicit EVAL_TIMEOUT_MS to override the 30s default.
 * A timedOut result must be treated as failure (fail-closed) by the caller.
 */
export function runSplit(
  tmpDir: string,
  split: "train" | "val" | "holdout" | "all",
  opts: RunSplitOpts = {},
): ProcessResult {
  const { dryRun = false, filter, judgeVotes = 1, structuredJudge = true } = opts;

  const scriptPath = join(tmpDir, "skills", "canon", "evals", "run-evals.sh");

  const parts: string[] = ["bash", scriptPath];

  if (split !== "all") {
    parts.push("--split", split);
  }

  if (structuredJudge) {
    parts.push("--structured-judge");
  }

  if (judgeVotes > 1) {
    parts.push("--judge-votes", String(judgeVotes));
  }

  if (filter !== undefined) {
    parts.push("--filter", filter);
  }

  if (dryRun) {
    parts.push("--dry-run");
  }

  const command = parts.join(" ");

  return runShell(command, tmpDir, EVAL_TIMEOUT_MS);
}
