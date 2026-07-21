#!/usr/bin/env tsx
/**
 * backfill.ts — one-shot reconstruction of the 4 T2 records lost to recorder
 * under-firing (see PROBE-FINDINGS.md Probe 1 + root CLAUDE.md § Post-Step
 * Effects "T2 live-forward checker"). Reuses the SHIPPED `runRecorder`
 * (record.ts) — never hand-builds JSON — so `rubric_hash` matches the frozen
 * constant by construction (probe-before-build-invoke-not-infer).
 *
 * Each of the 4 builds is reconstructed against its REVIEWED HEAD, not the
 * current worktree tip: 2 of 4 tips have diverged via post-review
 * `origin/main` merges (see PROBE-FINDINGS.md Probe 2 — pinning the wrong sha
 * silently corrupts `touched_files`). The custom `appendLine` seam passed to
 * `runRecorder` stamps `backfilled: true` + a `checker_elapsed_ms: 0`
 * synthetic-timing sentinel (d-t2fix-05) before appending to the REAL target
 * JSONL, and refuses (throws, so `runRecorder` reports `ok:false` and nothing
 * is appended) on either a degraded reconstruction (`failed_open: true`,
 * errors-are-values — never append a degraded record) or a `rubric_hash` that
 * doesn't match the frozen constant (rubric drift since the lost run).
 *
 * APPEND-ONLY: refuses to run unless the target JSONL already has >= 4 lines
 * whose first 4 hash to the frozen native-record prefix (guards against
 * running against the wrong file), and refuses if any source worktree is
 * missing. Idempotent / re-run-safe: a build already present as a
 * `backfilled:true` record (matched by slug) is skipped, not duplicated.
 *
 * Usage (from repo root):
 *   cd mcp-server && npx tsx scripts/t2-probe/backfill.ts --root <main_repo_root>
 *
 * `--root` is REQUIRED (unlike record.ts's optional `--root`) — this script's
 * whole purpose is to write into a specific checkout's live JSONL, and the
 * misroute hazard (worktree `.canon/` vs main checkout `.canon/`) is exactly
 * the failure mode this backfill exists to repair. Guessing is not acceptable.
 *
 * canon:allow-unwired: one-shot backfill instrument, CLI-invoked (not tool-registered)
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type CheckerRunRecord, runRecorder } from "./record.ts";

/** The 4 builds lost to recorder under-firing — reviewed HEADs pinned per PROBE-FINDINGS.md Probe 2. */
const TARGETS: ReadonlyArray<{ slug: string; base: string; reviewedHead: string; worktree: string }> = [
  {
    base: "689dfc4970836b40287ae6817b368960ef9f0664",
    reviewedHead: "d7a668195e737f1a1b87acba59aeca2c8ece2f85",
    slug: "fix-adr-0052-retirement-pipeline",
    worktree:
      "/Users/michelle/Documents/canon/.canon/workspaces/main/fix-adr-0052-retirement-pipeline-bug-1-as-a-bundled-change-a-widen/worktree",
  },
  {
    base: "2a731d66a8aa08f70bc2cafb5776ec346cb5d434",
    reviewedHead: "62b371043ee4a78e7d52caae2014c31668e7331b",
    slug: "remediate-adm-zip-advisory",
    worktree:
      "/Users/michelle/Documents/canon/.canon/workspaces/canon--fix-adm-zip-advisory/remediate-the-newly-disclosed-high-severity-adm-zip-advisory-ghsa-xcpc/worktree",
  },
  {
    base: "8c6580e2759c87431e454e7bab28a9f272182c3f",
    reviewedHead: "17e8974f8c1e650b1a6487a9331ab96bccf39237",
    slug: "resolve-npm-audit-blocking-pr-519",
    worktree:
      "/Users/michelle/Documents/canon/.canon/workspaces/canon--fix-pr519-adm-zip-audit/resolve-the-high-severity-npm-audit-failure-blocking-pr-519-ci-by/worktree",
  },
  {
    base: "cdc5ad637ad8e2579b3ac928af5eb05706093c39",
    reviewedHead: "087878e0363c461f825886f7ab218ec00b2fb69b",
    slug: "fix-pr-520-biome-formatter",
    worktree:
      "/Users/michelle/Documents/canon/.canon/workspaces/canon--fix-pr520-biome-format/fix-pr-520-ci-biome-254-formatter-errors-in-mcp/worktree",
  },
];

const FROZEN_FIRST_FOUR_MD5 = "51a44025b5ea192385619d3528e56fe1";
const FROZEN_RUBRIC_HASH = "315696f6415cbd7097d9c2ae978fa5f0cddeb71332c2f98470bf1f598193d30e";

type AppendedEntry = { slug: string; rubric_hash: string; touched_files: number };

/** md5 of the first 4 non-empty lines, each newline-terminated — matches `head -4 <file> | md5`. */
export function computeFirstFourLinesMd5(lines: readonly string[]): string {
  const text = lines
    .slice(0, 4)
    .map((line) => `${line}\n`)
    .join("");
  return createHash("md5").update(text).digest("hex");
}

/**
 * Builds the `appendLine` seam handed to `runRecorder` for one target: parses
 * the record `runRecorder` computed, refuses (throws) on a degraded or
 * rubric-drifted reconstruction, otherwise stamps provenance and appends the
 * mutated record to the real target path. Never touches the original 4 lines.
 */
export function makeBackfillAppendLine(
  targetPath: string,
  slug: string,
  onAppended: (entry: AppendedEntry) => void,
): (path: string, line: string) => void {
  return (_path: string, line: string): void => {
    const parsed = JSON.parse(line) as CheckerRunRecord;
    if (parsed.failed_open) {
      throw new Error(`reconstruction degraded (failed_open:true) for ${slug} — refusing to append a degraded record`);
    }
    if (parsed.rubric_hash !== FROZEN_RUBRIC_HASH) {
      throw new Error(
        `rubric_hash mismatch for ${slug} (got ${parsed.rubric_hash}, expected ${FROZEN_RUBRIC_HASH}) — refusing to append`,
      );
    }
    const stamped: CheckerRunRecord = { ...parsed, backfilled: true, checker_elapsed_ms: 0 };
    mkdirSync(dirname(targetPath), { recursive: true });
    appendFileSync(targetPath, `${JSON.stringify(stamped)}\n`, "utf-8");
    onAppended({ rubric_hash: stamped.rubric_hash, slug: stamped.slug, touched_files: stamped.touched_files.length });
  };
}

/**
 * Pure selector: which of `targets` still need backfilling, given the records
 * already present in the target JSONL. A target is skipped once a
 * `backfilled:true` record with a matching slug exists — idempotent re-run.
 */
export function selectPendingTargets(
  targets: ReadonlyArray<{ slug: string }>,
  existingRecords: ReadonlyArray<Pick<CheckerRunRecord, "slug" | "backfilled">>,
): string[] {
  const alreadyBackfilledSlugs = new Set(
    existingRecords.filter((record) => record.backfilled === true).map((record) => record.slug),
  );
  return targets.filter((target) => !alreadyBackfilledSlugs.has(target.slug)).map((target) => target.slug);
}

function parseArgs(argv: string[]): { root?: string } {
  const idx = argv.indexOf("--root");
  return { root: idx !== -1 ? argv[idx + 1] : undefined };
}

function main(): void {
  const { root } = parseArgs(process.argv.slice(2));
  if (!root) {
    process.stderr.write(
      "backfill.ts: --root <main_repo_root> is required. Omitting it risks misrouting the append into the " +
        "wrong checkout's .canon/t2-probe/ — the exact failure mode this script exists to repair. Refusing to run.\n",
    );
    process.exitCode = 1;
    return;
  }

  const targetPath = join(root, ".canon", "t2-probe", "checker-runs.jsonl");

  let rawLines: string[];
  try {
    rawLines = readFileSync(targetPath, "utf-8")
      .split("\n")
      .filter((line) => line.length > 0);
  } catch (err) {
    process.stderr.write(`backfill.ts: could not read target JSONL at ${targetPath}: ${String(err)}\n`);
    process.exitCode = 1;
    return;
  }

  if (rawLines.length < 4 || computeFirstFourLinesMd5(rawLines) !== FROZEN_FIRST_FOUR_MD5) {
    process.stderr.write(
      `backfill.ts: refusing to run — the first 4 lines of ${targetPath} do not match the known-native-record ` +
        "prefix. This guards against running against the wrong file or a corrupted prefix (AC-9).\n",
    );
    process.exitCode = 1;
    return;
  }

  let existingRecords: CheckerRunRecord[];
  try {
    existingRecords = rawLines.map((line) => JSON.parse(line) as CheckerRunRecord);
  } catch (err) {
    process.stderr.write(`backfill.ts: refusing to run — target JSONL contains an unparseable line: ${String(err)}\n`);
    process.exitCode = 1;
    return;
  }
  const missingWorktrees = TARGETS.filter((target) => !existsSync(target.worktree));
  if (missingWorktrees.length > 0) {
    process.stderr.write(
      `backfill.ts: refusing to run — missing source worktree(s): ${missingWorktrees.map((t) => t.slug).join(", ")}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const pendingSlugs = new Set(selectPendingTargets(TARGETS, existingRecords));
  const skipped = TARGETS.filter((target) => !pendingSlugs.has(target.slug)).map((target) => target.slug);

  const appended: AppendedEntry[] = [];
  const failed: { slug: string; reason: string }[] = [];

  for (const target of TARGETS.filter((t) => pendingSlugs.has(t.slug))) {
    let thisAppend: AppendedEntry | undefined;
    const result = runRecorder(
      { base: target.base, head: target.reviewedHead, out: targetPath, root, slug: target.slug, worktree: target.worktree },
      { appendLine: makeBackfillAppendLine(targetPath, target.slug, (entry) => { thisAppend = entry; }) },
    );

    if (!result.ok || !thisAppend) {
      failed.push({ reason: result.ok ? "seam declined to append" : result.reason, slug: target.slug });
      continue;
    }
    appended.push(thisAppend);
  }

  for (const entry of appended) {
    process.stdout.write(`backfilled: ${entry.slug} rubric_hash=${entry.rubric_hash} touched_files=${entry.touched_files}\n`);
  }
  for (const slug of skipped) {
    process.stdout.write(`skipped (already backfilled): ${slug}\n`);
  }
  for (const failure of failed) {
    process.stderr.write(`UNBACKFILLABLE: ${failure.slug} — ${failure.reason}\n`);
  }

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

// Only run main() when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
