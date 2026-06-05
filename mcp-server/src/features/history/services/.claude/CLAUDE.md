# history/services/ — Cross-Run Analysis Services

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
Pure computation services backing `get_cross_run_analysis`. All functions are pure (no I/O) — callers pre-load data and pass it in.

## Architecture
<!-- last-updated: 2026-06-04 -->

| File | Responsibility |
|------|---------------|
| `cross-run-analyzer.ts` | Orchestrates cross-run analysis — `analyzeCrossRunPatterns`, `summaryToOutcomeSignals`; composes results from the two helper modules and `judge-weight.ts` |
| `cross-run-craft-drift.ts` | Craft-drift computation — `computeCraftDrift`; ordinal trend classification across `CraftDimension`s and subsystem areas; sparse areas (< 4 profiles) yield `"stable"` |
| `cross-run-patterns.ts` | Pattern-extraction helpers — `computePerformanceTrends`, `analyzePlannerPatterns`; pure functions over `FlowRunEntry` and `RunSummary` inputs |
| `judge-weight.ts` | `computeOutcomeWeight(OutcomeSignals): number` — maps review outcome signals to a promotion weight clamped to `[0.4, 1.2]` (neutral = 1.0) |
| `consolidate-policy.ts` | `decideWatchDisposition(watch, confidence): WatchDisposition` — rule engine for `.canon/proposed-learnings/` promotion/decay; `isWatchProposal(x)` named type guard |
| `archive-service.ts` | Build-archive read/write utilities |
| `run-summary-builder.ts` | Assembles `RunSummary` from archived artifacts |
| `run-summary-extractors.ts` | Pure extractors for summary sub-fields |

## Invariants
<!-- last-updated: 2026-06-04 -->
- All cross-run-* functions are pure — no filesystem or DB I/O
- `summaryToOutcomeSignals` picks the verdict from the review holding the matching principle (not the first review in the run)
- `fix_iterations` is derived from `FlowRunEntry.state_iterations`, not from a field that no longer exists
- bounded-context-boundaries: cross-run-* files import only from `@shared/*`, `@platform/*` types, and `../history-types.ts` — no cross-feature imports
