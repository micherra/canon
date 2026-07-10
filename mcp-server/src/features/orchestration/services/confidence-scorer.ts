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
 *  - Sensitive-path deny-list floor (ADR-0044): SENSITIVE_PATH_DENY_LIST + matchSensitivePath
 *    is the sole authoritative path floor; checked FIRST in computeConfidence, ahead of the
 *    override_tier short-circuit — the floor beats override, a safety invariant over
 *    user preference. Folds in and replaces the old SECURITY_PATTERNS/hasSecurityFiles.
 *  - Scoring algorithm produces 0-100 score; tier = score >= 80 → autonomous,
 *    score >= 40 → light-touch, else → supervised
 */

import { graphQuery } from "@features/knowledge-graph/tools/graph-query.ts";
import { matchGlob } from "@shared/lib/glob-matcher.ts";

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
  deny_list_match: DenyListMatch | null;
  override_tier?: AutonomyTier; // user-forced tier
};

/**
 * Minimal adapter interface for drift.db access within confidence scoring.
 * Defined here so confidence-scorer.ts has no direct platform dependency.
 * Tool wrappers (in tools/) import getDriftDb and create a concrete instance.
 */
export type DriftDbAdapter = {
  getAllFlowRuns(): Array<{
    state_iterations: unknown;
    gate_pass_rate?: number | null;
  }>;
  getSignals(): {
    getFileViolationHistory(filePaths: string[]): unknown[];
    getPathEffects(filePaths: string[]): Array<{
      violation_streak: number;
      clean_streak: number;
    }>;
  };
};

export type ConfidenceResult = {
  tier: AutonomyTier;
  score: number; // 0-100, or -1 for override, or 0 for deny-list floor
  reasoning: string;
  signals_used: string[];
  floor?: DenyListMatch;
};

// ---- Sensitive-path deny-list (ADR-0044) ----

export type DenyCategory =
  | "canon-safety-hooks"
  | "ci-config"
  | "secrets-credentials"
  | "auth"
  | "drift-store-schema"
  | "mcp-tool-contract"
  | "principles-rules-config"
  | "settings-permissions";

export type DenyListEntry = { category: DenyCategory; pattern: string };
export type DenyListMatch = { category: DenyCategory; pattern: string; matched_path: string };

// Authoritative sensitive-path deny-list. Repo-root-relative POSIX patterns, Canon glob dialect.
// Category names are prose↔code-parity-checked against root CLAUDE.md (deny-list-parity.test.ts).
// Folds in and replaces the old SECURITY_PATTERNS regex list under "principles-rules-config".
export const SENSITIVE_PATH_DENY_LIST: readonly DenyListEntry[] = [
  { category: "canon-safety-hooks", pattern: "hooks/**" },
  { category: "ci-config", pattern: ".github/workflows/**" },
  { category: "secrets-credentials", pattern: ".env" },
  { category: "secrets-credentials", pattern: "**/.env" },
  { category: "secrets-credentials", pattern: "**/*.env" },
  // Dotenv-variant coverage (.env.local, .env.production, etc. — the dominant
  // dotenv convention, not covered by the exact ".env" literal above). Root
  // literal + "**/" nested pair mirrors the convention used by every other
  // entry in this list; matchGlob("**/.env*", ...) requires a "/" to precede
  // the match, so a root-level file like ".env.local" needs the unprefixed
  // literal too.
  { category: "secrets-credentials", pattern: ".env*" },
  { category: "secrets-credentials", pattern: "**/.env*" },
  { category: "auth", pattern: "mcp-server/src/app/mcp-http/**" },
  { category: "auth", pattern: "mcp-server/src/app/daemon.ts" },
  {
    category: "drift-store-schema",
    pattern: "mcp-server/src/domains/workspaces/execution-schema.ts",
  },
  { category: "drift-store-schema", pattern: "mcp-server/src/platform/storage/**" },
  { category: "drift-store-schema", pattern: "mcp-server/src/graph/kg-schema.ts" },
  { category: "mcp-tool-contract", pattern: "mcp-server/src/app/register-*.ts" },
  { category: "mcp-tool-contract", pattern: "mcp-server/src/shared/lib/tool-result.ts" },
  { category: "principles-rules-config", pattern: "principles/**" },
  { category: "principles-rules-config", pattern: "rules/**" },
  { category: "principles-rules-config", pattern: ".canon/config.json" },
  { category: "settings-permissions", pattern: ".claude/settings*.json" },
  { category: "settings-permissions", pattern: "**/.claude/settings*.json" },
];

/**
 * First deny-list match across files x entries, else null.
 * Deterministic, linear-time (matchGlob is O(m·n) DP, no RegExp on the match path).
 */
export function matchSensitivePath(filePaths: string[]): DenyListMatch | null {
  for (const fp of filePaths) {
    for (const entry of SENSITIVE_PATH_DENY_LIST) {
      if (matchGlob(entry.pattern, fp)) {
        return { category: entry.category, matched_path: fp, pattern: entry.pattern };
      }
    }
  }
  return null;
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
    parts.push(
      `low-medium blast radius (${signals.blast_radius.total_affected_files} affected files)`,
    );
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

/** Deduct build history penalties from score; push used signal names to the list. */
function applyBuildHistoryPenalties(
  signals: ConfidenceSignals["build_history"],
  score: number,
  used: string[],
): number {
  let s = score;
  if (signals.recent_runs < 5) {
    s -= 30;
    used.push("build_history.recent_runs");
  }
  const cleanPenalty = (1 - signals.clean_review_rate) * 30;
  if (cleanPenalty > 0) {
    s -= cleanPenalty;
    used.push("build_history.clean_review_rate");
  }
  const retryPenalty = Math.min(signals.avg_retry_count * 5, 20);
  if (retryPenalty > 0) {
    s -= retryPenalty;
    used.push("build_history.avg_retry_count");
  }
  const failurePenalty = signals.recent_failure_rate * 10;
  if (failurePenalty > 0) {
    s -= failurePenalty;
    used.push("build_history.recent_failure_rate");
  }
  return s;
}

/** Deduct blast radius and compliance penalties; push used signal names to the list. */
function applyBlastAndCompliancePenalties(
  signals: ConfidenceSignals,
  score: number,
  used: string[],
): number {
  let s = score;
  if (signals.blast_radius.total_affected_files > 50) {
    s -= 30;
    used.push("blast_radius.total_affected_files");
  } else if (signals.blast_radius.total_affected_files > 20) {
    s -= 20;
    used.push("blast_radius.total_affected_files");
  } else if (signals.blast_radius.total_affected_files > 10) {
    s -= 10;
    used.push("blast_radius.total_affected_files");
  }
  if (signals.blast_radius.max_depth > 3) {
    s -= 10;
    used.push("blast_radius.max_depth");
  }
  const violationPenalty = Math.min(signals.compliance.total_active_violations * 5, 15);
  if (violationPenalty > 0) {
    s -= violationPenalty;
    used.push("compliance.total_active_violations");
  }
  const streakPenalty = signals.compliance.max_violation_streak * 3;
  if (streakPenalty > 0) {
    s -= streakPenalty;
    used.push("compliance.max_violation_streak");
  }
  if (signals.file_paths.length > 20) {
    s -= 10;
    used.push("file_paths.length");
  } else if (signals.file_paths.length > 10) {
    s -= 5;
    used.push("file_paths.length");
  }
  return s;
}

// ---- Pure scoring function ----

/**
 * Compute autonomy tier from pre-gathered signals.
 * Pure function: no I/O, no side effects.
 * Returns tier, score (0-100), reasoning, and signals_used list.
 */
export function computeConfidence(signals: ConfidenceSignals): ConfidenceResult {
  // Floor-first (ADR-0044): the sensitive-path deny-list floor is checked BEFORE the
  // override_tier short-circuit — a safety invariant beats a user preference. The floor
  // only ever returns supervised; it never lowers a tier.
  const floor = signals.deny_list_match;
  if (floor) {
    return {
      floor,
      reasoning: `sensitive-path deny-list floor engaged — category "${floor.category}" matched pattern "${floor.pattern}" on "${floor.matched_path}"; supervised tier + mandatory canon:security review + adversarial re-review required (uncircumventable by override_tier)`,
      score: 0,
      signals_used: ["deny_list_floor"],
      tier: "supervised",
    };
  }

  // Short-circuit: user override takes precedence over all scoring (but not the floor above)
  if (signals.override_tier !== undefined) {
    return {
      reasoning: `user override to ${signals.override_tier}`,
      score: -1,
      signals_used: ["override_tier"],
      tier: signals.override_tier,
    };
  }

  const signals_used: string[] = [];
  let score = 100;
  score = applyBuildHistoryPenalties(signals.build_history, score, signals_used);
  score = applyBlastAndCompliancePenalties(signals, score, signals_used);
  score = Math.max(0, Math.min(100, score));
  const tier: AutonomyTier =
    score >= 80 ? "autonomous" : score >= 40 ? "light-touch" : "supervised";

  return {
    reasoning: buildReasoning(signals, score),
    score,
    signals_used: signals_used.length > 0 ? signals_used : ["baseline"],
    tier,
  };
}

// ---- I/O signal gathering ----

const RECENT_RUNS_LOOKBACK = 10;

/** Gather build_history signals from drift.db. Returns a new build_history sub-object. */
async function gatherBuildHistorySignals(
  driftDb: DriftDbAdapter,
): Promise<ConfidenceSignals["build_history"]> {
  // Worst-case defaults — high avg_retry_count maximises retry penalty
  const defaults: ConfidenceSignals["build_history"] = {
    avg_retry_count: 4,
    clean_review_rate: 0,
    recent_failure_rate: 1,
    recent_runs: 0,
  };
  try {
    const flowRuns = driftDb.getAllFlowRuns();
    const recent = flowRuns.slice(-RECENT_RUNS_LOOKBACK);

    if (recent.length === 0) return defaults; // keep worst-case defaults

    // Subtract 1 from each state_iterations value — the baseline attempt is not a retry.
    // Clamp to 0 so states that ran exactly once contribute 0 retries.
    const totalIter = recent.reduce((sum, run) => {
      const iters = Object.values(run.state_iterations as Record<string, number>);
      return sum + iters.reduce((s, v) => s + Math.max(v - 1, 0), 0);
    }, 0);

    const cleanCount = recent.filter(
      (run) => run.gate_pass_rate != null && run.gate_pass_rate >= 1.0,
    ).length;

    const failCount = recent.filter(
      (run) => run.gate_pass_rate == null || run.gate_pass_rate < 1.0,
    ).length;

    return {
      avg_retry_count: totalIter / recent.length,
      clean_review_rate: cleanCount / recent.length,
      recent_failure_rate: failCount / recent.length,
      recent_runs: recent.length,
    };
  } catch (err) {
    console.warn(
      "[canon] confidence-scorer: build history signal gathering failed:",
      err instanceof Error ? err.message : err,
    );
    return defaults;
  }
}

/** Extract the maximum depth value from a blast radius result array. */
function extractMaxDepth(results: Array<Record<string, unknown>>): number {
  let maxDepth = 0;
  for (const entry of results) {
    const depth = typeof entry.depth === "number" ? entry.depth : 0;
    if (depth > maxDepth) maxDepth = depth;
  }
  return maxDepth;
}

/** Gather blast_radius signals from the KG. Returns a new blast_radius sub-object. */
async function gatherBlastRadiusSignals(
  filePaths: string[],
  projectDir: string,
): Promise<ConfidenceSignals["blast_radius"]> {
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
        maxDepth = Math.max(
          maxDepth,
          extractMaxDepth(result.results as Array<Record<string, unknown>>),
        );
      }
      // KG_NOT_INDEXED is non-fatal — leave blast radius at 0
    }

    return { max_depth: maxDepth, total_affected_files: totalAffected };
  } catch (err) {
    console.warn(
      "[canon] confidence-scorer: blast radius signal gathering failed:",
      err instanceof Error ? err.message : err,
    );
    // keep default 0 values — lack of KG data is non-blocking
    return { max_depth: 0, total_affected_files: 0 };
  }
}

/** Gather compliance signals from drift.db signals DAO. Returns a new compliance sub-object. */
async function gatherComplianceSignals(
  driftDb: DriftDbAdapter,
  filePaths: string[],
): Promise<ConfidenceSignals["compliance"]> {
  try {
    const signalsDao = driftDb.getSignals();

    const violationHistory = signalsDao.getFileViolationHistory(filePaths);
    const totalActiveViolations = violationHistory.length;

    const pathEffects = signalsDao.getPathEffects(filePaths);
    let maxStreak = 0;
    let hasClean = false;
    for (const effect of pathEffects) {
      if (effect.violation_streak > maxStreak) maxStreak = effect.violation_streak;
      if (effect.clean_streak >= 3) hasClean = true;
    }

    return {
      has_clean_streak: hasClean,
      max_violation_streak: maxStreak,
      total_active_violations: totalActiveViolations,
    };
  } catch (err) {
    console.warn(
      "[canon] confidence-scorer: compliance signal gathering failed:",
      err instanceof Error ? err.message : err,
    );
    // worst-case defaults — high values maximise penalty so scoring remains conservative
    return { has_clean_streak: false, max_violation_streak: 10, total_active_violations: 10 };
  }
}

/**
 * Gather confidence signals from drift.db, KG blast radius, and file path patterns.
 * NOT pure — performs I/O.
 *
 * @param filePaths - Files changed in the build.
 * @param projectDir - Absolute path to the project root (used for KG blast radius queries).
 * @param driftDb - Optional DriftDbAdapter. When provided, build history and compliance
 *   signals are gathered from the drift DB. When undefined, those signals remain at
 *   worst-case defaults (conservative, never best-case).
 *
 * Each signal source is wrapped in try/catch: failure sets that signal to its
 * worst-case (most conservative) value rather than best-case.
 */
export async function gatherSignals(
  filePaths: string[],
  projectDir: string,
  driftDb?: DriftDbAdapter,
): Promise<ConfidenceSignals> {
  const buildHistory =
    driftDb !== undefined
      ? await gatherBuildHistorySignals(driftDb)
      : {
          avg_retry_count: 4, // worst-case default — maximises retry penalty
          clean_review_rate: 0, // worst-case default
          recent_failure_rate: 1, // worst-case default
          recent_runs: 0,
        };

  const compliance =
    driftDb !== undefined
      ? await gatherComplianceSignals(driftDb, filePaths)
      : { has_clean_streak: false, max_violation_streak: 10, total_active_violations: 10 };

  const blastRadius = await gatherBlastRadiusSignals(filePaths, projectDir);

  return {
    blast_radius: blastRadius,
    build_history: buildHistory,
    compliance,
    deny_list_match: matchSensitivePath(filePaths),
    file_paths: filePaths,
  };
}
