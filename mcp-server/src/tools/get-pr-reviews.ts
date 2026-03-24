/** Read stored PR reviews from .canon/pr-reviews.jsonl. */

import { PrStore } from "../drift/pr-store.js";
import type { PrReviewEntry } from "../schema.js";

export interface GetPrReviewsOutput {
  reviews: PrReviewEntry[];
}

export async function getPrReviews(projectDir: string): Promise<GetPrReviewsOutput> {
  try {
    const store = new PrStore(projectDir);
    const reviews = await store.getReviews();
    return { reviews };
  } catch {
    return { reviews: [] };
  }
}
