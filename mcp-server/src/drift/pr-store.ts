import { join } from "path";
import type { PrReviewEntry } from "../schema.ts";
import { readJsonl, appendJsonl, rotateIfNeeded } from "./jsonl-store.ts";
import { CANON_DIR } from "../constants.ts";

export class PrStore {
  private reviewsPath: string;

  constructor(projectDir: string) {
    this.reviewsPath = join(projectDir, CANON_DIR, "pr-reviews.jsonl");
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
