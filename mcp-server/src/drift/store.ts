import { join } from "path";
import type { DecisionEntry, PatternEntry, ReviewEntry } from "../schema.js";
import { readJsonl, appendJsonl, rotateIfNeeded } from "./jsonl-store.js";
import { CANON_DIR } from "../constants.js";

export interface WeeklyTrendPoint {
  week: string; // ISO week: "2026-W12"
  pass_rate: number; // 0-1
  violations: number;
  reviews: number;
}

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

  /**
   * Compute weekly compliance trend for a principle.
   * Buckets reviews by ISO week and computes pass rate per bucket.
   */
  async getComplianceTrend(principleId: string, weeks?: number): Promise<WeeklyTrendPoint[]> {
    const reviews = await this.getReviews(principleId);
    if (reviews.length === 0) return [];

    const weekBuckets = new Map<string, { violations: number; passes: number }>();

    for (const review of reviews) {
      const week = toISOWeek(review.timestamp);
      const bucket = weekBuckets.get(week) ?? { violations: 0, passes: 0 };

      const hasViolation = review.violations.some(v => v.principle_id === principleId);
      const isHonored = review.honored.includes(principleId);

      if (hasViolation) bucket.violations++;
      if (isHonored) bucket.passes++;

      weekBuckets.set(week, bucket);
    }

    const sorted = Array.from(weekBuckets.entries())
      .sort(([a], [b]) => a.localeCompare(b));

    // Optionally limit to most recent N weeks
    const limited = weeks ? sorted.slice(-weeks) : sorted;

    return limited.map(([week, data]) => {
      const total = data.violations + data.passes;
      return {
        week,
        pass_rate: total > 0 ? Math.round((data.passes / total) * 100) / 100 : 0,
        violations: data.violations,
        reviews: total,
      };
    });
  }
}

/** Convert an ISO timestamp to ISO week string (e.g., "2026-W12"). */
function toISOWeek(timestamp: string): string {
  const date = new Date(timestamp);
  // Thursday-based ISO week calculation
  const jan4 = new Date(date.getFullYear(), 0, 4);
  const dayOfYear = Math.floor((date.getTime() - new Date(date.getFullYear(), 0, 1).getTime()) / 86400000) + 1;
  const weekNum = Math.ceil((dayOfYear + jan4.getDay() - 1) / 7);
  return `${date.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}
