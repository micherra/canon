# Canon MCP Server — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
TypeScript MCP (Model Context Protocol) server that provides tools for managing, enforcing, and tracking engineering principles across a codebase.

## Architecture
<!-- last-updated: 2026-05-31 -->

ES module TypeScript project using `@modelcontextprotocol/sdk` and `zod` for schema validation.

```
src/
├── app/                  # Entry point — tool registration (index.ts, register-*.ts, server-state.ts, all handlers via gatedWrapHandler)
├── domains/              # Shared domain types and persistence
│   ├── board/            # Board mutation logic (pure functions)
│   ├── drift/            # Drift/review type definitions
│   ├── flows/            # Flow and board-state type definitions, schemas
│   ├── knowledge-graph/  # KG type definitions (FileMetrics, LayerViolation)
│   ├── messages/         # Flow lifecycle events, event bus, variable substitution (message persistence removed 2026-05-16)
│   └── workspaces/       # Workspace and execution store (SQLite persistence)
├── features/             # Tool implementations grouped by bounded context
│   ├── diagnostics/      # Drift reports, agent metrics, summary storage, wiki lint
│   ├── file-context/     # get_file_context tool
│   ├── history/          # get_build_history, get_historical_artifacts, get_cross_run_analysis tools
│   ├── knowledge-graph/  # graph_query, semantic_search, codebase_graph, git-intel
│   ├── orchestration/    # Orchestration runtime: init_workspace, finalize_workspace, log_step, record_agent_metrics, all orchestration tools
│   ├── pr-review/        # show_pr_impact, review_code, store_pr_review, present_review
│   ├── principles/       # get_principles, list_principles, get_compliance
│   └── prompt-pipeline/  # Prompt assembly, context enrichment, consultation pipeline
├── graph/                # Legacy graph scanner — import/export parsing (being migrated to features/knowledge-graph)
├── orchestration/        # Legacy orchestration — flow parser, execution store, schemas (being migrated to features/orchestration)
├── platform/             # Infrastructure: adapters (git, process), job manager, workers, storage
├── shared/               # Shared kernel: constants, parser, matcher, schema, lib/ utilities
├── tests/                # Cross-cutting test helpers
└── ui/                   # HTML artifact rendering — renderer agent utilities and design system snippets (Svelte app removed 2026-05-20)
    └── snippets/         # HTML/CSS component recipes for agent-composed artifacts; DESIGN-SYSTEM.md is authoritative reference; includes node-detail-panel.html (click-to-inspect panel, added 2026-05-20)
```

**Key subsystems:**
- **Drift tracking** (`platform/storage/drift/`) — JSONL-backed store for reviews with auto-rotation
- **Dependency graph** (`graph/`, `features/knowledge-graph/`) — SQLite KG via `KgQuery`/`KgStore`; scans imports/exports (JS/TS/Python), computes in/out degree, detects cycles and hubs; `graph/query.ts` and `graph/view-materializer.ts` deleted (ADR-005, 2026-04-01)
- **Community detection** (`graph/kg-community.ts`) — Louvain algorithm assigns `community_id` to each file in the KG; added 2026-05-02
- **Tag propagation** (`graph/kg-tags.ts`) — 4-signal pipeline (directory, imports, community, cross-ref) writes computed tags to `file_tags` table; used by `get-principles` and `get-file-context`; added 2026-05-02
- **Principle matching** (`shared/matcher.ts`) — Context-aware filtering by layers, file patterns, tags, severity; OR semantics: matches if layers OR scope.tags intersect (updated 2026-05-02)
- **Orchestration** (`orchestration/`, `features/orchestration/`) — Orchestration runtime: board persistence (seeded by `init_workspace`), journal (`log_step`/`batch_log_steps`), gate execution, consultation preparation, wave briefing assembly, competitive flows, debate protocol


## Contracts
<!-- last-updated: 2026-06-04 -->

**`boot.sh`** (`mcp-server/boot.sh`) — self-resolving launcher; prefers `${CLAUDE_PLUGIN_ROOT}/mcp-server`, falls back to `BASH_SOURCE` dir; never uses `npx`. Boot sequence: (1) resolve SERVER_DIR; (2) compute `DATA_DIR=${CLAUDE_PLUGIN_DATA}/node_modules`; (3) clear stale dangling symlink (`SERVER_DIR/node_modules` symlink not resolving to real dir) with `rm -f` before poll — skipped under `--print-resolution`, real-dir and absent cases untouched; (4) deps-ready poll — polls `DATA_DIR/.bin/tsx` up to `CANON_BOOT_DEPS_TIMEOUT` ticks (default 60, interval `CANON_BOOT_DEPS_INTERVAL` default 1s) when `CLAUDE_PLUGIN_DATA` set; timeout → loud `exit 1`; (5) ESM co-location symlink — `rm -f` + `ln -s DATA_DIR SERVER_DIR/node_modules` when DATA deps exist and `SERVER_DIR/node_modules` is not a real dir; idempotent; `ln` failure emits `CANON WARNING` and degrades; (6) dangling-symlink guard — if symlink still does not resolve, emits `CANON ERROR` and exits 1; skipped under `--print-resolution`; (7) resolve `NODE_PATH` and `tsx` binary; (8) `--print-resolution` prints `SERVER_DIR NODE_PATH TSX_BIN` and exits 0. `CLAUDE_PLUGIN_ROOT` not expanded when `.mcp.json` loads as project config; `BASH_SOURCE` is the backstop. **ESM/NODE_PATH pitfall**: `NODE_PATH` is CJS-only — ESM ignores it and uses the co-located symlink (step 5). A missing or dangling symlink produces `ERR_MODULE_NOT_FOUND` at the MCP `initialize` handshake (~4s after `boot.sh` exits cleanly). See `references/plugin-server-boot.md` for full guide.

**`http-server.ts` scope + PID file** (`src/app/http-server.ts`) — `startHttpServer(port?, projectDir?)` seeds a module-level `resolvedProjectDir` at startup (threaded from `index.ts`'s already-resolved scope). `resolvePidDir()` resolves: `CLAUDE_PLUGIN_DATA` → `{resolvedProjectDir}/.canon` → **fails closed (throws)**; no `process.cwd()` / `CANON_PROJECT_DIR` fallback. `stopHttpServer` wraps the PID-removal call in try/catch — degrades to skipping removal when no scope is resolvable (best-effort, never reintroduces cwd fallback). `writePidFile(pidDir?)` writes `{pid}:{port}\n` to `{CLAUDE_PLUGIN_DATA}/.canon/mcp-server.pid` (fallback `.canon/mcp-server.pid`) on bind; `removePidFile` removes only if PID matches; failures WARN, never thrown; skipped in VITEST. `resetStateForTesting()` clears `resolvedProjectDir`. Updated 2026-06-04.

**`resolveGitRoot(cwd, gitTopLevelFn)`** (`src/app/resolve-project-dir.ts`) — returns git repo root for `cwd`; falls back to `cwd` when not in a git repo or git is unavailable; errors are logged and swallowed (never throws).

**Per-connection scope** (`src/app/server-state.ts`) — HTTP Phase 1 (1a–1d) complete. `export let projectDir` / `setProjectDir` global deleted; `resolveScope(extra)` is the sole accessor. Lookup order: (1) per-session registry entry keyed by `extra.sessionId`; (2) `STDIO_SESSION_ID = "__stdio__"` sentinel. Fails closed (throws) for any unregistered session — closes the cross-tenant cwd-leak hazard. Startup: `index.ts` calls `registerConnectionScope(STDIO_SESSION_ID, resolvedDir)` instead of `setProjectDir`. `registerConnectionScope(sessionId, dir)` / `clearConnectionScope(sessionId)` manage the registry. `resetForTesting()` clears all mutable state (not called in production). **JobManager is now per-project** (isolation-finish slice, 2026-06-04): `job-manager.ts` replaced the module-level singleton with a `Map<string, JobManager>` keyed by `path.resolve(projectDir)`; `getOrCreateJobManager(projectDir, ...)` is the sole factory; `getJobManager(projectDir)` is a required-arg non-creating lookup (returns `undefined` for unknown scope); `cleanupAllJobManagers()` tears down all managers at shutdown; `initJobManager` deleted (was dead code). Eviction hooks remain unwired: `evictStoresForScope(projectDir)` (`execution-store-cache.ts`) and `evictDriftDbForScope(projectDir)` (`drift-db-cache.ts`) — wiring deferred to the HTTP-transport sub-build per `decisions/isolation-finish-01.md` (workspace-root `decisions/` directory). <!-- last-updated: 2026-06-04 -->

**`present_artifact` MCP tool** — `html` parameter required; serves the provided HTML directly via HTTP server; returns `{ url: string }` (fire-and-forget; does not block). Updated 2026-05-16.

**`present_review` MCP tool** — thin composition: `showPrImpact` → read pre-rendered `${workspace}/artifacts/review.html` → `presentArtifact`; returns `{ url: string }`; `INVALID_INPUT` when `review.html` missing or `has_review === false`. Added 2026-05-15, updated 2026-05-16.

**Tool error types** (`src/shared/lib/tool-result.ts`) — ADR-002, 2026-03-31: `ToolResult<T>` is a discriminated union `({ ok: true } & T) | CanonToolError`; all tools return this (never throw for expected errors). `CanonErrorCode` has 9 values (see source). Unexpected throws are caught as `UNEXPECTED` errors by `gatedWrapHandler` (inlined) or `wrapHandler<T>` in `wrap-handler.ts` (non-gated paths).

**`wrapHandler` extra forwarding** (`src/shared/lib/wrap-handler.ts`) — inner handler optionally receives `extra: RequestHandlerExtra` as second arg; backward compatible. Updated 2026-06-01.

**Subprocess adapters** (`src/platform/adapters/`) — ADR-002; only files here may import `node:child_process`. Three adapters: `git-adapter.ts` (sync, shell never true, 30s default), `git-adapter-async.ts` (async, never rejects), `process-adapter.ts` (shell: true, 512KB maxBuffer). See source for signatures.

**Flow parser** (`src/orchestration/flow-parser.ts`) — ADR-004, 2026-04-01: `loadAndResolveFlow` now throws on hard validation errors (was returning `errors` array). Exports: `validateSpawnCoverage`, `analyzeReachability`, `checkUnresolvedRefs`, `validateStateIdParams`, `VIRTUAL_SINKS`, `RUNTIME_VARIABLES` (see source).

**Execution store** (`src/domains/workspaces/execution-store.ts`) — optimistic locking via `updateExecutionVersioned(fields, expectedVersion)` (returns `{ updated: true|false }`); transparent `SQLITE_BUSY` retry via `withRetry`; all board mutations use `updateExecutionVersioned`. `isStuck` is SQL-based. SCHEMA_VERSION = '11'. See Invariants.

**KG schema** (`src/graph/kg-schema.ts`) — SCHEMA_VERSION = "5"; v5 adds `community_id` (INTEGER NULL on `files`), `file_tags` table, `hotspot_scores` table, `co_change_edges` table (see source for columns).

**Execution schema** (`src/domains/workspaces/execution-schema.ts`) — SCHEMA_VERSION = '11'; `runMigrations(db)` is idempotent. v3 adds `iteration_results` table, v11 adds `version` column to `execution` table.

**Board sync** (`src/domains/board/board-sync.ts`) — `syncBoardToStore` returns `SyncResult` (`{ ok: true; newVersion } | { ok: false; error: "version_conflict" }`); wraps all writes in single transaction; callers must check `result.ok`.

**Fragment param syntax** — typed params (`param_name: { type: state_id|string|number|boolean, default? }`) replace null-marker `~`; backward compat retained; `state_id` params validated at load time.

**Drift DB schema** (`src/platform/storage/drift/drift-schema.ts`) — DRIFT_SCHEMA_VERSION = "9"; tables: `file_violation_history`, `path_effects` (v4), `error_fixes` (v6), `violation_outcomes` (v7), `area_observations` (v8), `craft_profiles` (v9 — `flow_slug`, `subsystem_key`, `ratings` JSON, `rollup` REAL, `source` "review"|"audit"); idempotent migrations. Updated 2026-06-03.

**OutcomeStore** (`src/platform/storage/drift/outcome-store.ts`) — sync DAO for `violation_outcomes`; `recordOutcome`, `getOutcomesForPrinciple`, `getOutcomeStats`, `getOutcomesForFiles`. Added 2026-05-25.

**DriftDbSignals DAO** (`src/platform/storage/drift/drift-db-signals.ts`) — sync DAO for `file_violation_history`, `path_effects`, `error_fixes`; `DriftDb.getSignals()` lazy accessor. Updated 2026-05-22.

**Drift DB module split** (`src/platform/storage/drift/`) — extracted from `drift-db.ts` (lint: noExcessiveLinesPerFile). `drift-db-cache.ts`: `getDriftDb(projectDir)` factory + `evictDriftDbForScope(projectDir)` lifecycle hook; `drift-db-rows.ts`: 5 SQLite row types + 3 deserializers. All ~20 importers of `getDriftDb` import from `drift-db-cache.ts` directly (no barrel). Added 2026-06-03.

**AreaMemoryDao** (`src/platform/storage/drift/area-memory-dao.ts`) — sync DAO for `area_observations`; `insertObservation`, `getObservationsForSubsystems` (7-day expiry via SQL), `markInjected`; `DriftDb.getAreaMemory()` lazy accessor; `deriveSubsystemKey` strips path prefixes to stable keys like `features/orchestration`. Added 2026-05-29.

**CraftProfileDao** (`src/platform/storage/drift/craft-profile-dao.ts`) — sync DAO for `craft_profiles`; `insertProfile(CraftProfileRow)`, `getRecentProfiles({ subsystemKeys?, source?, limit? })` (order by `created_at DESC`); `DriftDb.getCraftProfiles()` lazy accessor; `source` discriminates `"review"` vs `"audit"` profiles. Added 2026-06-03.

**`drift-db-rows.ts`** — private row types + deserializers extracted from `drift-db.ts` for line-cap compliance; `DriftDb` public API unchanged. (See Drift DB module split entry above.)

**Drift Store** (`src/platform/storage/drift/store.ts`) — `ReviewEntry` is the unified type for all reviews (principle + PR); `PrStore` deleted 2026-03-25. `DriftStore.getReviews(options?)` AND-filters by principleId/branch/prNumber (see source for full signature).

**`show_pr_impact`** — unified PR analysis tool; returns `UnifiedPrOutput` with `has_review` boolean; `status` always `"ok"`; resource URI: `ui://canon/pr-review`
**`get_drift_report`** — `pr_reviews` field uses `ReviewEntry[]` (unified type); filters by pr_number/branch presence
**KgQuery** (`src/graph/kg-query.ts`) — `computeImpactScore`, `computeFileInsightMaps` (call once per request), `getFileMetrics`, `getSubgraph`; must call `computeFileInsightMaps` before `getFileMetrics` in loops (see source for full API)
**Git Intelligence** (`src/features/knowledge-graph/git-intel/`) — pipeline: git log → parse → churn scoring → co-change detection → persist atomically; `ensureGitIntelFresh` is the main entry point (no-op when fresh)
**Craft rubric** (`src/shared/lib/craft-rubric.ts`) — `CRAFT_DIMENSIONS` (6), `CRAFT_BANDS` (strong/adequate/weak/n-a), `CRAFT_DIMENSION_PRINCIPLES`, `craftBandOrdinal` (3/2/1/null), `craftRollup` (ordinal mean 1–3, undefined when all n-a); types exported via `src/shared/schema.ts`. Added 2026-06-03.

**Craft audit service** (`src/features/diagnostics/services/craft-audit-service.ts`) — `selectAuditAreas(files, options?)` (pure, bounded by `limit` default 5); `persistAuditProfile(areas, ratings, dao)` (writes `source:"audit"` rows via injected `CraftProfileDao`); reuses `CraftProfileSchema` + `deriveSubsystemKey`. Added 2026-06-03.

**Wiki lint services** (`src/features/diagnostics/services/wiki-lint.ts`, `doc-gap-detect.ts`) — pure functions: `checkContradictions`, `checkOrphanPrinciples`, `checkStaleRefs`, `checkMissingExamples`, `checkCitedPaths` (added 2026-06-02 — flags non-resolving paths in `references/**/*.md`; see `CheckName` in `tools/wiki-lint.ts`), `assembleWikiLintOutput(AssembleWikiLintInput)`; `detectDocGaps(entries)`, `scanDirectories(rootDir, excludeDirs?)`; all accept pre-loaded data (no I/O except `scanDirectories` and `checkCitedPaths`). Added 2026-05-26.
**Signal Compiler** (`src/features/diagnostics/services/signal-compiler.ts`) — `compileSignals(filePaths, driftDbSignals)` reads violation history + path effects, scores by priority, fits within per-file token budget; read-only
**Pitfall Enrichment** (`src/features/diagnostics/services/pitfall-enrichment.ts`) — pure functions over drift signals + error fixes; `formatPitfallsSection` returns `""` when both arrays empty.
**Area Memory Enrichment** (`src/features/diagnostics/services/area-memory-enrichment.ts`) — fail-open; calls `markInjected` after query; returns `{ section: ""; count: 0 }` on error.
**Hot-File Detection** (`src/features/diagnostics/services/hot-file-detection.ts`) — threshold ≥ 3 appearances, cap 3; fail-open.
**Backfill Error Fixes** (`src/features/diagnostics/services/backfill-error-fixes.ts`) — added 2026-05-22; script that mines `file_violation_history` to populate the `error_fixes` table; call once per project to seed historical data
**`store-summaries`** — DB-only write path (JSON removed ADR-005); `inferLanguageFromExtension` maps extensions to language strings
**`CANON_FILES` constants** — remaining keys: `CONFIG`, `KNOWLEDGE_DB`, `ORCHESTRATION_DB`, `DRIFT_DB`
**Principle matcher** (`src/shared/matcher.ts`) — OR semantics: matches if layers OR scope.tags intersect; `matchesScopeTags` checks tag overlap
**`get-principles`** — loads KG computed tags and passes to `matchPrinciples`; tag matching active when KG indexed
**`get-file-context`** — surfaces `computed_tags`, `hotspot_score`, `co_change_partners`; `shape` derived from graph metrics (see `deriveShape` in source)
**PR Review Data** (`pr-review-data.ts`) — pure functions: `classifyFile`, `generateNarrative`, `buildFileViolationMap`, `assembleOutput`; bucket thresholds: needs-attention = violations OR high in_degree; worth-a-look = priority >= 5; `getPrReviewData` returns `{ error }` (not throw) for invalid `pr_number`. Extracted 2026-05-25.
**Correction Reader** (`features/orchestration/services/correction-reader.ts`) — `readCorrections(projectDir, filePaths?, maxAge?)` → `{ ok: true; records[] } | { ok: false; error }`; ENOENT → `ok:true, records:[]`; updated 2026-05-25
**Confidence engine** (`src/shared/lib/confidence.ts`) — added 2026-05-25; `deriveTier(score, sampleSize)` returns `"insufficient"` for sparse data (never throws); `computeConfidenceAnnotation(inputs[])` returns zero-confidence for empty input.

**Review confidence adapter** (`src/features/orchestration/services/review-confidence-adapter.ts`) — composes severity_tier + violation_history + path_effects + base_sample signals; zero-confidence for undefined file_path. Added 2026-05-25.

**Drift confidence adapter** (`src/platform/storage/drift/drift-confidence-adapter.ts`) — composes sample_size (0.5) + trend_stability (0.3) + rate_stability (0.2); in platform/ to avoid circular imports. Added 2026-05-25.

**`write_review` tool** — accepts optional `confidence` annotation per violation; auto-annotates from drift DB when `confidenceAdapter` present; extracts area observations from BLOCKING/WARNING reviews via `areaMemoryWriter`; fail-open; no observations for CLEAN reviews. Updated 2026-05-29.

**`get_compliance` tool** — updated 2026-05-26: returns `confidence: ConfidenceAnnotation` in response; uses per-principle confidence from `analyzeDrift` when available, falls back to drift confidence adapter (sample_size + trend_stability + rate_stability signals).

**`write_implementation_summary` tool** — accepts optional `decisions?: DecisionRecord[]`; decisions rendered as markdown table in summary, stored in meta JSON, and logged as `agent_decision` events; extracts area observations from `deviations` and stores via `areaMemoryWriter`; fail-open throughout. Updated 2026-05-29.

**`get_drift_report` tool** — updated 2026-05-25: confidence tier rendered inline as `[confidence: TIER]` per violation in formatted output. Updated 2026-05-29: formatted output also renders `### Documentation freshness` section (omitted when empty) with commits-since-last-sync and `[confidence: TIER]` per direction doc, sorted by staleness descending.

**`DocFreshness` type** (`src/platform/storage/drift/analyzer.ts`) — `{ doc_path: string; commits_since_sync: number; confidence: ConfidenceAnnotation; warning?: string }`; placed in platform so service can import it without platform importing from features. `DriftReport.doc_freshness: DocFreshness[]` added (defaults to `[]`).

**`doc-freshness-adapter.ts`** (`src/platform/storage/drift/`) — `computeFreshnessConfidence(signals)`: maps `commits_since_sync` to staleness score, delegates to `computeConfidenceAnnotation`; `FRESHNESS_SAMPLE_SIZE = 10`. Added 2026-05-29.

**`computeDocFreshness`** (`src/features/diagnostics/services/doc-freshness.ts`) — enumerates `docs/*.md` (excludes `docs/reference/`), git injectable seam; `!ok` paths log WARN + return `DocFreshness` with `warning?`; ENOENT → `[]`. Added 2026-05-29.

**Shared libs** — `token-budget.ts`: `fitWithinBudget` greedy selector by priority; `violation-patterns.ts`: 8 extracted pure functions for violation analysis; `config.ts`: `buildLayerInferrer` supports globs; `DEFAULT_LAYER_MAPPINGS` includes `hooks: ["hooks"]` entry ordered before `shared` so `hooks/lib/*.sh` resolves to layer `hooks` (added 2026-05-29)

**Composite context tool:**

| Tool | Purpose |
|------|---------|
| `get_context` | Batch context for multiple files — composes `getPrinciplesBatch`, `getFileContext` (per-file), `getDriftReport`, `graphQuery`, `compileSignals` in a single call; `include` param gates sections (default: all 5) |

**`get_context` tool** — implementation in `src/app/get-context-handler.ts` (extracted 2026-06-01 from `register-knowledge.ts`); re-exported from `register-knowledge.ts` so existing test imports remain valid. Input: `file_paths[]` + optional `include` (5 sections: principles, file_context, drift, graph, signals). `file_context` errors fail-closed; graph/signals fail open. Exports: `handleGetContext(input, extra?)`, `buildSlimmedOutput`, `GetContextOutput`.

**Text-only principle/review tools:**

| Tool | Purpose |
|------|---------|
| `get_principles` | Find applicable principles for context (file, layer, task) |
| `list_principles` | Browse principle index (metadata only) |
| `review_code` | Surface principles for code review + code content |
| `report` | Log reviews (drift tracking) |
| `store_summaries` | Persist file summaries to SQLite KG DB (DB-only since ADR-005 2026-04-01; JSON write path removed) |
| `get_drift_report` | Full drift report — compliance rates, most violated principles, hotspot directories, trend, recommendations, PR reviews |
| `get_compliance` | Compliance stats for a specific principle — violation counts, rate, trend, weekly history |
| `wiki_lint` | Lint Canon's own meta-layer artifacts — contradictions between CLAUDE.md files, orphan principles, stale file refs, principles missing examples, cited-path accuracy in `references/**/*.md`; optional `checks` array selects subset (default: all 5); returns `WikiLintOutput` |
| `graph_query` | Query codebase knowledge graph — callers, callees, blast radius, dead code, search |
| `store_pr_review` | Store a PR review result for drift tracking; accepts optional `craft_profile` (validated via `CraftProfileSchema`; persists one row per distinct subsystem area to `craft_profiles` with `source:"review"`) |

**History tools** (`src/features/history/`):

| Tool | Purpose |
|------|---------|
| `get_build_history` | List archived build runs with metadata |
| `get_historical_artifacts` | Retrieve archived artifacts from a previous build |
| `get_cross_run_analysis` | Cross-run meta-analysis for the learner agent; result includes `craft_drift: CraftDrift` (`by_dimension[]`, `by_area[]`, `profile_count`) computed by `computeCraftDrift` in `cross-run-analyzer.ts`; higher band ordinal = better; sparse areas (< 4 profiles) yield `"stable"` direction; n-a bands excluded from ordinal math |

**Transcript capture** — best-effort; always returns `ok: true`; writes to `{workspace}/transcripts/`; path-traversal guarded
**Orchestration tools** — `resolve_after_consultations`: pure resolution, call after last wave before `report_result`; `resolve_wave_event`: apply/reject pending events, emits `wave_event_resolved`; `resolve_agent_skills`: **async** since 2026-05-20; applies progressive disclosure when `projectDir` provided — if `preload_prompt` exceeds 12k chars, full JSON is written to `.canon/artifacts/agent-skills-*.json` and result contains a compact summary + `full_data_path` pointer; accepts optional `options?: { filePaths?: string[]; workspace?: string }` — when `filePaths` provided, appends "Known Pitfalls", "Area Memory", and "Hot-File Caution" sections to `preload_prompt`; logs `pitfall_injected` or `area_enrichment_injected` audit events when data found. Updated 2026-05-29.
**Gate runner** — `normalizeGates` resolves via 3-tier priority (direct > named > discovered); **fail-closed**: unresolved gate → `{ passed: false }`; `bash_check` denylist: `rm`, `sudo`, `curl`, `wget`, `chmod`, `chown`, `mkfs`, `dd`
**Flow schema** (`flow-schema.ts`) — `StateDefinitionSchema` is a `z.discriminatedUnion` with 5 type schemas; all new fields MUST be `.optional()`; `WavePolicy` defaults: isolation=worktree, merge=sequential, on_conflict=hitl
**Step journaling** — `log_step` / `batch_log_steps` record step completion (status, artifacts, agent ID) in `journal.json`; quality signals (gate_results, postconditions, violations, tests, files_changed) and discovery fields accumulate across steps (append, not replace)
**Analytics** — `computeAnalytics(entries)` aggregates flow run metrics; skips entries without gate data

**Orchestration harness tools:**

| Tool | Purpose |
|------|---------|
| `open_artifact` | Open an HTML artifact from `${workspace}/artifacts/` in browser; reads file, registers with HTTP server, opens fire-and-forget; returns `{ url }`; path traversal blocked; `UNEXPECTED` when HTTP server not running. Added 2026-05-25. |
| `init_workspace` | Create or resume a workspace; seeds `progress.md`; creates build worktree at `{workspace}/worktree` on `canon/{slug}` branch (returned as `worktree_path`/`worktree_branch`); `preflight: true` checks git status + stale sessions + file claims — on issues returns `workspace: ""` with `candidate_workspace` and `preflight_issues`; resume checks `{workspace}/worktree` first, then legacy `.canon/worktrees/{slug}` fallback; `expectedTask` mismatch blocks resume to prevent slug-collision |
| `write_plan_index` | Write a structured `INDEX.md` for wave execution to `{workspace}/plans/{slug}/INDEX.md`; validates task IDs (`/^[a-zA-Z0-9_-]+$/`), wave ≥ 1, no duplicates; returns `{ path, task_count, wave_count }` — added 2026-04-01 |
| `finalize_workspace` | Close the flow: verifies journal completeness, releases file claims for the workflow slug, aggregates gate/postcondition/violation/test metrics into `FlowRunEntry` |
| `log_step` | Record a single step execution (status, artifacts, agent ID) in `journal.json` |
| `record_agent_metrics` | Agent-callable tool to record performance counters (`tool_calls`, `orientation_calls`, `turns`) directly into execution state metrics; merges with existing metrics preserving orchestrator fields; returns `INVALID_INPUT` if no fields provided, `WORKSPACE_NOT_FOUND` if state not found — added 2026-04-01 (ADR-003a) |
| `post_event` | Structured activity logging; stores `agent_activity` event via `appendEvent`; returns `{ ok: true }` or `WORKSPACE_NOT_FOUND`/`INVALID_INPUT` — added 2026-04-07 |
| `batch_log_steps` | Log multiple steps in one journal read-modify-write; fail-closed (batch rejected if any `step_id` empty); parallel transcript capture for completed entries with `agent_id` — added 2026-04-30 |
| `capture_transcript` | Best-effort transcript capture; reads CC agent JSONL from `{CLAUDE_CONFIG_DIR}/projects/…`, writes `TranscriptEntry[]` to `{workspace}/transcripts/`; returns warning (never error) when source not found; `source_path` is the primary source with the `agent_id` glob scan as fallback; `persist_path: true` records the path via `setTranscriptPath()` for `get_transcript` (fail-open) — added 2026-04-26, updated 2026-05-30 |
| `compute_autonomy_tier` | Compute autonomy tier (autonomous/light-touch/supervised) from build history, blast radius, compliance signals; returns `ComputeAutonomyTierResult` with `tier`, `score`, `reasoning`, `signals_used`; fail-safe: defaults to supervised on any signal-gathering error; logs `auto_decision` event to execution store |
| `get_next_escalation_strategy` | Get next fallback strategy when agent failure/stuck detected; reads/writes escalation state in execution_states.metrics; returns `EscalationResult` with `strategy`, `reasoning`, `attempts_so_far`, `time_elapsed_ms`, `is_terminal`; cascade sequence: add_primer → increase_budget → escalate_model → narrow_scope → hitl; 2-minute cumulative timeout; per-flow config via `skip_strategies`; logs `auto_decision` event |
| `reconcile_workspace` | Cliff detection; inputs: `{ workspace, emit_telemetry?: boolean, source?: "resume" \| "post_subagent" }`; returns `{ incomplete_steps: IncompleteStep[], needs_recovery: boolean }`; flags `started`/`planned` steps whose declared artifacts are either missing on disk (`missing_artifacts`) or present but still a `## Status: Partial` / `IN_PROGRESS` skeleton (`partial_artifacts`); `completed` steps and `planned` steps with empty `artifacts_expected` are never flagged; when `emit_telemetry: true` and `needs_recovery: true`, appends a best-effort fail-open `cliff_detected` event to the execution-store event log (never mutates journal/archive; telemetry write failure never changes the returned result); `WORKSPACE_NOT_FOUND` when journal absent — added 2026-05-29, partial detection 2026-05-30, telemetry seam 2026-06-04 |

## Dependencies
<!-- last-updated: 2026-05-16 -->

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | MCP server/client implementation |
| `zod` | Runtime schema validation |
| `gray-matter` | YAML frontmatter parsing in `parser.ts` |
| `tsx` | TypeScript execution (runtime dependency — server launched via boot.sh → tsx) |
| `vitest` | Unit testing (dev) |

**Worktree settings injection** (`src/features/prompt-pipeline/services/worktree-settings.ts`) — added 2026-04-08: `injectWorktreeSettings(worktreePath, tools)` atomically writes `.claude/settings.local.json`; returns `false` on failure (never throws); idempotent. `profileToAllowRules` filters to `BUILTIN_CLAUDE_TOOLS`. `buildWorktreeSettings` produces `{ permissions: { allow: [] } }` for empty input.

**Agent Provenance** (`src/shared/lib/commit-trailers.ts`, `src/shared/lib/file-claims.ts`) — added 2026-04-09: `formatCommitTrailers(TrailerOpts)` / `buildCommitMessage(subject, body, trailerOpts)` produce Canon trailer blocks; `ClaimsFile` persisted to `.canon/claims.json`; `readClaims`/`registerClaims`/`releaseClaims`/`checkClaimOverlaps` manage 24h-TTL file ownership claims; spawn prompts include a `## Commit Provenance` section via `inject-coordination.ts`.

**`injectSettingsIntoRequests`** (`src/features/orchestration/tools/drive-flow.ts`) — calls `injectWorktreeSettings` when `permission_mode === "auto"` AND `worktree_path` AND `tools` present; never throws.

## Invariants
<!-- last-updated: 2026-05-27 -->

- **ADR-002 subprocess isolation**: Only files in `src/platform/adapters/` may import `node:child_process`; all `features/` and `orchestration/` code must use adapter functions (`gitExec`, `gitExecAsync`, `runShell`) — added 2026-03-31
- **ADR-002 ToolResult contract**: Tools return `ToolResult<T>` for all expected error conditions; unexpected errors are caught by `gatedWrapHandler` (gated handlers) or `wrapHandler` (non-gated paths) and returned as `UNEXPECTED` `CanonToolError`; tools never throw for expected conditions — added 2026-03-31
- **ADR-002 security boundary**: `git-adapter.ts` never sets `shell: true`; `process-adapter.ts` sets `shell: true` for arbitrary shell commands; the two adapters must not be interchanged for git operations — added 2026-03-31
- All subprocess adapters enforce a default 30s timeout; callers may pass an explicit timeout override — added 2026-03-31
- All data persists to `.canon/` directory (reviews.jsonl, knowledge-graph.db, orchestration.db, drift.db); `graph-data.json`, `summaries.json`, `reverse-deps.json` no longer written (removed ADR-005 2026-04-01)
- JSONL files auto-rotate when exceeding size limits
- Atomic file writes prevent corruption on concurrent access
- `CANON_PROJECT_DIR` env var sets project root; when unset, cwd fallback resolves to the git repo root (`resolveGitRoot`) before being passed to `resolveProjectDir` — ensures `.canon/` lands at the repo root even when the server starts from a subdirectory
- `CANON_PLUGIN_DIR` env var sets plugin directory (defaults to parent of mcp-server)
- Workspace subdirectories created by `initWorkspace`: `artifacts/`, `plans/`, `reviews/`, `transcripts/` — `notes/` removed 2026-03-24; `artifacts/` added 2026-05-16; `decisions/`, `handoffs/`, `research/` removed 2026-05-25 (never populated by any tool)
- `progress.md` is seeded at workspace creation by `init_workspace`; no tool currently appends to it server-side; agents treat it as read-only
- Gate runner is **fail-closed**: a named gate that cannot be resolved returns `{ passed: false }` — never silently passes (changed from fail-open 2026-03-26)
- `bash_check` postconditions are filtered against a denylist before shell execution: `rm`, `sudo`, `curl`, `wget`, `chmod`, `chown`, `mkfs`, `dd`; blocked commands return `passed: false`
- All new schema fields in `flow-schema.ts` MUST be `.optional()` — `BoardSchema.parse()` must not throw on existing workspace `board.json` files
- `discovered_gates` and `discovered_postconditions` on `BoardStateEntry` accumulate across multiple step-journal calls (append, not replace)
- `EffectTypeSchema` switch in `effects.ts` has no `default` case — TypeScript enforces exhaustiveness when new effect types are added
- **ADR-004 hard-blocking validation**: `loadAndResolveFlow` throws on spawn coverage errors or unresolved refs; callers must not expect an `errors` field on the return value — added 2026-04-01
- **ADR-004 SQL stuck detection**: `ExecutionStore.recordIterationResult` must be called after each iteration before `isStuck` is queried; `isStuck` returns `false` (not stuck) when fewer than 2 results exist — added 2026-04-01
- **ADR-004 fragment typed params**: `state_id`-typed params in fragment `with:` maps are validated against real state IDs at load time; supplying a non-existent state ID is a hard error — added 2026-04-01
- **ADR-005 KG sole data source**: `graph/query.ts` and `graph/view-materializer.ts` deleted; SQLite KG (via `KgQuery`/`KgStore`) is the exclusive store for graph and summary data; no JSON artifacts are written for graph or summary data — added 2026-04-01
- **ADR-005 computeFileInsightMaps call pattern**: call `computeFileInsightMaps(db)` once per request and pass the `FileInsightMaps` result into `KgQuery.getFileMetrics()`; do not call `getFileMetrics()` in a loop without pre-computing insight maps — added 2026-04-01
- **worktree_path is the sole isolation signal** (2026-04-08; updated 2026-05-25): `SpawnPromptEntry` no longer carries `isolation`; `resolveToolProfile` permission_mode fallback uses `worktreePath ? "auto" : "prompt"` (not `isolation`); Canon owns the worktree lifecycle; `persistWaveTaskResult` stores the convention branch (`canon-wave/{task_id}`) unconditionally. **Build worktrees** are now created at `{workspace}/worktree` (was `.canon/worktrees/{slug}`); `tryResumeWorkspace` checks new path first with legacy fallback; agent-teams orchestrator passes `worktree_path` to all code-writing agents and omits `isolation` from Agent calls (Claude Code's `isolation` parameter only accepts `"worktree"` — omitting it is the correct way to disable Agent-managed isolation)
- **auto-approve settings injection** (2026-04-08): `injectSettingsIntoRequests` is called in all three spawn paths (`startNextWave`, `enterWaveState`, `tryEnterSingleState`) before returning `{ action: "spawn" }`; injection is conditional on `req.permission_mode === "auto"` AND `req.worktree_path` AND `req.tools`; `injectWorktreeSettings` failure returns `false` and never blocks spawn (fail-closed); agents that would have received auto-approve simply fall back to standard prompting
- **file claims non-blocking** (2026-04-09): all claim operations in `init_workspace`, `finalize_workspace`, and `inject-coordination.ts` are wrapped in try/catch; claim failures never block workflow execution; overlap warnings are advisory strings in board metadata (`claim_warnings`), not errors
- **file claims lifecycle** (2026-04-09): claims are registered via `write_plan_index` (architect's affected-file list) and the `init_workspace` flow, checked as informational warnings by `init_workspace` preflight, and released by `finalize_workspace`; do not call `file-claims.ts` functions directly from feature code outside these integration points
- **optimistic locking on all board mutations** (2026-04-09): all board-write paths read `version` once at entry via `store.getVersion()` and pass it to `store.updateExecutionVersioned()`; a stale version returns `BOARD_LOCKED` (recoverable: true); do not use `store.updateExecution()` in handler code — use `store.updateExecutionVersioned()` instead
- **syncBoardToStore is atomic** (2026-04-09): all writes in `syncBoardToStore` are wrapped in a single `store.transaction()`; partial writes cannot land — a version conflict aborts the entire sync and returns `{ ok: false, error: "version_conflict" }`; callers must check `result.ok`
- **SQLITE_BUSY is transparent to callers** (2026-04-09): `store.transaction()` internally retries via `withRetry`; callers do not need to handle `SQLITE_BUSY` themselves; `withRetry` does not retry other error codes

## Conventions
<!-- last-updated: 2026-05-26 -->

**Recursive filesystem scanners — root threading**: Scanners that exclude paths by relative prefix must thread the original scan root through all recursive calls. Never update the root to the current directory. Pattern: `scanFn(currentDir, rootDir)` where `rootDir` never changes. The bug class (root-drift) is silent — exclusion logic passes at depth 0 and silently fails at depth 1+. See `tools/wiki-lint.ts` (`FindFilesCtx.originalRoot`) and `services/doc-gap-detect.ts` (`scanOne(currentDir, rootDir, excludeDirs)`) as reference implementations.

## Development
<!-- last-updated: 2026-05-30 -->

```bash
npm install          # Install dependencies
npm run build        # Emit TypeScript declarations only (.d.ts via tsc emitDeclarationOnly; no runnable dist/ produced)
npm start            # Run server via tsx (tsx is a runtime dependency; loaded by boot.sh in production)
npm test             # Run vitest unit tests
```

Node.js 24+ required.
