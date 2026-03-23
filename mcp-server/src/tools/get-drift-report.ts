import { DriftStore } from "../drift/store.js";
import { analyzeDrift, type DriftReport } from "../drift/analyzer.js";
import { formatDriftReport } from "../drift/reporter.js";
import { loadAllPrinciples } from "../matcher.js";

export interface GetDriftReportInput {
  last_n?: number;
  principle_id?: string;
  directory?: string;
}

export interface GetDriftReportOutput {
  report: DriftReport;
  formatted: string;
}

export async function getDriftReport(
  input: GetDriftReportInput,
  projectDir: string,
  pluginDir: string
): Promise<GetDriftReportOutput> {
  const store = new DriftStore(projectDir);

  const [reviews, decisions, principles] = await Promise.all([
    store.getReviews(),
    store.getDecisions(),
    loadAllPrinciples(projectDir, pluginDir),
  ]);

  const allIds = principles.map((p) => p.id);

  const report = analyzeDrift(reviews, decisions, allIds, {
    lastN: input.last_n,
    principleId: input.principle_id,
    directory: input.directory,
  });

  const formatted = formatDriftReport(report);

  return { report, formatted };
}
