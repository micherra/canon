import { DriftStore } from "../drift/store.js";
import { analyzeDrift } from "../drift/analyzer.js";
import { loadAllPrinciples } from "../matcher.js";

export interface GetComplianceInput {
  principle_id: string;
}

export interface GetComplianceOutput {
  principle_id: string;
  found: boolean;
  compliance_rate: number;
  total_violations: number;
  unintentional_violations: number;
  intentional_deviations: number;
  times_honored: number;
  total_reviews: number;
  trend: "improving" | "stable" | "declining" | "insufficient_data";
}

export async function getCompliance(
  input: GetComplianceInput,
  projectDir: string,
  pluginDir: string
): Promise<GetComplianceOutput> {
  const store = new DriftStore(projectDir);
  const [reviews, decisions, principles] = await Promise.all([
    store.getReviews(),
    store.getDecisions(),
    loadAllPrinciples(projectDir, pluginDir),
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
    // Count times honored across all reviews
    const honored = reviews.filter((r) =>
      r.honored.includes(input.principle_id)
    ).length;

    return {
      principle_id: input.principle_id,
      found: true,
      compliance_rate: 100,
      total_violations: 0,
      unintentional_violations: 0,
      intentional_deviations: decisions.filter(
        (d) => d.principle_id === input.principle_id
      ).length,
      times_honored: honored,
      total_reviews: report.total_reviews,
      trend: report.trend,
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
  };
}
