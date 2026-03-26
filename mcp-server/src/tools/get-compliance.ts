import { DriftStore, type WeeklyTrendPoint } from "../drift/store.ts";
import { analyzeDrift } from "../drift/analyzer.ts";
import { loadAllPrinciples } from "../matcher.ts";

export interface ComplianceInput {
  principle_id: string;
}

export interface ComplianceOutput {
  principle_id: string;
  found: boolean;
  compliance_rate: number;
  total_violations: number;
  unintentional_violations: number;
  intentional_deviations: number;
  times_honored: number;
  total_reviews: number;
  trend: "improving" | "stable" | "declining" | "insufficient_data";
  weekly_trend: WeeklyTrendPoint[];
}

export async function getCompliance(
  input: ComplianceInput,
  projectDir: string,
  pluginDir: string
): Promise<ComplianceOutput> {
  const store = new DriftStore(projectDir);

  // Load principles (cached) and filter parsed JSONL entries to this principle only
  const [reviews, decisions, principles, weeklyTrend] = await Promise.all([
    store.getReviews({ principleId: input.principle_id }),
    store.getDecisions(input.principle_id),
    loadAllPrinciples(projectDir, pluginDir),
    store.getComplianceTrend(input.principle_id),
  ]);

  const allIds = principles.map((p) => p.id);
  const principleExists = allIds.includes(input.principle_id);

  if (!principleExists) {
    return {
      principle_id: input.principle_id,
      found: false,
      compliance_rate: 0,
      total_violations: 0,
      unintentional_violations: 0,
      intentional_deviations: 0,
      times_honored: 0,
      total_reviews: 0,
      trend: "insufficient_data",
      weekly_trend: [],
    };
  }

  const report = analyzeDrift(reviews, decisions, allIds, {
    principleId: input.principle_id,
  });

  const stats = report.most_violated.find(
    (s) => s.principle_id === input.principle_id
  );

  // If principle wasn't in most_violated, check if it was honored
  if (!stats) {
    // Count times honored — already filtered to this principle
    const honored = reviews.filter((r) =>
      r.honored.includes(input.principle_id)
    ).length;

    return {
      principle_id: input.principle_id,
      found: true,
      compliance_rate: 100,
      total_violations: 0,
      unintentional_violations: 0,
      intentional_deviations: decisions.length,
      times_honored: honored,
      total_reviews: report.total_reviews,
      trend: report.trend,
      weekly_trend: weeklyTrend,
    };
  }

  return {
    principle_id: input.principle_id,
    found: true,
    compliance_rate: stats.compliance_rate,
    total_violations: stats.total_violations,
    unintentional_violations: stats.unintentional_violations,
    intentional_deviations: stats.intentional_deviations,
    times_honored: stats.times_honored,
    total_reviews: report.total_reviews,
    trend: report.trend,
    weekly_trend: weeklyTrend,
  };
}
