#!/usr/bin/env tsx
/**
 * aggregate.ts — T2 probe live-forward aggregation + verdict CLI.
 *
 * Reads the JSONL checker records written by record.ts plus drift.db's
 * reviewer ground truth, joins each record to the review that reviewed the
 * SAME diff (layered-exact — never first-archive, never latest-global; P2(b)
 * fix), scores per-finding file-level recall/FP excluding failed-open runs
 * from every denominator (P2(a) fix), and emits an N-gated PASS/FALSIFY/
 * CONTINUE verdict against the frozen thresholds. Never mutates build state
 * — read + report only, mirroring measure.ts's now-retired posture.
 *
 * Usage (from repo root):
 *   cd mcp-server && npx tsx scripts/t2-probe/aggregate.ts \
 *     [--in <path>] [--out <path>] [--root <dir>]
 *
 * canon:allow-unwired: T2 live-forward measurement instrument, CLI-invoked (not tool-registered)
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import type { ReviewEntry } from "@shared/schema.ts";
import type { CheckerFinding } from "./checker.ts";
import type { CheckerRunRecord } from "./record.ts";

const TARGET_PRINCIPLE = "leave-touched-files-better";
const JOIN_WINDOW_MS = 2 * 60 * 60 * 1000; // +/-2h (decision t2live-01/t2live-03 layer-3 window)

// ---- Frozen thresholds (dc-05) — mirrors DESIGN.md verbatim. Do not edit
// here without updating the committed DESIGN.md; the two must stay in sync. ----
export const MIN_SCORED_RECORDS = 10; // N-gate (decision t2live-03)
export const MIN_POSITIVE_UNITS = 5; // carried over from #457's MIN_RETRIEVABLE_POSITIVES
export type Verdict = "PASS" | "FALSIFY" | "CONTINUE";
// PASS: recall >= 0.8 && fp <= 0.1 ; FALSIFY: recall < 0.5 || fp > 0.35 ; else CONTINUE
// N-gate unmet -> CONTINUE with reason "insufficient_n"

/** Which layer of the deterministic join matched a record to a review. */
export type JoinLayer = 1 | 2 | 3;

export type JoinResult =
  | { status: "joined"; record: CheckerRunRecord; review: ReviewEntry; layer: JoinLayer }
  | { status: "unjoinable"; record: CheckerRunRecord };

export type ScoreResult = {
  scored_record_count: number;
  positive_units: number;
  negative_units: number;
  caught: number;
  false_positives: number;
  recall: number;
  fp_rate: number;
  failed_open_count: number;
  unjoinable_count: number;
  excluded_no_file_path: number;
};

/** Strip a leading `./` and normalize separators to posix, so both sides of a join compare equal. */
function normalizePath(path: string): string {
  return path.replace(/^\.\//, "").replace(/\\/g, "/");
}

/**
 * Element-level guard for `CheckerFinding` — every findings[] entry must
 * carry a string `file_path`, a string `description`, and a `line` that is
 * either a number or null (checker.ts's `parseFindings` always sets one or
 * the other, never omits the key). A findings element failing this check
 * fails the WHOLE record (W2) — `scoreRecords` reads `f.file_path` for every
 * finding unconditionally, so admitting a shape-invalid element would crash
 * the aggregate CLI on hand-edited or cross-version-skewed JSONL instead of
 * degrading gracefully to the `malformed` counter.
 */
function isCheckerFinding(value: unknown): value is CheckerFinding {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f.file_path === "string" &&
    typeof f.description === "string" &&
    (typeof f.line === "number" || f.line === null)
  );
}

/**
 * Named type guard for JSON.parse output — the record is only trusted once
 * every required field's shape is verified (never cast through `unknown`
 * blindly), INCLUDING every `findings[]` element's shape (W2). Unknown/extra
 * fields are ignored; missing/mistyped required fields count the line as
 * malformed.
 */
function isCheckerRunRecord(value: unknown): value is CheckerRunRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.record_id === "string" &&
    typeof v.timestamp === "string" &&
    typeof v.slug === "string" &&
    typeof v.branch === "string" &&
    typeof v.base_sha === "string" &&
    typeof v.head_sha === "string" &&
    Array.isArray(v.touched_files) &&
    Array.isArray(v.findings) &&
    v.findings.every(isCheckerFinding) &&
    typeof v.failed_open === "boolean" &&
    typeof v.checker_elapsed_ms === "number" &&
    typeof v.rubric_hash === "string"
  );
}

/** Parse JSONL lines into records. Malformed lines are counted, never thrown. */
export function parseRecords(lines: string[]): { records: CheckerRunRecord[]; malformed: number } {
  const records: CheckerRunRecord[] = [];
  let malformed = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isCheckerRunRecord(parsed)) {
        records.push(parsed);
      } else {
        malformed++;
      }
    } catch {
      malformed++;
    }
  }
  return { malformed, records };
}

/** Keep only the latest record per (branch, head_sha) — re-reviews after fix loops produce multiple records at distinct SHAs, but retries at the same SHA collapse to the newest. */
export function dedupeRecords(records: CheckerRunRecord[]): CheckerRunRecord[] {
  const latestByKey = new Map<string, CheckerRunRecord>();
  for (const record of records) {
    const key = `${record.branch}::${record.head_sha}`;
    const existing = latestByKey.get(key);
    if (!existing || Date.parse(record.timestamp) >= Date.parse(existing.timestamp)) {
      latestByKey.set(key, record);
    }
  }
  return [...latestByKey.values()];
}

/**
 * Layered deterministic join (P2(b) fix): (1) `review_id` exact, (2)
 * `branch` + `last_reviewed_sha === head_sha`, (3) `branch` + EXACTLY ONE
 * same-branch review within +/-2h of the record timestamp. Two-or-more
 * layer-3 candidates is ambiguity, not a guess -> unjoinable. Never
 * first-archive, never latest-global.
 */
export function joinRecordsToReviews(records: CheckerRunRecord[], reviews: ReviewEntry[]): JoinResult[] {
  const results: JoinResult[] = [];

  for (const record of records) {
    if (record.review_id !== undefined) {
      const exact = reviews.find((r) => r.review_id === record.review_id);
      if (exact) {
        results.push({ layer: 1, record, review: exact, status: "joined" });
        continue;
      }
    }

    const shaMatch = reviews.find((r) => r.branch === record.branch && r.last_reviewed_sha === record.head_sha);
    if (shaMatch) {
      results.push({ layer: 2, record, review: shaMatch, status: "joined" });
      continue;
    }

    const recordTime = Date.parse(record.timestamp);
    const windowCandidates = reviews.filter((r) => {
      if (r.branch !== record.branch) return false;
      const reviewTime = Date.parse(r.timestamp);
      if (Number.isNaN(reviewTime) || Number.isNaN(recordTime)) return false;
      return Math.abs(reviewTime - recordTime) <= JOIN_WINDOW_MS;
    });
    if (windowCandidates.length === 1) {
      results.push({ layer: 3, record, review: windowCandidates[0], status: "joined" });
      continue;
    }

    results.push({ record, status: "unjoinable" });
  }

  return results;
}

/**
 * Per-finding file-level scoring (AC6 / decision t2live-03). failed_open
 * records are excluded from every numerator and denominator (P2(a) fix) —
 * they only increment `failed_open_count`. Unjoinable records are excluded
 * from scoring entirely and only increment `unjoinable_count`.
 */
export function scoreRecords(joined: JoinResult[]): ScoreResult {
  let scoredRecordCount = 0;
  let positiveUnits = 0;
  let negativeUnits = 0;
  let caught = 0;
  let falsePositives = 0;
  let failedOpenCount = 0;
  let unjoinableCount = 0;
  let excludedNoFilePath = 0;

  for (const result of joined) {
    if (result.status === "unjoinable") {
      unjoinableCount++;
      continue;
    }

    const { record, review } = result;
    if (record.failed_open) {
      failedOpenCount++;
      continue;
    }

    scoredRecordCount++;

    const touchedFiles = record.touched_files.map(normalizePath);
    const touchedSet = new Set(touchedFiles);

    const positiveFiles = new Set<string>();
    for (const violation of review.violations) {
      if (violation.principle_id !== TARGET_PRINCIPLE) continue;
      if (violation.file_path === undefined) {
        excludedNoFilePath++;
        continue;
      }
      const normalized = normalizePath(violation.file_path);
      if (touchedSet.has(normalized)) {
        positiveFiles.add(normalized);
      }
    }

    const findingFiles = new Set(record.findings.map((f) => normalizePath(f.file_path)));

    for (const file of touchedSet) {
      if (positiveFiles.has(file)) {
        positiveUnits++;
        if (findingFiles.has(file)) caught++;
      } else {
        negativeUnits++;
        if (findingFiles.has(file)) falsePositives++;
      }
    }
  }

  const recall = positiveUnits > 0 ? caught / positiveUnits : 0;
  const fpRate = negativeUnits > 0 ? falsePositives / negativeUnits : 0;

  return {
    caught,
    excluded_no_file_path: excludedNoFilePath,
    failed_open_count: failedOpenCount,
    false_positives: falsePositives,
    fp_rate: fpRate,
    negative_units: negativeUnits,
    positive_units: positiveUnits,
    recall,
    scored_record_count: scoredRecordCount,
    unjoinable_count: unjoinableCount,
  };
}

/** Apply the N-gate, then the frozen PASS/FALSIFY/CONTINUE thresholds. Pure function. */
export function applyVerdict(score: ScoreResult, scoredRecordCount: number): { verdict: Verdict; reason: string } {
  if (scoredRecordCount < MIN_SCORED_RECORDS || score.positive_units < MIN_POSITIVE_UNITS) {
    return { reason: "insufficient_n", verdict: "CONTINUE" };
  }
  if (score.recall >= 0.8 && score.fp_rate <= 0.1) {
    return { reason: "recall_and_fp_within_pass_thresholds", verdict: "PASS" };
  }
  if (score.recall < 0.5 || score.fp_rate > 0.35) {
    return { reason: "recall_or_fp_beyond_falsify_thresholds", verdict: "FALSIFY" };
  }
  return { reason: "mid_zone", verdict: "CONTINUE" };
}

/** One row of the per-record join table written to the report. */
function joinTableRow(result: JoinResult): {
  record_id: string;
  slug: string;
  join_layer: string;
  reviewer_flagged_files: number;
  checker_flagged_files: number;
} {
  const checkerFlaggedFiles = new Set(result.record.findings.map((f) => normalizePath(f.file_path))).size;

  if (result.status === "unjoinable") {
    return {
      checker_flagged_files: checkerFlaggedFiles,
      join_layer: "unjoinable",
      record_id: result.record.record_id,
      reviewer_flagged_files: 0,
      slug: result.record.slug,
    };
  }

  const reviewerFlaggedFiles = new Set(
    result.review.violations
      .filter((v) => v.principle_id === TARGET_PRINCIPLE && v.file_path !== undefined)
      .map((v) => normalizePath(v.file_path as string)),
  ).size;

  return {
    checker_flagged_files: checkerFlaggedFiles,
    join_layer: String(result.layer),
    record_id: result.record.record_id,
    reviewer_flagged_files: reviewerFlaggedFiles,
    slug: result.record.slug,
  };
}

/** Render the markdown results doc: verdict, metrics, denominators, join table, coverage stat, caveats. Pure function. */
export function renderReport(input: {
  verdict: Verdict;
  reason: string;
  score: ScoreResult;
  malformed: number;
  joined: JoinResult[];
  rubricHashes: string[];
  coverageReviewsInWindow: number;
}): string {
  const { verdict, reason, score, malformed, joined, rubricHashes, coverageReviewsInWindow } = input;
  const lines: string[] = [];

  lines.push("# T2 Live-Forward Probe Results — `leave-touched-files-better`");
  lines.push("");
  lines.push(`**Verdict: ${verdict}** (${reason})`);
  lines.push("");
  lines.push(`- Scored records: ${score.scored_record_count}`);
  lines.push(`- Recall: ${score.recall.toFixed(3)} (${score.caught}/${score.positive_units} positive file-units caught)`);
  lines.push(
    `- False-positive rate: ${score.fp_rate.toFixed(3)} (${score.false_positives}/${score.negative_units} negative file-units flagged)`,
  );
  lines.push(`- Failed-open runs (excluded from denominators): ${score.failed_open_count}`);
  lines.push(`- Unjoinable records (excluded): ${score.unjoinable_count}`);
  lines.push(`- Malformed JSONL lines (skipped): ${malformed}`);
  lines.push(`- Reviewer violations excluded for missing file_path: ${score.excluded_no_file_path}`);
  lines.push("");
  lines.push(
    "**Coverage stat** (silent non-wiring detector, DESIGN.md ASSUMPTION 4): " +
      `${score.scored_record_count} scored records vs ${coverageReviewsInWindow} drift.db reviews-with-branch ` +
      "in the same [earliest record, latest record] timestamp window. A large gap suggests the orchestrator " +
      'is not consistently invoking the recorder after review (see root CLAUDE.md § Post-Step Effects "After reviewer").',
  );
  lines.push("");
  if (rubricHashes.length > 1) {
    lines.push(
      `**WARNING: rubric drift detected** — ${rubricHashes.length} distinct \`rubric_hash\` values observed ` +
        "across scored records. Recall/FP comparisons across records scored under different rubric revisions " +
        "are not apples-to-apples.",
    );
    lines.push("");
  }
  lines.push(
    "**Conservative-bias caveats**: (1) the negative set is every touched file without a recorded reviewer " +
      "violation for this principle — this over-counts false positives, biasing against the checker, so a " +
      "PASS verdict here is trustworthy; (2) reviewer violations missing a `file_path` are excluded from the " +
      "recall denominator entirely rather than guessed at, which shrinks the positive-units count.",
  );
  lines.push("");
  lines.push("## Per-record join table");
  lines.push("");
  lines.push("| record_id | slug | join_layer | reviewer_flagged_files | checker_flagged_files |");
  lines.push("|---|---|---|---|---|");
  for (const result of joined) {
    const row = joinTableRow(result);
    lines.push(
      `| ${row.record_id} | ${row.slug} | ${row.join_layer} | ${row.reviewer_flagged_files} | ${row.checker_flagged_files} |`,
    );
  }
  lines.push("");

  return lines.join("\n");
}

/** Resolve the project root the same way sibling scripts do (measure.ts / regen-context-manifest.ts pattern). */
function resolveProjectDir(argRoot: string | undefined): string {
  if (argRoot) return argRoot;
  if (process.env.CANON_PROJECT_DIR) return process.env.CANON_PROJECT_DIR;
  const scriptDir = dirname(fileURLToPath(import.meta.url)); // mcp-server/scripts/t2-probe/
  return join(scriptDir, "..", "..", ".."); // three levels up -> repo root
}

/** Coverage stat: drift.db reviews-with-branch whose timestamp falls in [earliest record, latest record]. */
function computeCoverage(records: CheckerRunRecord[], reviews: ReviewEntry[]): number {
  if (records.length === 0) return 0;
  const timestamps = records.map((r) => Date.parse(r.timestamp)).filter((t) => !Number.isNaN(t));
  if (timestamps.length === 0) return 0;
  const earliest = Math.min(...timestamps);
  const latest = Math.max(...timestamps);
  return reviews.filter((r) => {
    if (!r.branch) return false;
    const t = Date.parse(r.timestamp);
    return !Number.isNaN(t) && t >= earliest && t <= latest;
  }).length;
}

function main(): void {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };

  const projectDir = resolveProjectDir(get("--root"));
  const inPath = get("--in") ?? join(projectDir, ".canon", "t2-probe", "checker-runs.jsonl");
  const outPath = get("--out") ?? join(projectDir, "docs", "t2-probe-live-results.md");

  let lines: string[] = [];
  try {
    lines = readFileSync(inPath, "utf-8").split("\n");
  } catch {
    lines = [];
  }

  const { malformed, records } = parseRecords(lines);
  const deduped = dedupeRecords(records);

  const driftDb = getDriftDb(projectDir);
  const allReviews = driftDb.getReviews({ includeResolvedViolations: true });

  const joined = joinRecordsToReviews(deduped, allReviews);
  const score = scoreRecords(joined);
  const { reason, verdict } = applyVerdict(score, score.scored_record_count);
  const rubricHashes = [...new Set(deduped.map((r) => r.rubric_hash).filter((h) => h.length > 0))];
  const coverageReviewsInWindow = computeCoverage(deduped, allReviews);

  const report = renderReport({ coverageReviewsInWindow, joined, malformed, reason, rubricHashes, score, verdict });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, report, "utf-8");
  process.stdout.write(`Wrote ${outPath}\n`);
  process.stdout.write(`Verdict: ${verdict} (${reason})\n`);
}

// Only run main() when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
