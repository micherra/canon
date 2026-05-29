import { dirname } from "node:path";
import type { ConfidenceAnnotation } from "@shared/lib/confidence.ts";
import type { ReviewEntry } from "@shared/schema.ts";
import { computeComplianceConfidence } from "./drift-confidence-adapter.ts";

export type PrincipleStats = {
  principle_id: string;
  total_violations: number;
  unintentional_violations: number;
  times_honored: number;
  compliance_rate: number; // 0-100
  confidence?: ConfidenceAnnotation;
};

export type DirectoryStats = {
  directory: string;
  total_violations: number;
  review_count: number;
};

export type DriftReport = {
  total_reviews: number;
  avg_score: {
    rules: number;
    opinions: number;
    conventions: number;
  };
  craft: {
    score: number;
    holistic_count: number;
  };
  most_violated: PrincipleStats[];
  violation_directories: DirectoryStats[];
  never_triggered: string[]; // principle IDs that never appeared in reviews
  trend: "improving" | "stable" | "declining" | "insufficient_data";
};

function applyFilters(
  reviews: ReviewEntry[],
  options?: { lastN?: number; principleId?: string; directory?: string },
): ReviewEntry[] {
  let filtered = reviews;
  if (options?.lastN) {
    filtered = reviews.slice(-options.lastN);
  }
  if (options?.principleId) {
    filtered = filtered.filter(
      (r) =>
        r.violations.some((v) => v.principle_id === options.principleId) ||
        r.honored.includes(options.principleId!),
    );
  }
  if (options?.directory) {
    filtered = filtered.filter((r) => r.files.some((f) => f.startsWith(options.directory!)));
  }
  return filtered;
}

function initStats(id: string): PrincipleStats {
  return {
    compliance_rate: 0,
    principle_id: id,
    times_honored: 0,
    total_violations: 0,
    unintentional_violations: 0,
  };
}

function computePrincipleStats(reviews: ReviewEntry[]): Map<string, PrincipleStats> {
  const principleMap = new Map<string, PrincipleStats>();

  for (const review of reviews) {
    for (const v of review.violations) {
      const stats = principleMap.get(v.principle_id) || initStats(v.principle_id);
      stats.total_violations++;
      stats.unintentional_violations++;
      principleMap.set(v.principle_id, stats);
    }
    for (const h of review.honored) {
      const stats = principleMap.get(h) || initStats(h);
      stats.times_honored++;
      principleMap.set(h, stats);
    }
  }

  for (const stats of principleMap.values()) {
    const total = stats.times_honored + stats.total_violations;
    stats.compliance_rate = total > 0 ? Math.round((stats.times_honored / total) * 100) : 100;
  }

  return principleMap;
}

function computeViolationDirectories(reviews: ReviewEntry[]): DirectoryStats[] {
  const dirMap = new Map<string, DirectoryStats>();

  for (const review of reviews) {
    if (review.violations.length === 0) continue;

    const hasPerFileViolations = review.violations.some((v) => v.file_path);
    if (hasPerFileViolations) {
      accumulatePerFileViolations(review, dirMap);
    } else {
      accumulateLegacyViolations(review, dirMap);
    }
  }

  return [...dirMap.values()].sort((a, b) => b.total_violations - a.total_violations).slice(0, 10);
}

function accumulatePerFileViolations(
  review: ReviewEntry,
  dirMap: Map<string, DirectoryStats>,
): void {
  const perFileCount = new Map<string, number>();
  for (const v of review.violations) {
    const file = v.file_path || review.files[0] || "";
    perFileCount.set(file, (perFileCount.get(file) || 0) + 1);
  }
  for (const [file, count] of perFileCount) {
    const dir = dirname(file);
    const stats = dirMap.get(dir) || { directory: dir, review_count: 0, total_violations: 0 };
    stats.total_violations += count;
    stats.review_count++;
    dirMap.set(dir, stats);
  }
}

function accumulateLegacyViolations(
  review: ReviewEntry,
  dirMap: Map<string, DirectoryStats>,
): void {
  const dir = dirname(review.files[0] || ".");
  const stats = dirMap.get(dir) || { directory: dir, review_count: 0, total_violations: 0 };
  stats.total_violations += review.violations.length;
  stats.review_count++;
  dirMap.set(dir, stats);
}

function computeAverageScores(reviews: ReviewEntry[]): {
  rules: number;
  opinions: number;
  conventions: number;
} {
  if (reviews.length === 0) return { conventions: 0, opinions: 0, rules: 0 };

  let rTotal = 0,
    rPassed = 0;
  let oTotal = 0,
    oPassed = 0;
  let cTotal = 0,
    cPassed = 0;

  for (const r of reviews) {
    rTotal += r.score.rules.total;
    rPassed += r.score.rules.passed;
    oTotal += r.score.opinions.total;
    oPassed += r.score.opinions.passed;
    cTotal += r.score.conventions.total;
    cPassed += r.score.conventions.passed;
  }

  return {
    conventions: cTotal > 0 ? Math.round((cPassed / cTotal) * 100) : 100,
    opinions: oTotal > 0 ? Math.round((oPassed / oTotal) * 100) : 100,
    rules: rTotal > 0 ? Math.round((rPassed / rTotal) * 100) : 100,
  };
}

function computeTrend(reviews: ReviewEntry[]): DriftReport["trend"] {
  if (reviews.length < 6) return "insufficient_data";

  const mid = Math.floor(reviews.length / 2);
  const firstHalf = reviews.slice(0, mid);
  const secondHalf = reviews.slice(mid);

  const firstAvg = firstHalf.reduce((sum, r) => sum + r.violations.length, 0) / firstHalf.length;
  const secondAvg = secondHalf.reduce((sum, r) => sum + r.violations.length, 0) / secondHalf.length;

  if (secondAvg < firstAvg * 0.8) return "improving";
  if (secondAvg > firstAvg * 1.2) return "declining";
  return "stable";
}

function computePrincipleTrend(reviews: ReviewEntry[], principleId: string): DriftReport["trend"] {
  if (reviews.length < 6) return "insufficient_data";

  const mid = Math.floor(reviews.length / 2);
  const firstHalf = reviews.slice(0, mid);
  const secondHalf = reviews.slice(mid);

  const countViolations = (rs: ReviewEntry[]) =>
    rs.reduce(
      (sum, r) => sum + r.violations.filter((v) => v.principle_id === principleId).length,
      0,
    );

  const firstAvg = countViolations(firstHalf) / firstHalf.length;
  const secondAvg = countViolations(secondHalf) / secondHalf.length;

  if (firstAvg === 0 && secondAvg === 0) return "stable";
  if (firstAvg === 0) return "declining";
  if (secondAvg < firstAvg * 0.8) return "improving";
  if (secondAvg > firstAvg * 1.2) return "declining";
  return "stable";
}

/**
 * Compute a craft score (0–100) from holistic reviewer recommendations.
 *
 * Formula: `score = max(0, 100 − min(100, holistic_count × 10))`
 *
 * Each holistic finding deducts 10 craft points; 10 or more findings floor
 * the score at 0. Holistic findings signal structural or cross-cutting
 * concerns (source === "holistic") rather than per-principle violations.
 */
export function computeCraftScore(reviews: ReviewEntry[]): {
  score: number;
  holistic_count: number;
} {
  if (reviews.length === 0) return { holistic_count: 0, score: 100 };

  let holistic_count = 0;
  for (const r of reviews) {
    if (!r.recommendations) continue;
    for (const rec of r.recommendations) {
      if (rec.source === "holistic") holistic_count++;
    }
  }

  // Each holistic finding costs 10 craft points; 10+ findings floor the score at 0.
  const score = Math.max(0, 100 - Math.min(100, holistic_count * 10));
  return { holistic_count, score };
}

// Main

export function analyzeDrift(
  reviews: ReviewEntry[],
  allPrincipleIds: string[],
  options?: { lastN?: number; principleId?: string; directory?: string },
): DriftReport {
  const filteredReviews = applyFilters(reviews, options);
  const principleMap = computePrincipleStats(filteredReviews);
  const trend = computeTrend(filteredReviews);

  const topViolated = [...principleMap.values()]
    .filter((s) => s.total_violations > 0)
    .sort((a, b) => b.total_violations - a.total_violations)
    .slice(0, 10);

  const mostViolated = topViolated.map((s) => ({
    ...s,
    confidence: computeComplianceConfidence({
      ...s,
      trend: computePrincipleTrend(filteredReviews, s.principle_id),
    }),
  }));

  const triggeredIds = new Set(principleMap.keys());
  const neverTriggered = allPrincipleIds.filter((id) => !triggeredIds.has(id));

  return {
    avg_score: computeAverageScores(filteredReviews),
    craft: computeCraftScore(filteredReviews),
    most_violated: mostViolated,
    never_triggered: neverTriggered,
    total_reviews: filteredReviews.length,
    trend,
    violation_directories: computeViolationDirectories(filteredReviews),
  };
}
