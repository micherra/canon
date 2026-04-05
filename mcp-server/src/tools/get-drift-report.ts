import { analyzeDrift, type DriftReport } from "../drift/analyzer.ts";
import { formatDriftReport } from "../drift/reporter.ts";
import { DriftStore } from "../drift/store.ts";
import { loadAllPrinciples } from "../shared/matcher.ts";
import type { ReviewEntry } from "../shared/schema.ts";

export type DriftReportInput = {
  last_n?: number;
  principle_id?: string;
  directory?: string;
};

export type DriftReportOutput = {
  report: DriftReport;
  formatted: string;
  pr_reviews: ReviewEntry[];
};

export async function getDriftReport(
  input: DriftReportInput,
  projectDir: string,
  pluginDir: string,
): Promise<DriftReportOutput> {
  const store = new DriftStore(projectDir);

  const [reviews, principles] = await Promise.all([
    store.getReviews(),
    loadAllPrinciples(projectDir, pluginDir),
  ]);

  const allIds = principles.map((p) => p.id);

  const report = analyzeDrift(reviews, allIds, {
    directory: input.directory,
    lastN: input.last_n,
    principleId: input.principle_id,
  });

  const formatted = formatDriftReport(report);

  // PR-specific reviews: those with pr_number or branch set
  const prReviews = reviews.filter((r) => r.pr_number !== undefined || r.branch !== undefined);

  return { formatted, pr_reviews: prReviews, report };
}
