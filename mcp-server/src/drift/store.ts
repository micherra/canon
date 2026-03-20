import { join } from "path";
import type { DecisionEntry, PatternEntry, ReviewEntry } from "../schema.js";
import { readJsonl, appendJsonl, rotateIfNeeded } from "./jsonl-store.js";
import { CANON_DIR } from "../constants.js";

export class DriftStore {
  private decisionsPath: string;
  private patternsPath: string;
  private reviewsPath: string;

  constructor(projectDir: string) {
    const canonDir = join(projectDir, CANON_DIR);
    this.decisionsPath = join(canonDir, "decisions.jsonl");
    this.patternsPath = join(canonDir, "patterns.jsonl");
    this.reviewsPath = join(canonDir, "reviews.jsonl");
  }

  async getDecisions(principleId?: string): Promise<DecisionEntry[]> {
    const filter = principleId
      ? (d: DecisionEntry) => d.principle_id === principleId
      : undefined;
    return readJsonl<DecisionEntry>(this.decisionsPath, filter);
  }

  async getPatterns(): Promise<PatternEntry[]> {
    return readJsonl<PatternEntry>(this.patternsPath);
  }

  async getReviews(principleId?: string): Promise<ReviewEntry[]> {
    const filter = principleId
      ? (r: ReviewEntry) =>
          r.violations.some((v) => v.principle_id === principleId) ||
          r.honored.includes(principleId)
      : undefined;
    return readJsonl<ReviewEntry>(this.reviewsPath, filter);
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
