/**
 * backfill-review-extraction tests — idempotency, non-fabrication, evidence preservation.
 *
 * Every test builds a throwaway archive corpus under an isolated `mkdtemp` projectDir.
 * Never `process.cwd()`: the global drift-db-leak-guard fails the suite on any write to
 * the repo's real `.canon/drift.db`.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ArchiveManifestEntry } from "../src/platform/storage/drift/drift-analytics-types.ts";
import {
  evictDriftDbForScope,
  getDriftDb,
} from "../src/platform/storage/drift/drift-db-cache.ts";
import { runBackfill } from "./backfill-review-extraction.ts";

// ---- Fixtures ----

/** A REVIEW.md carrying two id-shaped violation rows and one prose row the guard drops. */
const REVIEW_WITH_VIOLATIONS = `---
verdict: WARNING
files-reviewed: 3
principles-checked: 12
---

## Canon Review — Verdict: WARNING

### Principle Compliance

#### Violations
| Principle | Severity | Location | Confidence | Description | Fix |
|-----------|----------|----------|------------|-------------|-----|
| errors-are-values | rule | \`src/a.ts:10\` | HIGH | throws on expected error | return a Result |
| single-source-of-truth | convention | \`src/b.ts:22\` | MEDIUM | second parser | import the shipped one |
| Some prose sentence, not an id | rule | \`src/c.ts:1\` | LOW | prose | n/a |

#### Honored
- **fail-closed-by-default**: gate rejects on error
`;

/** A REVIEW.md whose Violations section carries a sentinel line, not a table. */
const REVIEW_NO_VIOLATIONS = `---
verdict: CLEAN
files-reviewed: 1
principles-checked: 4
---

#### Violations
None found.

#### Honored
- **tests-are-deterministic**
`;

type ArchiveSpec = {
  id: string;
  /** Omit to create the archive dir with no run-summary.json (→ skipped). */
  runSummary?: string;
  /** Omit to create no reviews/ dir (→ unbackfillable). */
  review?: string;
};

function makeRunSummary(archiveId: string): string {
  return `${JSON.stringify(
    {
      archive_id: archiveId,
      version: 1,
      run_metadata: { branch: "main", flow: "feature" },
      planner_context: { outcome: "ship it" },
      runbook_steps: [{ agent: "engineer", step_id: "implement" }],
      step_outcomes: [{ step_id: "implement", status: "completed" }],
      review_results: [],
      decision_summaries: [],
      artifact_inventory: { directories: [], files: [], total_files: 0 },
    },
    null,
    2,
  )}\n`;
}

function manifestEntry(archiveId: string, archivePath: string): ArchiveManifestEntry {
  return {
    archive_id: archiveId,
    archive_path: archivePath,
    archived_at: "2026-07-14T00:00:00.000Z",
    artifact_types: ["reviews"],
    branch: "main",
    flow: "feature",
    has_run_summary: true,
    sanitized_branch: "main",
    slug: archiveId,
    source_run_id: null,
    task: "test archive",
    tier: "standard",
  };
}

/** Build an isolated projectDir with a drift.db registering each spec'd archive. */
function makeCorpus(specs: ArchiveSpec[]): string {
  const projectDir = mkdtempSync(join(tmpdir(), "canon-backfill-"));
  const db = getDriftDb(projectDir);

  for (const spec of specs) {
    const archivePath = join(projectDir, "history", spec.id);
    mkdirSync(archivePath, { recursive: true });

    if (spec.runSummary !== undefined) {
      writeFileSync(join(archivePath, "run-summary.json"), spec.runSummary, "utf-8");
    }
    if (spec.review !== undefined) {
      mkdirSync(join(archivePath, "reviews"), { recursive: true });
      writeFileSync(join(archivePath, "reviews", "REVIEW.md"), spec.review, "utf-8");
    }
    db.appendArchiveManifest(manifestEntry(spec.id, archivePath));
  }

  return projectDir;
}

function summaryPath(projectDir: string, archiveId: string): string {
  return join(projectDir, "history", archiveId, "run-summary.json");
}

function reviewPath(projectDir: string, archiveId: string): string {
  return join(projectDir, "history", archiveId, "reviews", "REVIEW.md");
}

/** Unwrap a successful outcome, failing the test on the error variant. */
function expectOk(outcome: ReturnType<typeof runBackfill>) {
  if (!outcome.ok) throw new Error(`expected ok, got error: ${outcome.error}`);
  return outcome.result;
}

// ---- Tests ----

describe("runBackfill", () => {
  let projectDirs: string[];

  beforeEach(() => {
    projectDirs = [];
  });

  afterEach(() => {
    for (const dir of projectDirs) {
      evictDriftDbForScope(dir);
      rmSync(dir, { force: true, recursive: true });
    }
  });

  function corpus(specs: ArchiveSpec[]): string {
    const dir = makeCorpus(specs);
    projectDirs.push(dir);
    return dir;
  }

  test("happy path — extracts the id-shaped violations and drops the prose row", () => {
    const dir = corpus([
      { id: "a1", review: REVIEW_WITH_VIOLATIONS, runSummary: makeRunSummary("a1") },
    ]);

    const result = expectOk(runBackfill({ dryRun: false, projectDir: dir }));

    expect(result.backfilled).toBe(1);
    expect(result.violations_extracted).toBe(2);

    const written = JSON.parse(readFileSync(summaryPath(dir, "a1"), "utf-8"));
    expect(written.review_results[0].violations.map((v: { principle_id: string }) => v.principle_id))
      .toEqual(["errors-are-values", "single-source-of-truth"]);
  });

  test("idempotency (AC#5) — a second run is byte-identical and does not double-count", () => {
    const dir = corpus([
      { id: "a1", review: REVIEW_WITH_VIOLATIONS, runSummary: makeRunSummary("a1") },
    ]);

    const first = expectOk(runBackfill({ dryRun: false, projectDir: dir }));
    const afterFirst = readFileSync(summaryPath(dir, "a1"), "utf-8");

    const second = expectOk(runBackfill({ dryRun: false, projectDir: dir }));
    const afterSecond = readFileSync(summaryPath(dir, "a1"), "utf-8");

    expect(afterSecond).toBe(afterFirst);
    expect(second.violations_extracted).toBe(first.violations_extracted);
  });

  test("never fabricates — an archive with no reviews/ is unbackfillable and untouched", () => {
    const dir = corpus([{ id: "dark", runSummary: makeRunSummary("dark") }]);
    const before = readFileSync(summaryPath(dir, "dark"), "utf-8");

    const result = expectOk(runBackfill({ dryRun: false, projectDir: dir }));

    expect(result.unbackfillable).toBe(1);
    expect(result.backfilled).toBe(0);
    expect(readFileSync(summaryPath(dir, "dark"), "utf-8")).toBe(before);
  });

  test("never fabricates — a reviews/ dir holding no .md is unbackfillable, not an empty derive", () => {
    // The 120-archive shape the dir-only guard misclassified: `reviews/` exists but is
    // empty (or holds no .md), so extractReviewResults returns [] for lack of source —
    // NOT because the review honestly found nothing. Writing that [] and reporting it
    // as "backfilled" would fabricate a derived zero over an archive with no source text.
    const dir = corpus([{ id: "emptyreviews", runSummary: makeRunSummary("emptyreviews") }]);
    mkdirSync(join(dir, "history", "emptyreviews", "reviews"), { recursive: true });
    writeFileSync(join(dir, "history", "emptyreviews", "reviews", "notes.txt"), "x", "utf-8");
    const before = readFileSync(summaryPath(dir, "emptyreviews"), "utf-8");

    const result = expectOk(runBackfill({ dryRun: false, projectDir: dir }));

    expect(result.unbackfillable).toBe(1);
    expect(result.backfilled).toBe(0);
    expect(readFileSync(summaryPath(dir, "emptyreviews"), "utf-8")).toBe(before);
  });

  test("counts archives, not drift.db rows — a repeated archive_path is visited once", () => {
    // Measured: 585 build_archives rows resolve to only 481 distinct archive_paths (94
    // repeat, one 6x). Counting rows visits the same REVIEW.md up to 6 times and
    // multiplies its violations into the reported yield — the corpus-wide count stops
    // meaning "violations in the corpus". Writes stay safe either way (derive-and-
    // overwrite is idempotent), but the REPORT must count each archive once.
    const dir = corpus([
      { id: "a1", review: REVIEW_WITH_VIOLATIONS, runSummary: makeRunSummary("a1") },
    ]);
    const sharedPath = join(dir, "history", "a1");
    getDriftDb(dir).appendArchiveManifest(manifestEntry("a1-rerun", sharedPath));
    getDriftDb(dir).appendArchiveManifest(manifestEntry("a1-rerun-2", sharedPath));

    const result = expectOk(runBackfill({ dryRun: false, projectDir: dir }));

    expect(result.backfilled).toBe(1);
    expect(result.violations_extracted).toBe(2);
  });

  test("archived REVIEW.md is primary evidence — bytes and mtime unchanged", () => {
    const dir = corpus([
      { id: "a1", review: REVIEW_WITH_VIOLATIONS, runSummary: makeRunSummary("a1") },
    ]);
    const beforeBytes = readFileSync(reviewPath(dir, "a1"), "utf-8");
    const beforeMtime = statSync(reviewPath(dir, "a1")).mtimeMs;

    expectOk(runBackfill({ dryRun: false, projectDir: dir }));

    expect(readFileSync(reviewPath(dir, "a1"), "utf-8")).toBe(beforeBytes);
    expect(statSync(reviewPath(dir, "a1")).mtimeMs).toBe(beforeMtime);
  });

  test("an archive with no run-summary.json is skipped", () => {
    const dir = corpus([{ id: "nosummary", review: REVIEW_WITH_VIOLATIONS }]);

    const result = expectOk(runBackfill({ dryRun: false, projectDir: dir }));

    expect(result.skipped).toBe(1);
    expect(result.backfilled).toBe(0);
  });

  test("fail-open — a malformed run-summary.json is reported, siblings still backfill", () => {
    const dir = corpus([
      { id: "bad", review: REVIEW_WITH_VIOLATIONS, runSummary: "{ not json" },
      { id: "good", review: REVIEW_WITH_VIOLATIONS, runSummary: makeRunSummary("good") },
    ]);

    const result = expectOk(runBackfill({ dryRun: false, projectDir: dir }));

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].archive_id).toBe("bad");
    expect(result.backfilled).toBe(1);
    expect(readFileSync(summaryPath(dir, "bad"), "utf-8")).toBe("{ not json");
  });

  test("--dry-run reports the same counts and writes nothing", () => {
    const specs: ArchiveSpec[] = [
      { id: "a1", review: REVIEW_WITH_VIOLATIONS, runSummary: makeRunSummary("a1") },
      { id: "a2", review: REVIEW_NO_VIOLATIONS, runSummary: makeRunSummary("a2") },
      { id: "dark", runSummary: makeRunSummary("dark") },
    ];
    const dryDir = corpus(specs);
    const before = readFileSync(summaryPath(dryDir, "a1"), "utf-8");

    const dry = expectOk(runBackfill({ dryRun: true, projectDir: dryDir }));

    expect(readFileSync(summaryPath(dryDir, "a1"), "utf-8")).toBe(before);

    const liveDir = corpus(specs);
    const live = expectOk(runBackfill({ dryRun: false, projectDir: liveDir }));

    expect(dry.backfilled).toBe(live.backfilled);
    expect(dry.unbackfillable).toBe(live.unbackfillable);
    expect(dry.violations_extracted).toBe(live.violations_extracted);
  });

  test("only review_results mutates — every other top-level key is preserved", () => {
    const dir = corpus([
      { id: "a1", review: REVIEW_WITH_VIOLATIONS, runSummary: makeRunSummary("a1") },
    ]);
    const before = JSON.parse(readFileSync(summaryPath(dir, "a1"), "utf-8"));

    expectOk(runBackfill({ dryRun: false, projectDir: dir }));
    const after = JSON.parse(readFileSync(summaryPath(dir, "a1"), "utf-8"));

    expect(Object.keys(after)).toEqual(Object.keys(before));
    for (const key of Object.keys(before)) {
      if (key === "review_results") continue;
      expect(after[key]).toEqual(before[key]);
    }
    expect(after.review_results).not.toEqual(before.review_results);
  });
});
