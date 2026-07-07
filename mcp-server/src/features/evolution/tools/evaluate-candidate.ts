/**
 * evaluate-candidate.ts — evaluate_candidate MCP tool handler.
 *
 * Thin handler: logic lives in services/eval-runner.ts and services/candidate-injection.ts.
 *
 * Contract:
 * - Returns ToolResult<EvaluateCandidateResult> — never throws for expected errors.
 * - Fail-closed: any subprocess error or timeout → ToolResult error (NOT an accept).
 * - §7 gate: strict holdout improvement only. Train/val numbers never enter accept decision.
 * - ADR-002: does NOT import node:child_process. Uses runShell via eval-runner.runSplit.
 */

import { readFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolError, toolOk } from "@shared/lib/tool-result.ts";
import { z } from "zod";
import {
  isGuardrailTarget,
  withInjectedCandidate,
  withInjectedGuardrailCandidate,
} from "../services/candidate-injection.ts";
import type { PerSplit } from "../services/eval-runner.ts";
import {
  decideGate,
  parseSummary,
  resolveAgentEvalRoot,
  runSplit,
} from "../services/eval-runner.ts";
import { checkFrontmatterImmutable } from "../services/frontmatter-guard.ts";

/** Input schema for evaluate_candidate. */
export const EvaluateCandidateInputSchema = z.object({
  candidate_text: z.string().describe("The candidate artifact text to evaluate"),
  project_dir: z
    .string()
    .describe("Absolute path to the project root (directory containing skills/canon/evals/)"),
  splits: z
    .array(z.enum(["train", "val", "holdout"]))
    .optional()
    .describe("Which splits to run (default: all three)"),
  target_path: z
    .string()
    .describe(
      "Path relative to project_dir where the candidate file should be injected " +
        "(e.g. 'skills/canon/evals/eval-set.json')",
    ),
});

type EvaluateCandidateInput = z.input<typeof EvaluateCandidateInputSchema>;

/** Per-split scoring detail returned in the result. */
type PerSplitResult = {
  baseline_passed: number;
  candidate_passed: number;
  total: number;
};

/** Full result shape for evaluate_candidate. */
// canon:allow-unwired: evaluate_candidate contract type consumed by the future evolve-loop (Phase-1 deliverable 4/5, out of scope this build) + evolution tests
export type EvaluateCandidateResult = {
  /** Holdout baseline pass count (convenience — matches per_split.holdout.baseline_passed). */
  baseline_score: number;
  /** Holdout candidate pass count (convenience — matches per_split.holdout.candidate_passed). */
  candidate_score: number;
  /** Per-split detailed scores. */
  per_split: Record<"train" | "val" | "holdout", PerSplitResult>;
  /** True iff candidate improved holdout (strict > baseline). §7 gate result. */
  accepted: boolean;
  /** True iff candidate regressed holdout vs baseline. */
  regressed: boolean;
  /** Candidate text length minus baseline file length (chars). Signal only, not a gate term. */
  size_delta: number;
  /** Number of judge votes used on the holdout gate run. Documents AC#7. */
  judge_votes_holdout: number;
  /**
   * Present ONLY when the runtime frontmatter-reject guard rejected an agent-def candidate
   * before any subprocess ran (TASK-003, dc-08). Additive-optional — existing consumers
   * already treat `accepted:false` as "do not propose"; this field adds a typed reason.
   */
  guard_rejection?: {
    reason: "frontmatter_modified" | "frontmatter_unverifiable";
    fields?: string[];
  };
};

/** Number of judge votes for the holdout gate run (AC#7, evaluate-candidate-04). */
const HOLDOUT_JUDGE_VOTES = 3;

/** One scored run (parse result from stdout). */
type SummaryScore = { passed: number; failed: number; total: number };

/** Run one split (baseline or candidate) inside an injected temp dir. */
async function runOneSplit(
  projectDir: string,
  fileContent: string,
  targetPath: string,
  split: "train" | "val" | "holdout",
): Promise<ToolResult<SummaryScore>> {
  const judgeVotes = split === "holdout" ? HOLDOUT_JUDGE_VOTES : 1;

  // Auto-select injection mode based on target_path (ADR-0025):
  // - Guardrail-corpus targets (rules/, agents/, primers/, etc.) → full plugin sandbox injection.
  //   The sandbox is passed as pluginDir so run-evals.sh loads the rewritten guardrail artifact.
  // - Eval-surface targets (skills/canon/evals/**) → eval-surface injection (ADR-0022, unchanged).
  //
  // Suite selection (eval-candidate-resolution) is likewise DERIVED from target_path — no new
  // input field. Inside the guardrail sandbox, resolveAgentEvalRoot checks whether target_path
  // is an agent-def with a per-agent eval suite present; when it is, runSplit dispatches to that
  // suite's run-agent-evals.sh instead of the global run-evals.sh. Absent suite → null → the
  // global runner (today's behavior), same fail-open fallback as the injection-mode dispatch.
  const result = isGuardrailTarget(targetPath)
    ? await withInjectedGuardrailCandidate(projectDir, fileContent, targetPath, async (tmpDir) => {
        const agentEvalRoot = resolveAgentEvalRoot(tmpDir, targetPath) ?? undefined;
        return runSplit(tmpDir, split, {
          agentEvalRoot,
          judgeVotes,
          pluginDir: tmpDir,
          structuredJudge: true,
        });
      })
    : await withInjectedCandidate(projectDir, fileContent, targetPath, async (tmpDir) =>
        runSplit(tmpDir, split, { judgeVotes, structuredJudge: true }),
      );

  // Timeout is always fail-closed — even if stdout contains a summary line, we reject.
  if (result.timedOut) {
    return toolError(
      "UNEXPECTED",
      `Eval script timed out during ${split} run. Timed-out gate is a rejection.`,
      false,
      { split, stderr: result.stderr },
    );
  }

  // run-evals.sh exits 1 whenever FAILED > 0 || ERRORS > 0 — a nonzero exit with a
  // parseable summary line is a valid eval result (e.g. baseline 2/3 failing cases).
  // Only treat as an infra error when there is NO parseable summary in stdout.
  const summary = parseSummary(result.stdout);
  if (!result.ok && summary.total === 0) {
    return toolError(
      "UNEXPECTED",
      `Eval script failed during ${split} run with no parseable summary: ${result.stderr || result.stdout}`,
      false,
      { exitCode: result.exitCode, split, stderr: result.stderr },
    );
  }

  return toolOk(summary);
}

/** Run all requested splits in parallel; fail-closed on first error. */
async function runAllSplits(
  projectDir: string,
  fileContent: string,
  targetPath: string,
  splits: Array<"train" | "val" | "holdout">,
): Promise<ToolResult<Partial<Record<"train" | "val" | "holdout", SummaryScore>>>> {
  const scores: Partial<Record<"train" | "val" | "holdout", SummaryScore>> = {};

  const results = await Promise.all(
    splits.map((split) => runOneSplit(projectDir, fileContent, targetPath, split)),
  );

  for (let i = 0; i < splits.length; i++) {
    const result = results[i];
    if (!result.ok) return result;
    scores[splits[i]] = { failed: result.failed, passed: result.passed, total: result.total };
  }

  return toolOk(scores);
}

/** True iff targetPath's first path segment is "agents" (an agent-def artifact). */
function isAgentDefTarget(targetPath: string): boolean {
  const normalized = normalize(targetPath);
  return normalized.split(sep)[0] === "agents";
}

/** Build the zeroed-out rejection result for a frontmatter-guard reject (dc-08). */
function buildGuardRejectionResult(
  reason: "frontmatter_modified" | "frontmatter_unverifiable",
  fields: string[] | undefined,
): EvaluateCandidateResult {
  const emptySplit: PerSplitResult = { baseline_passed: 0, candidate_passed: 0, total: 0 };
  return {
    accepted: false,
    baseline_score: 0,
    candidate_score: 0,
    guard_rejection: fields ? { fields, reason } : { reason },
    judge_votes_holdout: HOLDOUT_JUDGE_VOTES,
    per_split: { holdout: emptySplit, train: emptySplit, val: emptySplit },
    regressed: false,
    size_delta: 0,
  };
}

/** Cheap dry-run sanity check — verifies the eval script is reachable. */
async function checkScriptReachable(
  projectDir: string,
  candidateText: string,
  targetPath: string,
): Promise<ToolResult<{ ok: true }>> {
  // Same mode auto-selection as runOneSplit (ADR-0025).
  const check = isGuardrailTarget(targetPath)
    ? await withInjectedGuardrailCandidate(projectDir, candidateText, targetPath, async (tmpDir) =>
        runSplit(tmpDir, "train", {
          dryRun: true,
          judgeVotes: 1,
          pluginDir: tmpDir,
          structuredJudge: false,
        }),
      )
    : await withInjectedCandidate(projectDir, candidateText, targetPath, async (tmpDir) =>
        runSplit(tmpDir, "train", { dryRun: true, judgeVotes: 1, structuredJudge: false }),
      );

  if (check.timedOut) {
    return toolError(
      "UNEXPECTED",
      `Eval script timed out during sanity check (${check.duration_ms}ms). Timed-out gate is a rejection.`,
      false,
      { stderr: check.stderr },
    );
  }

  if (!check.ok && (check.stderr.includes("No such file") || check.stderr.includes("ENOENT"))) {
    return toolError(
      "UNEXPECTED",
      `Eval script not found during sanity check: ${check.stderr}`,
      false,
      { stderr: check.stderr },
    );
  }

  return toolOk({ ok: true as const });
}

/** Build PerSplit from scored baseline and candidate maps. */
function buildPerSplit(
  baseline: Partial<Record<"train" | "val" | "holdout", SummaryScore>>,
  candidate: Partial<Record<"train" | "val" | "holdout", SummaryScore>>,
): PerSplit {
  const bHoldout = baseline.holdout ?? { failed: 0, passed: 0, total: 0 };
  const cHoldout = candidate.holdout ?? { failed: 0, passed: 0, total: 0 };
  return {
    holdout: {
      baseline_passed: bHoldout.passed,
      candidate_passed: cHoldout.passed,
      total: bHoldout.total,
    },
    train: {
      baseline_passed: baseline.train?.passed ?? 0,
      candidate_passed: candidate.train?.passed ?? 0,
      total: baseline.train?.total ?? 0,
    },
    val: {
      baseline_passed: baseline.val?.passed ?? 0,
      candidate_passed: candidate.val?.passed ?? 0,
      total: baseline.val?.total ?? 0,
    },
  };
}

/**
 * evaluateCandidate — main handler.
 *
 * Layered cheap→expensive (AC#6):
 * 1. Dry-run sanity check.
 * 2. Baseline + candidate splits run in parallel.
 * 3. decideGate on holdout only (§7).
 */
export async function evaluateCandidate(
  input: EvaluateCandidateInput,
): Promise<ToolResult<EvaluateCandidateResult>> {
  const { candidate_text, project_dir, splits: requestedSplits, target_path } = input;
  const requestedSplitsOrDefault: Array<"train" | "val" | "holdout"> = requestedSplits ?? [
    "train",
    "val",
    "holdout",
  ];
  const splitsWithHoldout = requestedSplitsOrDefault.includes("holdout")
    ? requestedSplitsOrDefault
    : [...requestedSplitsOrDefault, "holdout" as const];

  let realContent = "";
  // Baseline-absent is a valid first run — fall back to a fresh baseline eval rather than failing.
  try {
    realContent = await readFile(join(project_dir, target_path), "utf-8");
  } catch {
    realContent = "";
  }

  // TASK-003 (dc-08): agent-def candidates are rejected BEFORE any subprocess if their
  // frontmatter block differs from baseline. Fail-closed, never throws. Skipped for
  // non-agent-def targets (unchanged behavior).
  if (isAgentDefTarget(target_path)) {
    const fmResult = checkFrontmatterImmutable(realContent, candidate_text);
    if (!fmResult.ok) {
      return toolOk(buildGuardRejectionResult(fmResult.reason, fmResult.fields));
    }
  }

  const sanityCheck = await checkScriptReachable(project_dir, candidate_text, target_path);
  if (!sanityCheck.ok) return sanityCheck;

  const [baselineResult, candidateResult] = await Promise.all([
    runAllSplits(project_dir, realContent, target_path, splitsWithHoldout),
    runAllSplits(project_dir, candidate_text, target_path, splitsWithHoldout),
  ]);

  if (!baselineResult.ok) return baselineResult;
  if (!candidateResult.ok) return candidateResult;

  const perSplit = buildPerSplit(baselineResult, candidateResult);
  const { accepted, regressed } = decideGate(perSplit);

  return toolOk({
    accepted,
    baseline_score: perSplit.holdout.baseline_passed,
    candidate_score: perSplit.holdout.candidate_passed,
    judge_votes_holdout: HOLDOUT_JUDGE_VOTES,
    per_split: {
      holdout: {
        baseline_passed: perSplit.holdout.baseline_passed,
        candidate_passed: perSplit.holdout.candidate_passed,
        total: perSplit.holdout.total,
      },
      train: {
        baseline_passed: perSplit.train.baseline_passed,
        candidate_passed: perSplit.train.candidate_passed,
        total: perSplit.train.total,
      },
      val: {
        baseline_passed: perSplit.val.baseline_passed,
        candidate_passed: perSplit.val.candidate_passed,
        total: perSplit.val.total,
      },
    },
    regressed,
    size_delta: candidate_text.length - realContent.length,
  });
}
