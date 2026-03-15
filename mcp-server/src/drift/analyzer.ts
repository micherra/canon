import type { DecisionEntry, ReviewEntry } from "../schema.js";

export interface PrincipleStats {
  principle_id: string;
  total_violations: number;
  unintentional_violations: number;
  intentional_deviations: number;
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
  total_decisions: number;
  avg_score: {
    rules: number;
    opinions: number;
    conventions: number;
  };
  most_violated: PrincipleStats[];
  hotspot_directories: DirectoryStats[];
  intentional_ratio: number; // 0-100: what % of deviations were intentional
  recent_decisions: DecisionEntry[];
  never_triggered: string[]; // principle IDs that never appeared in reviews
  trend: "improving" | "stable" | "declining" | "insufficient_data";
}

export function analyzeDrift(
  reviews: ReviewEntry[],
  decisions: DecisionEntry[],
  allPrincipleIds: string[],
  options?: { lastN?: number; principleId?: string; directory?: string }
): DriftReport {
  let filteredReviews = reviews;
  let filteredDecisions = decisions;

  // Apply lastN filter
  if (options?.lastN) {
    filteredReviews = reviews.slice(-options.lastN);
  }

  // Apply principle filter
  if (options?.principleId) {
    filteredReviews = filteredReviews.filter(
      (r) =>
        r.violations.some((v) => v.principle_id === options.principleId) ||
        r.honored.includes(options.principleId!)
    );
    filteredDecisions = filteredDecisions.filter(
      (d) => d.principle_id === options.principleId
    );
  }

  // Apply directory filter
  if (options?.directory) {
    filteredReviews = filteredReviews.filter((r) =>
      r.files.some((f) => f.startsWith(options.directory!))
    );
    filteredDecisions = filteredDecisions.filter((d) =>
      d.file_path.startsWith(options.directory!)
    );
  }

  // Compute per-principle stats
  const principleMap = new Map<string, PrincipleStats>();
  const initStats = (id: string): PrincipleStats => ({
    principle_id: id,
    total_violations: 0,
    unintentional_violations: 0,
    intentional_deviations: 0,
    times_honored: 0,
    compliance_rate: 0,
  });

  // Count violations and honored from reviews
  for (const review of filteredReviews) {
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

  // Count intentional deviations from decisions and adjust unintentional count
  for (const d of filteredDecisions) {
    const stats = principleMap.get(d.principle_id) || initStats(d.principle_id);
    stats.intentional_deviations++;
    // Each intentional deviation accounts for one violation that was previously counted as unintentional
    if (stats.unintentional_violations > 0) {
      stats.unintentional_violations--;
    }
    principleMap.set(d.principle_id, stats);
  }

  // Compute compliance rates
  for (const stats of principleMap.values()) {
    const total = stats.times_honored + stats.total_violations;
    stats.compliance_rate = total > 0 ? Math.round((stats.times_honored / total) * 100) : 100;
  }

  // Sort by most violated
  const mostViolated = [...principleMap.values()]
    .filter((s) => s.total_violations > 0)
    .sort((a, b) => b.total_violations - a.total_violations);

  // Compute directory hotspots
  const dirMap = new Map<string, DirectoryStats>();
  for (const review of filteredReviews) {
    if (review.violations.length === 0) continue;
    for (const file of review.files) {
      const dir = file.substring(0, file.lastIndexOf("/")) || file;
      const stats = dirMap.get(dir) || { directory: dir, total_violations: 0, review_count: 0 };
      stats.total_violations += review.violations.length;
      stats.review_count++;
      dirMap.set(dir, stats);
    }
  }
  const hotspotDirectories = [...dirMap.values()]
    .sort((a, b) => b.total_violations - a.total_violations)
    .slice(0, 10);

  // Compute average scores
  const avgScore = { rules: 0, opinions: 0, conventions: 0 };
  if (filteredReviews.length > 0) {
    let rTotal = 0, rPassed = 0;
    let oTotal = 0, oPassed = 0;
    let cTotal = 0, cPassed = 0;
    for (const r of filteredReviews) {
      rTotal += r.score.rules.total;
      rPassed += r.score.rules.passed;
      oTotal += r.score.opinions.total;
      oPassed += r.score.opinions.passed;
      cTotal += r.score.conventions.total;
      cPassed += r.score.conventions.passed;
    }
    avgScore.rules = rTotal > 0 ? Math.round((rPassed / rTotal) * 100) : 100;
    avgScore.opinions = oTotal > 0 ? Math.round((oPassed / oTotal) * 100) : 100;
    avgScore.conventions = cTotal > 0 ? Math.round((cPassed / cTotal) * 100) : 100;
  }

  // Intentional ratio
  const totalDeviations = mostViolated.reduce((sum, s) => sum + s.total_violations, 0) +
    filteredDecisions.length;
  const intentionalRatio = totalDeviations > 0
    ? Math.round((filteredDecisions.length / totalDeviations) * 100)
    : 100;

  // Never-triggered principles
  const triggeredIds = new Set(principleMap.keys());
  const neverTriggered = allPrincipleIds.filter((id) => !triggeredIds.has(id));

  // Trend: compare first half vs second half of reviews
  let trend: DriftReport["trend"] = "insufficient_data";
  if (filteredReviews.length >= 6) {
    const mid = Math.floor(filteredReviews.length / 2);
    const firstHalf = filteredReviews.slice(0, mid);
    const secondHalf = filteredReviews.slice(mid);

    const firstViolations = firstHalf.reduce((sum, r) => sum + r.violations.length, 0) / firstHalf.length;
    const secondViolations = secondHalf.reduce((sum, r) => sum + r.violations.length, 0) / secondHalf.length;

    if (secondViolations < firstViolations * 0.8) {
      trend = "improving";
    } else if (secondViolations > firstViolations * 1.2) {
      trend = "declining";
    } else {
      trend = "stable";
    }
  }

  // Recent decisions (last 5)
  const recentDecisions = filteredDecisions.slice(-5);

  return {
    total_reviews: filteredReviews.length,
    total_decisions: filteredDecisions.length,
    avg_score: avgScore,
    most_violated: mostViolated.slice(0, 10),
    hotspot_directories: hotspotDirectories,
    intentional_ratio: intentionalRatio,
    recent_decisions: recentDecisions,
    never_triggered: neverTriggered,
    trend,
  };
}
