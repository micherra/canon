#!/usr/bin/env tsx
/**
 * measure.ts — T2 probe measurement harness (throwaway, not a build gate).
 *
 * Replays historical reviews from drift.db against the T2 checker
 * (checker.ts) and computes recall + false-positive rate for the
 * `leave-touched-files-better` principle, against the thresholds frozen in
 * this build's DESIGN.md. Never mutates build state — read + report only.
 *
 * Usage (from repo root):
 *   cd mcp-server && npx tsx scripts/t2-probe/measure.ts
 *
 * `--root <dir>` overrides the project root (default: derived repo root,
 * or `CANON_PROJECT_DIR` env var — same resolution pattern as
 * `regen-context-manifest.ts`). `--workspace-copy <path>` optionally copies
 * the results doc to a build workspace's plans dir (e.g.
 * `${WORKSPACE}/plans/${slug}/T2-PROBE-RESULTS.md`) in addition to the
 * committed `docs/t2-probe-results.md`.
 *
 * Execution itself (running this against real history) is a separate
 * runbook step from the build that authored this file — see probe-01-PLAN.md.
 *
 * canon:allow-unwired: throwaway T2 measurement probe, never wired to production
 */

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitDiff, gitExec } from "@platform/adapters/git-adapter.ts";
import type { ArchiveManifestEntry } from "@platform/storage/drift/drift-analytics-types.ts";
import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import type { ReviewEntry } from "@shared/schema.ts";
import { getBuildHistory } from "../../src/features/history/tools/get-build-history.ts";
import { runCheckerOnDiff } from "./checker.ts";

const TARGET_PRINCIPLE = "leave-touched-files-better";
const MIN_RETRIEVABLE_POSITIVES = 5;
const RUBRIC_PATH = join(dirname(fileURLToPath(import.meta.url)), "rubric.md");

// ---- Frozen thresholds (dc-04) — mirrors DESIGN.md verbatim. Do not edit
// here without updating the committed DESIGN.md; the two must stay in sync. ----
type Verdict = "PASS" | "FALSIFY" | "WEAK" | "INCONCLUSIVE";

/** Apply the frozen PASS/FALSIFY/WEAK/INCONCLUSIVE thresholds. Pure function. */
export function applyThresholds(
  retrievablePositives: number,
  recall: number,
  fpRate: number,
): Verdict {
  if (retrievablePositives < MIN_RETRIEVABLE_POSITIVES) return "INCONCLUSIVE";
  if (recall >= 0.8 && fpRate <= 0.1) return "PASS";
  if (recall < 0.5 || fpRate > 0.35) return "FALSIFY";
  return "WEAK";
}

/** One row of the per-build join table written to the results doc. */
export type JoinRow = {
  review_id: string;
  reviewer_flagged: boolean;
  checker_flagged: boolean;
  failed_open: boolean;
  diff_available: boolean;
};

/** Aggregate measurement result. */
export type MeasureResult = {
  verdict: Verdict;
  recall: number;
  fp_rate: number;
  retrievable_positives: number;
  retrievable_negatives: number;
  excluded_diff_unavailable: number;
  failed_open_count: number;
  rows: JoinRow[];
};

/** Resolve the project root the same way sibling scripts do (regen-context-manifest.ts pattern). */
function resolveProjectDir(argRoot: string | undefined): string {
  if (argRoot) return argRoot;
  if (process.env.CANON_PROJECT_DIR) return process.env.CANON_PROJECT_DIR;
  const scriptDir = dirname(fileURLToPath(import.meta.url)); // mcp-server/scripts/t2-probe/
  return join(scriptDir, "..", "..", ".."); // three levels up -> repo root
}

/**
 * Split all reviews into the positive set (reviews with a recorded
 * `leave-touched-files-better` violation) and the conservative negative set
 * (every other review — DESIGN ASSUMPTION 3: this over-counts FP, biasing
 * against the checker, so a PASS verdict is trustworthy).
 */
function splitPositiveNegative(
  allReviews: ReviewEntry[],
  positiveReviews: ReviewEntry[],
): { positives: ReviewEntry[]; negatives: ReviewEntry[] } {
  const positiveIds = new Set(positiveReviews.map((r) => r.review_id));
  const negatives = allReviews.filter((r) => !positiveIds.has(r.review_id));
  return { positives: positiveReviews, negatives };
}

/** Diff resolution result — a review's reviewed diff, or why it's unavailable. */
type DiffResolution = { ok: true; diff: string } | { ok: false; reason: string };

/**
 * Reconstruct the reviewed unified diff for one review. Best-effort:
 * matches the review's branch to an archived build, uses that build's
 * FlowRunEntry.commits (the run's own commit list) to derive a base sha
 * (parent of the first commit made during the run), verifies both shas
 * resolve in git, then diffs base..last_reviewed_sha.
 *
 * Returns `{ ok: false }` for any unresolvable step — this is a first-class
 * MEASURED outcome (DESIGN ASSUMPTION 2), not a thrown error.
 */
async function resolveReviewedDiff(
  review: ReviewEntry,
  projectDir: string,
): Promise<DiffResolution> {
  if (!review.branch || !review.last_reviewed_sha) {
    return { ok: false, reason: "missing_branch_or_sha" };
  }

  const historyResult = await getBuildHistory({ branch: review.branch, project_dir: projectDir });
  if (!historyResult.ok || historyResult.archives.length === 0) {
    return { ok: false, reason: "no_archive" };
  }

  const driftDb = getDriftDb(projectDir);
  const allRuns = driftDb.getAllFlowRuns();

  const baseSha = findBaseShaFromArchives(historyResult.archives, allRuns);
  if (baseSha === null) {
    return { ok: false, reason: "no_commit_range" };
  }

  const headSha = review.last_reviewed_sha;
  const baseResolves = gitExec(["cat-file", "-e", baseSha], projectDir).ok;
  const headResolves = gitExec(["cat-file", "-e", headSha], projectDir).ok;
  if (!baseResolves || !headResolves) {
    return { ok: false, reason: "sha_unresolvable" };
  }

  const diffResult = gitDiff([`${baseSha}..${headSha}`], projectDir);
  if (!diffResult.ok) {
    return { ok: false, reason: "diff_command_failed" };
  }

  return { diff: diffResult.stdout, ok: true };
}

/** Find a usable base sha (parent of the first commit) from the archives matching a review's branch. */
function findBaseShaFromArchives(
  archives: ArchiveManifestEntry[],
  allRuns: ReturnType<ReturnType<typeof getDriftDb>["getAllFlowRuns"]>,
): string | null {
  for (const archive of archives) {
    if (archive.source_run_id === null) continue;
    const run = allRuns.find((r) => r.run_id === archive.source_run_id);
    if (run?.commits && run.commits.length > 0) {
      return `${run.commits[0]}^`;
    }
  }
  return null;
}

/** Run the full measurement pass. Never mutates build state — read + report only. */
export async function runMeasurement(projectDir: string): Promise<MeasureResult> {
  const driftDb = getDriftDb(projectDir);
  const allReviews = driftDb.getReviews();
  const positiveReviews = driftDb.getReviews({ principleId: TARGET_PRINCIPLE });
  const { positives, negatives } = splitPositiveNegative(allReviews, positiveReviews);

  const rows: JoinRow[] = [];
  let excludedDiffUnavailable = 0;
  let failedOpenCount = 0;
  let retrievablePositives = 0;
  let retrievableNegatives = 0;
  let hitsOnPositives = 0;
  let hitsOnNegatives = 0;

  for (const [set, reviewerFlagged] of [
    [positives, true],
    [negatives, false],
  ] as const) {
    for (const review of set) {
      const diffResolution = await resolveReviewedDiff(review, projectDir);
      if (!diffResolution.ok) {
        excludedDiffUnavailable++;
        rows.push({
          checker_flagged: false,
          diff_available: false,
          failed_open: false,
          review_id: review.review_id,
          reviewer_flagged: reviewerFlagged,
        });
        continue;
      }

      const checkerResult = runCheckerOnDiff(diffResolution.diff, RUBRIC_PATH);
      if (checkerResult.failed_open) failedOpenCount++;

      const checkerFlagged = checkerResult.findings.length > 0;
      if (reviewerFlagged) {
        retrievablePositives++;
        if (checkerFlagged) hitsOnPositives++;
      } else {
        retrievableNegatives++;
        if (checkerFlagged) hitsOnNegatives++;
      }

      rows.push({
        checker_flagged: checkerFlagged,
        diff_available: true,
        failed_open: checkerResult.failed_open,
        review_id: review.review_id,
        reviewer_flagged: reviewerFlagged,
      });
    }
  }

  const recall = retrievablePositives > 0 ? hitsOnPositives / retrievablePositives : 0;
  const fpRate = retrievableNegatives > 0 ? hitsOnNegatives / retrievableNegatives : 0;
  const verdict = applyThresholds(retrievablePositives, recall, fpRate);

  return {
    excluded_diff_unavailable: excludedDiffUnavailable,
    failed_open_count: failedOpenCount,
    fp_rate: fpRate,
    recall,
    retrievable_negatives: retrievableNegatives,
    retrievable_positives: retrievablePositives,
    rows,
    verdict,
  };
}

/** Render the results doc (recall, FP, per-build join table, verdict). Pure function. */
export function renderResultsDoc(result: MeasureResult): string {
  const lines: string[] = [];
  lines.push("# T2 Probe Results — `leave-touched-files-better`");
  lines.push("");
  lines.push(`**Verdict: ${result.verdict}**`);
  lines.push("");
  lines.push(`- Recall: ${result.recall.toFixed(3)} (${result.retrievable_positives} retrievable positives)`);
  lines.push(`- False-positive rate: ${result.fp_rate.toFixed(3)} (${result.retrievable_negatives} retrievable negatives)`);
  lines.push(`- Excluded (diff_unavailable): ${result.excluded_diff_unavailable}`);
  lines.push(`- Checker failed-open count: ${result.failed_open_count}`);
  lines.push("");
  lines.push(
    "**Conservative negative set caveat**: the negative set is every review " +
      "without a recorded violation for this principle (DESIGN ASSUMPTION 3) — " +
      "this over-counts false positives, biasing against the checker, so a " +
      "PASS verdict here is trustworthy.",
  );
  lines.push("");
  lines.push("## Per-build join table");
  lines.push("");
  lines.push("| review_id | reviewer_flagged | checker_flagged | failed_open | diff_available |");
  lines.push("|---|---|---|---|---|");
  for (const row of result.rows) {
    lines.push(
      `| ${row.review_id} | ${row.reviewer_flagged} | ${row.checker_flagged} | ${row.failed_open} | ${row.diff_available} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const rootIdx = args.indexOf("--root");
  const workspaceCopyIdx = args.indexOf("--workspace-copy");
  const argRoot = rootIdx !== -1 ? args[rootIdx + 1] : undefined;
  const workspaceCopyPath = workspaceCopyIdx !== -1 ? args[workspaceCopyIdx + 1] : undefined;

  const projectDir = resolveProjectDir(argRoot);
  const result = await runMeasurement(projectDir);
  const doc = renderResultsDoc(result);

  const committedPath = join(projectDir, "docs", "t2-probe-results.md");
  mkdirSync(dirname(committedPath), { recursive: true });
  writeFileSync(committedPath, doc, "utf-8");
  process.stdout.write(`Wrote ${committedPath}\n`);

  if (workspaceCopyPath) {
    mkdirSync(dirname(workspaceCopyPath), { recursive: true });
    copyFileSync(committedPath, workspaceCopyPath);
    process.stdout.write(`Copied to ${workspaceCopyPath}\n`);
  }

  process.stdout.write(`Verdict: ${result.verdict}\n`);
}

// Only run main() when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    process.stderr.write(`measure.ts failed: ${String(err)}\n`);
    process.exitCode = 1;
  });
}
