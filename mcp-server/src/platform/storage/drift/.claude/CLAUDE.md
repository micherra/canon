# platform/storage/drift/ — Drift DB Layer

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
SQLite-backed drift storage: violation history, path effects, error fixes, area observations, craft profiles, and confidence-decay adapters. All DAO classes are synchronous (better-sqlite3). This layer is imported by `features/diagnostics/` and `features/orchestration/` but must not import from features.

## Architecture
<!-- last-updated: 2026-06-05 -->

**Schema / migration:**

| File | Responsibility |
|------|---------------|
| `drift-schema.ts` | `DRIFT_SCHEMA_VERSION = "9"`, idempotent `runMigrations(db)`; tables: `file_violation_history`, `path_effects` (v4), `error_fixes` (v6), `violation_outcomes` (v7), `area_observations` (v8), `craft_profiles` (v9 — `flow`/`run_id` nullable review-only; `source`, `subsystem_key`, `ratings` JSON, `rollup` REAL) |
| `drift-db.ts` | `DriftDb` class — lazy-accessor facade; `getSignals()`, `getOutcomes()`, `getAreaMemory()`, `getCraftProfiles()` accessors |
| `drift-db-cache.ts` | `getDriftDb(projectDir)` factory + `evictDriftDbForScope(projectDir)` lifecycle hook; import `getDriftDb` here directly (no barrel) |
| `drift-db-rows.ts` | Private row types + deserializers; not exported from barrel |

**DAO classes:**

| File | DAO | Table | Key notes |
|------|-----|-------|-----------|
| `drift-db-signals.ts` | `DriftDbSignals` | `file_violation_history`, `path_effects`, `error_fixes` | `DriftDb.getSignals()` lazy accessor |
| `outcome-store.ts` | `OutcomeStore` | `violation_outcomes` | `DriftDb.getOutcomes()` lazy accessor; added 2026-05-25 |
| `area-memory-dao.ts` | `AreaMemoryDao` | `area_observations` | `DriftDb.getAreaMemory()`; 7-day expiry; uses `deriveSubsystemKey` from `src/shared/lib/subsystem-key.ts` to produce stable keys like `features/orchestration` |
| `craft-profile-dao.ts` | `CraftProfileDao` | `craft_profiles` | `DriftDb.getCraftProfiles()`; `source` discriminates `"review"` vs `"audit"` profiles |
| `store.ts` | `DriftStore` | `reviews.jsonl` | `ReviewEntry` unified type; `PrStore` deleted 2026-03-25; `getReviews(options?)` AND-filters by principleId/branch/prNumber |

**Confidence / analytics:**

| File | Key export | Notes |
|------|-----------|-------|
| `drift-confidence-adapter.ts` | `computeConfidenceAnnotation` | Composes sample_size (0.5) + trend_stability (0.3) + rate_stability (0.2); in platform/ to avoid circular imports |
| `doc-freshness-adapter.ts` | `computeFreshnessConfidence(signals)` | Maps `commits_since_sync` to staleness; `FRESHNESS_SAMPLE_SIZE = 10`; added 2026-05-29 |
| `watch-staleness-adapter.ts` | `computeWatchConfidence(WatchStalenessSignals)` | 0 days → 1.0, 30+ days → 0.0 (`STALENESS_SATURATION_DAYS=30`); non-finite/negative → fully stale; 3rd decay-engine adapter; added 2026-06-04 |
| `analyzer.ts` | `analyzeDrift`, `DocFreshness` | `DocFreshness: { doc_path, commits_since_sync, confidence, warning? }`; `DriftReport.doc_freshness: DocFreshness[]` defaults to `[]` |

## Contracts
<!-- last-updated: 2026-06-05 -->

- `getDriftDb(projectDir)` — module-level cache keyed by resolved `projectDir`; returns existing `DriftDb` or creates + migrates; `evictDriftDbForScope(projectDir)` removes entry (lifecycle hook, currently unwired at HTTP transport layer)
- `DriftDb` — lazy accessors: `.getSignals()` returns `DriftDbSignals`, `.getOutcomes()` returns `OutcomeStore`, `.getAreaMemory()` returns `AreaMemoryDao`, `.getCraftProfiles()` returns `CraftProfileDao`
- `craft_profiles` schema (v9): columns `subsystem_key`, `source` ("review"|"audit"), `flow` (nullable, review-only), `run_id` (nullable, review-only), `ratings` (JSON), `rollup` (REAL)
- `area_observations` schema (v8): keyed by `subsystem_key`; 7-day TTL enforced by `AreaMemoryDao`
- `ReviewEntry` (unified type) lives in `@shared/schema.ts` — import from there, not from this layer

## Invariants
<!-- last-updated: 2026-06-05 -->
- Import `getDriftDb` from `drift-db-cache.ts` directly — no barrel; `drift-db-rows.ts` is private (row types only)
- All DAOs are synchronous; never return Promises (better-sqlite3 is sync)
- `DriftStore.getReviews()` AND-filters: principleId AND branch AND prNumber — each filter is optional
- Confidence adapters live in `platform/` to avoid circular imports with features that use both drift DB and confidence scoring
