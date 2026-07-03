# platform/storage/drift/ — Drift DB Layer

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
SQLite-backed drift storage: violation history, path effects, error fixes, area observations, craft profiles, and confidence-decay adapters. All DAO classes are synchronous (better-sqlite3). This layer is imported by `features/diagnostics/` and `features/orchestration/` but must not import from features.

## Architecture
<!-- last-updated: 2026-07-03 -->

**Schema / migration:**

| File | Responsibility |
|------|---------------|
| `drift-schema.ts` | `DRIFT_SCHEMA_VERSION = "13"`, idempotent `runMigrations(db)`; tables: `file_violation_history`, `path_effects` (v4), `error_fixes` (v6), `violation_outcomes` (v7), `area_observations` (v8), `craft_profiles` (v9 — `flow`/`run_id` nullable review-only; `source`, `subsystem_key`, `ratings` JSON, `rollup` REAL), `cliff_events` (v10 — UNIQUE(workspace_slug, step_id); 11 columns; index on `detected_at`), violation lifecycle columns: `status`, `resolved_at`, `resolved_by_review_id`, `resolution_reason` + `idx_violations_open` partial index (v11), `applied_evolutions` (v12 — apply-provenance for evolution-candidates; UNIQUE(proposal_id); 12 columns; indexes on `applied_at` + `principle_id`; ADR-0034), `active_workspaces` (v13 — project-level active-build discovery registry; PK `workspace_path`; `status` ('live'\|'finalized_on_disk'\|'reaped') enforced at the DAO write layer, not a DB CHECK; index on `status`) |
| `drift-db.ts` | `DriftDb` class — lazy-accessor facade; `getSignals()`, `getOutcomes()`, `getAreaMemory()`, `getCraftProfiles()`, `getCliffEvents()`, `getClosures()`, `getActiveWorkspaces()`, `getAppliedEvolutions()` accessors |
| `drift-db-cache.ts` | `getDriftDb(projectDir)` factory + `evictDriftDbForScope(projectDir)` lifecycle hook; import `getDriftDb` here directly (no barrel) |
| `drift-db-rows.ts` | Private row types + deserializers; not exported from barrel |

**DAO classes:**

| File | DAO | Table | Key notes |
|------|-----|-------|-----------|
| `drift-db-signals.ts` | `DriftDbSignals` | `file_violation_history`, `path_effects`, `error_fixes` | `DriftDb.getSignals()` lazy accessor |
| `outcome-store.ts` | `OutcomeStore` | `violation_outcomes` | `DriftDb.getOutcomes()` lazy accessor; added 2026-05-25 |
| `area-memory-dao.ts` | `AreaMemoryDao` | `area_observations` | `DriftDb.getAreaMemory()`; 7-day expiry; uses `deriveSubsystemKey` from `src/shared/lib/subsystem-key.ts` to produce stable keys like `features/orchestration` |
| `craft-profile-dao.ts` | `CraftProfileDao` | `craft_profiles` | `DriftDb.getCraftProfiles()`; `source` discriminates `"review"` vs `"audit"` profiles |
| `cliff-events-dao.ts` | `CliffEventsDao` | `cliff_events` | `DriftDb.getCliffEvents()` lazy accessor; upsert semantics (UNIQUE workspace_slug+step_id); exports `CLIFF_RECOVERY_OUTCOMES`, `CliffRecoveryOutcome`, `CliffEventRow`, `UpsertCliffEventInput` |
| `active-workspaces-dao.ts` | `ActiveWorkspacesDao` | `active_workspaces` | `DriftDb.getActiveWorkspaces()` lazy accessor; `register()` UPSERT (re-register on resume-after-reap), `markFinalized()`/`markReaped()` status transitions (no-op on absent row), `getByPath()` (null on absent), `list()` (DESC order, optional status filter); backs `post_message`/`tail_messages`/`list_active_workspaces` registry gate; lifecycle wiring is fail-open at all three call sites (init/finalize/janitor) |
| `applied-evolutions-dao.ts` | `AppliedEvolutionsDao` | `applied_evolutions` | `DriftDb.getAppliedEvolutions()` lazy accessor; idempotent upsert (UNIQUE proposal_id, COALESCE preserves back-filled `applying_commit`/`apply_base_commit`); methods `record`, `getByProposalId`, `listAppliedSince`; exports `AppliedEvolutionRow`, `RecordAppliedEvolutionInput` (apply-provenance, ADR-0034) |
| `violation-closure-dao.ts` | `ViolationClosureDao` | `violations` | `DriftDb.getClosures()` lazy accessor; `supersedeOpenViolations({ files, honored, recordedViolations, reviewId, timestamp })` sets `status='resolved'` for open violations where file ∈ review.files AND principle ∈ honored AND no new violation recorded in this review |
| `store.ts` | `DriftStore` | `reviews.jsonl` | `ReviewEntry` unified type; `PrStore` deleted 2026-03-25; `getReviews(options?)` AND-filters by principleId/branch/prNumber |

**Cross-feature persistence helpers:**

| File | Key export | Notes |
|------|-----------|-------|
| `craft-persistence.ts` | `validateAndPersistCraftProfile(craft_profile, files, projectDir)` | Extracted from `features/pr-review` (ADR-0003); validates via `CraftProfileSchema`, persists one row per distinct subsystem area to `craft_profiles` via `getDriftDb`; pure platform layer — no `@features` imports |

**Backfill seeds:**

| File | Key export | Notes |
|------|-----------|-------|
| `reconcile-violations.ts` | `AUDITED_STALE_2026_06`, `AUDITED_STALE_2026_06_13`, `reconcileStaleViolations` | Two human-audited stale-violation seed sets (epoch 1: 2026-06; epoch 2: 2026-06-13, 20 pairs); `reconcileStaleViolations(db, seed)` closes open rows for each pair — idempotent, run once per epoch; no lifecycle wiring (decision closure-04 Option A) |

**Confidence / analytics:**

| File | Key export | Notes |
|------|-----------|-------|
| `drift-confidence-adapter.ts` | `computeConfidenceAnnotation` | Composes sample_size (0.5) + trend_stability (0.3) + rate_stability (0.2); in platform/ to avoid circular imports |
| `doc-freshness-adapter.ts` | `computeFreshnessConfidence(signals)` | Maps `commits_since_sync` to staleness; `FRESHNESS_SAMPLE_SIZE = 10`; added 2026-05-29 |
| `watch-staleness-adapter.ts` | `computeWatchConfidence(WatchStalenessSignals)` | 0 days → 1.0, 30+ days → 0.0 (`STALENESS_SATURATION_DAYS=30`); non-finite/negative → fully stale; 3rd decay-engine adapter; added 2026-06-04 |
| `analyzer.ts` | `analyzeDrift`, `DocFreshness` | `DocFreshness: { doc_path, commits_since_sync, confidence, warning? }`; `DriftReport.doc_freshness: DocFreshness[]` defaults to `[]` |

## Contracts
<!-- last-updated: 2026-07-03 -->

- `getDriftDb(projectDir)` — module-level cache keyed by resolved `projectDir`; returns existing `DriftDb` or creates + migrates; `evictDriftDbForScope(projectDir)` removes entry (lifecycle hook, currently unwired at HTTP transport layer)
- `DriftDb` — lazy accessors: `.getSignals()` returns `DriftDbSignals`, `.getOutcomes()` returns `OutcomeStore`, `.getAreaMemory()` returns `AreaMemoryDao`, `.getCraftProfiles()` returns `CraftProfileDao`, `.getCliffEvents()` returns `CliffEventsDao`, `.getClosures()` returns `ViolationClosureDao`, `.getActiveWorkspaces()` returns `ActiveWorkspacesDao`
- `DriftDb.getReviews(options?)` / `DriftStore.getReviews(options?)` — two-views invariant: default (`includeResolvedViolations` absent) reconstitutes **open-only** violations — the view used by `get_compliance`, `getComplianceTrend`, re-review paths, and every other caller (preserves the closure-02 / Codex P2 compliance fix); `includeResolvedViolations: true` reconstitutes **open + resolved** violations — used ONLY by `get-drift-report.ts` so `most_violated` / historical drift analytics reflect the true historical record. These two views must not be unified — unifying would re-depress compliance.
- `cliff_events` schema (v10): UNIQUE(workspace_slug, step_id); upsert with COALESCE for nullable enrichment columns; `recovery_outcome` CASE-guarded against downgrade; 11 columns including `agent_type`, `missing_count`, `partial_count`, `source`, `detected_at`, `recorded_at`
- violations lifecycle schema (v11): `status TEXT NOT NULL DEFAULT 'open'`, `resolved_at TEXT`, `resolved_by_review_id TEXT`, `resolution_reason TEXT`; partial index `idx_violations_open` on `status='open'`; `DriftDb.appendReview()` calls `ViolationClosureDao.supersedeOpenViolations()` inside the review transaction
- `craft_profiles` schema (v9): columns `subsystem_key`, `source` ("review"|"audit"), `flow` (nullable, review-only), `run_id` (nullable, review-only), `ratings` (JSON), `rollup` (REAL)
- `area_observations` schema (v8): keyed by `subsystem_key`; 7-day TTL enforced by `AreaMemoryDao`
- `ReviewEntry` (unified type) lives in `@shared/schema.ts` — import from there, not from this layer

## Invariants
<!-- last-updated: 2026-07-01 -->
- Import `getDriftDb` from `drift-db-cache.ts` directly — no barrel; `drift-db-rows.ts` is private (row types only)
- All DAOs are synchronous; never return Promises (better-sqlite3 is sync)
- `DriftStore.getReviews()` AND-filters: principleId AND branch AND prNumber — each filter is optional; `includeResolvedViolations` is a separate switch (default `false`, open-only) controlling violation reconstitution, not part of the AND-filter chain — see Contracts two-views invariant
- Confidence adapters live in `platform/` to avoid circular imports with features that use both drift DB and confidence scoring
