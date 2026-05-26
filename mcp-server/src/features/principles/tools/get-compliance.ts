import type { PrincipleStats } from "@platform/storage/drift/analyzer.ts";
import { analyzeDrift } from "@platform/storage/drift/analyzer.ts";
import {
  type ConfidenceAnnotation,
  computeComplianceConfidence,
} from "@platform/storage/drift/drift-confidence-adapter.ts";
import { DriftStore, type WeeklyTrendPoint } from "@platform/storage/drift/store.ts";
import { loadAllPrinciples } from "@shared/matcher.ts";
import type { ReviewEntry } from "@shared/schema.ts";

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
  confidence?: ConfidenceAnnotation;
};

type ResolvedStats = {
  compliance_rate: number;
  times_honored: number;
  total_violations: number;
  unintentional_violations: number;
};

function resolveStats(
  stats: PrincipleStats | undefined,
  principleId: string,
  reviews: ReviewEntry[],
): ResolvedStats {
  if (stats) {
    return {
      compliance_rate: stats.compliance_rate,
      times_honored: stats.times_honored,
      total_violations: stats.total_violations,
      unintentional_violations: stats.unintentional_violations,
    };
  }
  // Principle only honored, never violated
  const honored = reviews.filter((r) => r.honored.includes(principleId)).length;
  return {
    compliance_rate: 100,
    times_honored: honored,
    total_violations: 0,
    unintentional_violations: 0,
  };
}

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

  const report = analyzeDrift(reviews, allIds, { principleId: input.principle_id });
  const rawStats = report.most_violated.find((s) => s.principle_id === input.principle_id);
  const resolved = resolveStats(rawStats, input.principle_id, reviews);

  const confidence =
    rawStats?.confidence ??
    computeComplianceConfidence({
      compliance_rate: resolved.compliance_rate,
      principle_id: input.principle_id,
      times_honored: resolved.times_honored,
      total_violations: resolved.total_violations,
    });

  return {
    compliance_rate: resolved.compliance_rate,
    confidence,
    found: true,
    principle_id: input.principle_id,
    times_honored: resolved.times_honored,
    total_reviews: report.total_reviews,
    total_violations: resolved.total_violations,
    trend: report.trend,
    unintentional_violations: resolved.unintentional_violations,
    weekly_trend: weeklyTrend,
  };
}
