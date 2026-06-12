# Canon MCP Server — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
TypeScript MCP (Model Context Protocol) server that provides tools for managing, enforcing, and tracking engineering principles across a codebase.

## Architecture
<!-- last-updated: 2026-06-10 -->

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
│   ├── loops/            # list_loops, get_loop_definition — loop-definition schema, registry loader + read-only-shell carve-out (Phase B current)
│   ├── orchestration/    # Orchestration runtime: init_workspace, finalize_workspace, log_step, record_agent_metrics, all orchestration tools
│   ├── pr-review/        # show_pr_impact, review_code, store_pr_review, present_review
│   ├── principles/       # get_principles, list_principles, get_compliance
│   └── routines/         # list_routines, get_routine, sync_routines — managed routine artifact class (shared/routine.ts loader, services/, tools/, registered via register-routines.ts)
├── graph/                # Legacy graph scanner — import/export parsing (being migrated to features/knowledge-graph)
├── orchestration/        # Legacy orchestration — flow parser, execution store, schemas (being migrated to features/orchestration)
├── platform/             # Infrastructure: adapters (git, process), job manager, workers, storage
├── shared/               # Shared kernel: constants, parser, matcher, schema, lib/ utilities
├── tests/                # Cross-cutting test helpers
└── ui/                   # HTML artifact rendering — renderer agent utilities and design system snippets (Svelte app removed 2026-05-20)
    └── snippets/         # HTML/CSS component recipes; DESIGN-SYSTEM.md is authoritative reference
```

**Key subsystems (directory docs):**
- **Boot / server scope** (`app/`) — `boot.sh` launcher, per-connection scope, per-project `JobManager`. See `src/app/.claude/CLAUDE.md`.
- **HTTP auth + sessions** (`app/mcp-http/`) — token auth, per-session McpServer, scope handshake, idle reaper. See `src/app/mcp-http/.claude/CLAUDE.md`.
- **Drift storage** (`platform/storage/drift/`) — SQLite drift DB, DAO inventory, confidence-decay adapters. See `src/platform/storage/drift/.claude/CLAUDE.md`.
- **Orchestration tools** (`features/orchestration/`) — workspace lifecycle, artifact writing, agent skill resolution. See `src/features/orchestration/.claude/CLAUDE.md`.
- **Diagnostics tools** (`features/diagnostics/`) — drift reports, wiki lint, signal compiler, area memory, doc freshness. See `src/features/diagnostics/.claude/CLAUDE.md`.
- **History tools + RecurringViolation types** → `src/features/history/.claude/CLAUDE.md`.
- **History services** (`features/history/services/`) — cross-run analysis, craft drift, judge-weight, consolidate-policy. See `src/features/history/services/.claude/CLAUDE.md`.
- **Loop tools** (`features/loops/`) — loop-definition schema, registry loader, list_loops/get_loop_definition. See `src/features/loops/.claude/CLAUDE.md`.
- **PR review tools + PR Review Data service** → `src/features/pr-review/.claude/CLAUDE.md`.
- **Shared kernel** (`shared/`) — constants, matcher, schema, lib/ utilities. See `src/shared/.claude/CLAUDE.md`.
- **UI snippets** (`ui/snippets/`) — force-graph, file-detail-card, renderer helpers. See `src/ui/snippets/.claude/CLAUDE.md`.
- **Dependency graph** (`graph/`, `features/knowledge-graph/`) — SQLite KG via `KgQuery`/`KgStore`; scans imports/exports + doc references; computes in/out degree, detects cycles; lazy commit-granularity freshness via `ensureGraphFresh` (structural) and `ensureGitIntelFresh` (git signals); `graph/query.ts` and `graph/view-materializer.ts` deleted (ADR-005, 2026-04-01); `doc` node kind added 2026-06-08 for `docs/**/*.md` (excl. `docs/explore/`), `mcp-server/src/domains/*/README.md`, and `CONTEXT.md`; `doc:references` edge type persisted via `resolveImports` (conservative backtick-path grammar + link URLs); metric queries (`in_degree`, `out_degree`, adjacency, hub/impact) pinned to `edge_type='imports'`; blast-radius and subgraph queries left inclusive; `CANON_SCAN_DIRS` extended with `"docs"` and `"mcp-server/src/domains"`, `CANON_SCAN_FILES` added for root-level singletons (`CONTEXT.md`); **project-local language overlay** (`graph/kg-language-overlay.ts`) — fail-open loader reads `.canon/kg-languages/*.json` + validates paired `.canon/grammars/<wasm>`; `loadOverlayConfigs(projectDir, builtinIds)` returns `LanguageConfig[]`, skips+warns on any error; built-in ids win on collision; `mergeOverlayIntoConfigs(configs)` merges into `LANGUAGE_CONFIGS`/`EXT_TO_CONFIG`; `registerOverlayAdapters(configs)` wires adapters in `kg-adapter-registry.ts`; `initParsers(projectDir?)` now returns `LanguageConfig[]` (changed from `void`) and accepts optional `projectDir` for overlay loading — callers must pass result to `registerOverlayAdapters`; `getLanguage(ext)` falls back to overlay language id before `"unknown"`
- **Community / tags** (`graph/kg-community.ts`, `graph/kg-tags.ts`) — Louvain `community_id` + 4-signal tag propagation to `file_tags` table; used by `get-principles` and `get-file-context`; `kg-tags.ts` exports `VALID_COMPUTED_TAGS` (deduped union of directory + import + graph-role tags, 15 values — static const, no I/O) for vocabulary validation in `wiki_lint`
- **Principle matching** (`shared/matcher.ts`) — OR semantics: matches if layers OR scope.tags intersect

## Contracts
<!-- last-updated: 2026-06-09 -->

> **Subsystem detail by directory:**
> - App (boot.sh, server-state, http-server, findAnchorDir) → `src/app/.claude/CLAUDE.md`
> - Drift DB (DAOs, schema, confidence adapters) → `src/platform/storage/drift/.claude/CLAUDE.md`
> - Orchestration tools (init_workspace, write_review, write_implementation_summary, resolve_agent_skills, etc.) → `src/features/orchestration/.claude/CLAUDE.md`
> - Diagnostics services (wiki_lint, signal compiler, area memory, doc freshness, craft audit) → `src/features/diagnostics/.claude/CLAUDE.md`
> - History tools + RecurringViolation types → `src/features/history/.claude/CLAUDE.md`
> - History services (judge-weight, consolidate-policy, cross-run analysis, craft drift) → `src/features/history/services/.claude/CLAUDE.md`
> - PR review tools + PR Review Data service → `src/features/pr-review/.claude/CLAUDE.md`

**Tool error types** (`src/shared/lib/tool-result.ts`) — ADR-002: `ToolResult<T>` is a discriminated union `({ ok: true } & T) | CanonToolError`; all tools return this (never throw for expected errors). `CanonErrorCode` has 9 values; unexpected throws caught as `UNEXPECTED` by `gatedWrapHandler` or `wrapHandler<T>`.

**`wrapHandler` extra forwarding** (`src/shared/lib/wrap-handler.ts`) — inner handler optionally receives `extra: RequestHandlerExtra` as second arg; backward compatible. Updated 2026-06-01.

**Subprocess adapters** (`src/platform/adapters/`) — ADR-002; only files here may import `node:child_process`. Three adapters: `git-adapter.ts` (sync, shell never true, 30s default), `git-adapter-async.ts` (async, never rejects), `process-adapter.ts` (shell: true, 512KB maxBuffer).

**Flow parser** (`src/orchestration/flow-parser.ts`) — ADR-004: `loadAndResolveFlow` throws on hard validation errors. Exports: `validateSpawnCoverage`, `analyzeReachability`, `checkUnresolvedRefs`, `validateStateIdParams`, `VIRTUAL_SINKS`, `RUNTIME_VARIABLES`.

**Execution store** (`src/domains/workspaces/execution-store.ts`) — optimistic locking via `updateExecutionVersioned(fields, expectedVersion)` (returns `{ updated: true|false }`); `SQLITE_BUSY` retry via `withRetry`; all board mutations use `updateExecutionVersioned`; `isStuck` is SQL-based. SCHEMA_VERSION = '11'.

**KG schema** (`src/graph/kg-schema.ts`) — SCHEMA_VERSION = "5"; v5 adds `community_id`, `file_tags`, `hotspot_scores`, `co_change_edges`. Freshness marker in `meta` table under key `graph_head_commit`; stamped on full-project runs only — scoped runs skip orphan pruning and marker stamping.

**Execution schema** (`src/domains/workspaces/execution-schema.ts`) — SCHEMA_VERSION = '11'; `runMigrations(db)` idempotent.

**Board sync** (`src/domains/board/board-sync.ts`) — `syncBoardToStore` returns `SyncResult` (`{ ok: true; newVersion } | { ok: false; error: "version_conflict" }`); single transaction; callers must check `result.ok`.

**Fragment param syntax** — typed params (`param_name: { type: state_id|string|number|boolean, default? }`) replace null-marker `~`; backward compat retained; `state_id` params validated at load time.

**KgQuery** (`src/graph/kg-query.ts`) — call `computeFileInsightMaps(db)` once per request, then pass result into `getFileMetrics()`; never call `getFileMetrics()` in a loop without pre-computing. Other methods: `computeImpactScore`, `getSubgraph`.

**KgStore** (`src/graph/kg-store.ts`) — `getMeta(key)` / `setMeta(key, value)` (upsert), `getAllFilePaths()`; used by `runPipeline` for freshness marker + orphan prune.

**Structural KG freshness** (`src/features/knowledge-graph/ensure-graph-fresh.ts`) — `ensureGraphFresh(projectDir, opts?)`: async, fail-open; no-op when marker matches HEAD; orphan pruning on full-project runs only; concurrent callers share one in-process single-flight run per DB (fail-open). Sibling: `ensureGitIntelFresh`. Called before `graph_query`, `semantic_search`, and inside `getFileContext`.

**`get-file-context`** — surfaces `computed_tags`, `hotspot_score`, `co_change_partners`; calls `ensureGraphFresh`; KG loaders extracted to `get-file-context-kg.ts`, re-exported from `get-file-context.ts`.

**`show_pr_impact`** — returns `UnifiedPrOutput` with `has_review` boolean; `status` always `"ok"`; resource URI: `ui://canon/pr-review`

**`get_drift_report`** — `pr_reviews` field uses `ReviewEntry[]`; renders `### Documentation freshness` section (omitted when empty), sorted by staleness descending with `[confidence: TIER]` per doc.

**`get_compliance` tool** — returns `confidence: ConfidenceAnnotation`; uses per-principle confidence from `analyzeDrift` when available, falls back to drift confidence adapter.

**`present_artifact` MCP tool** — `html` parameter required; serves HTML via HTTP server; returns `{ url: string }` fire-and-forget.

**`present_review` MCP tool** — `showPrImpact` → read pre-rendered `review.html` → `presentArtifact`; `INVALID_INPUT` when `review.html` missing or `has_review === false`.

**`store-summaries`** — DB-only write path (JSON removed ADR-005); `inferLanguageFromExtension` maps extensions to language strings.

**`CANON_FILES` constants** — remaining keys: `CONFIG`, `KNOWLEDGE_DB`, `ORCHESTRATION_DB`, `DRIFT_DB`.

**Wiki lint services** (`src/features/diagnostics/services/wiki-lint.ts`) — 7 checks plus `checkGlossaryConsistency` in sibling `wiki-lint-glossary.ts`, `checkIndexDrift` in `index-inventory.ts`, and `checkMisroutedPrinciples`/`checkDuplicateTitles` in new sibling `wiki-lint-principle-tier.ts` (10 DEFAULT_CHECKS + `index_drift` = 11 total `CheckName` values; `WIKI_LINT_CHECK_NAMES` const exported from `register-knowledge.ts` with schema-parity enforcement): `checkContradictions`, `checkOrphanPrinciples`, `checkStaleRefs`, `checkMissingExamples`, `checkCitedPaths`, `checkScopeLayers`, `checkScopeTags`, `checkGlossaryConsistency`, `checkIndexDrift`, `checkMisroutedPrinciples`, `checkDuplicateTitles`; `wiki-lint-principle-tier.ts` is a pure sibling split per `line-limit-split-into-siblings`; both `checkScopeLayers` and `checkScopeTags` guard scalar (non-array) input with a "must be a YAML list" finding; `stale_refs` and `cited_paths` now include the DDD doc set (`docs/**/*.md` excl. `docs/explore/`, `mcp-server/src/domains/*/README.md`, `CONTEXT.md`); `checkGlossaryConsistency` parses CONTEXT.md H2 headings, flags exact-duplicate and naked-vs-qualified collisions; see `src/features/diagnostics/.claude/CLAUDE.md` for `CheckName` details.

**Agent Provenance** (`src/shared/lib/commit-trailers.ts`, `src/shared/lib/file-claims.ts`) — `formatCommitTrailers`/`buildCommitMessage` produce Canon trailer blocks; `ClaimsFile` persisted to `.canon/claims.json`; 24h-TTL file ownership claims. See `src/shared/.claude/CLAUDE.md`.

**Confidence engine** (`src/shared/lib/confidence.ts`) — `deriveTier(score, sampleSize)` returns `"insufficient"` for sparse data; `computeConfidenceAnnotation(inputs[])` returns zero-confidence for empty input. Added 2026-05-25.

**Correction Reader** (`features/orchestration/services/correction-reader.ts`) — `readCorrections(projectDir, filePaths?, maxAge?)` → `{ ok: true; records[] } | { ok: false; error }`; ENOENT → `ok:true, records:[]`; updated 2026-05-25.

**Shared libs** (`src/shared/lib/`) — `token-budget.ts`: `fitWithinBudget(items, budget)` greedy selector by priority; `violation-patterns.ts`: 8 extracted pure functions for violation analysis; `config.ts`: `buildLayerInferrer` supports globs; `DEFAULT_LAYER_MAPPINGS` has `hooks: ["hooks/**"]` before `shared` so `hooks/lib/*.sh` resolves to `hooks` layer (2026-05-29); `VALID_LAYERS = Object.keys(DEFAULT_LAYER_MAPPINGS)` — derived valid `scope.layers` set (2026-06-05). See `src/shared/.claude/CLAUDE.md`.

**Flow schema** (`flow-schema.ts`) — `StateDefinitionSchema` is a `z.discriminatedUnion` with 5 type schemas; all new fields MUST be `.optional()`; `WavePolicy` defaults: isolation=worktree, merge=sequential, on_conflict=hitl.

**`computeAnalytics(projectDir)`** (`platform/storage/drift/analytics.ts`) — async wrapper over `DriftDb.computeAnalytics()`; returns `FlowAnalytics`; entries without gate data excluded from `avg_gate_pass_rate`.

**Step journaling** — `log_step` / `batch_log_steps` record step completion in `journal.json`; quality signals and discovery fields accumulate across steps (append, not replace).

**Orchestration harness tools:**

| Tool | Purpose |
|------|---------|
| `open_artifact` | Open an HTML artifact from `${workspace}/artifacts/` in browser; reads file, registers with HTTP server, opens fire-and-forget; returns `{ url }`; path traversal blocked; `UNEXPECTED` when HTTP server not running. Added 2026-05-25. |
| `init_workspace` | Create or resume a workspace; seeds `progress.md`; creates build worktree at `{workspace}/worktree` on `canon/{slug}` branch (returned as `worktree_path`/`worktree_branch`); `preflight: true` checks git status, stale sessions, file claims (non-blocking); when preflight issues found, returns `workspace: ""` + `candidate_workspace` + `preflight_issues` — callers must check `preflight_issues`; resume checks `{workspace}/worktree` first, then legacy `.canon/worktrees/{slug}`; `expectedTask` mismatch blocks resume (slug-collision guard) |
| `write_plan_index` | Write a structured `INDEX.md` for wave execution to `{workspace}/plans/{slug}/INDEX.md`; validates task IDs (`/^[a-zA-Z0-9_-]+$/`), wave ≥ 1, no duplicates; returns `{ path, task_count, wave_count }` — added 2026-04-01 |
| `finalize_workspace` | Close the flow: verifies journal completeness, releases file claims for the workflow slug, aggregates gate/postcondition/violation/test metrics into `FlowRunEntry`; populates `diff_stat` + `total_files_changed` via `tryComputeDiffStats` at finalize time (single-rev worktree-state measurement: committed + staged + unstaged + untracked; best-effort; fields absent when unobtainable; `total_files_changed: 0` on empty diff) <!-- last-updated: 2026-06-05 --> |
| `log_step` | Record a single step execution (status, artifacts, agent ID) in `journal.json` |
| `record_agent_metrics` | Record performance counters into execution state; `INVALID_INPUT` if no fields; `WORKSPACE_NOT_FOUND` if state absent — ADR-003a 2026-04-01 |
| `post_event` | Structured activity logging via `appendEvent`; returns `{ ok: true }` or error codes — added 2026-04-07 |
| `batch_log_steps` | Log multiple steps in one journal read-modify-write; fail-closed (batch rejected if any `step_id` empty); parallel transcript capture for completed entries with `agent_id` — added 2026-04-30 |
| `capture_transcript` | Best-effort transcript capture; reads CC agent JSONL, writes `TranscriptEntry[]` to `{workspace}/transcripts/`; warning (never error) when source not found; `source_path` primary, `agent_id` glob fallback; `persist_path: true` records path for `get_transcript` (fail-open) — added 2026-04-26, updated 2026-05-30 |
| `compute_autonomy_tier` | autonomous/light-touch/supervised from build history + blast radius + compliance; fail-safe: defaults to supervised on error; logs `auto_decision`; returns `{ tier, score, reasoning, signals_used }` |
| `get_next_escalation_strategy` | Next fallback strategy on agent failure; cascade: add_primer → increase_budget → escalate_model → narrow_scope → hitl; 2-minute cumulative timeout; `skip_strategies` per-flow config; logs `auto_decision`; returns `EscalationResult` with `strategy`, `is_terminal` |
| `reconcile_workspace` | Cliff detection; `{ workspace, emit_telemetry?, source?, projectDir? }`; returns `{ incomplete_steps[], needs_recovery }`; flags `started`/`planned` steps with missing or partial-skeleton artifacts; `completed` and empty-`artifacts_expected` planned steps never flagged; `emit_telemetry: true` appends fail-open `cliff_detected` event to orchestration.db AND upserts rows to drift.db `cliff_events` table via `CliffEventsDao` (dual fail-open write-through; `projectDir` required for drift.db write, injected by `register-journal.ts` via `resolveScope`); `WORKSPACE_NOT_FOUND` when journal absent — added 2026-05-29, dual-write 2026-06-08 |

**Text-only principle/review tools:**

| Tool | Purpose |
|------|---------|
| `get_principles` | Find applicable principles for context (file, layer, task) |
| `list_principles` | Browse principle index (metadata only) |
| `review_code` | Surface principles for code review + code content |
| `report` | Log reviews (drift tracking) |
| `store_summaries` | Persist file summaries to SQLite KG DB (DB-only since ADR-005 2026-04-01) |
| `get_drift_report` | Full drift report — compliance rates, most violated principles, hotspot directories, trend, recommendations, PR reviews, doc freshness |
| `get_compliance` | Compliance stats for a specific principle — violation counts, rate, trend, weekly history |
| `wiki_lint` | Lint Canon's own meta-layer artifacts — contradictions, orphan principles, stale file refs, missing examples, cited-path accuracy in `references/**/*.md` and DDD doc set, invalid `scope.layers` values, invalid `scope.tags` values, CONTEXT.md glossary self-consistency, index inventory drift, misrouted principles (`portable:false` in shipped tree), duplicate titles across both principle tiers; optional `checks` array selects subset (default: 10 checks, `index_drift` excluded — pass explicitly to run it); returns `WikiLintOutput` |
| `sync_indexes` | Regenerate sentinel-delimited `## Artifact Inventory` blocks in the 5 sibling artifact-class indexes (`rules/`, `principles/`, `agents/`, `templates/`, `references/`); skips indexes without sentinels; returns `{ synced[], skipped[] }` |
| `graph_query` | Query codebase knowledge graph — callers, callees, blast radius, dead code, search |
| `store_pr_review` | Store a PR review result; accepts optional `craft_profile` (persists one row per distinct subsystem area to `craft_profiles` with `source:"review"`) |
| `get_context` | Batch context for multiple files — composes principles, file_context, drift, graph, signals in one call |

**History tools** (`src/features/history/`):

| Tool | Purpose |
|------|---------|
| `get_build_history` | List archived build runs with metadata |
| `get_historical_artifacts` | Retrieve archived artifacts from a previous build |
| `get_cross_run_analysis` | Cross-run meta-analysis for the learner; includes `craft_drift: CraftDrift` (`by_dimension[]`, `by_area[]`, `profile_count`) and `cliff_events: CliffEventsDimension`; runs fail-open `sweepCliffEvents(project_dir)` before analysis |

**Loop tools** (`src/features/loops/`): <!-- last-updated: 2026-06-09 -->

| Tool | Purpose |
|------|---------|
| `list_loops` | Load all loops from `loops/` registry; filters by `status:active`, `lifecycle_hook`, `tier`; always returns `invalid[]` alongside valid |
| `get_loop_definition` | Return a single loop's `LoopDefinition` + markdown body by id; `INVALID_INPUT` when not found |

**Routine tools** (`src/features/routines/`): <!-- last-updated: 2026-06-09 -->

| Tool | Purpose |
|------|---------|
| `list_routines` | List all routines (project-local + plugin, project-local takes precedence); returns name, status, binding, trigger |
| `get_routine` | Retrieve a single routine by name; returns frontmatter + body; `INVALID_INPUT` when not found |
| `sync_routines` | Sync routine state to `.canon/routines/`; returns drift summary |

## Dependencies
<!-- last-updated: 2026-05-16 -->

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | MCP server/client implementation |
| `zod` | Runtime schema validation |
| `gray-matter` | YAML frontmatter parsing in `parser.ts` |
| `tsx` | TypeScript execution (runtime dependency — server launched via boot.sh → tsx) |
| `vitest` | Unit testing (dev) |

## Invariants
<!-- last-updated: 2026-05-27 -->

- **ADR-002 subprocess isolation**: Only files in `src/platform/adapters/` may import `node:child_process`; all `features/` and `orchestration/` code must use adapter functions (`gitExec`, `gitExecAsync`, `runShell`) — added 2026-03-31
- **ADR-002 ToolResult contract**: Tools return `ToolResult<T>` for all expected error conditions; unexpected errors caught as `UNEXPECTED` by `gatedWrapHandler` or `wrapHandler`; tools never throw for expected conditions — added 2026-03-31
- **ADR-002 security boundary**: `git-adapter.ts` never sets `shell: true`; `process-adapter.ts` sets `shell: true`; the two adapters must not be interchanged for git operations — added 2026-03-31
- All subprocess adapters enforce a default 30s timeout; callers may pass an explicit timeout override — added 2026-03-31
- All data persists to `.canon/` directory (reviews.jsonl, knowledge-graph.db, orchestration.db, drift.db); `graph-data.json`, `summaries.json`, `reverse-deps.json` no longer written (removed ADR-005 2026-04-01)
- JSONL files auto-rotate when exceeding size limits
- Atomic file writes prevent corruption on concurrent access
- `CANON_PROJECT_DIR` env var sets project root; when unset, cwd fallback resolves to git repo root (`resolveGitRoot`) — ensures `.canon/` lands at repo root even when server starts from a subdirectory
- `CANON_PLUGIN_DIR` env var is validated before use (non-empty, token-free, absolute, marker-dirs present); invalid values fall through to `findAnchorDir` marker-walk; all-miss throws loud (see `src/app/.claude/CLAUDE.md`)
- Workspace subdirectories created by `initWorkspace`: `artifacts/`, `plans/`, `reviews/`, `transcripts/` — `notes/` removed 2026-03-24; `decisions/`, `handoffs/`, `research/` removed 2026-05-25 (never populated by any tool)
- `progress.md` seeded at workspace creation; no tool appends to it server-side; agents treat it as read-only
- Gate runner is **fail-closed**: unresolved gate → `{ passed: false }` — never silently passes (changed from fail-open 2026-03-26)
- `bash_check` postconditions filtered against denylist: `rm`, `sudo`, `curl`, `wget`, `chmod`, `chown`, `mkfs`, `dd`; blocked commands return `passed: false`
- All new schema fields in `flow-schema.ts` MUST be `.optional()` — `BoardSchema.parse()` must not throw on existing `board.json` files
- `discovered_gates` and `discovered_postconditions` accumulate across step-journal calls (append, not replace)
- `EffectTypeSchema` switch in `effects.ts` has no `default` case — TypeScript enforces exhaustiveness when new effect types are added
- **ADR-004 hard-blocking validation**: `loadAndResolveFlow` throws on spawn coverage errors or unresolved refs; callers must not expect an `errors` field — added 2026-04-01
- **ADR-004 SQL stuck detection**: `ExecutionStore.recordIterationResult` must be called after each iteration before `isStuck`; `isStuck` returns `false` when fewer than 2 results exist — added 2026-04-01
- **ADR-004 fragment typed params**: `state_id`-typed params in fragment `with:` maps validated against real state IDs at load time — added 2026-04-01
- **ADR-005 KG sole data source**: SQLite KG (via `KgQuery`/`KgStore`) is the exclusive store; no JSON artifacts written for graph or summary data — added 2026-04-01
- **ADR-005 computeFileInsightMaps call pattern**: call `computeFileInsightMaps(db)` once per request and pass result into `getFileMetrics()`; do not call `getFileMetrics()` in a loop without pre-computing — added 2026-04-01
- **worktree_path is the sole isolation signal** (2026-04-08): `SpawnPromptEntry` no longer carries `isolation`; `resolveToolProfile` uses `worktreePath ? "auto" : "prompt"`; build worktrees created at `{workspace}/worktree` (was `.canon/worktrees/{slug}`); `tryResumeWorkspace` checks new path first with legacy fallback; omit `isolation` from Agent calls (Claude Code's `isolation: "worktree"` auto-merges to calling branch — bypasses Canon lifecycle)
- **auto-approve settings injection** (2026-04-08): `injectSettingsIntoRequests` called in all three spawn paths; conditional on `permission_mode === "auto"` AND `worktree_path` AND `tools`; failure returns `false` and never blocks spawn
- **file claims non-blocking** (2026-04-09): all claim operations wrapped in try/catch; failures never block workflow execution; overlap warnings are advisory strings in `claim_warnings`, not errors
- **file claims lifecycle** (2026-04-09): claims registered via `write_plan_index` and `init_workspace`, checked by `init_workspace` preflight, released by `finalize_workspace`; do not call `file-claims.ts` functions directly from feature code
- **optimistic locking on all board mutations** (2026-04-09): all board-write paths use `store.updateExecutionVersioned()`; stale version returns `BOARD_LOCKED` (recoverable: true); do not use `store.updateExecution()` in handler code
- **syncBoardToStore is atomic** (2026-04-09): all writes in a single `store.transaction()`; partial writes cannot land; version conflict returns `{ ok: false, error: "version_conflict" }`; callers must check `result.ok`
- **SQLITE_BUSY is transparent to callers** (2026-04-09): `store.transaction()` internally retries via `withRetry`; callers do not handle `SQLITE_BUSY`; `withRetry` does not retry other error codes

## Conventions
<!-- last-updated: 2026-05-26 -->

**Recursive filesystem scanners — root threading**: Scanners that exclude paths by relative prefix must thread the original scan root through all recursive calls. Never update the root to the current directory. Pattern: `scanFn(currentDir, rootDir)` where `rootDir` never changes. The bug class (root-drift) is silent — exclusion logic passes at depth 0 and silently fails at depth 1+. See `tools/wiki-lint.ts` (`FindFilesCtx.originalRoot`) and `services/doc-gap-detect.ts` as reference implementations.

## Development
<!-- last-updated: 2026-06-09 -->

```bash
npm install          # Install dependencies
npm run build        # Emit TypeScript declarations only (.d.ts via tsc emitDeclarationOnly; no runnable dist/ produced)
npm start            # Run server via tsx (tsx is a runtime dependency; loaded by boot.sh in production)
npm test             # Run vitest unit tests
```

Node.js 24+ required. Enforced at runtime by `boot.sh` Step 12.5 (fail-closed, actionable error) and declared in `package.json` `engines.node`. No `.tool-versions` pin is shipped — `boot.sh` validates the floor against the user's ambient Node.

**Vitest policy** — `vitest.config.ts` sets `testTimeout: 20000` (20s) and `maxWorkers: 4` project-wide; do not add per-test `timeout` overrides — the config-level policy covers subprocess-heavy suites (git, depcruise, embeddings).

**CI supply-chain gate** — `.github/workflows/ci.yml` runs `npm audit --omit=dev --audit-level=high` after `npm ci`; high+ production-dependency vulnerabilities fail CI.
