/**
 * eval-runner.ts — Eval harness invocation and scoring services.
 *
 * ADR-002: imports runShell from @platform/adapters/process-adapter.ts only.
 * NEVER imports node:child_process directly.
 *
 * Exports:
 * - parseSummary(stdout): { passed, failed, total } — pure, last-line scan
 * - decideGate(perSplit): { accepted, regressed } — pure, HOLDOUT ONLY (§7)
 * - decideCompositeGate(perStage, holistic): { accepted, regressed } — pure, ANDs decideGate's
 *   strict per-stage `>` with a holistic non-regression veto (`>=`) — the Goodhart guard (G4,
 *   watch_VVVVV2 / PR #332)
 * - resolveAgentEvalRoot(tmpDir, targetPath): string | null — pure target→suite resolution
 * - resolveHolisticEvalRoot(tmpDir, agentEvalRoot): string | null — pure holistic-suite resolution
 * - runSplit(tmpDir, split, opts): ProcessResult — calls runShell with explicit timeout
 * - PerSplit — type for per-split pass counts
 */

import { existsSync } from "node:fs";
import { join, normalize, sep } from "node:path";
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
  /**
   * Optional plugin sandbox directory (guardrail injection mode, ADR-0025).
   * When set, prefixes `EVAL_PLUGIN_DIR=<dir>` to the shell command so
   * run-evals.sh can pass `--plugin-dir <dir> --setting-sources project` to
   * the activating claude -p invocations, overriding the installed plugin.
   * Not set for eval-surface injection (ADR-0022) — only guardrail mode uses this.
   */
  pluginDir?: string;
  /**
   * Optional per-agent eval root (relative to tmpDir, e.g. "agents/reviewer/evals") resolved
   * by resolveAgentEvalRoot. When set, runSplit invokes that suite's run-agent-evals.sh
   * instead of the global skills/canon/evals/run-evals.sh. Not set → unchanged global behavior.
   */
  agentEvalRoot?: string;
  /**
   * Optional override for the `--eval-root` flag value (holistic-gate, G4). run-agent-evals.sh
   * always lives at `agentEvalRoot` (e.g. "agents/reviewer/evals") — this only overrides which
   * subdir's eval-set.json + fixtures it reads, e.g. "agents/reviewer/evals/holistic" for the
   * whole-PR holistic suite. Ignored when `agentEvalRoot` is unset. Defaults to `agentEvalRoot`
   * itself when omitted (unchanged per-stage behavior).
   */
  evalRootOverride?: string;
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
 * decideCompositeGate — pure function. Holistic §7 veto (G4, the Goodhart guard —
 * watch_VVVVV2 / PR #332).
 *
 * Composes the existing per-stage `decideGate` (unchanged, STRICT `>` on holdout) with a
 * whole-PR holistic suite that must NOT regress. The holistic term is a non-regression
 * VETO (`>=`), never a second improvement term — a stage-targeted mutation usually leaves
 * most golden-PR verdicts unchanged, so requiring holistic to also strictly improve would
 * make acceptance impossible in the common case.
 *
 * `holistic === null` (no holistic suite for this target) returns `perStageDecision`
 * unchanged — the documented backward-compatible path for whole-file/non-reviewer targets.
 *
 * The composite can only make acceptance STRICTER than the per-stage decision alone, never
 * looser: `accepted` requires both terms; `regressed` fires if either term regresses.
 */
export function decideCompositeGate(
  perStage: PerSplit,
  holistic: PerSplit | null,
): { accepted: boolean; regressed: boolean } {
  const perStageDecision = decideGate(perStage);
  if (holistic === null) return perStageDecision;

  const h = holistic.holdout;
  const holisticNonRegress = h.candidate_passed >= h.baseline_passed;
  const holisticRegressed = h.candidate_passed < h.baseline_passed;

  return {
    accepted: perStageDecision.accepted && holisticNonRegress,
    regressed: perStageDecision.regressed || holisticRegressed,
  };
}

/**
 * resolveAgentEvalRoot — pure target→suite resolution (eval-candidate-resolution).
 *
 * Returns `agents/<name>/evals` (relative to tmpDir) when targetPath matches an
 * agent-def path directly under `agents/` (e.g. `agents/reviewer.md`) AND
 * `<tmpDir>/agents/<name>/evals/run-agent-evals.sh` exists in the sandbox.
 * Returns `null` for any other targetPath, or when the per-agent suite is absent
 * (fail-open — caller falls back to the global run-evals.sh).
 *
 * Never throws. Pure aside from the one existsSync check.
 */
export function resolveAgentEvalRoot(tmpDir: string, targetPath: string): string | null {
  const parts = normalize(targetPath).split(sep);

  // Must be exactly "agents/<name>.md" — first segment "agents", one filename, ".md" suffix.
  if (parts.length !== 2 || parts[0] !== "agents") return null;

  const filename = parts[1];
  if (!filename.endsWith(".md")) return null;

  const name = filename.slice(0, -".md".length);
  if (!name) return null;

  const evalRoot = join("agents", name, "evals");
  const runnerPath = join(tmpDir, evalRoot, "run-agent-evals.sh");

  return existsSync(runnerPath) ? evalRoot : null;
}

/**
 * resolveHolisticEvalRoot — pure holistic-suite resolution (holistic-gate, G4).
 *
 * Given the per-stage `agentEvalRoot` returned by `resolveAgentEvalRoot` (e.g.
 * "agents/reviewer/evals"), returns the `holistic/` sub-suite path (e.g.
 * "agents/reviewer/evals/holistic") when `<tmpDir>/<agentEvalRoot>/holistic/eval-set.json`
 * exists in the sandbox. Returns `null` when absent (fail-open — caller skips the holistic
 * run and `decideCompositeGate` falls back to the per-stage-only decision).
 *
 * Never throws. Pure aside from the one existsSync check.
 */
export function resolveHolisticEvalRoot(tmpDir: string, agentEvalRoot: string): string | null {
  const holisticRoot = join(agentEvalRoot, "holistic");
  const evalFile = join(tmpDir, holisticRoot, "eval-set.json");
  return existsSync(evalFile) ? holisticRoot : null;
}

/**
 * runSplit — runs run-evals.sh (or, when `agentEvalRoot` is set, that suite's
 * run-agent-evals.sh) for a given split in the temp directory.
 *
 * Constructs the command with:
 * - optional --eval-root <agentEvalRoot> (per-agent suite dispatch)
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
  const {
    agentEvalRoot,
    dryRun = false,
    evalRootOverride,
    filter,
    judgeVotes = 1,
    pluginDir,
    structuredJudge = true,
  } = opts;

  // run-agent-evals.sh always lives at agentEvalRoot — evalRootOverride only changes which
  // subdir's eval-set.json + fixtures the `--eval-root` flag points the script at (holistic-gate, G4).
  const scriptPath = agentEvalRoot
    ? join(tmpDir, agentEvalRoot, "run-agent-evals.sh")
    : join(tmpDir, "skills", "canon", "evals", "run-evals.sh");

  const parts: string[] = ["bash", scriptPath];

  if (agentEvalRoot) {
    parts.push("--eval-root", evalRootOverride ?? agentEvalRoot);
  }

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

  const baseCommand = parts.join(" ");

  // Guardrail injection mode (ADR-0025): prefix EVAL_PLUGIN_DIR env var so
  // run-evals.sh passes --plugin-dir <tmpDir> to the activating claude -p runs.
  // runShell uses shell: true, so env-var prefix in the command string is safe.
  const command = pluginDir
    ? `EVAL_PLUGIN_DIR=${JSON.stringify(pluginDir)} ${baseCommand}`
    : baseCommand;

  return runShell(command, tmpDir, EVAL_TIMEOUT_MS);
}
