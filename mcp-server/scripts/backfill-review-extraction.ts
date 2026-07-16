#!/usr/bin/env tsx
/**
 * backfill-review-extraction.ts — re-derive `review_results` for archived builds.
 *
 * `extractReviewResults` runs at ARCHIVE time and freezes its result into
 * `run-summary.json`. Archives written while the violations parser was broken carry a
 * frozen `violations: []` that no parser fix can reach — the raw `reviews/REVIEW.md`
 * is still on disk, but nothing re-reads it. This script re-derives the frozen
 * interpretation from that surviving source (ADR-0059).
 *
 * Violations only. The honored side is parsed on READ, so the parser fix is already
 * retroactive there and needs no backfill.
 *
 * Usage (from mcp-server/):
 *   npm run backfill:review-extraction -- --dry-run     # report, write nothing
 *   npm run backfill:review-extraction                  # live: rewrite run-summary.json
 *   npm run backfill:review-extraction -- --root <dir>  # override projectDir
 *
 * Safety properties:
 * - **Reuses the shipped extractor.** No second parser exists here; a copy would drift
 *   from the real one and re-create the bug this repairs (`single-source-of-truth`).
 * - **Idempotent by construction.** The operation is `review_results := f(reviews/)`, a
 *   derive-and-overwrite of a pure function of an input this script never modifies.
 *   Two runs are byte-identical. There is deliberately NO version column, ledger, or
 *   "already backfilled" marker — that would be bookkeeping around a property already
 *   guaranteed structurally, and would itself be state that can drift.
 * - **Never fabricates.** An archive with no `reviews/` has no source text; it is left
 *   byte-identical and reported `unbackfillable`. An honest zero beats invented data.
 * - **Never modifies `reviews/REVIEW.md`** — primary evidence, read-only.
 * - **Fail-open per archive.** One malformed archive is reported and skipped, never
 *   aborting the run.
 */

import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractReviewResults } from "../src/platform/storage/archive/run-summary-builder.ts";
import { getDriftDb } from "../src/platform/storage/drift/drift-db-cache.ts";

/** Per-archive disposition counts. Every archive lands in exactly one category. */
export type BackfillResult = {
  /** Archives whose `review_results` was re-derived from a surviving `reviews/` dir. */
  backfilled: number;
  /** Archives with a `run-summary.json` but no readable review `.md` — no source text. */
  unbackfillable: number;
  /** Archives with no `run-summary.json` on disk — nothing to rewrite. */
  skipped: number;
  /** Archives that threw mid-processing (malformed JSON, unreadable file). */
  failed: { archive_id: string; error: string }[];
  /** Total violations across every re-derived review result. */
  violations_extracted: number;
};

/** Errors-are-values: a total failure (unreadable drift.db) is a variant, not a throw. */
export type BackfillOutcome =
  | { ok: true; result: BackfillResult }
  | { ok: false; error: string };

export type BackfillOptions = {
  projectDir: string;
  /** Compute and report, write nothing. Verifies yield before mutating the corpus. */
  dryRun: boolean;
};

/**
 * The ONE serializer for a backfilled run-summary: 2-space indent + trailing newline.
 *
 * Byte-stability is what makes idempotency observable — an unstable serializer would
 * break the property at the byte level even though the derived value is identical.
 */
function serializeRunSummary(summary: unknown): string {
  return `${JSON.stringify(summary, null, 2)}\n`;
}

/** Write via tmp-file + atomic rename so a partial failure cannot truncate an archive. */
function writeAtomic(path: string, contents: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, contents, "utf-8");
  renameSync(tmp, path);
}

type ArchiveDisposition =
  | { kind: "backfilled"; violations: number }
  | { kind: "unbackfillable" }
  | { kind: "skipped" };

/**
 * True when an archive holds review source text the extractor could actually read.
 *
 * The test is for a readable `.md`, NOT merely a `reviews/` directory. Measured over the
 * live corpus, 120 archives carry an empty-or-md-less `reviews/` dir — for those,
 * `extractReviewResults` returns `[]` because there is no source, not because the review
 * honestly found nothing. Writing that `[]` back and counting it `backfilled` would
 * fabricate a derived zero over an archive with no source text and inflate the reported
 * yield (351 real sources reported as 568). An unreadable dir is a sourceless archive.
 */
function hasReviewSource(archivePath: string): boolean {
  const reviewsDir = join(archivePath, "reviews");
  if (!existsSync(reviewsDir)) return false;
  try {
    return readdirSync(reviewsDir).some((entry) => entry.endsWith(".md"));
  } catch {
    return false;
  }
}

/**
 * Re-derive one archive's `review_results` and overwrite it in place.
 *
 * Throws only on genuinely malformed input (unparseable JSON, unwritable path); the
 * caller categorizes that as `failed` and continues.
 */
function backfillArchive(archivePath: string, dryRun: boolean): ArchiveDisposition {
  const summaryPath = join(archivePath, "run-summary.json");
  if (!existsSync(summaryPath)) return { kind: "skipped" };

  // No readable review source means nothing to re-derive from. Leave it untouched.
  if (!hasReviewSource(archivePath)) return { kind: "unbackfillable" };

  const summary = JSON.parse(readFileSync(summaryPath, "utf-8")) as Record<string, unknown>;
  const reviewResults = extractReviewResults(archivePath);
  const violations = reviewResults.reduce((sum, r) => sum + r.violations.length, 0);

  if (!dryRun) {
    summary.review_results = reviewResults;
    writeAtomic(summaryPath, serializeRunSummary(summary));
  }

  return { kind: "backfilled", violations };
}

type ArchiveRow = { archive_id: string; archive_path: string };

/**
 * Collapse drift.db rows to one entry per distinct `archive_path`, first-occurrence-wins.
 *
 * `build_archives` keys on `archive_id`, not on location: measured over the live corpus,
 * 585 rows resolve to 481 distinct paths (94 repeat, one 6 times) because re-running a
 * build re-archives to the same slug directory. Re-deriving is idempotent, so the extra
 * visits cannot corrupt anything — but they would count one REVIEW.md's violations up to
 * 6 times, and `violations_extracted` would stop meaning "violations in the corpus".
 * Deduping keeps the report honest; enumeration order makes the surviving id
 * deterministic.
 */
function dedupeByArchivePath(rows: ArchiveRow[]): ArchiveRow[] {
  const seen = new Map<string, ArchiveRow>();
  for (const row of rows) {
    if (!seen.has(row.archive_path)) seen.set(row.archive_path, row);
  }
  return [...seen.values()];
}

/**
 * Re-derive `review_results` for every archive registered in the project's drift.db.
 *
 * Enumerates the same `build_archives` source `attribute_outcomes` reads. Each archive
 * is isolated in a try/catch: one bad archive is reported in `failed` and never aborts
 * the run (`observable-best-effort`).
 *
 * @param options.projectDir - Project root holding `.canon/drift.db`.
 * @param options.dryRun - When true, compute and report without writing.
 * @returns `{ ok: true, result }` with per-category counts; `{ ok: false, error }` only
 *   when the drift.db itself cannot be read (nothing to enumerate).
 */
export function runBackfill({ projectDir, dryRun }: BackfillOptions): BackfillOutcome {
  let rows: { archive_id: string; archive_path: string }[];
  try {
    rows = getDriftDb(projectDir).getArchiveManifests();
  } catch (err) {
    return { error: `drift.db unreadable at ${projectDir}: ${String(err)}`, ok: false };
  }

  const archives = dedupeByArchivePath(rows);

  const result: BackfillResult = {
    backfilled: 0,
    failed: [],
    skipped: 0,
    unbackfillable: 0,
    violations_extracted: 0,
  };

  for (const archive of archives) {
    try {
      const disposition = backfillArchive(archive.archive_path, dryRun);
      if (disposition.kind === "backfilled") {
        result.backfilled += 1;
        result.violations_extracted += disposition.violations;
      } else if (disposition.kind === "unbackfillable") {
        result.unbackfillable += 1;
      } else {
        result.skipped += 1;
      }
    } catch (err) {
      result.failed.push({ archive_id: archive.archive_id, error: String(err) });
    }
  }

  return { ok: true, result };
}

function parseArgs(argv: string[]): { dryRun: boolean; root?: string } {
  let dryRun = false;
  let root: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") {
      dryRun = true;
    } else if (argv[i] === "--root") {
      root = argv[i + 1];
      i++;
    }
  }
  return { dryRun, root };
}

function renderResult(result: BackfillResult, dryRun: boolean): string {
  const lines = [
    dryRun ? "DRY RUN — nothing written" : "Backfill complete",
    `  backfilled:           ${result.backfilled}`,
    `  unbackfillable:       ${result.unbackfillable}  (no review .md — no source text)`,
    `  skipped:              ${result.skipped}  (no run-summary.json)`,
    `  failed:               ${result.failed.length}`,
    `  violations_extracted: ${result.violations_extracted}`,
  ];
  for (const f of result.failed) {
    lines.push(`    FAILED ${f.archive_id}: ${f.error}`);
  }
  return lines.join("\n");
}

// CLI entry — skipped on import (the test imports runBackfill directly).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const scriptDir = dirname(fileURLToPath(import.meta.url)); // mcp-server/scripts/
  const { dryRun, root } = parseArgs(process.argv.slice(2));
  const projectDir = root ?? join(scriptDir, "..", ".."); // two levels up → repo root

  const outcome = runBackfill({ dryRun, projectDir });
  if (!outcome.ok) {
    console.error(`FAILED: ${outcome.error}`);
    process.exitCode = 1;
  } else {
    // `failed` entries are reported, not fatal — exit 0.
    console.log(renderResult(outcome.result, dryRun));
  }
}
