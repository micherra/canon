import { readFile, appendFile, mkdir } from "fs/promises";
import { join } from "path";
import type { DecisionEntry, PatternEntry, ReviewEntry } from "../schema.js";

export type { DecisionEntry, PatternEntry, ReviewEntry, ReviewViolation } from "../schema.js";

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
  const dir = filePath.substring(0, filePath.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });
  await appendFile(filePath, JSON.stringify(entry) + "\n", "utf-8");
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
  }

  async appendPattern(entry: PatternEntry): Promise<void> {
    await appendJsonl(this.patternsPath, entry);
  }

  async appendReview(entry: ReviewEntry): Promise<void> {
    await appendJsonl(this.reviewsPath, entry);
  }
}
