/**
 * build-trend-summary-writer — best-effort cross-run trend summary for finalizeWorkspace.
 *
 * After a build completes, this service reads the drift DB to produce a concise
 * markdown summary of build trends across recent flow runs. The summary is written
 * to ${workspace}/build-trend-summary.md so the orchestrator can surface it.
 *
 * Public entry point: tryWriteBuildTrendSummary(workspace)
 *   — mirrors tryWriteBuildDigest / tryReleaseClaims / tryAppendAnalytics
 *   — best-effort: wraps everything in try/catch, returns false on failure
 *   — returns true (graceful skip) when fewer than 5 flow runs exist
 *   — never throws
 *
 * Design decisions:
 *  - Reads from DriftDb (drift.db) via getDriftDb(projectDir)
 *  - Uses projectDir from @app/server-state.ts (same as digest-writer.ts)
 *  - atomicWriteFile for all writes (same filesystem = atomic rename)
 *  - < 100 lines of markdown output
 */

import { join } from "node:path";
import { projectDir } from "@app/server-state.ts";
import type { FlowRunEntry } from "@platform/storage/drift/drift-analytics-types.ts";
import { getDriftDb } from "@platform/storage/drift/drift-db.ts";
import { atomicWriteFile } from "@shared/lib/atomic-write.ts";
import type { ReviewEntry } from "@shared/schema.ts";

// ---- Data types ----

type RecurringViolation = {
  principle_id: string;
  count: number;
};

type TierStats = {
  tier: string;
  count: number;
  avg_duration_ms: number | null;
};

type RetriedState = {
  state: string;
  total_iterations: number;
};

type TrendData = {
  recurringViolations: RecurringViolation[];
  tierDistribution: TierStats[];
  mostRetriedStates: RetriedState[];
  runCount: number;
};

// ---- Computation helpers ----

/**
 * Compute recurring violations from reviews — violations with >= 2 occurrences.
 * Groups by principle_id across all reviews, counts how many reviews each appears in.
 */
export function computeRecurringViolations(reviews: ReviewEntry[]): RecurringViolation[] {
  const counts = new Map<string, number>();
  for (const review of reviews) {
    for (const v of review.violations ?? []) {
      counts.set(v.principle_id, (counts.get(v.principle_id) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count >= 2)
    .map(([principle_id, count]) => ({ count, principle_id }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Compute tier distribution from flow runs.
 * Groups by tier, counts runs per tier, and computes avg duration.
 */
export function computeTierDistribution(runs: FlowRunEntry[]): TierStats[] {
  const grouped = new Map<string, { count: number; totalMs: number; hasMs: boolean }>();
  for (const run of runs) {
    const tier = run.tier || "unknown";
    const existing = grouped.get(tier) ?? { count: 0, hasMs: false, totalMs: 0 };
    existing.count++;
    if (run.total_duration_ms != null && run.total_duration_ms > 0) {
      existing.totalMs += run.total_duration_ms;
      existing.hasMs = true;
    }
    grouped.set(tier, existing);
  }
  return Array.from(grouped.entries())
    .map(([tier, stats]) => ({
      avg_duration_ms: stats.hasMs ? Math.round(stats.totalMs / stats.count) : null,
      count: stats.count,
      tier,
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Compute most-retried states across flow runs.
 * Parses state_iterations (Record<string, number>) from each run,
 * aggregates totals per state, returns top 5 sorted desc.
 */
export function computeMostRetriedStates(runs: FlowRunEntry[]): RetriedState[] {
  const totals = new Map<string, number>();
  for (const run of runs) {
    const iterations = run.state_iterations;
    if (!iterations || typeof iterations !== "object") continue;
    for (const [state, count] of Object.entries(iterations)) {
      if (typeof count === "number" && count > 1) {
        totals.set(state, (totals.get(state) ?? 0) + count);
      }
    }
  }
  return Array.from(totals.entries())
    .map(([state, total_iterations]) => ({ state, total_iterations }))
    .sort((a, b) => b.total_iterations - a.total_iterations)
    .slice(0, 5);
}

// ---- Formatting ----

/** Format milliseconds as human-readable: "Xm" or "Xh Ym". */
function formatDuration(ms: number | null): string {
  if (ms === null) return "unknown";
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${totalMinutes}m`;
}

/**
 * Format TrendData as a concise markdown summary.
 * Target: < 100 lines.
 */
export function formatTrendSummary(data: TrendData): string {
  const lines: string[] = [];
  const date = new Date().toISOString().slice(0, 10);

  lines.push(`# Build Trend Summary — ${date}`);
  lines.push("");
  lines.push(`_Based on last ${data.runCount} flow runs._`);
  lines.push("");

  // Recurring Violations
  lines.push("## Recurring Violations");
  lines.push("");
  if (data.recurringViolations.length === 0) {
    lines.push("No recurring violations (none appeared in 2+ reviews).");
  } else {
    lines.push("| Principle | Reviews |");
    lines.push("|-----------|---------|");
    for (const v of data.recurringViolations) {
      lines.push(`| ${v.principle_id} | ${v.count} |`);
    }
  }
  lines.push("");

  // Tier Distribution
  lines.push("## Tier Distribution");
  lines.push("");
  if (data.tierDistribution.length === 0) {
    lines.push("No tier data available.");
  } else {
    lines.push("| Tier | Runs | Avg Duration |");
    lines.push("|------|------|--------------|");
    for (const t of data.tierDistribution) {
      lines.push(`| ${t.tier} | ${t.count} | ${formatDuration(t.avg_duration_ms)} |`);
    }
  }
  lines.push("");

  // Most-Retried States
  lines.push("## Most-Retried States");
  lines.push("");
  if (data.mostRetriedStates.length === 0) {
    lines.push("No states with multiple iterations detected.");
  } else {
    lines.push("| State | Total Iterations |");
    lines.push("|-------|-----------------|");
    for (const s of data.mostRetriedStates) {
      lines.push(`| ${s.state} | ${s.total_iterations} |`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

// ---- Public entry point ----

/**
 * Best-effort build trend summary writer. Called from finalizeWorkspace inside
 * the `if (complete)` block alongside tryWriteBuildDigest / tryReleaseClaims.
 *
 * Returns true when summary was written (or gracefully skipped due to < 5 runs).
 * Returns false on any error — including DB access failures or filesystem errors.
 * Never throws.
 */
export async function tryWriteBuildTrendSummary(workspace: string): Promise<boolean> {
  try {
    const driftDb = getDriftDb(projectDir);

    // 1. Get all flow runs
    const allRuns = driftDb.getAllFlowRuns();

    // 2. Graceful skip when fewer than 5 runs exist
    if (allRuns.length < 5) {
      return true;
    }

    // 3. Take the last 10 runs (sorted descending by started, take last 10)
    const sorted = [...allRuns].sort((a, b) => {
      const aTime = a.started ? Date.parse(a.started) : 0;
      const bTime = b.started ? Date.parse(b.started) : 0;
      return bTime - aTime;
    });
    const recentRuns = sorted.slice(0, 10);

    // 4. Get reviews for recurring violations
    const reviews = driftDb.getReviews({});

    // 5. Compute trend sections
    const data: TrendData = {
      mostRetriedStates: computeMostRetriedStates(recentRuns),
      recurringViolations: computeRecurringViolations(reviews),
      runCount: recentRuns.length,
      tierDistribution: computeTierDistribution(recentRuns),
    };

    // 6. Format markdown
    const content = formatTrendSummary(data);

    // 7. Write to workspace
    const outputPath = join(workspace, "build-trend-summary.md");
    await atomicWriteFile(outputPath, content);

    return true;
  } catch (err: unknown) {
    console.warn(
      "[canon] finalizeWorkspace: trend summary write failed:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
