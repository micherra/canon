import { readFile, writeFile, appendFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import type { PrReviewEntry } from "../schema.js";

const MAX_ENTRIES = 500;

async function readJsonl<T>(filePath: string): Promise<T[]> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  const results: T[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    try {
      results.push(JSON.parse(line) as T);
    } catch {
      // skip malformed
    }
  }
  return results;
}

async function appendJsonl<T>(filePath: string, entry: T): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  await appendFile(filePath, JSON.stringify(entry) + "\n", "utf-8");
}

async function rotateIfNeeded(filePath: string): Promise<void> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return;
  }

  const lines = content.split("\n").filter((l) => l.trim() !== "");
  if (lines.length <= MAX_ENTRIES) return;

  const archiveLines = lines.slice(0, lines.length - MAX_ENTRIES);
  const keepLines = lines.slice(lines.length - MAX_ENTRIES);

  const archivePath = filePath.replace(/\.jsonl$/, ".archive.jsonl");
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  await appendFile(archivePath, archiveLines.join("\n") + "\n", "utf-8");
  await writeFile(filePath, keepLines.join("\n") + "\n", "utf-8");
}

export class PrStore {
  private reviewsPath: string;

  constructor(projectDir: string) {
    this.reviewsPath = join(projectDir, ".canon", "pr-reviews.jsonl");
  }

  async getReviews(prNumber?: number): Promise<PrReviewEntry[]> {
    const entries = await readJsonl<PrReviewEntry>(this.reviewsPath);
    if (prNumber === undefined) return entries;
    return entries.filter((e) => e.pr_number === prNumber);
  }

  async getLastReviewForPr(prNumber: number): Promise<PrReviewEntry | null> {
    const reviews = await this.getReviews(prNumber);
    return reviews.length > 0 ? reviews[reviews.length - 1] : null;
  }

  async appendReview(entry: PrReviewEntry): Promise<void> {
    await appendJsonl(this.reviewsPath, entry);
    await rotateIfNeeded(this.reviewsPath);
  }
}
