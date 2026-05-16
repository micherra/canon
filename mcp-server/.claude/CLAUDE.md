# Canon MCP Server — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
TypeScript MCP (Model Context Protocol) server that provides tools for managing, enforcing, and tracking engineering principles across a codebase.

## Architecture
<!-- last-updated: 2026-05-05 (unified graph intelligence: kg-community.ts + kg-tags.ts added; register-composite.ts, get-file-context-batch.ts, workspace-structure.ts, runbook-tail-validator.ts, principle-reranker.ts removed; get_context relocated to register-knowledge.ts; computed_tags + min_confidence added to graph_query) -->

ES module TypeScript project using `@modelcontextprotocol/sdk` and `zod` for schema validation.

```
src/
├── app/                  # Entry point — tool registration (index.ts, register-*.ts, all handlers via wrapHandler)
├── domains/              # Shared domain types and persistence
│   ├── board/            # Board mutation logic (pure functions)
│   ├── drift/            # Drift/review type definitions
│   ├── flows/            # Flow and board-state type definitions, schemas
│   ├── knowledge-graph/  # KG type definitions (FileMetrics, LayerViolation)
│   ├── messages/         # Message persistence for agent collaboration
│   └── workspaces/       # Workspace and execution store (SQLite persistence)
├── features/             # Tool implementations grouped by bounded context
│   ├── diagnostics/      # Drift reports, agent metrics, summary storage
│   ├── file-context/     # get_file_context tool
│   ├── knowledge-graph/  # graph_query, semantic_search, codebase_graph, git-intel
│   ├── orchestration/    # Flow engine, drive_flow, init_workspace, report_result, all orchestration tools
│   ├── pr-review/        # show_pr_impact, review_code, store_pr_review
│   ├── principles/       # get_principles, list_principles, get_compliance
│   └── prompt-pipeline/  # Prompt assembly, context enrichment, consultation pipeline
├── graph/                # Legacy graph scanner — import/export parsing (being migrated to features/knowledge-graph)
├── orchestration/        # Legacy orchestration — flow parser, execution store, schemas (being migrated to features/orchestration)
├── platform/             # Infrastructure: adapters (git, process), job manager, workers, storage
├── shared/               # Shared kernel: constants, parser, matcher, schema, lib/ utilities
├── tests/                # Cross-cutting test helpers
└── ui/                   # Svelte frontend — MCP App (Sigma.js graph, PR review UI)
```

**Key subsystems:**
- **Drift tracking** (`platform/storage/drift/`) — JSONL-backed store for reviews with auto-rotation
- **Dependency graph** (`graph/`, `features/knowledge-graph/`) — SQLite KG via `KgQuery`/`KgStore`; scans imports/exports (JS/TS/Python), computes in/out degree, detects cycles and hubs; `graph/query.ts` and `graph/view-materializer.ts` deleted (ADR-005, 2026-04-01)
- **Community detection** (`graph/kg-community.ts`) — Louvain algorithm assigns `community_id` to each file in the KG; added 2026-05-02
- **Tag propagation** (`graph/kg-tags.ts`) — 4-signal pipeline (directory, imports, community, cross-ref) writes computed tags to `file_tags` table; used by `get-principles` and `get-file-context`; added 2026-05-02
- **Principle matching** (`shared/matcher.ts`) — Context-aware filtering by layers, file patterns, tags, severity; OR semantics: matches if layers OR scope.tags intersect (updated 2026-05-02)
- **Orchestration** (`orchestration/`, `features/orchestration/`) — Flow state machine runtime: board persistence, unified messaging, variable resolution, gate execution, consultation preparation, wave briefing assembly, competitive flows, debate protocol

## Contracts
<!-- last-updated: 2026-05-02 (unified graph intelligence: community detection, tag propagation, semantic principle matching, scope.tags OR semantics) -->

**Tool error types** (`src/shared/lib/tool-result.ts`) — added 2026-03-31 (ADR-002):
- `CanonErrorCode` — union of 9 string literals: `WORKSPACE_NOT_FOUND`, `FLOW_NOT_FOUND`, `FLOW_PARSE_ERROR`, `KG_NOT_INDEXED`, `BOARD_LOCKED`, `CONVERGENCE_EXCEEDED`, `INVALID_INPUT`, `PREFLIGHT_FAILED`, `UNEXPECTED`
- `CanonToolError` — `{ ok: false; error_code: CanonErrorCode; message: string; recoverable: boolean; context?: Record<string, unknown> }`
- `ToolResult<T>` — discriminated union `({ ok: true } & T) | CanonToolError`; all tool functions now return this type instead of throwing for expected errors
- `toolError(code, message, recoverable?, context?)` / `toolOk<T>(data)` / `isToolError(result)` / `assertOk<T>(result)` — construction and guard helpers in `tool-result.ts`

**Top-level MCP catch-all** (`src/shared/lib/wrap-handler.ts`) — `wrapHandler<T>(handler)` wraps any tool handler; catches unexpected throws and returns them as typed `UNEXPECTED` `CanonToolError`; all tool registrations in `index.ts` use this wrapper — added 2026-03-31 (ADR-002)

**Subprocess adapters** (`src/platform/adapters/`) — added 2026-03-31 (ADR-002); only files in this directory may import `node:child_process`:
- `git-adapter.ts`: `gitExec` / `gitDiff` / `gitStatus` → `ProcessResult` (sync, `shell` never `true`); default 30s timeout
- `git-adapter-async.ts`: `gitExecAsync` → `Promise<ProcessResult>`; never rejects; default 30s timeout
- `process-adapter.ts`: `runShell` → `ProcessResult` (sync, `shell: true`); 512KB maxBuffer; default 30s timeout

**Tool return types updated to `ToolResult<T>`** (ADR-002, 2026-03-31; ADR-004 updates 2026-04-01):
- `loadFlow`, `updateBoard`, `getFileContext`, `enterAndPrepareState`, `reportResult` / `reportResultLocked` all return `ToolResult<T>` variants; `KG_NOT_INDEXED` is `recoverable: true`

**Flow parser** (`src/orchestration/flow-parser.ts`) — updated 2026-04-01 (ADR-004):
- `loadAndResolveFlow(pluginDir, flowName, projectDir?)` → `Promise<ResolvedFlow>` — **breaking**: throws `Error` when hard validation errors exist (was `{ flow, errors }`); reachability warnings are non-blocking
- New exports: `validateSpawnCoverage`, `analyzeReachability`, `checkUnresolvedRefs`, `validateStateIdParams`, `VIRTUAL_SINKS`, `RUNTIME_VARIABLES`

**Execution store** (`src/domains/workspaces/execution-store.ts`) — updated through 2026-04-09:
<!-- last-updated: 2026-04-09 (concurrency: SCHEMA_VERSION 11, withRetry, updateExecutionVersioned, getVersion) -->
- `recordIterationResult(stateId, iteration, status, data)` — records raw iteration result; `INSERT OR REPLACE` on unique key
- `isStuck(stateId, stuckWhen): boolean` — SQL-based stuck detection; `false` when fewer than 2 results exist
- `updateStateMetrics(stateId, metrics)` — merges fields into existing `metrics` JSON; returns `true` when row found
- `withRetry<T>(fn, maxAttempts?)` — transparently retries synchronous DB ops on `SQLITE_BUSY`; default 3 attempts
- `updateExecutionVersioned(fields, expectedVersion)` — optimistic-locking update; returns `{ updated: false; currentVersion }` on mismatch (never throws)
- `getVersion()` — reads current `version`; returns `1` when no row exists
- `transaction()` — wraps callback in `withRetry` internally; do not use `updateExecution` directly — use `updateExecutionVersioned`

**KG schema** (`src/graph/kg-schema.ts`) — updated 2026-05-02:
- `SCHEMA_VERSION = "5"` — migration v5 adds `community_id` column on `files` and new `file_tags` table
- `hotspot_scores` table — per-file churn/complexity percentiles and hotspot flag
- `co_change_edges` table — Jaccard-weighted co-change pairs; alphabetically normalized pair keys
- `file_tags` table (v5) — computed tags per file from 4-signal pipeline

**Execution schema** (`src/domains/workspaces/execution-schema.ts`):
<!-- last-updated: 2026-04-09 (SCHEMA_VERSION bumped to "11"; migration v11 adds version column) -->
- `SCHEMA_VERSION = '11'`; `runMigrations(db)` — version-gated; each migration wrapped in transaction; safe to call repeatedly
- Migration v11 adds `version INTEGER NOT NULL DEFAULT 1` on `execution` table (idempotent)

**Board sync** (`src/domains/board/board-sync.ts`):
<!-- last-updated: 2026-04-09 (syncBoardToStore now returns SyncResult; all writes wrapped in single transaction) -->
- `SyncResult` — `{ ok: true; newVersion: number } | { ok: false; error: "version_conflict" }`
- `syncBoardToStore(store, board, expectedVersion?)` — all writes in single `store.transaction()`; uses `updateExecutionVersioned`; callers must check `result.ok`

**Fragment param syntax** (`flows/fragments/*.md`) — typed param declarations replace null-marker `~` syntax; `state_id`-typed params validated against real state names; old format still accepted for backward compat — updated 2026-04-01 (ADR-004)

**Drift Store** (`src/platform/storage/drift/store.ts`):
- `ReviewEntry` — unified type for all reviews; optional PR fields: `pr_number?`, `branch?`, `last_reviewed_sha?`, `file_priorities?`
- `DriftStore.getReviews(options?)`, `getLastReviewForPr(prNumber)`, `getLastReviewForBranch(branch)` — AND-filtered query methods
- `PrReviewEntry` and `PrStore` — DELETED 2026-03-25; all review persistence unified under `DriftStore`

**`show_pr_impact` tool** (`src/features/pr-review/tools/show-pr-impact.ts`):
- Unified tool — merges `show_pr_impact` and `get_pr_review_data` (removed 2026-03-25)
- Accepts `options?: { branch?, pr_number?, diff_base?, incremental? }` — all exposed as top-level MCP input fields
- Returns `UnifiedPrOutput` — `prep: PrReviewDataOutput` (always present), `has_review: boolean`, plus `review?`, `blastRadius?`, `hotspots`, `subgraph`, `co_change_warnings` (git-intel, 2026-04-08)
- `computeKgData(db, changedFiles, projectDir)` — exported for testing
- Resource URI: `ui://canon/pr-review`

**PR Review Data** (`src/features/pr-review/tools/pr-review-data.ts`) — `getPrReviewData` called internally by `showPrImpact`; `PrReviewDataOutput` gained `hotspot_files?` (git-intel, 2026-04-08). Interfaces: `PrViolation`, `PrFileInfo`, `PrFileSummary`, `PrReviewDataOutput`, `BlastRadiusEntry` — see source for field lists. Pure functions: `classifyFile`, `generateNarrative`, `buildFileViolationMap`.

**Knowledge Graph types** (`src/graph/kg-types.ts`):
- `FileMetrics` — `{ in_degree, out_degree, is_hub, in_cycle, cycle_peers, layer, layer_violation_count, layer_violations, impact_score }`
- `FileRow` gained `community_id?: number | null` (schema v5)

**KgQuery** (`src/graph/kg-query.ts`) — key exports: `computeImpactScore`, `computeFileInsightMaps(db)` (batch helper — call once per request), `KgQuery.getFileMetrics`, `KgQuery.getSubgraph`, `KgQuery.getKgFreshnessMs` — updated ADR-005 2026-04-01

**Git Intelligence Layer** (`src/features/knowledge-graph/git-intel/`) — added 2026-04-08 (Phase 1):
<!-- last-updated: 2026-04-08 (git-intel Phase 1: types, config, parser, scorer, detector, pipeline) -->
- `git-intel-types.ts` — `GitCommitRecord`, `ChurnEntry`, `CoChangePair`, `HotspotRow`, `CoChangeRow`, `HotspotScoreOutput`, `CoChangePartner`
- `git-intel-config.ts` — `GitIntelConfig`, `DEFAULT_GIT_INTEL_CONFIG`, `isExcluded(filePath, patterns)`
- `git-log-parser.ts` — `parseGitLog(stdout): GitCommitRecord[]` — pure, never throws
- `hotspot-scorer.ts` — `computeChurn`, `computePercentiles`, `buildHotspotRows`, `persistHotspots`, `getComplexityMap`
- `co-change-detector.ts` — `computeCoChangePairs`, `persistCoChangeEdges`
- `git-intel-pipeline.ts` — `runGitIntelPipeline` (full orchestration in single `db.transaction()`), `ensureGitIntelFresh` (no-op when fresh), `computeGitIntel` (standalone entry point)

**`store-summaries.ts`** — DB-only write since ADR-005 2026-04-01; `loadSummariesFile` and `flattenSummaries` removed; `inferLanguageFromExtension` exported

**`CANON_FILES` constants** (`src/shared/constants.ts`) — `GRAPH_DATA`, `REVERSE_DEPS`, `SUMMARIES` removed (ADR-005 2026-04-01); remaining: `CONFIG`, `KNOWLEDGE_DB`, `ORCHESTRATION_DB`, `DRIFT_DB`

**Principle parser/matcher** (`src/shared/parser.ts`, `src/shared/matcher.ts`) — updated 2026-05-02:
- `PrincipleScope.tags?: string[]` — optional computed tags for KG-tag-based matching
- `matchPrinciples` uses OR semantics: matches if layers OR `scope.tags` intersect `computed_tags`
- `matchesScopeTags(principle, computedTags)` — new export

**`get-principles` tool** — loads KG computed tags via `loadKgFileData` and passes `computed_tags` to `matchPrinciples`; updated 2026-05-02

**`get-file-context` tool** — `FileContextOutput` includes: `file_path`, `layer`, `content`, `imports`, `imported_by`, `exports`, `violation_count`, `last_verdict`, `summary`, `violations`, `imports_by_layer`, `imported_by_layer`, `layer_stack`, `role`, `shape`, `project_max_impact`, `graph_metrics?`, `entities?`, `blast_radius?`, `hotspot_score?`, `co_change_partners?`, `computed_tags?`; `shape` derived by `deriveShape(metrics)` — updated 2026-05-02

**`graph_query` tool** — entity results now include `computed_tags?`; new optional `min_confidence?` param; updated 2026-05-02

**Principles — Batch** (`get-principles.ts`) — `getPrinciplesBatch(input, projectDir, pluginDir)` deduplicates across files; returns `GetPrinciplesBatchOutput` with `principles[]`, `total_matched`, `total_in_canon`, `graph_context_by_file` — added 2026-04-30

**Tools with MCP App UIs** (each has its own `ui://canon/*` resource):

| Tool | UI Resource | Purpose |
|------|-------------|---------|
| `show_pr_impact` | `ui://canon/pr-review` | PR Review — change analysis (always), blast radius, hotspots, violations, subgraph (when stored review exists) |
| `codebase_graph` | `ui://canon/codebase-graph` | Interactive dependency graph with compliance overlay |
| `get_file_context` | `ui://canon/file-context` | File dependencies, entities, blast radius, metrics |

**Composite context tool:**

| Tool | Purpose |
|------|---------|
| `get_context` | Batch context for multiple files — composes `getPrinciplesBatch`, `getFileContext` (per-file), `getDriftReport`, `graphQuery` in a single call; `include` param gates sections (default: all) |

**`get_context` tool** (`src/app/register-knowledge.ts`) — input: `file_paths: string[]`, `include?: Array<"principles"|"file_context"|"drift"|"graph">`; returns sections keyed by include param; `file_context` errors propagated fail-closed; graph query failures skipped gracefully — added 2026-04-30

**Text-only principle/review tools:**

| Tool | Purpose |
|------|---------|
| `get_principles` | Find applicable principles for context (file, layer, task) |
| `list_principles` | Browse principle index (metadata only) |
| `review_code` | Surface principles for code review + code content |
| `report` | Log reviews (drift tracking) |
| `store_summaries` | Persist file summaries to SQLite KG DB |
| `get_drift_report` | Full drift report — compliance rates, most violated principles, hotspot directories, trend, recommendations, PR reviews |
| `get_compliance` | Compliance stats for a specific principle — violation counts, rate, trend, weekly history |
| `graph_query` | Query codebase knowledge graph — callers, callees, blast radius, dead code, search |
| `store_pr_review` | Store a PR review result for drift tracking |

**`capture_transcript` tool** — best-effort; reads CC agent JSONL, transforms to Canon `TranscriptEntry[]`, writes to `{workspace}/transcripts/`; returns warning (never error) when source not found — added 2026-04-26 (NF-12)

**`resolve_after_consultations` tool** — pure resolution; reads `flow.states[state_id].consultations.after`; returns `ConsultationPromptEntry[]` for orchestrator to spawn; call after last wave before `report_result` — added 2026-03-26

**`resolve_wave_event` tool** — resolves pending wave event (apply/reject); emits `wave_event_resolved` on event bus; acquires board lock for full duration — added 2026-03-26

**Event bus** (`src/orchestration/events.ts`) — `FlowEventType` includes `"wave_event_resolved"` and `"agent_activity"`

**Gate runner** (`src/orchestration/gate-runner.ts`):
- `normalizeGates(stateDef, flow, cwd, boardState?)` — 3-tier priority: direct `gates[]` > named `gate` ref > `discovered_gates[]`
- `runGates` / `runGate` — **fail-closed**: unresolved gate name returns `{ passed: false }` (changed from fail-open 2026-03-26)

**Contract checker** (`src/orchestration/contract-checker.ts`) — assertion types: `file_exists`, `file_changed`, `pattern_match`, `no_pattern`, `bash_check`; `bash_check` denylist: `rm`, `sudo`, `curl`, `wget`, `chmod`, `chown`, `mkfs`, `dd` — added 2026-03-26

**Flow schema types** (`src/orchestration/flow-schema.ts`) — key types: `GateResult`, `DiscoveredGate`, `PostconditionAssertion`, `PostconditionResult`, `ViolationSeverities`, `TestResults`, `WavePolicy`, `TypedParam`, `FragmentParamValue`; `StateDefinitionSchema` is a `z.discriminatedUnion` with five per-type schemas (`SingleState`, `WaveState`, `ParallelState`, `ParallelPerState`, `TerminalState`); `StateMetricsSchema` includes 7 optional contract-checker fields and 7 optional agent-performance fields — updated through 2026-04-01

**Analytics** — `computeAnalytics(entries: FlowRunEntry[])` aggregates gate/postcondition pass rates; `FlowRunEntry` optional fields: `gate_pass_rate`, `postcondition_pass_rate`, `total_violations`, `total_test_results`, `total_files_changed` — added 2026-03-26

**`report_result` tool** — optional quality signal fields: `gate_results?`, `postcondition_results?`, `violation_count?`, `violation_severities?`, `test_results?`, `files_changed?`; discovery fields: `discovered_gates?`, `discovered_postconditions?` (accumulate across calls); `revision_count` auto-computed — updated 2026-03-26

**Parallel transitions** (`src/orchestration/transitions.ts`) — `isRoleOptional(entry)` exported; `aggregateParallelPerResults(results, optionalRoles?)` excludes optional roles from blocking/cannot_fix determination — updated 2026-03-26

**Orchestration harness tools:**

| Tool | Purpose |
|------|---------|
| `init_workspace` | Create or resume a workspace; creates build worktree at `{workspace}/worktree` on `canon/{slug}` branch; optional `preflight: true` checks git status, stale sessions, file claims; resume checks `{workspace}/worktree` first with legacy fallback |
| `write_plan_index` | Write structured `INDEX.md` for wave execution; validates task IDs, wave ≥ 1, no duplicates — added 2026-04-01 |
| `drive_flow` | Drive flow state machine for a single state; returns `SpawnRequest` or `HitlBreakpoint`; `{ action: "done" }` includes `learn_gate_passed?` |
| `update_board` | Mutate board state (skip_state, block, unblock, complete_flow, set_wave_progress, set_metadata); `complete_flow` releases file claims and aggregates analytics |
| `report_result` | Record agent result and evaluate transitions; `progress_line` appends to progress.md server-side |
| `post_message` | Post a message to a workspace channel (unified messaging) |
| `get_messages` | Read messages from a workspace channel; supports `include_events` for wave events |
| `inject_wave_event` | Inject user events into running wave execution |
| `resolve_wave_event` | Resolve a pending wave event (apply or reject) |
| `resolve_after_consultations` | Resolve "after" consultation prompts; call after last wave, before `report_result` |
| `record_agent_metrics` | Record performance counters (`tool_calls`, `orientation_calls`, `turns`) into execution state metrics — added 2026-04-01 (ADR-003a) |
| `post_event` | Structured activity logging; stores `agent_activity` event in execution store — added 2026-04-07 |
| `batch_log_steps` | Log multiple steps in one journal read-modify-write; validates all entries upfront; runs transcript captures in parallel for completed entries — added 2026-04-30 |
| `capture_transcript` | Best-effort transcript capture from CC agent JSONL; writes to `{workspace}/transcripts/` — added 2026-04-26 (NF-12) |

**Config utilities** (`src/shared/lib/config.ts`):
- `buildLayerInferrer(mappings)` — supports glob patterns in addition to plain directory name segments
- `loadLayerMappingsStrict(projectDir)` — throws if no layer mappings configured
- `loadGraphCompositionConfig(projectDir)` — reads `config.graph.composition`; returns typed config with defaults

**Worktree settings injection** (`src/features/prompt-pipeline/services/worktree-settings.ts`) — `injectWorktreeSettings(worktreePath, tools)` atomically writes `.claude/settings.local.json`; returns `false` on failure without throwing; failure never blocks spawn — added 2026-04-08

**`injectSettingsIntoRequests`** — called in all three spawn paths before returning `{ action: "spawn" }`; sequential for error isolation — added 2026-04-08

**Agent Provenance** (`src/shared/lib/commit-trailers.ts`, `src/shared/lib/file-claims.ts`) — `formatCommitTrailers(opts: TrailerOpts)`, `buildCommitMessage(subject, body, trailerOpts)`; `ClaimsFile` persisted to `.canon/claims.json`; `readClaims`, `registerClaims`, `releaseClaims`, `checkClaimOverlaps` — added 2026-04-09
<!-- last-updated: 2026-04-09 (agent provenance system: commit trailers + file claims) -->

## Dependencies
<!-- last-updated: 2026-05-02 (@anthropic-ai/sdk removed) -->

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | MCP server/client implementation |
| `zod` | Runtime schema validation |
| `gray-matter` | YAML frontmatter parsing in `parser.ts` (replaced hand-rolled parser 2026-03-26) |
| `tsx` | TypeScript execution (dev) |
| `vitest` | Unit testing (dev) |
| ~~`@anthropic-ai/sdk`~~ | ~~LLM API client~~ — removed 2026-05-02 (added then removed; no LLM calls in MCP tools) |

## Invariants
<!-- last-updated: 2026-04-09 (concurrency invariants added: optimistic locking, SQLITE_BUSY retry, atomic board sync) -->

- **ADR-002 subprocess isolation**: Only files in `src/platform/adapters/` may import `node:child_process`; all `features/` and `orchestration/` code must use adapter functions (`gitExec`, `gitExecAsync`, `runShell`) — added 2026-03-31
- **ADR-002 ToolResult contract**: Tools return `ToolResult<T>` for all expected error conditions; unexpected errors are caught by `wrapHandler` and returned as `UNEXPECTED` `CanonToolError`; tools never throw for expected conditions — added 2026-03-31
- **ADR-002 security boundary**: `git-adapter.ts` never sets `shell: true`; `process-adapter.ts` sets `shell: true` for arbitrary shell commands; the two adapters must not be interchanged for git operations — added 2026-03-31
- All subprocess adapters enforce a default 30s timeout; callers may pass an explicit timeout override — added 2026-03-31
- All data persists to `.canon/` directory (reviews.jsonl, knowledge-graph.db, orchestration.db, drift.db); `graph-data.json`, `summaries.json`, `reverse-deps.json` no longer written (removed ADR-005 2026-04-01)
- JSONL files auto-rotate when exceeding size limits
- Atomic file writes prevent corruption on concurrent access
- `CANON_PROJECT_DIR` env var sets project root (defaults to `process.cwd()`)
- `CANON_PLUGIN_DIR` env var sets plugin directory (defaults to parent of mcp-server)
- Workspace subdirectories created by `initWorkspace`: `research/`, `decisions/`, `plans/`, `reviews/` — `notes/` is NOT created (removed 2026-03-24)
- `progress.md` is seeded at workspace creation and appended server-side by `report_result` via its `progress_line` parameter; agents treat it as read-only
- Gate runner is **fail-closed**: a named gate that cannot be resolved returns `{ passed: false }` — never silently passes (changed from fail-open 2026-03-26)
- `bash_check` postconditions are filtered against a denylist before shell execution: `rm`, `sudo`, `curl`, `wget`, `chmod`, `chown`, `mkfs`, `dd`; blocked commands return `passed: false`
- All new schema fields in `flow-schema.ts` MUST be `.optional()` — `BoardSchema.parse()` must not throw on existing workspace `board.json` files
- `discovered_gates` and `discovered_postconditions` on `BoardStateEntry` accumulate across multiple `report_result` calls (append, not replace)
- `EffectTypeSchema` switch in `effects.ts` has no `default` case — TypeScript enforces exhaustiveness when new effect types are added
- **ADR-004 hard-blocking validation**: `loadAndResolveFlow` throws on spawn coverage errors or unresolved refs; callers must not expect an `errors` field on the return value — added 2026-04-01
- **ADR-004 SQL stuck detection**: `ExecutionStore.recordIterationResult` must be called after each iteration before `isStuck` is queried; `isStuck` returns `false` (not stuck) when fewer than 2 results exist — added 2026-04-01
- **ADR-004 fragment typed params**: `state_id`-typed params in fragment `with:` maps are validated against real state IDs at load time; supplying a non-existent state ID is a hard error — added 2026-04-01
- **ADR-005 KG sole data source**: `graph/query.ts` and `graph/view-materializer.ts` deleted; SQLite KG (via `KgQuery`/`KgStore`) is the exclusive store for graph and summary data; no JSON artifacts are written for graph or summary data — added 2026-04-01
- **ADR-005 computeFileInsightMaps call pattern**: call `computeFileInsightMaps(db)` once per request and pass the `FileInsightMaps` result into `KgQuery.getFileMetrics()`; do not call `getFileMetrics()` in a loop without pre-computing insight maps — added 2026-04-01
- **worktree_path is the sole isolation signal** (2026-04-08; updated 2026-04-27): `SpawnPromptEntry` no longer carries `isolation`; `resolveToolProfile` permission_mode fallback uses `worktreePath ? "auto" : "prompt"`; wave SpawnRequests with `worktree_path` are emitted with `isolation: "none"` — Canon owns the worktree lifecycle; build worktrees created at `{workspace}/worktree` (was `.canon/worktrees/{slug}`); `tryResumeWorkspace` checks new path first with legacy fallback
- **auto-approve settings injection** (2026-04-08): `injectSettingsIntoRequests` called in all three spawn paths; conditional on `req.permission_mode === "auto"` AND `req.worktree_path` AND `req.tools`; failure returns `false` and never blocks spawn
- **file claims non-blocking** (2026-04-09): all claim operations wrapped in try/catch; claim failures never block workflow execution; overlap warnings are advisory strings in board metadata
- **file claims lifecycle** (2026-04-09): registered by `update_board set_metadata`, checked by `init_workspace` preflight, released by `update_board complete_flow`; do not call `file-claims.ts` functions directly outside these three integration points
- **optimistic locking on all board mutations** (2026-04-09): all `update_board` handlers read `version` once via `store.getVersion()` and pass to `store.updateExecutionVersioned()`; stale version returns `BOARD_LOCKED` (recoverable: true); do not use `store.updateExecution()` in handler code
- **syncBoardToStore is atomic** (2026-04-09): all writes wrapped in single `store.transaction()`; version conflict aborts entire sync; callers must check `result.ok`
- **SQLITE_BUSY is transparent to callers** (2026-04-09): `store.transaction()` retries via `withRetry`; callers do not need to handle `SQLITE_BUSY` themselves

## Development
<!-- last-updated: 2026-03-22 -->

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript (tsc → dist/)
npm start            # Run server with tsx (hot TypeScript execution)
npm test             # Run vitest unit tests
```

Node.js 24+ required.
