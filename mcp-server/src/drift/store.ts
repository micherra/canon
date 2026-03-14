import { readFile, appendFile, mkdir } from "fs/promises";
import { join } from "path";

export interface DecisionEntry {
  decision_id: string;
  timestamp: string;
  principle_id: string;
  file_path: string;
  justification: string;
  category?: string;
}

export interface ReviewViolation {
  principle_id: string;
  severity: string;
}

export interface ReviewEntry {
  review_id: string;
  timestamp: string;
  verdict: "BLOCKING" | "WARNING" | "CLEAN";
  files: string[];
  violations: ReviewViolation[];
  honored: string[];
  score: {
    rules: { passed: number; total: number };
    opinions: { passed: number; total: number };
    conventions: { passed: number; total: number };
  };
}

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
  private reviewsPath: string;

  constructor(projectDir: string) {
    this.decisionsPath = join(projectDir, ".canon", "decisions.jsonl");
    this.reviewsPath = join(projectDir, ".canon", "reviews.jsonl");
  }

  async getDecisions(): Promise<DecisionEntry[]> {
    return readJsonl<DecisionEntry>(this.decisionsPath);
  }

  async getReviews(): Promise<ReviewEntry[]> {
    return readJsonl<ReviewEntry>(this.reviewsPath);
  }

  async appendDecision(entry: DecisionEntry): Promise<void> {
    await appendJsonl(this.decisionsPath, entry);
  }

  async appendReview(entry: ReviewEntry): Promise<void> {
    await appendJsonl(this.reviewsPath, entry);
  }
}
