/**
 * get_history — Query project execution history from drift.db.
 *
 * Returns a reverse-chronological HistoryEntry[] filtered by file path,
 * principle ID, topic keyword, and/or date. Queries drift.db only — no
 * live git calls (Decision: get-history-scope-04).
 */

import { getDriftDb } from "@platform/storage/drift/drift-db.ts";
import type { DecisionEntry, FlowRunEntry } from "@platform/storage/drift/drift-analytics-types.ts";
import type { ReviewEntry } from "@shared/schema.ts";
import { toolError, toolOk } from "@shared/lib/tool-result.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";

// ---- Types ----

export type HistoryEntryType =
  | "flow_run"
  | "decision"
  | "regression"
  | "principle_change"
  | "learning";

export type HistoryEntry = {
  type: HistoryEntryType;
  id: string;
  timestamp: string;
  summary: string;
  flow_run_id?: string;
  decision_id?: string;
  commit_shas?: string[];
  /** Cross-references to related entries. */
  links: Record<string, string>;
};

export type GetHistoryOutput = {
  entries: HistoryEntry[];
  total: number;
};

export type GetHistoryInput = {
  file_path?: string;
  principle_id?: string;
  topic?: string;
  since?: string;
  limit?: number;
};

// ---- Converters ----

function flowRunToEntry(run: FlowRunEntry): HistoryEntry {
  return {
    commit_shas: run.commits ?? [],
    flow_run_id: run.run_id,
    id: run.run_id,
    links: {},
    summary: `Flow run: ${run.flow} — ${run.task} (${run.tier})`,
    timestamp: run.completed,
    type: "flow_run",
  };
}

function decisionToEntry(decision: DecisionEntry): HistoryEntry {
  return {
    decision_id: decision.decision_id,
    id: decision.decision_id,
    links: decision.run_id ? { flow_run: decision.run_id } : {},
    summary: decision.summary ?? decision.title,
    timestamp: decision.timestamp,
    type: "decision",
  };
}

/**
 * Convert a ReviewEntry to a HistoryEntry.
 * Reviews with "BLOCKING" verdict or violations are typed as "regression";
 * otherwise "flow_run" (representing a completed review cycle).
 */
function reviewToEntry(review: ReviewEntry): HistoryEntry {
  const isRegression =
    review.verdict === "BLOCKING" ||
    (review.violations !== undefined && review.violations.length > 0);

  const rulesPassed = review.score.rules.passed;
  const rulesTotal = review.score.rules.total;
  const scoreStr = `${rulesPassed}/${rulesTotal} rules`;

  return {
    id: review.review_id,
    links: {
      review_id: review.review_id,
      ...(review.pr_number !== undefined
        ? { pr_number: String(review.pr_number) }
        : {}),
      ...(review.branch !== undefined ? { branch: review.branch } : {}),
    },
    summary: `Code review: verdict=${review.verdict}, score=${scoreStr}`,
    timestamp: review.timestamp,
    type: isRegression ? "regression" : "flow_run",
  };
}

// ---- Main function ----

export async function getHistory(
  input: GetHistoryInput,
  projectDir: string,
): Promise<ToolResult<GetHistoryOutput>> {
  // Validate since parameter if provided
  if (input.since !== undefined) {
    const parsed = new Date(input.since);
    if (isNaN(parsed.getTime())) {
      return toolError(
        "INVALID_INPUT",
        `Invalid ISO date for 'since': ${input.since}`,
        false,
        { since: input.since },
      );
    }
  }

  const driftDb = getDriftDb(projectDir);
  const limit = input.limit ?? 20;
  const entries: HistoryEntry[] = [];

  // 1. Topic search — use FTS5 searchHistory
  if (input.topic !== undefined) {
    let ftsResults: Array<{ entity_type: string; entity_id: string; rank: number }> = [];
    try {
      ftsResults = driftDb.searchHistory(input.topic, limit);
    } catch {
      // FTS5 not available — fall back gracefully with empty results
      ftsResults = [];
    }

    for (const hit of ftsResults) {
      if (hit.entity_type === "flow_run") {
        // Fetch the matching flow run
        const runs = driftDb.getFlowRuns({ limit: 1000 });
        const run = runs.find((r) => r.run_id === hit.entity_id);
        if (run !== undefined) {
          entries.push(flowRunToEntry(run));
        }
      } else if (hit.entity_type === "decision") {
        const decisions = driftDb.getRecentDecisions(1000);
        const decision = decisions.find((d) => d.decision_id === hit.entity_id);
        if (decision !== undefined) {
          entries.push(decisionToEntry(decision));
        }
      }
    }
  }

  // 2. File path filter — search flow_runs by diff_stat + decisions by files_affected
  if (input.file_path !== undefined) {
    const flowRuns = driftDb.getFlowRunsByFilePath(input.file_path, limit);
    for (const run of flowRuns) {
      entries.push(flowRunToEntry(run));
    }

    const decisions = driftDb.getDecisionsByFilesAffected(input.file_path);
    for (const decision of decisions) {
      entries.push(decisionToEntry(decision));
    }

    // Reviews that touched this file
    const reviews = driftDb.getReviewsByFiles([input.file_path]);
    for (const review of reviews) {
      entries.push(reviewToEntry(review));
    }
  }

  // 3. Principle ID filter — query reviews + decisions
  if (input.principle_id !== undefined) {
    const reviews = driftDb.getReviews({ principleId: input.principle_id });
    for (const review of reviews) {
      entries.push(reviewToEntry(review));
    }
    // principle_change entries: placeholder until principle version tracking is implemented
    // learning entries: placeholder until learning proposal DB is implemented
  }

  // 4. No filters — return recent history (flow_runs + decisions, reverse chronological)
  if (
    input.file_path === undefined &&
    input.principle_id === undefined &&
    input.topic === undefined
  ) {
    const recentRuns = driftDb.getFlowRuns({ limit });
    for (const run of recentRuns) {
      entries.push(flowRunToEntry(run));
    }

    const recentDecisions = driftDb.getRecentDecisions(limit);
    for (const decision of recentDecisions) {
      entries.push(decisionToEntry(decision));
    }
  }

  // 5. Apply since filter
  const filtered =
    input.since !== undefined
      ? entries.filter((e) => e.timestamp >= input.since!)
      : entries;

  // Sort all entries by timestamp descending, deduplicate by id, apply limit
  filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const deduplicated = [...new Map(filtered.map((e) => [e.id, e])).values()];
  const limited = deduplicated.slice(0, limit);

  return toolOk({ entries: limited, total: deduplicated.length });
}
