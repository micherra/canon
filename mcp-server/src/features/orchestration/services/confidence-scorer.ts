/**
 * confidence-scorer — Pure confidence scoring and signal gathering for autonomy tier assignment.
 *
 * Public entry points:
 *   computeConfidence(signals): ConfidenceResult  — pure, no I/O
 *   gatherSignals(filePaths, projectDir): ConfidenceSignals  — I/O, reads drift.db + KG
 *
 * Design:
 *  - computeConfidence is a pure function; all I/O is isolated in gatherSignals
 *  - gatherSignals wraps each signal source in try/catch; failure sets worst-case value
 *  - Security file pattern match: principles/, rules/, hooks/, .canon/config.json
 *  - Scoring algorithm produces 0-100 score; tier = score >= 80 → autonomous,
 *    score >= 40 → light-touch, else → supervised
 */

import { getDriftDb } from "@platform/storage/drift/drift-db.ts";
import { graphQuery } from "@features/knowledge-graph/tools/graph-query.ts";

// ---- Types ----

export type AutonomyTier = "autonomous" | "light-touch" | "supervised";

export type ConfidenceSignals = {
  file_paths: string[];
  build_history: {
    recent_runs: number;
    clean_review_rate: number; // 0-1, fraction of CLEAN verdicts in last 10 runs
    avg_retry_count: number; // average state_iterations across recent runs
    recent_failure_rate: number; // fraction of runs with any BLOCKING review
  };
  blast_radius: {
    total_affected_files: number;
    max_depth: number;
  };
  compliance: {
    total_active_violations: number;
    max_violation_streak: number;
    has_clean_streak: boolean; // any file with clean_streak >= 3
  };
  has_security_files: boolean;
  override_tier?: AutonomyTier; // user-forced tier
};

export type ConfidenceResult = {
  tier: AutonomyTier;
  score: number; // 0-100, or -1 for override
  reasoning: string;
  signals_used: string[];
};

// ---- Security file pattern matching ----

// Security file patterns — must be an anchored top-level directory or specific path.
// principles/, rules/, hooks/ must appear at the start of the path (not nested under src/).
// .canon/config.json must be the exact path from the repo root.
const SECURITY_PATTERNS = [
  /^principles\//,
  /^rules\//,
  /^hooks\//,
  /^\.canon\/config\.json$/,
];

/**
 * Returns true when any file path matches a security-sensitive pattern.
 * Positive: hooks/pre-commit.sh — matches
 * Negative: src/hooks-utils.ts — does NOT match
 */
export function hasSecurityFiles(filePaths: string[]): boolean {
  return filePaths.some((fp) => SECURITY_PATTERNS.some((pattern) => pattern.test(fp)));
}

// ---- Scoring helpers ----

function buildReasoning(signals: ConfidenceSignals, score: number): string {
  const parts: string[] = [];

  if (signals.build_history.recent_runs < 5) {
    parts.push(`insufficient build history (${signals.build_history.recent_runs} runs)`);
  }
  if (signals.build_history.clean_review_rate < 1) {
    const pct = Math.round((1 - signals.build_history.clean_review_rate) * 100);
    parts.push(`${pct}% non-clean review rate`);
  }
  if (signals.build_history.avg_retry_count > 0) {
    parts.push(`avg ${signals.build_history.avg_retry_count.toFixed(1)} retries per run`);
  }
  if (signals.build_history.recent_failure_rate > 0) {
    const pct = Math.round(signals.build_history.recent_failure_rate * 100);
    parts.push(`${pct}% builds with BLOCKING review`);
  }
  if (signals.blast_radius.total_affected_files > 50) {
    parts.push(`high blast radius (${signals.blast_radius.total_affected_files} affected files)`);
  } else if (signals.blast_radius.total_affected_files > 20) {
    parts.push(`medium blast radius (${signals.blast_radius.total_affected_files} affected files)`);
  } else if (signals.blast_radius.total_affected_files > 10) {
    parts.push(`low-medium blast radius (${signals.blast_radius.total_affected_files} affected files)`);
  }
  if (signals.blast_radius.max_depth > 3) {
    parts.push(`dependency depth ${signals.blast_radius.max_depth}`);
  }
  if (signals.compliance.total_active_violations > 0) {
    parts.push(`${signals.compliance.total_active_violations} active violation(s)`);
  }
  if (signals.compliance.max_violation_streak > 0) {
    parts.push(`violation streak ${signals.compliance.max_violation_streak}`);
  }
  if (signals.file_paths.length > 20) {
    parts.push(`${signals.file_paths.length} files changed`);
  }

  if (parts.length === 0) {
    return `score ${score} — clean signals across all dimensions`;
  }
  return `score ${score} — penalized by: ${parts.join(", ")}`;
}

// ---- Pure scoring function ----

/**
 * Compute autonomy tier from pre-gathered signals.
 * Pure function: no I/O, no side effects.
 * Returns tier, score (0-100), reasoning, and signals_used list.
 */
export function computeConfidence(signals: ConfidenceSignals): ConfidenceResult {
  // Short-circuit: user override takes precedence over all scoring
  if (signals.override_tier !== undefined) {
    return {
      reasoning: `user override to ${signals.override_tier}`,
      score: -1,
      signals_used: ["override_tier"],
      tier: signals.override_tier,
    };
  }

  // Short-circuit: security files always produce supervised tier
  if (signals.has_security_files) {
    return {
      reasoning: "security-sensitive files present — supervised tier required",
      score: 0,
      signals_used: ["has_security_files"],
      tier: "supervised",
    };
  }

  let score = 100;
  const signals_used: string[] = [];

  // Build history scoring (up to 40 points deducted)
  if (signals.build_history.recent_runs < 5) {
    score -= 30;
    signals_used.push("build_history.recent_runs");
  }

  const cleanPenalty = (1 - signals.build_history.clean_review_rate) * 30;
  if (cleanPenalty > 0) {
    score -= cleanPenalty;
    signals_used.push("build_history.clean_review_rate");
  }

  // avg_retry_count penalty: 5 points per retry, capped at 20
  const retryPenalty = Math.min(signals.build_history.avg_retry_count * 5, 20);
  if (retryPenalty > 0) {
    score -= retryPenalty;
    signals_used.push("build_history.avg_retry_count");
  }

  const failurePenalty = signals.build_history.recent_failure_rate * 10;
  if (failurePenalty > 0) {
    score -= failurePenalty;
    signals_used.push("build_history.recent_failure_rate");
  }

  // Blast radius scoring (up to 30 points deducted)
  if (signals.blast_radius.total_affected_files > 50) {
    score -= 30;
    signals_used.push("blast_radius.total_affected_files");
  } else if (signals.blast_radius.total_affected_files > 20) {
    score -= 20;
    signals_used.push("blast_radius.total_affected_files");
  } else if (signals.blast_radius.total_affected_files > 10) {
    score -= 10;
    signals_used.push("blast_radius.total_affected_files");
  }

  if (signals.blast_radius.max_depth > 3) {
    score -= 10;
    signals_used.push("blast_radius.max_depth");
  }

  // Compliance scoring (up to 20 points deducted)
  const violationPenalty = Math.min(signals.compliance.total_active_violations * 5, 15);
  if (violationPenalty > 0) {
    score -= violationPenalty;
    signals_used.push("compliance.total_active_violations");
  }

  const streakPenalty = signals.compliance.max_violation_streak * 3;
  if (streakPenalty > 0) {
    score -= streakPenalty;
    signals_used.push("compliance.max_violation_streak");
  }

  // File count scoring (up to 10 points deducted)
  if (signals.file_paths.length > 20) {
    score -= 10;
    signals_used.push("file_paths.length");
  } else if (signals.file_paths.length > 10) {
    score -= 5;
    signals_used.push("file_paths.length");
  }

  score = Math.max(0, Math.min(100, score));
  const tier: AutonomyTier = score >= 80 ? "autonomous" : score >= 40 ? "light-touch" : "supervised";

  return {
    reasoning: buildReasoning(signals, score),
    score,
    signals_used: signals_used.length > 0 ? signals_used : ["baseline"],
    tier,
  };
}

// ---- I/O signal gathering ----

const RECENT_RUNS_LOOKBACK = 10;

/**
 * Gather confidence signals from drift.db, KG blast radius, and file path patterns.
 * NOT pure — performs I/O.
 *
 * Each signal source is wrapped in try/catch: failure sets that signal to its
 * worst-case (most conservative) value rather than best-case.
 */
export async function gatherSignals(
  filePaths: string[],
  projectDir: string,
): Promise<ConfidenceSignals> {
  const signals: ConfidenceSignals = {
    blast_radius: { max_depth: 0, total_affected_files: 0 },
    build_history: {
      avg_retry_count: 0,
      clean_review_rate: 0, // worst-case default
      recent_failure_rate: 1, // worst-case default
      recent_runs: 0,
    },
    compliance: {
      has_clean_streak: false,
      max_violation_streak: 0,
      total_active_violations: 0,
    },
    file_paths: filePaths,
    has_security_files: hasSecurityFiles(filePaths),
  };

  // -- Build history signals --
  try {
    const db = getDriftDb(projectDir);
    const flowRuns = db.getAllFlowRuns();
    const recent = flowRuns.slice(-RECENT_RUNS_LOOKBACK);
    signals.build_history.recent_runs = recent.length;

    if (recent.length > 0) {
      // avg_retry_count: average of total state_iterations across recent runs
      const totalIter = recent.reduce((sum, run) => {
        const iters = Object.values(run.state_iterations as Record<string, number>);
        return sum + iters.reduce((s, v) => s + v, 0);
      }, 0);
      signals.build_history.avg_retry_count = totalIter / recent.length;

      // clean_review_rate: fraction of recent runs with gate_pass_rate === 1.0
      const cleanCount = recent.filter(
        (run) => run.gate_pass_rate !== null && run.gate_pass_rate >= 1.0,
      ).length;
      signals.build_history.clean_review_rate = cleanCount / recent.length;

      // recent_failure_rate: fraction of runs with gate_pass_rate < 1.0 or null
      const failCount = recent.filter(
        (run) => run.gate_pass_rate === null || run.gate_pass_rate < 1.0,
      ).length;
      signals.build_history.recent_failure_rate = failCount / recent.length;
    } else {
      // No runs — keep worst-case defaults except recent_runs is already 0
      // clean_review_rate stays 0, recent_failure_rate stays 1
    }
  } catch (err) {
    console.warn(
      "[canon] confidence-scorer: build history signal gathering failed:",
      err instanceof Error ? err.message : err,
    );
    // keep worst-case defaults
  }

  // -- Blast radius signals --
  try {
    let totalAffected = 0;
    let maxDepth = 0;

    for (const fp of filePaths) {
      const result = graphQuery(
        { options: { max_depth: 5 }, query_type: "blast_radius", target: fp },
        projectDir,
      );
      if (result.ok) {
        totalAffected += result.count;
        // Infer depth from results (entries may have a depth field)
        for (const entry of result.results as Array<Record<string, unknown>>) {
          const depth = typeof entry.depth === "number" ? entry.depth : 0;
          if (depth > maxDepth) maxDepth = depth;
        }
      }
      // KG_NOT_INDEXED is non-fatal — leave blast radius at 0
    }

    signals.blast_radius.total_affected_files = totalAffected;
    signals.blast_radius.max_depth = maxDepth;
  } catch (err) {
    console.warn(
      "[canon] confidence-scorer: blast radius signal gathering failed:",
      err instanceof Error ? err.message : err,
    );
    // keep default 0 values — lack of KG data is non-blocking
  }

  // -- Compliance signals --
  try {
    const db = getDriftDb(projectDir);
    const signalsDao = db.getSignals();

    const violationHistory = signalsDao.getFileViolationHistory(filePaths);
    signals.compliance.total_active_violations = violationHistory.length;

    const pathEffects = signalsDao.getPathEffects(filePaths);
    let maxStreak = 0;
    let hasClean = false;
    for (const effect of pathEffects) {
      if (effect.violation_streak > maxStreak) maxStreak = effect.violation_streak;
      if (effect.clean_streak >= 3) hasClean = true;
    }
    signals.compliance.max_violation_streak = maxStreak;
    signals.compliance.has_clean_streak = hasClean;
  } catch (err) {
    console.warn(
      "[canon] confidence-scorer: compliance signal gathering failed:",
      err instanceof Error ? err.message : err,
    );
    // keep worst-case defaults (total_active_violations=0, max_violation_streak=0)
  }

  return signals;
}
