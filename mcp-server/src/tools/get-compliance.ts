import { analyzeDrift } from "../drift/analyzer.ts";
import { DriftStore, type WeeklyTrendPoint } from "../drift/store.ts";
import { loadAllPrinciples } from "../matcher.ts";

export type ComplianceInput = {
  principle_id: string;
};

export type ComplianceOutput = {
  principle_id: string;
  found: boolean;
  compliance_rate: number;
  total_violations: number;
  unintentional_violations: number;
  times_honored: number;
  total_reviews: number;
  trend: "improving" | "stable" | "declining" | "insufficient_data";
  weekly_trend: WeeklyTrendPoint[];
};

export async function getCompliance(
  input: ComplianceInput,
  projectDir: string,
  pluginDir: string,
): Promise<ComplianceOutput> {
  const store = new DriftStore(projectDir);

  // Load principles (cached) and filter parsed JSONL entries to this principle only
  const [reviews, principles, weeklyTrend] = await Promise.all([
    store.getReviews({ principleId: input.principle_id }),
    loadAllPrinciples(projectDir, pluginDir),
    store.getComplianceTrend(input.principle_id),
  ]);

  const allIds = principles.map((p) => p.id);
  const principleExists = allIds.includes(input.principle_id);

  if (!principleExists) {
    return {
      compliance_rate: 0,
      found: false,
      principle_id: input.principle_id,
      times_honored: 0,
      total_reviews: 0,
      total_violations: 0,
      trend: "insufficient_data",
      unintentional_violations: 0,
      weekly_trend: [],
    };
  }

  const report = analyzeDrift(reviews, allIds, {
    principleId: input.principle_id,
  });

  const stats = report.most_violated.find((s) => s.principle_id === input.principle_id);

  // If principle wasn't in most_violated, check if it was honored
  if (!stats) {
    // Count times honored — already filtered to this principle
    const honored = reviews.filter((r) => r.honored.includes(input.principle_id)).length;

    return {
      compliance_rate: 100,
      found: true,
      principle_id: input.principle_id,
      times_honored: honored,
      total_reviews: report.total_reviews,
      total_violations: 0,
      trend: report.trend,
      unintentional_violations: 0,
      weekly_trend: weeklyTrend,
    };
  }

  return {
    compliance_rate: stats.compliance_rate,
    found: true,
    principle_id: input.principle_id,
    times_honored: stats.times_honored,
    total_reviews: report.total_reviews,
    total_violations: stats.total_violations,
    trend: report.trend,
    unintentional_violations: stats.unintentional_violations,
    weekly_trend: weeklyTrend,
  };
}
