import { readFile, writeFile, appendFile, mkdir, rename } from "fs/promises";
import { dirname, join } from "path";
import type { DecisionEntry, PatternEntry, ReviewEntry } from "../schema.js";

// Maximum entries to keep in active .jsonl files before rotating
const MAX_ENTRIES = 500;

async function readJsonl<T>(filePath: string): Promise<T[]> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  const results: T[] = [];
  const lines = content.split("\n");
  let skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    try {
      results.push(JSON.parse(lines[i]) as T);
    } catch {
      skipped++;
    }
  }
  if (skipped > 0) {
    console.error(`[canon] Warning: skipped ${skipped} malformed line(s) in ${filePath}`);
  }
  return results;
}

async function appendJsonl<T>(filePath: string, entry: T): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  await appendFile(filePath, JSON.stringify(entry) + "\n", "utf-8");
}

/**
 * Rotate a .jsonl file when it exceeds MAX_ENTRIES.
 * Keeps the most recent MAX_ENTRIES entries in the active file.
 * Moves older entries to {filename}.archive.jsonl (appends, doesn't overwrite).
 */
async function rotateIfNeeded(filePath: string): Promise<void> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return;
  }

  const lines = content.split("\n").filter((l) => l.trim() !== "");
  if (lines.length <= MAX_ENTRIES) return;

  const keepCount = MAX_ENTRIES;
  const archiveLines = lines.slice(0, lines.length - keepCount);
  const keepLines = lines.slice(lines.length - keepCount);

  // Append old entries to archive
  const archivePath = filePath.replace(/\.jsonl$/, ".archive.jsonl");
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  await appendFile(archivePath, archiveLines.join("\n") + "\n", "utf-8");

  // Rewrite active file with only recent entries
  await writeFile(filePath, keepLines.join("\n") + "\n", "utf-8");

  console.error(
    `[canon] Rotated ${archiveLines.length} entries from ${filePath} to archive`
  );
}

export class DriftStore {
  private decisionsPath: string;
  private patternsPath: string;
  private reviewsPath: string;

  constructor(projectDir: string) {
    const canonDir = join(projectDir, ".canon");
    this.decisionsPath = join(canonDir, "decisions.jsonl");
    this.patternsPath = join(canonDir, "patterns.jsonl");
    this.reviewsPath = join(canonDir, "reviews.jsonl");
  }

  async getDecisions(): Promise<DecisionEntry[]> {
    return readJsonl<DecisionEntry>(this.decisionsPath);
  }

  async getPatterns(): Promise<PatternEntry[]> {
    return readJsonl<PatternEntry>(this.patternsPath);
  }

  async getReviews(): Promise<ReviewEntry[]> {
    return readJsonl<ReviewEntry>(this.reviewsPath);
  }

  async appendDecision(entry: DecisionEntry): Promise<void> {
    await appendJsonl(this.decisionsPath, entry);
    await rotateIfNeeded(this.decisionsPath);
  }

  async appendPattern(entry: PatternEntry): Promise<void> {
    await appendJsonl(this.patternsPath, entry);
    await rotateIfNeeded(this.patternsPath);
  }

  async appendReview(entry: ReviewEntry): Promise<void> {
    await appendJsonl(this.reviewsPath, entry);
    await rotateIfNeeded(this.reviewsPath);
  }
}
