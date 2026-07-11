# history/services/ — Cross-Run Analysis Services

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
Pure computation services backing `get_cross_run_analysis`. All functions are pure (no I/O) — callers pre-load data and pass it in.

## Architecture
<!-- last-updated: 2026-07-11 -->

| File | Responsibility |
|------|---------------|
| `cross-run-analyzer.ts` | Orchestrates cross-run analysis — `analyzeCrossRunPatterns`, `summaryToOutcomeSignals`; composes results from the two helper modules and `judge-weight.ts` |
| `cross-run-craft-drift.ts` | Craft-drift computation — `computeCraftDrift`; ordinal trend classification across `CraftDimension`s and subsystem areas; sparse areas (< 4 profiles) yield `"stable"` |
| `cross-run-cliff-events.ts` | Pure cliff-events dimension — `computeCliffEventsDimension(rows): CliffEventsDimension`; sparse-data contract: 0→no_data, <5→insufficient; re-exports `CLIFF_RECOVERY_OUTCOMES` |
| `cliff-event-sweep.ts` | Backfill sweep — `sweepCliffEvents(projectDir)`: walks `.canon/workspaces/`, opens each workspace orchestration.db read-only, upserts rows to drift.db; fail-open on every path; returns `{ events_ingested, outcomes_updated, scanned_workspaces, skipped[] }` |
| `cross-run-patterns.ts` | Pattern-extraction helpers — `computePerformanceTrends`, `analyzePlannerPatterns`, `computeCacheEfficiencyByAgent` (added 2026-07-11: per-agent-type cache-efficiency rollup over `step_outcomes[].metrics`); pure functions over `FlowRunEntry` and `RunSummary` inputs |
| `judge-weight.ts` | `computeOutcomeWeight(OutcomeSignals): number` — maps review outcome signals to a promotion weight clamped to `[0.4, 1.2]` (neutral = 1.0) |
| `consolidate-policy.ts` | `decideWatchDisposition(watch, confidence): WatchDisposition` — rule engine for `.canon/proposed-learnings/` promotion/decay; `isWatchProposal(x)` named type guard |

## Invariants
<!-- last-updated: 2026-06-08 -->
- `cross-run-*.ts` functions are pure — no filesystem or DB I/O; `cliff-event-sweep.ts` is the sole I/O service (reads foreign workspace DBs read-only, writes to drift.db)
- `summaryToOutcomeSignals` picks the verdict from the review holding the matching principle (not the first review in the run)
- `fix_iterations` is derived from `FlowRunEntry.state_iterations`, not from a field that no longer exists
- bounded-context-boundaries: `cross-run-*.ts` files import only from `@shared/*`, `@platform/*` types, and `../history-types.ts`; `cliff-event-sweep.ts` imports only from `node:*`, `better-sqlite3`, `@platform/storage/drift/*` — no cross-feature imports
