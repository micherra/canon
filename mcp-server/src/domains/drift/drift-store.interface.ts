/**
 * IDriftStore — capability interface for review persistence.
 *
 * Cross-context callers depend on this interface rather than the concrete
 * DriftStore class. This hides the SQLite-backed implementation behind a
 * capability contract.
 */

import type { FlowRunEntry } from "@platform/storage/drift/drift-analytics-types.ts";
import type { WeeklyTrendPoint } from "@platform/storage/drift/drift-db.ts";
import type { ReviewEntry } from "@shared/schema.ts";

// Re-export FlowRunEntry so orchestration callers can obtain the type from the domain
// layer without importing directly from @platform/storage/drift/.
export type { FlowRunEntry };

export type IDriftStore = {
  appendReview(entry: ReviewEntry): Promise<void>;
  getComplianceTrend(principleId: string, weeks?: number): Promise<WeeklyTrendPoint[]>;
  getLastReviewForBranch(branch: string): Promise<ReviewEntry | null>;
  getLastReviewForPr(prNumber: number): Promise<ReviewEntry | null>;
  getReviews(options?: {
    principleId?: string;
    branch?: string;
    prNumber?: number;
  }): Promise<ReviewEntry[]>;
  getReviewsForFiles(filePaths: string[]): Promise<ReviewEntry[]>;
  // Flow run persistence — needed by update-board.ts complete_flow action
  appendFlowRun(entry: FlowRunEntry): void | Promise<void>;
  // Flow run query — needed by learn-gate.ts and skip-when.ts (flow count gate)
  countFlowRunsSince(sinceIso: string): number;
};
