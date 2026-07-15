#!/usr/bin/env node
/**
 * One-shot, idempotent repair for a JSONL file with merged lines (the
 * predecessor-omitted-trailing-newline defect, PROBE-FINDINGS.md P1).
 *
 * Backup-first: copies the target to `<path>.bak-<ISO-ts-with-colons-hyphenated>`
 * before writing anything.
 *
 * Order-preserving, byte-preserving: a merged line is split via parse-forward
 * — try JSON.parse(line.slice(pos)); on failure, the thrown SyntaxError's
 * "position N" tells us where the first complete record ends, so we take
 * line.slice(pos, pos + N) as ONE record's ORIGINAL BYTES (never
 * JSON.stringify(JSON.parse(x)), which would silently rewrite key order and
 * number formatting) and advance. If a slice does not parse cleanly, this
 * bails out and leaves that line untouched — a genuinely-unrepairable line
 * is reported, never mangled.
 *
 * Usage: node scripts/repair-jsonl-merged-lines.mjs <path-to-jsonl>
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function isoTsForFilename() {
  return new Date().toISOString().replace(/:/g, "-");
}

/**
 * Splits one merged JSONL line into its constituent original-byte records.
 * Parses forward from position 0: a clean `JSON.parse` of the whole line
 * means it was never merged (1 record, no split needed). Otherwise the
 * SyntaxError's reported position marks the end of the first complete
 * record; slice it out verbatim and recurse on the remainder. Returns
 * `null` (bail out, leave untouched) if any slice fails to parse cleanly —
 * the split algorithm was proven parse-forward-shaped by PROBE-FINDINGS P9
 * on the real corrupt line, so a slice failure here means this is not the
 * known merge shape and must not be guessed at.
 */
function splitMergedLine(line) {
  try {
    JSON.parse(line);
    return [line]; // Already a single clean record — nothing to split.
  } catch {
    // fall through to parse-forward
  }

  const records = [];
  let pos = 0;
  while (pos < line.length) {
    const remainder = line.slice(pos);
    try {
      JSON.parse(remainder);
      records.push(remainder);
      pos = line.length;
      break;
    } catch (err) {
      const match = /position (\d+)/.exec(err.message);
      if (!match) return null; // Not a position-reporting parse error — bail.
      const endOffset = Number(match[1]);
      const candidate = remainder.slice(0, endOffset);
      try {
        JSON.parse(candidate);
      } catch {
        return null; // Candidate slice itself doesn't parse — bail, don't mangle.
      }
      records.push(candidate);
      pos += endOffset;
    }
  }
  return records;
}

function main() {
  const targetArg = process.argv[2];
  if (!targetArg) {
    console.error("Usage: node scripts/repair-jsonl-merged-lines.mjs <path-to-jsonl>");
    process.exit(1);
  }
  const targetPath = resolve(targetArg);
  if (!existsSync(targetPath)) {
    console.error(`repair-jsonl-merged-lines: file not found: ${targetPath}`);
    process.exit(1);
  }

  const raw = readFileSync(targetPath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const recordsBefore = lines.length;

  let linesRepaired = 0;
  let unparseableRemaining = 0;
  const outputLines = [];

  for (const line of lines) {
    const split = splitMergedLine(line);
    if (split === null) {
      unparseableRemaining++;
      outputLines.push(line); // Leave untouched — genuinely unrepairable.
      continue;
    }
    if (split.length > 1) linesRepaired++;
    outputLines.push(...split);
  }

  const recordsAfter = outputLines.length;

  if (linesRepaired === 0) {
    console.log(
      `repair-jsonl-merged-lines: no merged lines — ${recordsBefore} records, 0 unparseable, no-op.`,
    );
    return;
  }

  const backupPath = `${targetPath}.bak-${isoTsForFilename()}`;
  copyFileSync(targetPath, backupPath);

  writeFileSync(targetPath, `${outputLines.join("\n")}\n`, "utf-8");

  console.log(`repair-jsonl-merged-lines: backup written to ${backupPath}`);
  console.log(`repair-jsonl-merged-lines: records before=${recordsBefore} after=${recordsAfter}`);
  console.log(`repair-jsonl-merged-lines: lines repaired=${linesRepaired}`);
  console.log(`repair-jsonl-merged-lines: unparseable remaining=${unparseableRemaining}`);
}

main();
