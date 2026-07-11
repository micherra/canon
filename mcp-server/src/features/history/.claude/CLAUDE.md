# history/ — Cross-Run Analysis Tools

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
Cross-run analysis tools for the Canon learner: archived build history, historical artifact retrieval, and cross-run pattern analysis including craft drift.

## Architecture
<!-- last-updated: 2026-06-05 -->

**`tools/`** — MCP tool handlers.

| Tool file | MCP tool name |
|-----------|--------------|
| `get-build-history.ts` | `get_build_history` |
| `get-historical-artifacts.ts` | `get_historical_artifacts` |
| `get-cross-run-analysis.ts` | `get_cross_run_analysis` |

**`history-types.ts`** — shared types for cross-run analysis (imported by `tools/` and `services/`).

**`services/`** — See `services/.claude/CLAUDE.md` for `cross-run-analyzer.ts`, `cross-run-craft-drift.ts`, `cross-run-patterns.ts`, `judge-weight.ts`, `consolidate-policy.ts`. Note: `archive-service.ts`, `run-summary-builder.ts`, and `run-summary-extractors.ts` relocated to `platform/storage/archive/` (ADR-0003).

## Contracts
<!-- last-updated: 2026-07-11 -->

**`CacheEfficiencyByAgent[]`** (`history-types.ts`, added 2026-07-11) — `CrossRunAnalysisResult.cache_efficiency`, a per-agent-type cache-efficiency rollup (`agent_type`, `mean_cache_hit_ratio?`, `total_cache_read_tokens`, `total_cache_creation_tokens`, `sample_count`) computed by pure `computeCacheEfficiencyByAgent` (`services/cross-run-patterns.ts`) over already-archived `step_outcomes[].metrics` — no new capture, no I/O. Additive (no existing field changed). `mean_cache_hit_ratio` is omitted entirely — never `0`/`NaN` — when no step for that `agent_type` carried a ratio, matching the `weighted_instance_count`/`avg_tool_calls` omit convention below. An `agent_type` with zero sampled steps contributes no row (not a zero-valued row); results sorted by `agent_type`.

**`RecurringViolation.weighted_instance_count`** (`history-types.ts`) — additive optional field `weighted_instance_count?: number`; sum of `computeOutcomeWeight()` across all observed instances; absent when no outcome signals available for matching runs. Added 2026-06-04.

**`AgentPerformanceTrend.avg_tool_calls` / `avg_turns` / `avg_orientation_calls`** (`history-types.ts`, added 2026-07-10) — additive optional fields; averages of recorded `record_agent_metrics` counters (summed per-summary across `step_outcomes[].metrics`, via `services/cross-run-patterns.ts`'s `sumRecordedCounter`), averaged in `computeFlowTrend` only over the data points that carried a given counter (`averageRecordedCounter`). Each field is omitted entirely — never `0` or `NaN` — when no point in the flow's window carried that recorded metric; `FlowRunEntry`-fallback data points (no `RunSummary`) never carry these fields.

**`get_cross_run_analysis`** — result includes `craft_drift: CraftDrift` (`by_dimension[]`, `by_area[]`, `profile_count`) computed by `computeCraftDrift` in `services/cross-run-craft-drift.ts`; higher band ordinal = better; sparse areas (< 4 profiles) yield `"stable"` direction; n-a bands excluded from ordinal math. Also includes `cliff_events: CliffEventsDimension` (status, total_cliffs, workspaces_affected, by_agent_type, by_step_id, by_source, recovery_outcomes, confidence); `status === "no_data"` when 0 rows; `tier === "insufficient"` when < 5 rows; tool runs a fail-open `sweepCliffEvents(project_dir)` before analysis. Also includes `cache_efficiency: CacheEfficiencyByAgent[]` — see Contracts above.

## Invariants
<!-- last-updated: 2026-07-11 -->
- Must not import directly from other features — use `@domains/*` types as shared contracts
- `RecurringViolation.weighted_instance_count` is additive (absent = no signals, not zero); callers must treat absent as unweighted
- `AgentPerformanceTrend.avg_tool_calls`/`avg_turns`/`avg_orientation_calls` are additive (absent = no recorded metrics in window, not zero); callers must treat absent as no-signal, matching the `weighted_instance_count` convention above
- `CacheEfficiencyByAgent.mean_cache_hit_ratio` is additive (absent = no step in that agent_type's window carried a ratio, not zero); same omit convention as the two invariants above
