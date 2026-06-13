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
<!-- last-updated: 2026-06-08 -->

**`RecurringViolation.weighted_instance_count`** (`history-types.ts`) — additive optional field `weighted_instance_count?: number`; sum of `computeOutcomeWeight()` across all observed instances; absent when no outcome signals available for matching runs. Added 2026-06-04.

**`get_cross_run_analysis`** — result includes `craft_drift: CraftDrift` (`by_dimension[]`, `by_area[]`, `profile_count`) computed by `computeCraftDrift` in `services/cross-run-craft-drift.ts`; higher band ordinal = better; sparse areas (< 4 profiles) yield `"stable"` direction; n-a bands excluded from ordinal math. Also includes `cliff_events: CliffEventsDimension` (status, total_cliffs, workspaces_affected, by_agent_type, by_step_id, by_source, recovery_outcomes, confidence); `status === "no_data"` when 0 rows; `tier === "insufficient"` when < 5 rows; tool runs a fail-open `sweepCliffEvents(project_dir)` before analysis.

## Invariants
<!-- last-updated: 2026-06-05 -->
- Must not import directly from other features — use `@domains/*` types as shared contracts
- `RecurringViolation.weighted_instance_count` is additive (absent = no signals, not zero); callers must treat absent as unweighted
