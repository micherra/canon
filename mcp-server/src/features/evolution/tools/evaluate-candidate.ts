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
import type { ProcessResult, ToolResult } from "@shared/lib/tool-result.ts";
import { toolError, toolOk } from "@shared/lib/tool-result.ts";
import { z } from "zod";
import {
  isGuardrailTarget,
  withInjectedCandidate,
  withInjectedGuardrailCandidate,
} from "../services/candidate-injection.ts";
import type { PerSplit } from "../services/eval-runner.ts";
import {
  decideCompositeGate,
  parseSummary,
  resolveAgentEvalRoot,
  resolveHolisticEvalRoot,
  runSplit,
} from "../services/eval-runner.ts";
import type { FrontmatterGuardResult } from "../services/frontmatter-guard.ts";
import {
  checkFrontmatterImmutable,
  checkPrincipleFrontmatterImmutable,
} from "../services/frontmatter-guard.ts";

/** Input schema for evaluate_candidate. */
export const EvaluateCandidateInputSchema = z.object({
  candidate_text: z.string().describe("The candidate artifact text to evaluate"),
  project_dir: z
    .string()
    .describe("Absolute path to the project root (directory containing skills/canon/evals/)"),
  proposal_kind: z
    .enum(["rewrite", "retire", "reinforce"])
    .optional()
    .describe(
      "Distinguishes a wording-REWRITE candidate from an ADR-0052 RETIRE candidate. " +
        "Only affects the principles/ frontmatter guard's archived:true exception — " +
        "ONLY 'retire' tolerates a candidate that flips archived; omitted/'rewrite'/" +
        "'reinforce' all reject it (fail-closed default; a reinforce candidate never " +
        "reaches this gate in practice — it is emitted ungated, see mutation-proposal.ts).",
    ),
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
  /**
   * True iff the composite holistic gate accepts: per-stage holdout strictly improved
   * (§7, unchanged) AND, when a holistic suite exists for this target, the whole-PR
   * holistic holdout did not regress (G4, watch_VVVVV2 / PR #332). Absent holistic suite
   * → equals the per-stage-only §7 decision (backward-compatible).
   */
  accepted: boolean;
  /** True iff candidate regressed holdout on either the per-stage or the holistic suite. */
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
    reason: "frontmatter_modified" | "frontmatter_unverifiable" | "overlay_not_sandboxable";
    fields?: string[];
  };
  /**
   * Present ONLY when a `holistic/` eval suite exists for this target (holistic-gate, G4).
   * Additive-optional — mirrors the `guard_rejection?` precedent; existing consumers
   * already read the composite `accepted`/`regressed` fields unaffected.
   */
  holistic?: PerSplitResult;
};

/** Number of judge votes for the holdout gate run (AC#7, evaluate-candidate-04). */
const HOLDOUT_JUDGE_VOTES = 3;

/** One scored run (parse result from stdout). */
type SummaryScore = { passed: number; failed: number; total: number; errors: number };

/** One split's per-stage score plus (when a holistic suite exists) its holistic score. */
type SplitScoreWithHolistic = { perStage: SummaryScore; holistic: SummaryScore | null };

/** Raw process results for one split before summary parsing/error handling. */
type RawSplitRun = { perStage: ProcessResult; holistic: ProcessResult | null };

/**
 * scoreRun — apply the shared fail-closed timeout/error/summary-parse contract to one
 * raw ProcessResult. Timeout is always fail-closed. A nonzero exit is an infra error when
 * there's no parseable summary line (run-evals.sh exits 1 whenever FAILED>0||ERRORS>0,
 * which is a valid eval result, not a crash) OR when the summary itself reports runner
 * errors (`errors > 0`) — a summary line can appear even when the harness never actually
 * ran (e.g. run-agent-evals.sh's fail-closed missing-fixture path prints
 * `Errors: 1 | Total: 1 | Passed: 0`), which must not be scored as a valid 0-pass result.
 * A nonzero exit that is purely FAILED eval cases (`errors === 0, total > 0`) remains a
 * valid result and is still scored.
 */
function scoreRun(result: ProcessResult, label: string): ToolResult<SummaryScore> {
  if (result.timedOut) {
    return toolError(
      "UNEXPECTED",
      `Eval script timed out during ${label} run. Timed-out gate is a rejection.`,
      false,
      { label, stderr: result.stderr },
    );
  }

  const summary = parseSummary(result.stdout);
  if (!result.ok && (summary.total === 0 || summary.errors > 0)) {
    return toolError(
      "UNEXPECTED",
      `Eval script failed during ${label} run with no parseable summary: ${result.stderr || result.stdout}`,
      false,
      { exitCode: result.exitCode, label, stderr: result.stderr },
    );
  }

  return toolOk(summary);
}

/** Run one split (baseline or candidate) inside an injected temp dir. */
async function runOneSplit(
  projectDir: string,
  fileContent: string,
  targetPath: string,
  split: "train" | "val" | "holdout",
): Promise<ToolResult<SplitScoreWithHolistic>> {
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
  //
  // Mandatory holistic verdict gate (holistic-gate, G4, watch_VVVVV2 / PR #332): when a
  // per-agent suite is resolved AND its holdout split is being run, also probe for a
  // `holistic/` sub-suite in the SAME sandbox and run it too. Holdout-only, mirroring
  // decideGate's own holdout-only philosophy — the composite gate never reads train/val
  // holistic scores, so they're never run.
  const raw: RawSplitRun = isGuardrailTarget(targetPath)
    ? await withInjectedGuardrailCandidate(projectDir, fileContent, targetPath, async (tmpDir) => {
        const agentEvalRoot = resolveAgentEvalRoot(tmpDir, targetPath) ?? undefined;
        const perStage = runSplit(tmpDir, split, {
          agentEvalRoot,
          judgeVotes,
          pluginDir: tmpDir,
          structuredJudge: true,
        });

        const holisticEvalRoot =
          agentEvalRoot && split === "holdout"
            ? resolveHolisticEvalRoot(tmpDir, agentEvalRoot)
            : null;
        const holistic = holisticEvalRoot
          ? runSplit(tmpDir, split, {
              agentEvalRoot,
              evalRootOverride: holisticEvalRoot,
              judgeVotes,
              pluginDir: tmpDir,
              structuredJudge: true,
            })
          : null;

        return { holistic, perStage };
      })
    : {
        holistic: null,
        perStage: await withInjectedCandidate(projectDir, fileContent, targetPath, async (tmpDir) =>
          runSplit(tmpDir, split, { judgeVotes, structuredJudge: true }),
        ),
      };

  const perStageResult = scoreRun(raw.perStage, split);
  if (!perStageResult.ok) return perStageResult;
  const perStage: SummaryScore = perStageResult;

  if (!raw.holistic) {
    return toolOk({ holistic: null, perStage });
  }

  // Fail-closed: an error on EITHER suite is never an accept.
  const holisticResult = scoreRun(raw.holistic, `${split} (holistic)`);
  if (!holisticResult.ok) return holisticResult;
  const holistic: SummaryScore = holisticResult;

  return toolOk({ holistic, perStage });
}

/** Run all requested splits in parallel; fail-closed on first error. */
async function runAllSplits(
  projectDir: string,
  fileContent: string,
  targetPath: string,
  splits: Array<"train" | "val" | "holdout">,
): Promise<ToolResult<Partial<Record<"train" | "val" | "holdout", SplitScoreWithHolistic>>>> {
  const scores: Partial<Record<"train" | "val" | "holdout", SplitScoreWithHolistic>> = {};

  const results = await Promise.all(
    splits.map((split) => runOneSplit(projectDir, fileContent, targetPath, split)),
  );

  for (let i = 0; i < splits.length; i++) {
    const result = results[i];
    if (!result.ok) return result;
    scores[splits[i]] = { holistic: result.holistic, perStage: result.perStage };
  }

  return toolOk(scores);
}

/** True iff targetPath's first path segment is "agents" (an agent-def artifact). */
function isAgentDefTarget(targetPath: string): boolean {
  const normalized = normalize(targetPath);
  return normalized.split(sep)[0] === "agents";
}

/**
 * True iff targetPath's first path segment is "principles" (a BUILT-IN principle-wording
 * target). Overlay `.canon/principles/**` never reaches this check — `isOverlayTarget`
 * rejects it earlier, before any frontmatter comparison.
 */
function isPrincipleDefTarget(targetPath: string): boolean {
  const normalized = normalize(targetPath);
  return normalized.split(sep)[0] === "principles";
}

/**
 * isOverlayTarget — true iff targetPath's normalized first path segment is `.canon`
 * (ANY untrusted-project-local overlay path, not just `.canon/principles/**`).
 *
 * ADR-0027: overlay content must never enter the eval sandbox. The sandbox already
 * excludes `.canon/` (PROBE-FINDINGS Probe 2 — `overlayCopied: false`); this is
 * defense-in-depth so no future caller path can inject overlay text into
 * `withInjectedGuardrailCandidate`/`withInjectedCandidate`.
 *
 * Case-insensitive comparison: the TRUE boundary against overlay content ever
 * reaching the sandbox is the positive `isGuardrailTarget` allowlist plus the
 * `PLUGIN_ARTIFACT_ROOTS` copy enumeration (both filesystem-case-immune) — this
 * denylist is redundant defense-in-depth, made case-insensitive only to remove
 * the cosmetic ambiguity of a `.CANON`/`.Canon` variant slipping past a strict
 * string compare (ADR-0027).
 */
function isOverlayTarget(targetPath: string): boolean {
  const normalized = normalize(targetPath);
  return normalized.split(sep)[0].toLowerCase() === ".canon";
}

/**
 * checkTargetFrontmatterImmutable — dispatches to the correct frontmatter-immutability
 * guard for targetPath. Pure, no I/O. Extracted so `evaluateCandidate` makes a single
 * call instead of an if/else-if with a nested check per branch (keeps the handler's
 * cognitive complexity under the lint ceiling).
 *
 * - agent-def (`agents/`) → `checkFrontmatterImmutable` (raw byte-for-byte, unchanged).
 * - built-in principle (`principles/`) → `checkPrincipleFrontmatterImmutable` (field-level,
 *   tolerates `archived` ONLY when `proposalKind === "retire"` — the ADR-0052 retire
 *   exception, narrowed to retire-only per the gate-vs-apply soundness fix; fail-closed
 *   for a missing/`"rewrite"`/`"reinforce"` `proposalKind`).
 * - every other target → `{ ok: true }` (no guard; unchanged behavior). Overlay
 *   `.canon/principles/**` targets never reach this — `isOverlayTarget` rejects them earlier.
 */
function checkTargetFrontmatterImmutable(
  targetPath: string,
  baselineText: string,
  candidateText: string,
  proposalKind: "rewrite" | "retire" | "reinforce" | undefined,
): FrontmatterGuardResult {
  if (isAgentDefTarget(targetPath)) {
    return checkFrontmatterImmutable(baselineText, candidateText);
  }
  if (isPrincipleDefTarget(targetPath)) {
    return checkPrincipleFrontmatterImmutable(
      baselineText,
      candidateText,
      proposalKind === "retire",
    );
  }
  return { ok: true };
}

/** Build the zeroed-out rejection result for a frontmatter-guard reject (dc-08). */
function buildGuardRejectionResult(
  reason: "frontmatter_modified" | "frontmatter_unverifiable" | "overlay_not_sandboxable",
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

/** Build PerSplit from scored baseline and candidate maps (per-stage scores only). */
function buildPerSplit(
  baseline: Partial<Record<"train" | "val" | "holdout", SplitScoreWithHolistic>>,
  candidate: Partial<Record<"train" | "val" | "holdout", SplitScoreWithHolistic>>,
): PerSplit {
  const bHoldout = baseline.holdout?.perStage ?? { errors: 0, failed: 0, passed: 0, total: 0 };
  const cHoldout = candidate.holdout?.perStage ?? { errors: 0, failed: 0, passed: 0, total: 0 };
  return {
    holdout: {
      baseline_passed: bHoldout.passed,
      candidate_passed: cHoldout.passed,
      total: bHoldout.total,
    },
    train: {
      baseline_passed: baseline.train?.perStage.passed ?? 0,
      candidate_passed: candidate.train?.perStage.passed ?? 0,
      total: baseline.train?.perStage.total ?? 0,
    },
    val: {
      baseline_passed: baseline.val?.perStage.passed ?? 0,
      candidate_passed: candidate.val?.perStage.passed ?? 0,
      total: baseline.val?.perStage.total ?? 0,
    },
  };
}

/**
 * Build a holdout-only PerSplit from holistic scores (holistic-gate, G4). Returns null when
 * either side has no holistic score — either no holistic suite exists for this target, or
 * the holdout split wasn't run (train/val never carry a holistic score by construction).
 * Train/val fields are zeroed — decideCompositeGate only reads `.holdout` on the holistic arg.
 */
function buildHolisticPerSplit(
  baseline: Partial<Record<"train" | "val" | "holdout", SplitScoreWithHolistic>>,
  candidate: Partial<Record<"train" | "val" | "holdout", SplitScoreWithHolistic>>,
): PerSplit | null {
  const bHolistic = baseline.holdout?.holistic;
  const cHolistic = candidate.holdout?.holistic;
  if (!bHolistic || !cHolistic) return null;

  const emptySplit = { baseline_passed: 0, candidate_passed: 0, total: 0 };
  return {
    holdout: {
      baseline_passed: bHolistic.passed,
      candidate_passed: cHolistic.passed,
      total: bHolistic.total,
    },
    train: emptySplit,
    val: emptySplit,
  };
}

/** Build the final EvaluateCandidateResult from the composed per-stage + holistic decision. */
function buildAcceptedResult(
  perSplit: PerSplit,
  holisticPerSplit: PerSplit | null,
  candidateText: string,
  realContentLength: number,
): EvaluateCandidateResult {
  const { accepted, regressed } = decideCompositeGate(perSplit, holisticPerSplit);
  return {
    accepted,
    baseline_score: perSplit.holdout.baseline_passed,
    candidate_score: perSplit.holdout.candidate_passed,
    ...(holisticPerSplit
      ? {
          holistic: {
            baseline_passed: holisticPerSplit.holdout.baseline_passed,
            candidate_passed: holisticPerSplit.holdout.candidate_passed,
            total: holisticPerSplit.holdout.total,
          },
        }
      : {}),
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
    size_delta: candidateText.length - realContentLength,
  };
}

/**
 * evaluateCandidate — main handler.
 *
 * Layered cheap→expensive (AC#6):
 * 1. Dry-run sanity check.
 * 2. Baseline + candidate splits run in parallel.
 * 3. decideCompositeGate: §7 per-stage strict `>` ANDed with the holistic non-regression
 *    veto (G4) when a holistic suite exists for this target; equals decideGate otherwise.
 */
export async function evaluateCandidate(
  input: EvaluateCandidateInput,
): Promise<ToolResult<EvaluateCandidateResult>> {
  const {
    candidate_text,
    project_dir,
    proposal_kind,
    splits: requestedSplits,
    target_path,
  } = input;
  const requestedSplitsOrDefault: Array<"train" | "val" | "holdout"> = requestedSplits ?? [
    "train",
    "val",
    "holdout",
  ];
  const splitsWithHoldout = requestedSplitsOrDefault.includes("holdout")
    ? requestedSplitsOrDefault
    : [...requestedSplitsOrDefault, "holdout" as const];

  // Overlay fail-closed reject (dc-02, dc-06, ADR-0027) — checked BEFORE any file read or
  // subprocess. Model-generated overlay text must never enter the eval sandbox; this is
  // defense-in-depth on top of the sandbox's own PLUGIN_ARTIFACT_ROOTS exclusion (Probe 2).
  if (isOverlayTarget(target_path)) {
    return toolOk(buildGuardRejectionResult("overlay_not_sandboxable", undefined));
  }

  let realContent = "";
  // Baseline-absent is a valid first run — fall back to a fresh baseline eval rather than failing.
  try {
    realContent = await readFile(join(project_dir, target_path), "utf-8");
  } catch {
    realContent = "";
  }

  // TASK-003 (dc-08) + principle-wording extension (dc-03): agent-def and built-in
  // principle candidates are rejected BEFORE any subprocess if their frontmatter differs
  // from baseline. Fail-closed, never throws. Overlay principle targets never reach here —
  // isOverlayTarget already rejected them above.
  const fmResult = checkTargetFrontmatterImmutable(
    target_path,
    realContent,
    candidate_text,
    proposal_kind,
  );
  if (!fmResult.ok) {
    return toolOk(buildGuardRejectionResult(fmResult.reason, fmResult.fields));
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
  const holisticPerSplit = buildHolisticPerSplit(baselineResult, candidateResult);

  return toolOk(
    buildAcceptedResult(perSplit, holisticPerSplit, candidate_text, realContent.length),
  );
}
