/**
 * build-trend-summary-writer — best-effort build trend summary writer for finalizeWorkspace.
 *
 * Reads flow run and review data from drift.db and writes a structured
 * build-trend-summary.md to the workspace directory. Useful for identifying
 * recurring violations, tier patterns, and retry hotspots across builds.
 *
 * Public entry point: tryWriteBuildTrendSummary(workspace)
 *   — mirrors tryWriteBuildDigest / tryReleaseClaims / tryAppendAnalytics
 *   — best-effort: wraps everything in try/catch, returns false on failure
 *   — never throws
 *
 * Graceful skip: when fewer than 5 flow runs exist in drift.db, returns
 * true without writing (insufficient data — not an error).
 *
 * Design decisions:
 *  - Imports getDriftDb using the same projectDir pattern as digest-writer.ts
 *  - Uses findRecurringViolations from @shared/lib/violation-patterns.ts
 *  - Uses atomicWriteFile for filesystem writes
 *  - Output stays under 100 lines to remain agent-consumable
 */

import { join } from "node:path";
import type { FlowRunEntry } from "@platform/storage/drift/drift-analytics-types.ts";
import { getDriftDb } from "@platform/storage/drift/drift-db.ts";
import { atomicWriteFile } from "@shared/lib/atomic-write.ts";
import type { RecurringViolation } from "@shared/lib/violation-patterns.ts";
import { findRecurringViolations } from "@shared/lib/violation-patterns.ts";
import type { ReviewEntry } from "@shared/schema.ts";

// ---- Local types ----

export type TierDistribution = {
  small: number;
  medium: number;
  large: number;
  avgDurationMsByTier: Record<string, number>;
};

export type RetriedState = {
  state: string;
  totalIterations: number;
  buildsAffected: number;
};

export type TrendData = {
  generatedAt: string;
  lookbackCount: number;
  recurringViolations: RecurringViolation[];
  tierDistribution: TierDistribution;
  mostRetriedStates: RetriedState[];
};

// Minimum number of flow runs required before writing a summary.
const MIN_FLOW_RUNS = 5;

// ---- Data extraction helpers ----

/** Compute per-tier counts and average durations from flow runs. */
function computeTierDistribution(flowRuns: FlowRunEntry[]): TierDistribution {
  const tierCounts: Record<string, number> = {};
  const tierDurationSums: Record<string, number> = {};

  for (const run of flowRuns) {
    const tier = run.tier || "medium";
    tierCounts[tier] = (tierCounts[tier] ?? 0) + 1;
    tierDurationSums[tier] = (tierDurationSums[tier] ?? 0) + run.total_duration_ms;
  }

  const avgDurationMsByTier: Record<string, number> = {};
  for (const [tier, count] of Object.entries(tierCounts)) {
    avgDurationMsByTier[tier] = Math.round((tierDurationSums[tier] ?? 0) / count);
  }

  return {
    avgDurationMsByTier,
    large: tierCounts.large ?? 0,
    medium: tierCounts.medium ?? 0,
    small: tierCounts.small ?? 0,
  };
}

/** Aggregate state_iterations across all flow runs, sorted by total iterations DESC. */
function computeMostRetriedStates(flowRuns: FlowRunEntry[]): RetriedState[] {
  const totals = new Map<string, { total: number; builds: number }>();

  for (const run of flowRuns) {
    for (const [state, iters] of Object.entries(run.state_iterations)) {
      const existing = totals.get(state);
      if (existing === undefined) {
        totals.set(state, { builds: 1, total: iters });
      } else {
        existing.total += iters;
        existing.builds += 1;
      }
    }
  }

  return [...totals.entries()]
    .map(([state, { total, builds }]) => ({
      buildsAffected: builds,
      state,
      totalIterations: total,
    }))
    .sort((a, b) => b.totalIterations - a.totalIterations);
}

// ---- Data extraction ----

/**
 * Extract TrendData from flow runs and drift reviews.
 * Pure function: no I/O, no side effects.
 */
export function extractTrendData(flowRuns: FlowRunEntry[], reviews: ReviewEntry[]): TrendData {
  return {
    generatedAt: new Date().toISOString(),
    lookbackCount: flowRuns.length,
    mostRetriedStates: computeMostRetriedStates(flowRuns),
    // findRecurringViolations accepts pre-normalized violations + raw review entries;
    // pass empty for the first arg since all data is in reviews (no run summaries here).
    recurringViolations: findRecurringViolations([], reviews),
    tierDistribution: computeTierDistribution(flowRuns),
  };
}

// ---- Formatting ----

/** Format milliseconds as minutes (integer). */
function formatMinutes(ms: number): string {
  return `${Math.round(ms / 60000)}m`;
}

/** Format ISO timestamp as YYYY-MM-DD. */
function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

/** Append the Recurring Violations section to the output lines. */
function appendViolationsSection(lines: string[], data: TrendData): void {
  lines.push("");
  lines.push("## Recurring Violations");
  lines.push("");
  if (data.recurringViolations.length === 0) {
    lines.push("No violations found across recent builds.");
  } else {
    lines.push("| Principle | Occurrences | Last Seen |");
    lines.push("|-----------|-------------|-----------|");
    for (const v of data.recurringViolations) {
      lines.push(`| ${v.principle_id} | ${v.occurrence_count} | ${formatDate(v.last_seen)} |`);
    }
  }
}

/** Append the Tier Distribution section to the output lines. */
function appendTierSection(lines: string[], data: TrendData): void {
  lines.push("");
  lines.push("## Tier Distribution");
  lines.push("");
  lines.push("| Tier | Count | Avg Duration |");
  lines.push("|------|-------|-------------|");

  for (const tier of ["small", "medium", "large"] as const) {
    const count = data.tierDistribution[tier];
    const avgMs = data.tierDistribution.avgDurationMsByTier[tier] ?? 0;
    const avgFormatted = count > 0 ? formatMinutes(avgMs) : "--";
    lines.push(`| ${tier} | ${count} | ${avgFormatted} |`);
  }
}

/** Append the Most-Retried States section to the output lines. */
function appendRetriedStatesSection(lines: string[], data: TrendData): void {
  lines.push("");
  lines.push("## Most-Retried States");
  lines.push("");
  if (data.mostRetriedStates.length === 0) {
    lines.push("No retried states found across recent builds.");
  } else {
    lines.push("| State | Total Iterations | Builds Affected |");
    lines.push("|-------|-----------------|-----------------|");
    // Limit to top 10 to stay under 100 lines
    for (const s of data.mostRetriedStates.slice(0, 10)) {
      lines.push(`| ${s.state} | ${s.totalIterations} | ${s.buildsAffected} |`);
    }
  }
}

/**
 * Format TrendData as a markdown artifact under 100 lines.
 */
export function formatTrendMarkdown(data: TrendData): string {
  const lines: string[] = [];

  lines.push("# Build Trend Summary");
  lines.push("");
  lines.push(`Generated: ${formatDate(data.generatedAt)}`);
  lines.push(`Lookback: last ${data.lookbackCount} builds`);

  appendViolationsSection(lines, data);
  appendTierSection(lines, data);
  appendRetriedStatesSection(lines, data);

  lines.push("");

  return lines.join("\n");
}

// ---- Public entry point ----

/**
 * Best-effort build trend summary writer. Called from finalizeWorkspace inside
 * the `if (complete)` block alongside tryWriteBuildDigest / tryReleaseClaims.
 *
 * Returns true when:
 *   - Summary was written successfully, OR
 *   - Fewer than 5 flow runs exist (graceful skip — insufficient data)
 *
 * Returns false on any unexpected error (DB failure, write failure, etc.).
 * Never throws.
 */
export async function tryWriteBuildTrendSummary(
  workspace: string,
  projectDir: string,
): Promise<boolean> {
  try {
    const db = getDriftDb(projectDir);

    // 1. Load flow runs
    const flowRuns = db.getAllFlowRuns();

    // 2. Graceful skip: insufficient data
    if (flowRuns.length < MIN_FLOW_RUNS) {
      return true;
    }

    // 3. Load reviews for violation analysis
    const reviews = db.getReviews();

    // 4. Extract trend data and format
    const content = formatTrendMarkdown(extractTrendData(flowRuns, reviews));

    // 5. Write to workspace
    await atomicWriteFile(join(workspace, "build-trend-summary.md"), content);

    return true;
  } catch (err: unknown) {
    console.warn(
      "[canon] finalizeWorkspace: trend summary write failed:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
