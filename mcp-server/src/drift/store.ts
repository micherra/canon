/**
 * DriftStore — project-scoped facade for review persistence.
 *
 * Delegates all operations to DriftDb (SQLite-backed).
 * The public interface is identical to the former JSONL-backed implementation;
 * callers do not know the backend changed.
 *
 * Callers keep their `await` usage unchanged since all methods return Promises
 * (wrapping synchronous DriftDb calls for backward compatibility).
 */

import type { ReviewEntry } from "../schema.ts";
import { getDriftDb, type WeeklyTrendPoint } from "./drift-db.ts";

// Re-export WeeklyTrendPoint so callers can `import { WeeklyTrendPoint } from "./store.ts"` (unchanged interface).
export type { WeeklyTrendPoint };

export class DriftStore {
  private readonly projectDir: string;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
  }

  async getReviews(options?: {
    principleId?: string;
    branch?: string;
    prNumber?: number;
  }): Promise<ReviewEntry[]> {
    return getDriftDb(this.projectDir).getReviews(options);
  }

  async getLastReviewForPr(prNumber: number): Promise<ReviewEntry | null> {
    return getDriftDb(this.projectDir).getLastReviewForPr(prNumber);
  }

  async getLastReviewForBranch(branch: string): Promise<ReviewEntry | null> {
    return getDriftDb(this.projectDir).getLastReviewForBranch(branch);
  }

  async appendReview(entry: ReviewEntry): Promise<void> {
    getDriftDb(this.projectDir).appendReview(entry);
  }

  async getComplianceTrend(principleId: string, weeks?: number): Promise<WeeklyTrendPoint[]> {
    return getDriftDb(this.projectDir).getComplianceTrend(principleId, weeks);
  }

  /**
   * Returns reviews that contain at least one of the specified file paths.
   * Delegates to DriftDb.getReviewsByFiles for client-side filtering.
   * Returns empty array when filePaths is empty or when no reviews match.
   */
  async getReviewsForFiles(filePaths: string[]): Promise<ReviewEntry[]> {
    return getDriftDb(this.projectDir).getReviewsByFiles(filePaths);
  }
}
