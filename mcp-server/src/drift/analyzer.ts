import { dirname } from "node:path";
import type { ReviewEntry } from "../schema.ts";

export interface PrincipleStats {
  principle_id: string;
  total_violations: number;
  unintentional_violations: number;
  times_honored: number;
  compliance_rate: number; // 0-100
}

export interface DirectoryStats {
  directory: string;
  total_violations: number;
  review_count: number;
}

export interface DriftReport {
  total_reviews: number;
  avg_score: {
    rules: number;
    opinions: number;
    conventions: number;
  };
  most_violated: PrincipleStats[];
  violation_directories: DirectoryStats[];
  never_triggered: string[]; // principle IDs that never appeared in reviews
  trend: "improving" | "stable" | "declining" | "insufficient_data";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
        r.violations.some((v) => v.principle_id === options.principleId) || r.honored.includes(options.principleId!),
    );
  }
  if (options?.directory) {
    filtered = filtered.filter((r) => r.files.some((f) => f.startsWith(options.directory!)));
  }
  return filtered;
}

function initStats(id: string): PrincipleStats {
  return {
    principle_id: id,
    total_violations: 0,
    unintentional_violations: 0,
    times_honored: 0,
    compliance_rate: 0,
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

function accumulatePerFileViolations(review: ReviewEntry, dirMap: Map<string, DirectoryStats>): void {
  const perFileCount = new Map<string, number>();
  for (const v of review.violations) {
    const file = v.file_path || review.files[0] || "";
    perFileCount.set(file, (perFileCount.get(file) || 0) + 1);
  }
  for (const [file, count] of perFileCount) {
    const dir = dirname(file);
    const stats = dirMap.get(dir) || { directory: dir, total_violations: 0, review_count: 0 };
    stats.total_violations += count;
    stats.review_count++;
    dirMap.set(dir, stats);
  }
}

function accumulateLegacyViolations(review: ReviewEntry, dirMap: Map<string, DirectoryStats>): void {
  const dir = dirname(review.files[0] || ".");
  const stats = dirMap.get(dir) || { directory: dir, total_violations: 0, review_count: 0 };
  stats.total_violations += review.violations.length;
  stats.review_count++;
  dirMap.set(dir, stats);
}

function computeAverageScores(reviews: ReviewEntry[]): { rules: number; opinions: number; conventions: number } {
  if (reviews.length === 0) return { rules: 0, opinions: 0, conventions: 0 };

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
    rules: rTotal > 0 ? Math.round((rPassed / rTotal) * 100) : 100,
    opinions: oTotal > 0 ? Math.round((oPassed / oTotal) * 100) : 100,
    conventions: cTotal > 0 ? Math.round((cPassed / cTotal) * 100) : 100,
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function analyzeDrift(
  reviews: ReviewEntry[],
  allPrincipleIds: string[],
  options?: { lastN?: number; principleId?: string; directory?: string },
): DriftReport {
  const filteredReviews = applyFilters(reviews, options);
  const principleMap = computePrincipleStats(filteredReviews);

  const mostViolated = [...principleMap.values()]
    .filter((s) => s.total_violations > 0)
    .sort((a, b) => b.total_violations - a.total_violations);

  const triggeredIds = new Set(principleMap.keys());
  const neverTriggered = allPrincipleIds.filter((id) => !triggeredIds.has(id));

  return {
    total_reviews: filteredReviews.length,
    avg_score: computeAverageScores(filteredReviews),
    most_violated: mostViolated.slice(0, 10),
    violation_directories: computeViolationDirectories(filteredReviews),
    never_triggered: neverTriggered,
    trend: computeTrend(filteredReviews),
  };
}
