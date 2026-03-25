import { DriftStore } from "../drift/store.ts";
import { PrStore } from "../drift/pr-store.ts";
import { analyzeDrift, type DriftReport } from "../drift/analyzer.ts";
import { formatDriftReport } from "../drift/reporter.ts";
import { loadAllPrinciples } from "../matcher.ts";
import type { PrReviewEntry } from "../schema.ts";

export interface DriftReportInput {
  last_n?: number;
  principle_id?: string;
  directory?: string;
}

export interface DriftReportOutput {
  report: DriftReport;
  formatted: string;
  pr_reviews: PrReviewEntry[];
}

export async function getDriftReport(
  input: DriftReportInput,
  projectDir: string,
  pluginDir: string
): Promise<DriftReportOutput> {
  const store = new DriftStore(projectDir);
  const prStore = new PrStore(projectDir);

  const [reviews, decisions, principles, prReviews] = await Promise.all([
    store.getReviews(),
    store.getDecisions(),
    loadAllPrinciples(projectDir, pluginDir),
    prStore.getReviews(),
  ]);

  const allIds = principles.map((p) => p.id);

  const report = analyzeDrift(reviews, decisions, allIds, {
    lastN: input.last_n,
    principleId: input.principle_id,
    directory: input.directory,
  });

  const formatted = formatDriftReport(report);

  return { report, formatted, pr_reviews: prReviews };
}
