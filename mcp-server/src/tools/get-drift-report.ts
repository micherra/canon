import { DriftStore } from "../drift/store.ts";
import { analyzeDrift, type DriftReport } from "../drift/analyzer.ts";
import { formatDriftReport } from "../drift/reporter.ts";
import { loadAllPrinciples } from "../matcher.ts";
import type { ReviewEntry } from "../schema.ts";

export interface DriftReportInput {
  last_n?: number;
  principle_id?: string;
  directory?: string;
}

export interface DriftReportOutput {
  report: DriftReport;
  formatted: string;
  pr_reviews: ReviewEntry[];
}

export async function getDriftReport(
  input: DriftReportInput,
  projectDir: string,
  pluginDir: string
): Promise<DriftReportOutput> {
  const store = new DriftStore(projectDir);

  const [reviews, principles] = await Promise.all([
    store.getReviews(),
    loadAllPrinciples(projectDir, pluginDir),
  ]);

  const allIds = principles.map((p) => p.id);

  const report = analyzeDrift(reviews, allIds, {
    lastN: input.last_n,
    principleId: input.principle_id,
    directory: input.directory,
  });

  const formatted = formatDriftReport(report);

  // PR-specific reviews: those with pr_number or branch set
  const prReviews = reviews.filter(
    (r) => r.pr_number !== undefined || r.branch !== undefined
  );

  return { report, formatted, pr_reviews: prReviews };
}
