/**
 * History feature type definitions — bounded context for cross-run analysis.
 *
 * ArchiveManifestEntry and ArchiveManifestFilter live in the shared kernel
 * (drift-analytics-types.ts) so DriftDb can use them without importing from
 * this bounded context. History-specific types (cross-run analysis)
 * live here and must not be imported by the shared kernel.
 *
 * Run-summary types (RunSummary, RunbookStep, PlannerContext, StepOutcome,
 * ReviewResult, ReviewViolation, ArtifactInventory) have moved to
 * @platform/storage/archive/archive-types.ts — re-exported below so
 * existing consumers import from this module unchanged.
 *
 * bounded-context-boundaries: imports from shared kernel (re-exports for
 * consumers that only need to import from this module), history-only types stay here.
 */

import type { ConfidenceAnnotation } from "../../shared/lib/confidence.ts";
import type { CraftDimension } from "../../shared/lib/craft-rubric.ts";

// Re-export run-summary types that moved to platform/storage/archive
export type {
  ArtifactInventory,
  PlannerContext,
  ReviewResult,
  ReviewViolation,
  RunbookStep,
  RunSummary,
  StepOutcome,
} from "../../platform/storage/archive/archive-types.ts";
// Re-export shared types so consumers can import from one place
export type {
  ArchiveManifestEntry,
  ArchiveManifestFilter,
} from "../../platform/storage/drift/drift-analytics-types.ts";
export type { ConfidenceAnnotation, CraftDimension };

// --- Result shapes for tools ---

/** Result shape for get_build_history tool. */
export type BuildHistoryResult = {
  archives: import("../../platform/storage/drift/drift-analytics-types.ts").ArchiveManifestEntry[];
  total_count: number;
};

/** Artifact content returned by get_historical_artifacts. */
export type HistoricalArtifact = {
  path: string;
  content: string;
  size_bytes: number;
};

/** Result shape for get_historical_artifacts tool. */
export type HistoricalArtifactsResult = {
  archive_id: string;
  archive_path: string;
  artifacts: HistoricalArtifact[];
};

// --- Cross-run analysis types ---

/** A violation that recurs across multiple runs. */
export type RecurringViolation = {
  principle_id: string;
  severity: string;
  occurrence_count: number;
  affected_files: string[];
  first_seen: string;
  last_seen: string;
  /**
   * Sum of computeOutcomeWeight() across all observed instances.
   * Reflects build quality: CLEAN builds contribute > 1.0, BLOCKING < 1.0.
   * Optional — absent when no outcome signals are available for matching runs.
   */
  weighted_instance_count?: number;
};

/** Pattern of how long it takes to fix a recurring violation. */
export type FixCyclePattern = {
  principle_id: string;
  avg_fix_duration_ms: number;
  fix_count: number;
  recurrence_rate: number;
};

/** Trend data for agent/flow performance over time. */
export type AgentPerformanceTrend = {
  flow: string;
  avg_duration_ms: number;
  avg_spawns: number;
  run_count: number;
  trend: "improving" | "stable" | "degrading";
  /**
   * Averages of recorded per-step counters (record_agent_metrics), computed over
   * the points that carried them. Optional — omitted entirely (never NaN or a
   * misleading 0) when no point in the flow's window carried recorded metrics.
   */
  avg_tool_calls?: number;
  avg_turns?: number;
  avg_orientation_calls?: number;
};

/** Analysis of planner patterns across runs. */
export type PlannerPatternAnalysis = {
  total_runs_with_planner: number;
  common_assumptions: { assumption: string; occurrence_count: number }[];
  effort_accuracy: {
    estimate: string;
    actual_avg_duration_ms: number;
    sample_count: number;
  }[];
  value_distribution: { value: string; count: number }[];
};

// --- Craft drift types ---

/**
 * Per-dimension craft movement direction across recent profiles.
 * Higher band ordinal = better craft (strong=3, adequate=2, weak=1).
 * n-a bands are excluded from avg_band_ordinal calculation.
 */
export type CraftDimensionDrift = {
  dimension: CraftDimension;
  direction: "improving" | "stable" | "degrading";
  /** Mean of band ordinals across profiles (n-a excluded). */
  avg_band_ordinal: number;
  sample_count: number;
};

/**
 * Craft drift analysis across recent profiles.
 * by_dimension: global rollup across all areas.
 * by_area: per-subsystem breakdown, only for areas with ≥ MIN_CRAFT_PROFILES profiles.
 */
export type CraftDrift = {
  by_dimension: CraftDimensionDrift[];
  by_area?: Array<{ subsystem_key: string; by_dimension: CraftDimensionDrift[] }>;
  profile_count: number;
};

// --- Cliff events dimension types ---

import type { CliffRecoveryOutcome } from "../../platform/storage/drift/cliff-events-dao.ts";

/** Re-export so history consumers import outcome vocabulary from one place. */
export type { CliffRecoveryOutcome };

/** Aggregated count keyed by a grouping value. */
export type CliffCountBucket = { key: string; count: number };

/**
 * Cross-run cliff/write-cliff dimension (watch_BBBBB1 consumer).
 * status "no_data" when zero events exist — never an error.
 * Confidence reuses the shared engine: sample_size < 5 => tier "insufficient"
 * (the sparse-data floor; consumers must not derive rates from insufficient-tier data).
 */
export type CliffEventsDimension = {
  status: "no_data" | "observed";
  total_cliffs: number; // distinct (workspace, step) cliffed pairs
  workspaces_affected: number; // distinct workspace_slugs
  by_agent_type: CliffCountBucket[]; // null agent_type bucketed as "unknown"
  by_step_id: CliffCountBucket[];
  by_source: CliffCountBucket[];
  recovery_outcomes: Record<CliffRecoveryOutcome, number>; // all four keys always present
  confidence: ConfidenceAnnotation;
};

/** Per-agent-type cache-efficiency rollup over archived step_outcomes.metrics. */
export type CacheEfficiencyByAgent = {
  agent_type: string;
  /**
   * Mean of per-step cache_hit_ratio over steps that carried one.
   * Omitted entirely (never NaN/0) when no step for this agent_type carried a ratio —
   * matches aggregateCacheUsage + averageRecordedCounter's omit convention.
   */
  mean_cache_hit_ratio?: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  /** Steps that contributed at least one cache number (transparency for sparse data). */
  sample_count: number;
};

/** Full cross-run analysis result. */
export type CrossRunAnalysisResult = {
  recurring_violations: RecurringViolation[];
  fix_cycle_patterns: FixCyclePattern[];
  agent_performance_trends: AgentPerformanceTrend[];
  planner_patterns: PlannerPatternAnalysis;
  craft_drift: CraftDrift;
  cliff_events: CliffEventsDimension;
  /** Per-agent-type cache-efficiency rollup — additive (see CacheEfficiencyByAgent). */
  cache_efficiency: CacheEfficiencyByAgent[];
  total_archived_runs: number;
  analysis_window: { from: string; to: string };
};
