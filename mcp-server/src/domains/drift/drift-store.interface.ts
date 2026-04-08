/**
 * IDriftStore — capability interface for review persistence.
 *
 * Cross-context callers depend on this interface rather than the concrete
 * DriftStore class. This hides the SQLite-backed implementation behind a
 * capability contract.
 */

import type { WeeklyTrendPoint } from "@platform/storage/drift/drift-db.ts";
import type { ReviewEntry } from "@shared/schema.ts";

export interface IDriftStore {
  getReviews(options?: { principleId?: string; branch?: string; prNumber?: number }): Promise<ReviewEntry[]>;
  getLastReviewForPr(prNumber: number): Promise<ReviewEntry | null>;
  getLastReviewForBranch(branch: string): Promise<ReviewEntry | null>;
  appendReview(entry: ReviewEntry): Promise<void>;
  getComplianceTrend(principleId: string, weeks?: number): Promise<WeeklyTrendPoint[]>;
  getReviewsForFiles(filePaths: string[]): Promise<ReviewEntry[]>;
}
