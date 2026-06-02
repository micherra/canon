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
<!-- last-updated: 2026-06-02 (boot.sh ESM dep-resolution: NODE_PATH → symlink + deps-ready poll + dangling-symlink guard; per-connection scope registry; wrapHandler forwards extra; 5 register-*.ts boundaries migrated to resolveScope(extra); get-context-handler.ts extracted) -->

**`boot.sh`** (`mcp-server/boot.sh`) — self-resolving launcher: prefers `${CLAUDE_PLUGIN_ROOT}/mcp-server` as server dir; falls back to its own `BASH_SOURCE` dir; never uses `npx`. Boot sequence (updated 2026-06-02): (1) resolve SERVER_DIR; (2) compute `DATA_DIR=${CLAUDE_PLUGIN_DATA}/node_modules`; (3) **deps-ready poll** — if no usable `tsx` yet and `CLAUDE_PLUGIN_DATA` is set, polls `DATA_DIR/.bin/tsx` up to `CANON_BOOT_DEPS_TIMEOUT` ticks (default 60, interval `CANON_BOOT_DEPS_INTERVAL` default 1s) to close the ~26s SessionStart install race; emits `CANON: waiting...` before poll; timeout falls through to loud `exit 1`; (4) **ESM co-location symlink** — `ln -sfn DATA_DIR SERVER_DIR/node_modules` when DATA deps exist and `SERVER_DIR/node_modules` is not a real directory (never clobbers dev working-tree `node_modules`); `ln` failure emits `CANON WARNING` and degrades; idempotent, survives cache wipes; (5) **dangling-symlink guard** — if `SERVER_DIR/node_modules` is a symlink that does not resolve to a real dir, emits `CANON ERROR` and exits 1; skipped under `--print-resolution`; (6) resolve `NODE_PATH` and `tsx` binary; (7) `--print-resolution` flag prints `SERVER_DIR NODE_PATH TSX_BIN` and exits 0 (instant, skips wait and guard). `CLAUDE_PLUGIN_ROOT` is not expanded when `.mcp.json` loads as project config; `BASH_SOURCE` self-resolution is the backstop. Env seams: `CANON_BOOT_DEPS_TIMEOUT` (default 60), `CANON_BOOT_DEPS_INTERVAL` (default 1).

**`http-server.ts` PID file** (`src/app/http-server.ts`) — `writePidFile(pidDir?)` writes `{pid}:{port}\n` to `{CLAUDE_PLUGIN_DATA}/.canon/mcp-server.pid` (or `.canon/mcp-server.pid` fallback) on successful bind; `removePidFile(pidDir?)` removes only if stored PID matches current process; failures logged as WARN, never thrown; skipped in VITEST context. Added 2026-05-31.

**`resolveGitRoot(cwd, gitTopLevelFn)`** (`src/app/resolve-project-dir.ts`) — returns git repo root for `cwd`; falls back to `cwd` when not in a git repo or git is unavailable; errors are logged and swallowed (never throws).

**Per-connection scope** (`src/app/server-state.ts`) — Phase 1 groundwork for HTTP transport. `resolveScope(extra)` returns project dir for the current request: checks per-session registry entry first, then `STDIO_SESSION_ID` sentinel (written by `setProjectDir`), then module global fallback. `registerConnectionScope(sessionId, dir)` / `clearConnectionScope(sessionId)` manage the registry. `STDIO_SESSION_ID = "__stdio__"` is the sentinel used under stdio. `setProjectDir(dir)` now writes to both module global AND `STDIO_SESSION_ID` entry — behavior unchanged under stdio. `resetForTesting()` resets all mutable module state (not called in production). All five 1b register-*.ts boundaries (`register-artifacts`, `register-init-workspace`, `register-knowledge`, `register-principles`, `register-agent-teams`) resolve project dir via `resolveScope(extra)` per request; `projectDir` module global no longer imported in these files. Sub-builds 1c/1d (global deletion) remain pending.

**`present_artifact` MCP tool** — `html` parameter required; serves the provided HTML directly via HTTP server; returns `{ url: string }` (fire-and-forget; does not block). Updated 2026-05-16.

**`present_review` MCP tool** — thin composition: `showPrImpact` → read pre-rendered `${workspace}/artifacts/review.html` → `presentArtifact`; returns `{ url: string }`; `INVALID_INPUT` when `review.html` missing or `has_review === false`. Added 2026-05-15, updated 2026-05-16.

**Tool error types** (`src/shared/lib/tool-result.ts`) — ADR-002, 2026-03-31: `ToolResult<T>` is a discriminated union `({ ok: true } & T) | CanonToolError`; all tools return this (never throw for expected errors). `CanonErrorCode` has 9 values (see source). Unexpected throws are caught as `UNEXPECTED` errors by `gatedWrapHandler` (inlined) or `wrapHandler<T>` in `wrap-handler.ts` (non-gated paths).

**`wrapHandler` extra forwarding** (`src/shared/lib/wrap-handler.ts`) — inner handler optionally receives `extra: RequestHandlerExtra` as second argument; forwarded from the outer function; backward compatible (existing callers omitting `extra` type-check unchanged). Updated 2026-06-01.

**Subprocess adapters** (`src/platform/adapters/`) — ADR-002; only files here may import `node:child_process`. Three adapters: `git-adapter.ts` (sync, shell never true, 30s default), `git-adapter-async.ts` (async, never rejects), `process-adapter.ts` (shell: true, 512KB maxBuffer). See source for signatures.

**Flow parser** (`src/orchestration/flow-parser.ts`) — ADR-004, 2026-04-01: `loadAndResolveFlow` now throws on hard validation errors (was returning `errors` array). Exports: `validateSpawnCoverage`, `analyzeReachability`, `checkUnresolvedRefs`, `validateStateIdParams`, `VIRTUAL_SINKS`, `RUNTIME_VARIABLES` (see source).

**Execution store** (`src/domains/workspaces/execution-store.ts`) — concurrency update 2026-04-09: optimistic locking via `updateExecutionVersioned(fields, expectedVersion)` (returns `{ updated: true|false }`), transparent `SQLITE_BUSY` retry via `withRetry`, all board mutations use `updateExecutionVersioned` (not `updateExecution` directly). `isStuck` is SQL-based (see source). SCHEMA_VERSION = '11'. See Invariants for caller obligations.

**KG schema** (`src/graph/kg-schema.ts`) — SCHEMA_VERSION = "5"; v5 adds `community_id` (INTEGER NULL on `files`), `file_tags` table, `hotspot_scores` table, `co_change_edges` table (see source for columns).

**Execution schema** (`src/domains/workspaces/execution-schema.ts`) — SCHEMA_VERSION = '11'; `runMigrations(db)` is idempotent. v3 adds `iteration_results` table, v11 adds `version` column to `execution` table.

**Board sync** (`src/domains/board/board-sync.ts`) — `syncBoardToStore` returns `SyncResult` (`{ ok: true; newVersion } | { ok: false; error: "version_conflict" }`); wraps all writes in single transaction; callers must check `result.ok`.

**Fragment param syntax** — typed params (`param_name: { type: state_id|string|number|boolean, default? }`) replace null-marker `~`; backward compat retained; `state_id` params validated at load time.

**Drift DB schema** (`src/platform/storage/drift/drift-schema.ts`) — DRIFT_SCHEMA_VERSION = "8"; v4 adds `file_violation_history` + `path_effects` tables; v6 adds `error_fixes` table; v7 adds `violation_outcomes` table; v8 adds `area_observations` table (`id`, `subsystem_key`, `content`, `source`, `workflow_slug`, `created_at`, `injected_count`, `last_injected_at`; indices on `subsystem_key` and `created_at`); idempotent migrations. Updated 2026-05-29.

**OutcomeStore** (`src/platform/storage/drift/outcome-store.ts`) — sync DAO for `violation_outcomes`; `recordOutcome`, `getOutcomesForPrinciple`, `getOutcomeStats`, `getOutcomesForFiles`. Added 2026-05-25.

**DriftDbSignals DAO** (`src/platform/storage/drift/drift-db-signals.ts`) — sync DAO for `file_violation_history`, `path_effects`, `error_fixes`; `DriftDb.getSignals()` lazy accessor. Updated 2026-05-22.

**AreaMemoryDao** (`src/platform/storage/drift/area-memory-dao.ts`) — sync DAO for `area_observations`; `insertObservation`, `getObservationsForSubsystems` (7-day expiry via SQL), `markInjected`; `DriftDb.getAreaMemory()` lazy accessor; `deriveSubsystemKey` strips path prefixes to stable keys like `features/orchestration`. Added 2026-05-29.

**Drift Store** (`src/platform/storage/drift/store.ts`) — `ReviewEntry` is the unified type for all reviews (principle + PR); `PrStore` deleted 2026-03-25. `DriftStore.getReviews(options?)` AND-filters by principleId/branch/prNumber (see source for full signature).

**`show_pr_impact`** — unified PR analysis tool; returns `UnifiedPrOutput` with `has_review` boolean; `status` always `"ok"`; resource URI: `ui://canon/pr-review`
**`get_drift_report`** — `pr_reviews` field uses `ReviewEntry[]` (unified type); filters by pr_number/branch presence
**KgQuery** (`src/graph/kg-query.ts`) — `computeImpactScore`, `computeFileInsightMaps` (call once per request), `getFileMetrics`, `getSubgraph`; must call `computeFileInsightMaps` before `getFileMetrics` in loops (see source for full API)
**Git Intelligence** (`src/features/knowledge-graph/git-intel/`) — pipeline: git log → parse → churn scoring → co-change detection → persist atomically; `ensureGitIntelFresh` is the main entry point (no-op when fresh)
**Wiki lint services** (`src/features/diagnostics/services/wiki-lint.ts`, `doc-gap-detect.ts`) — pure functions: `checkContradictions`, `checkOrphanPrinciples`, `checkStaleRefs`, `checkMissingExamples`, `assembleWikiLintOutput(AssembleWikiLintInput)`; `detectDocGaps(entries)`, `scanDirectories(rootDir, excludeDirs?)`; all accept pre-loaded data (no I/O except `scanDirectories`). Added 2026-05-26.
**Signal Compiler** (`src/features/diagnostics/services/signal-compiler.ts`) — `compileSignals(filePaths, driftDbSignals)` reads violation history + path effects, scores by priority, fits within per-file token budget; read-only
**Pitfall Enrichment** (`src/features/diagnostics/services/pitfall-enrichment.ts`) — added 2026-05-22; `queryDriftSignalPitfalls`/`queryErrorFixPitfalls`/`formatPitfallsSection`/`countPitfalls`; pure functions; `formatPitfallsSection` returns `""` when both arrays empty
**Area Memory Enrichment** (`src/features/diagnostics/services/area-memory-enrichment.ts`) — added 2026-05-29; `queryAreaObservations`/`formatAreaMemorySection`/`buildAreaMemorySection`; fail-open, calls `markInjected` after query; returns `{ section: ""; count: 0 }` on error.
**Hot-File Detection** (`src/features/diagnostics/services/hot-file-detection.ts`) — added 2026-05-29; `detectHotFiles`/`formatHotFileSection`/`buildHotFileSection`; threshold ≥ 3 appearances, cap 3; fail-open.
**Backfill Error Fixes** (`src/features/diagnostics/services/backfill-error-fixes.ts`) — added 2026-05-22; script that mines `file_violation_history` to populate the `error_fixes` table; call once per project to seed historical data
**`store-summaries`** — DB-only write path (JSON removed ADR-005); `inferLanguageFromExtension` maps extensions to language strings
**`CANON_FILES` constants** — remaining keys: `CONFIG`, `KNOWLEDGE_DB`, `ORCHESTRATION_DB`, `DRIFT_DB`
**Principle matcher** (`src/shared/matcher.ts`) — OR semantics: matches if layers OR scope.tags intersect; `matchesScopeTags` checks tag overlap
**`get-principles`** — loads KG computed tags and passes to `matchPrinciples`; tag matching active when KG indexed
**`get-file-context`** — surfaces `computed_tags`, `hotspot_score`, `co_change_partners`; `shape` derived from graph metrics (see `deriveShape` in source)
**PR Review Data** (`pr-review-data.ts`) — pure functions: `classifyFile` (bucket assignment), `generateNarrative`, `buildFileViolationMap`, `assembleOutput(AssembleParams): PrReviewDataOutput` (extracted 2026-05-25); `PrFileInfo.bucket` thresholds: needs-attention = violations OR high in_degree; worth-a-look = priority >= 5; `getPrReviewData` returns `{ error }` (not throw) for invalid `pr_number`
**Correction Reader** (`features/orchestration/services/correction-reader.ts`) — `readCorrections(projectDir, filePaths?, maxAge?)` → `{ ok: true; records[] } | { ok: false; error }`; ENOENT → `ok:true, records:[]`; updated 2026-05-25
**Confidence engine** (`src/shared/lib/confidence.ts`) — added 2026-05-25; `deriveTier(score, sampleSize)` returns `"insufficient"` for sparse data (never throws); `computeConfidenceAnnotation(inputs[])` returns zero-confidence for empty input.

**Review confidence adapter** (`src/features/orchestration/services/review-confidence-adapter.ts`) — composes severity_tier + violation_history + path_effects + base_sample signals; zero-confidence for undefined file_path. Added 2026-05-25.

**Drift confidence adapter** (`src/platform/storage/drift/drift-confidence-adapter.ts`) — composes sample_size (0.5) + trend_stability (0.3) + rate_stability (0.2); in platform/ to avoid circular imports. Added 2026-05-25.

**`write_review` tool** — updated 2026-05-29: accepts optional `confidence` annotation per violation; when `confidenceAdapter` present, auto-annotates violations from drift DB signals; extracts area observations from BLOCKING/WARNING reviews and stores in `area_observations` via `areaMemoryWriter` (injected via `register-artifacts.ts`); fail-open when writer absent or throws; no observations extracted for CLEAN reviews.

**`get_compliance` tool** — updated 2026-05-26: returns `confidence: ConfidenceAnnotation` in response; uses per-principle confidence from `analyzeDrift` when available, falls back to drift confidence adapter (sample_size + trend_stability + rate_stability signals).

**`write_implementation_summary` tool** — updated 2026-05-29: accepts optional `decisions?: DecisionRecord[]` array; decisions rendered as markdown table in summary and stored in meta JSON; each decision logged as `agent_decision` event in execution store; `DecisionRecord` fields: `choice`, `rationale`, `alternatives_considered`, `informed_by` (refs: area_memory, pitfall, principle, task_plan, codebase_pattern); extracts area observations from `deviations` field and stores in `area_observations` via `areaMemoryWriter`; fail-open throughout.

**`get_drift_report` tool** — updated 2026-05-25: confidence tier rendered inline as `[confidence: TIER]` per violation in formatted output. Updated 2026-05-29: formatted output includes a `Craft: N (N holistic findings)` line after `Avg score:`, distinct from compliance numbers; also renders `### Documentation freshness` section (omitted when empty) with commits-since-last-sync and `[confidence: TIER]` per direction doc, sorted by staleness descending.

**`DocFreshness` type** (`src/platform/storage/drift/analyzer.ts`) — `{ doc_path: string; commits_since_sync: number; confidence: ConfidenceAnnotation; warning?: string }`; placed in platform so service can import it without platform importing from features. `DriftReport.doc_freshness: DocFreshness[]` added (defaults to `[]`).

**`doc-freshness-adapter.ts`** (`src/platform/storage/drift/`) — `computeFreshnessConfidence(signals)`: maps `commits_since_sync` to staleness score, delegates to `computeConfidenceAnnotation`; `FRESHNESS_SAMPLE_SIZE = 10`. Added 2026-05-29.

**`computeDocFreshness`** (`src/features/diagnostics/services/doc-freshness.ts`) — enumerates `docs/*.md` (excludes `docs/reference/`), git injectable seam; `!ok` paths log WARN + return `DocFreshness` with `warning?`; ENOENT → `[]`. Added 2026-05-29.

**`DriftReport.craft`** (`platform/storage/drift/analyzer.ts`) — added 2026-05-29: `craft: { holistic_count: number; score: number }` field on `DriftReport`; `computeCraftScore(reviews)` uses formula `max(0, 100 − min(100, holistic_count × 10))`; populated by `analyzeDrift` using the same filtered window as `avg_score`; kept DISTINCT from compliance score.

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
| `wiki_lint` | Lint Canon's own meta-layer artifacts — contradictions between CLAUDE.md files, orphan principles, stale file refs, principles missing examples; optional `checks` array selects subset (default: all 4); returns `WikiLintOutput` |
| `graph_query` | Query codebase knowledge graph — callers, callees, blast radius, dead code, search |
| `store_pr_review` | Store a PR review result for drift tracking |

**History tools** (`src/features/history/`):

| Tool | Purpose |
|------|---------|
| `get_build_history` | List archived build runs with metadata |
| `get_historical_artifacts` | Retrieve archived artifacts from a previous build |
| `get_cross_run_analysis` | Cross-run meta-analysis for the learner agent |

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
| `init_workspace` | Create or resume a workspace; seeds `progress.md` (header `## Progress: {task}`) on new workspace creation; creates build worktree at `{workspace}/worktree` on `canon/{slug}` branch (returned as `worktree_path` and `worktree_branch`); optional `preflight: true` checks git status, stale sessions, and active file claims before creating; when preflight finds issues, returns `workspace: ""` (empty string) and puts the candidate path in `candidate_workspace` — callers must check `preflight_issues` before using `workspace`; claim check is informational (non-blocking); resume checks `{workspace}/worktree` first, then legacy `.canon/worktrees/{slug}` fallback; `tryResumeWorkspace` accepts optional `expectedTask` — when provided and stored `session.task` differs, resume is blocked (returns null) to prevent slug-collision mismatches from `generateSlug` truncation |
| `write_plan_index` | Write a structured `INDEX.md` for wave execution to `{workspace}/plans/{slug}/INDEX.md`; validates task IDs (`/^[a-zA-Z0-9_-]+$/`), wave ≥ 1, no duplicates; returns `{ path, task_count, wave_count }` — added 2026-04-01 |
| `finalize_workspace` | Close the flow: verifies journal completeness, releases file claims for the workflow slug, aggregates gate/postcondition/violation/test metrics into `FlowRunEntry` |
| `log_step` | Record a single step execution (status, artifacts, agent ID) in `journal.json` |
| `inject_wave_event` | Inject user events into running wave execution |
| `resolve_wave_event` | Resolve a pending wave event (apply or reject); wraps `markEventApplied`/`markEventRejected`/`resolveEventAgents`; emits `wave_event_resolved` on event bus |
| `resolve_after_consultations` | Resolve "after" consultation prompts for a state; call after last wave, before `finalize_workspace`; returns `ConsultationPromptEntry[]` for orchestrator to spawn |
| `record_agent_metrics` | Agent-callable tool to record performance counters (`tool_calls`, `orientation_calls`, `turns`) directly into execution state metrics; merges with existing metrics preserving orchestrator fields; returns `INVALID_INPUT` if no fields provided, `WORKSPACE_NOT_FOUND` if state not found — added 2026-04-01 (ADR-003a) |
| `post_event` | Agent-callable tool for structured activity logging; input: `{ workspace, agent, action: "start"\|"complete", detail, artifacts?: string[] }`; stores `agent_activity` event in execution store's event log via `appendEvent`; returns `{ ok: true; event_type; agent; action; timestamp }` or `WORKSPACE_NOT_FOUND`/`INVALID_INPUT` on error — added 2026-04-07 |
| `batch_log_steps` | Log multiple steps in a single journal read-modify-write cycle; input: `{ workspace, steps: Array<{ step_id, status, agent_type?, artifacts_expected?, domain_skills_loaded?, outcome?, agent_id? }> }`; validates all entries upfront (fail-closed: entire batch rejected if any `step_id` is empty); runs transcript captures in parallel for completed entries with `agent_id`; returns `{ results: LogStepResult[] }` — added 2026-04-30 |
| `capture_transcript` | Best-effort transcript capture; input: `{ workspace, step_id, agent_type, agent_id, session_id?, project_id? }`; reads CC agent JSONL from `{CLAUDE_CONFIG_DIR}/projects/{projectId}/{sessionId}/subagents/agent-{agentId}.jsonl`, transforms to Canon `TranscriptEntry[]`, writes to `{workspace}/transcripts/{step_id}--{agent_type}--{iso}.jsonl`; output: `{ transcript_path, entry_count, warning? }`; returns warning (never error) when source not found; `project_id` defaults to `CANON_PROJECT_DIR`-derived value; `session_id` defaults to `CLAUDE_SESSION_ID` env var — added 2026-04-26 (NF-12) |
| `compute_autonomy_tier` | Compute autonomy tier (autonomous/light-touch/supervised) from build history, blast radius, compliance signals; returns `ComputeAutonomyTierResult` with `tier`, `score`, `reasoning`, `signals_used`; fail-safe: defaults to supervised on any signal-gathering error; logs `auto_decision` event to execution store |
| `get_next_escalation_strategy` | Get next fallback strategy when agent failure/stuck detected; reads/writes escalation state in execution_states.metrics; returns `EscalationResult` with `strategy`, `reasoning`, `attempts_so_far`, `time_elapsed_ms`, `is_terminal`; cascade sequence: add_primer → increase_budget → escalate_model → narrow_scope → hitl; 2-minute cumulative timeout; per-flow config via `skip_strategies`; logs `auto_decision` event |

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

**`injectSettingsIntoRequests`** (`src/features/orchestration/tools/drive-flow.ts`) — iterates spawn requests sequentially, calls `injectWorktreeSettings` when `permission_mode === "auto"` AND `worktree_path` AND `tools` present; never throws.

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
