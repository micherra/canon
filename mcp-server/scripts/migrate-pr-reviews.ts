#!/usr/bin/env tsx
/**
 * Migration script: .canon/pr-reviews.jsonl → .canon/reviews.jsonl
 *
 * Reads old PrReviewEntry records from pr-reviews.jsonl and appends them
 * to reviews.jsonl as unified ReviewEntry records, then renames the
 * source file to pr-reviews.jsonl.bak.
 *
 * Usage:
 *   npx tsx mcp-server/scripts/migrate-pr-reviews.ts [project-dir]
 *
 * If project-dir is omitted, the current working directory is used.
 */

import { createReadStream, createWriteStream, existsSync, renameSync } from "fs";
import { appendFileSync, readFileSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";

// Shape of the old PrReviewEntry (deleted 2026-03-25)
interface OldPrReviewEntry {
  pr_review_id: string;       // prefix "prr_"
  timestamp: string;
  pr_number: number;
  branch?: string;
  last_reviewed_sha?: string;
  file_priorities?: Array<{ path: string; priority_score: number }>;
  files: string[];
  violations: Array<{
    principle_id: string;
    severity: string;
    file_path?: string;
    impact_score?: number;
    message?: string;
  }>;
  honored: string[];
  score: {
    rules: { passed: number; total: number };
    opinions: { passed: number; total: number };
    conventions: { passed: number; total: number };
  };
  verdict: "BLOCKING" | "WARNING" | "CLEAN";
}

// Unified ReviewEntry (current schema from src/schema.ts)
interface ReviewEntry {
  review_id: string;          // prefix "rev_"
  timestamp: string;
  files: string[];
  violations: Array<{
    principle_id: string;
    severity: string;
    file_path?: string;
    impact_score?: number;
    message?: string;
  }>;
  honored: string[];
  score: {
    rules: { passed: number; total: number };
    opinions: { passed: number; total: number };
    conventions: { passed: number; total: number };
  };
  verdict: "BLOCKING" | "WARNING" | "CLEAN";
  pr_number?: number;
  branch?: string;
  last_reviewed_sha?: string;
  file_priorities?: Array<{ path: string; priority_score: number }>;
}

function mapEntry(old: OldPrReviewEntry): ReviewEntry {
  // Map pr_review_id (prr_...) → review_id (rev_...)
  const review_id = old.pr_review_id.replace(/^prr_/, "rev_");

  const entry: ReviewEntry = {
    review_id,
    timestamp: old.timestamp,
    files: old.files,
    violations: old.violations,
    honored: old.honored,
    score: old.score,
    verdict: old.verdict,
    // PR-specific optional fields
    pr_number: old.pr_number,
  };

  if (old.branch !== undefined) entry.branch = old.branch;
  if (old.last_reviewed_sha !== undefined) entry.last_reviewed_sha = old.last_reviewed_sha;
  if (old.file_priorities !== undefined) entry.file_priorities = old.file_priorities;

  return entry;
}

async function readJsonlLines(filePath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    const rl = createInterface({
      input: createReadStream(filePath),
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed.length > 0) lines.push(trimmed);
    });
    rl.on("close", () => resolve(lines));
    rl.on("error", reject);
  });
}

async function main() {
  const projectDir = process.argv[2] ?? process.cwd();
  const canonDir = join(projectDir, ".canon");
  const srcPath = join(canonDir, "pr-reviews.jsonl");
  const dstPath = join(canonDir, "reviews.jsonl");
  const bakPath = join(canonDir, "pr-reviews.jsonl.bak");

  if (!existsSync(srcPath)) {
    console.log(`Nothing to migrate: ${srcPath} does not exist.`);
    process.exit(0);
  }

  console.log(`Reading entries from: ${srcPath}`);
  const lines = await readJsonlLines(srcPath);

  if (lines.length === 0) {
    console.log("Source file is empty — nothing to migrate.");
    renameSync(srcPath, bakPath);
    console.log(`Renamed empty source to: ${bakPath}`);
    process.exit(0);
  }

  let migrated = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      errors.push(`Line ${i + 1}: invalid JSON — ${String(err)}`);
      skipped++;
      continue;
    }

    const old = parsed as OldPrReviewEntry;

    // Validate minimum required fields
    if (!old.pr_review_id || !old.timestamp || !old.files || !old.violations) {
      errors.push(`Line ${i + 1}: missing required fields (pr_review_id, timestamp, files, violations)`);
      skipped++;
      continue;
    }

    const newEntry = mapEntry(old);

    try {
      appendFileSync(dstPath, JSON.stringify(newEntry) + "\n", "utf8");
      migrated++;
    } catch (err) {
      errors.push(`Line ${i + 1}: failed to write — ${String(err)}`);
      skipped++;
    }
  }

  // Rename source to .bak
  try {
    renameSync(srcPath, bakPath);
    console.log(`Backed up source to: ${bakPath}`);
  } catch (err) {
    console.error(`Warning: could not rename source file — ${String(err)}`);
  }

  // Print summary
  console.log("\nMigration complete:");
  console.log(`  Migrated : ${migrated}`);
  console.log(`  Skipped  : ${skipped}`);
  console.log(`  Output   : ${dstPath}`);

  if (errors.length > 0) {
    console.log("\nErrors:");
    for (const e of errors) {
      console.log(`  ${e}`);
    }
  }

  process.exit(skipped > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
