# Canon MCP Server — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
TypeScript MCP (Model Context Protocol) server that provides tools for managing, enforcing, and tracking engineering principles across a codebase.

## Architecture
<!-- last-updated: 2026-06-24 -->

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
│   ├── evolution/        # evaluate_candidate (§7 holdout, dual injection ADR-0022/ADR-0025) + attribute_failure (provenance⋈failure join, ADR-0024) + select_mutation_targets (deterministic, no model calls)
│   ├── file-context/     # get_file_context tool
│   ├── history/          # get_build_history, get_historical_artifacts, get_cross_run_analysis tools
│   ├── knowledge-graph/  # graph_query, semantic_search, search_knowledge, codebase_graph, git-intel
│   ├── loops/            # list_loops, get_loop_definition — loop-definition schema, registry loader + read-only-shell carve-out (Phase C current)
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
- **Archive storage** (`platform/storage/archive/`) — build-archive persistence (ADR-0006 relocation from `features/history/services/`): `archiveWorkspace`, `buildRunSummary`, pure extractors, shared archive types. See `src/platform/storage/archive/.claude/CLAUDE.md`.
- **Orchestration tools** (`features/orchestration/`) — workspace lifecycle, artifact writing, agent skill resolution. See `src/features/orchestration/.claude/CLAUDE.md`.
- **Diagnostics tools** (`features/diagnostics/`) — drift reports, wiki lint, signal compiler, area memory, doc freshness. See `src/features/diagnostics/.claude/CLAUDE.md`.
- **Evolution tools** (`features/evolution/`) — `evaluate_candidate` fitness gate (§7 holdout, dual injection ADR-0022/ADR-0025) + `attribute_failure` attribution consumer (provenance⋈failure join, content_hash byte-identity, ADR-0024) + `select_mutation_targets` (deterministic selection, no model calls). See `src/features/evolution/.claude/CLAUDE.md`.
- **History tools + RecurringViolation types** → `src/features/history/.claude/CLAUDE.md`.
- **History services** (`features/history/services/`) — cross-run analysis, craft drift, judge-weight, consolidate-policy. See `src/features/history/services/.claude/CLAUDE.md`.
- **Loop tools** (`features/loops/`) — loop-definition schema, registry loader, list_loops/get_loop_definition. See `src/features/loops/.claude/CLAUDE.md`.
- **PR review tools + PR Review Data service** → `src/features/pr-review/.claude/CLAUDE.md`.
- **Shared kernel** (`shared/`) — constants, matcher, schema, lib/ utilities; overlay trust boundary (`UntrustedText` opaque box + closed-domain validators + linear-time `matchGlob`, ADR-0026/ADR-0027). See `src/shared/.claude/CLAUDE.md`.
- **UI snippets** (`ui/snippets/`) — force-graph, file-detail-card, renderer helpers. See `src/ui/snippets/.claude/CLAUDE.md`.
- **Dependency graph** (`graph/`, `features/knowledge-graph/`) — SQLite KG via `KgQuery`/`KgStore`; scans imports/exports + doc references; computes in/out degree, detects cycles; lazy commit-granularity freshness via `ensureGraphFresh` (structural) and `ensureGitIntelFresh` (git signals); `graph/query.ts` and `graph/view-materializer.ts` deleted (ADR-005, 2026-04-01); `doc` node kind added 2026-06-08 for `docs/**/*.md` (excl. `docs/explore/`), `mcp-server/src/domains/*/README.md`, and `CONTEXT.md`; `doc:references` edge type persisted via `resolveImports` (conservative backtick-path grammar + link URLs); metric queries (`in_degree`, `out_degree`, adjacency, hub/impact) pinned to `edge_type='imports'`; blast-radius and subgraph queries left inclusive; `CANON_SCAN_DIRS` extended with `"docs"` and `"mcp-server/src/domains"`, `CANON_SCAN_FILES` added for root-level singletons (`CONTEXT.md`); **parallel doc-vector index** (`graph/kg-doc-chunker.ts`, `kg-doc-store.ts`, `kg-doc-ingest.ts`, `kg-doc-query.ts`) — heading-section chunked markdown knowledge corpus stored in KG schema v6 tables (`doc_chunks`, `doc_vectors` vec0 float[384], `doc_chunk_meta`); isolated from entity/summary vectors; freshness via content-hash marker `doc_corpus_hash` (ADR-0029); queried by `search_knowledge` tool; **project-local language overlay** (`graph/kg-language-overlay.ts`) — fail-open loader reads `.canon/kg-languages/*.json` + validates paired `.canon/grammars/<wasm>`; `loadOverlayConfigs(projectDir, builtinIds)` returns `LanguageConfig[]`, skips+warns on any error; built-in ids win on collision; `mergeOverlayIntoConfigs(configs)` merges into `LANGUAGE_CONFIGS`/`EXT_TO_CONFIG`; `registerOverlayAdapters(configs)` wires adapters in `kg-adapter-registry.ts`; `initParsers(projectDir?)` now returns `LanguageConfig[]` (changed from `void`) and accepts optional `projectDir` for overlay loading — callers must pass result to `registerOverlayAdapters`; `getLanguage(ext)` falls back to overlay language id before `"unknown"`
- **Community / tags** (`graph/kg-community.ts`, `graph/kg-tags.ts`) — Louvain `community_id` + 4-signal tag propagation to `file_tags` table; used by `get-principles` and `get-file-context`; `kg-tags.ts` exports `VALID_COMPUTED_TAGS` (deduped union of directory + import + graph-role tags, 15 values — static const, no I/O) for vocabulary validation in `wiki_lint`
- **Principle matching** (`shared/matcher.ts`) — OR semantics: matches if layers OR scope.tags intersect; file-pattern matching uses `matchGlob` from `lib/glob-matcher.ts` (linear-time DP, `globToRegex`+RegExp removed, ADR-0026 §Amendment-3)

## Contracts
<!-- last-updated: 2026-06-24 -->

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

**Execution store** (`src/domains/workspaces/execution-store.ts`) — optimistic locking via `updateExecutionVersioned(fields, expectedVersion)` (returns `{ updated: true|false }`); `SQLITE_BUSY` retry via `withRetry`; all board mutations use `updateExecutionVersioned`; `isStuck` is SQL-based. SCHEMA_VERSION = '11'. Event types added 2026-06-24: `context_provenance` (emitted per agent spawn by `resolve_agent_skills` post-disclosure, keyed by `step_id`); `context_provenance_agent_id` (back-filled by `log_step`/`batch_log_steps` on step completion with `agent_id`, keyed by `step_id`).

**Context provenance module** (`src/domains/workspaces/context-provenance.ts`) — `ContextProvenanceRecord` / `ContextProvenanceSummary` types; `hashContent(s)` (deterministic sha256 hex); `buildContextProvenanceRecord(opts)` — pure; builds hashes + char spans for each artifact, never stores content; blanked artifacts carry `char_span: null` + `source:"sidecar"` + `sidecar_path`; fail-open: `indexOf === -1` yields `char_span: null`. Added 2026-06-24. (ADR-0018) — `ArtifactTrustTier = "trusted" | "untrusted-project-local"` is REQUIRED on `AssembledArtifact`; overlay artifacts carry `"untrusted-project-local"`, plugin/built-in carry `"trusted"`. Added 2026-06-27. `ProvenanceArtifactKind` widened with `"agent-def"` (ADR-0031); `AssembledArtifact` gained optional `sections?: SectionSpan[]` (populated only for `kind:"agent-def"`); `buildContextProvenanceRecord` gained an optional `agentDef?: { path, fullFile }` branch — emits exactly one `agent-def` artifact per spawn with `content_hash` over the WHOLE file (frontmatter included, keeps the `readCurrentBody` byte-identity seam unchanged) and `char_span: null` (the body is never part of `preload_prompt`); pure `computeBodySections(fullFile)` splits the BODY into markdown ATX-heading sections (`^#{1,6}\s`), every span starting at or after the frontmatter-end offset — frontmatter is never covered by a mutable span; malformed frontmatter YAML fails open to zero sections (never a fallback span overlapping the fence). Added 2026-07-01.

**KG schema** (`src/graph/kg-schema.ts`) — SCHEMA_VERSION = "6"; v6 adds `doc_chunks`, `doc_vectors` (vec0 float[384]), `doc_chunk_meta` — parallel doc-vector index isolated from entity/summary vectors, no regression to `semantic_search` (ADR-0029); v5 adds `community_id`, `file_tags`, `hotspot_scores`, `co_change_edges`. Freshness marker in `meta` table under key `graph_head_commit` (structural KG) or `doc_corpus_hash` (doc-vector index); `graph_head_commit` stamped on full-project runs only — scoped runs skip orphan pruning and marker stamping.

**Execution schema** (`src/domains/workspaces/execution-schema.ts`) — SCHEMA_VERSION = '11'; `runMigrations(db)` idempotent.

**Board sync** (`src/domains/board/board-sync.ts`) — `syncBoardToStore` returns `SyncResult` (`{ ok: true; newVersion } | { ok: false; error: "version_conflict" }`); single transaction; callers must check `result.ok`.

**Fragment param syntax** — typed params (`param_name: { type: state_id|string|number|boolean, default? }`) replace null-marker `~`; backward compat retained; `state_id` params validated at load time.

**KgQuery** (`src/graph/kg-query.ts`) — call `computeFileInsightMaps(db)` once per request, then pass result into `getFileMetrics()`; never call `getFileMetrics()` in a loop without pre-computing. Other methods: `computeImpactScore`, `getSubgraph`.

**KgStore** (`src/graph/kg-store.ts`) — `getMeta(key)` / `setMeta(key, value)` (upsert), `getAllFilePaths()`; used by `runPipeline` for freshness marker + orphan prune.

**Structural KG freshness** (`src/features/knowledge-graph/ensure-graph-fresh.ts`) — `ensureGraphFresh(projectDir, opts?)`: async, fail-open; no-op when marker matches HEAD; orphan pruning on full-project runs only; concurrent callers share one in-process single-flight run per DB (fail-open). Sibling: `ensureGitIntelFresh`. Called before `graph_query`, `semantic_search`, and inside `getFileContext`.

**Doc-corpus freshness** (`src/features/knowledge-graph/ensure-doc-corpus-fresh.ts`) — `ensureDocCorpusFresh(projectDir)`: async, fail-open; no-op when `meta.doc_corpus_hash` matches current corpus content-hash; content-hash = SHA-256 over sorted (relPath, size, mtimeMs) tuples of `DEFAULT_DOC_CORPUS_SOURCES`; on mismatch runs `ingestDocCorpus` (scan→chunk→embed→write, strict phase separation); concurrent callers share one in-process single-flight per DB. **Content-hash, not git-HEAD** — two corpus roots (build digests, `.canon/` gitignored paths) mutate without commits (ADR-0029). Called by the `search_knowledge` handler before querying.

**`get-file-context`** — surfaces `computed_tags`, `hotspot_score`, `co_change_partners`; calls `ensureGraphFresh`; KG loaders extracted to `get-file-context-kg.ts`, re-exported from `get-file-context.ts`.

**`show_pr_impact`** — returns `UnifiedPrOutput` with `has_review` boolean; `status` always `"ok"`; resource URI: `ui://canon/pr-review`

**`get_drift_report`** — `pr_reviews` field uses `ReviewEntry[]`; renders `### Documentation freshness` section (omitted when empty), sorted by staleness descending with `[confidence: TIER]` per doc.

**`get_compliance` tool** — returns `confidence: ConfidenceAnnotation`; uses per-principle confidence from `analyzeDrift` when available, falls back to drift confidence adapter.

**`presentArtifact` function** — canonical implementation lives in `src/app/artifact-presentation.ts` (moved from `features/orchestration/tools/present-artifact.ts`, ADR-0006); `features/orchestration/tools/present-artifact.ts` is now a thin re-export shim; `features/pr-review` and `app/register-present-artifact.ts` import from `@app/artifact-presentation.ts` directly.

**`present_artifact` MCP tool** — `html` parameter required; serves HTML via HTTP server; returns `{ url: string }` fire-and-forget.

**`present_review` MCP tool** — `showPrImpact` → read pre-rendered `review.html` → `presentArtifact`; `INVALID_INPUT` when `review.html` missing or `has_review === false`.

**`store-summaries`** — DB-only write path (JSON removed ADR-005); `inferLanguageFromExtension` maps extensions to language strings.

**`CANON_FILES` constants** — remaining keys: `CONFIG`, `KNOWLEDGE_DB`, `ORCHESTRATION_DB`, `DRIFT_DB`.

**Wiki lint services** (`src/features/diagnostics/services/wiki-lint.ts`) — 7 checks plus `checkGlossaryConsistency` in sibling `wiki-lint-glossary.ts`, `checkIndexDrift` in `index-inventory.ts`, `checkMisroutedPrinciples`/`checkDuplicateTitles` in sibling `wiki-lint-principle-tier.ts`, `runFrontmatterSchemaCheck` in sibling `frontmatter-schema.ts`, and corpus link graph in sibling `link-graph.ts` (12 DEFAULT_CHECKS + `index_drift` = 13 total `CheckName` values; `WIKI_LINT_CHECK_NAMES` const exported from `register-knowledge.ts` with schema-parity enforcement): `checkContradictions`, `checkOrphanPrinciples`, `checkStaleRefs`, `checkMissingExamples`, `checkCitedPaths`, `checkScopeLayers`, `checkScopeTags`, `checkGlossaryConsistency`, `checkIndexDrift`, `checkMisroutedPrinciples`, `checkDuplicateTitles`, `frontmatter_schema` (ADR-0021), `link_integrity` (ADR-0019); `orphan_principles` now inbound-`[[id]]`-link-based (ADR-0019) — the link graph's `referencedPrincipleIds` replaces the prior prose-substring scan; see `src/features/diagnostics/.claude/CLAUDE.md` for full `CheckName` details. <!-- last-updated: 2026-06-24 -->

**Context manifest** (`src/features/diagnostics/services/context-manifest.ts`) — `buildContextManifest(pluginDir)`: pure async; reads all `.md` files under corpus dirs, hashes each via `hashContent` (sha256, reused from `context-provenance.ts`), returns sorted `ContextManifest`; `checkContextStaleness(projectDir, manifest)`: compares live corpus against manifest, classifies each entry as drifted/missing/extra; returns `StalenessReport`. Both functions registered via `check_context_staleness` tool in `register-knowledge.ts` (added 2026-06-25). Committed source-of-truth manifest at `context-manifest.json` (repo root); regenerated via `npm run regen:context-manifest`. <!-- last-updated: 2026-06-25 -->

**Agent Provenance** (`src/shared/lib/commit-trailers.ts`, `src/shared/lib/file-claims.ts`) — `formatCommitTrailers`/`buildCommitMessage` produce Canon trailer blocks; `ClaimsFile` persisted to `.canon/claims.json`; 24h-TTL file ownership claims. See `src/shared/.claude/CLAUDE.md`.

**Confidence engine** (`src/shared/lib/confidence.ts`) — `deriveTier(score, sampleSize)` returns `"insufficient"` for sparse data; `computeConfidenceAnnotation(inputs[])` returns zero-confidence for empty input. Added 2026-05-25.

**Correction Reader** (`features/orchestration/services/correction-reader.ts`) — `readCorrections(projectDir, filePaths?, maxAge?)` → `{ ok: true; records[] } | { ok: false; error }`; ENOENT → `ok:true, records:[]`; updated 2026-05-25.

**Shared libs** (`src/shared/lib/`) — `token-budget.ts`: `fitWithinBudget(items, budget)` greedy selector by priority; `violation-patterns.ts`: 8 extracted pure functions for violation analysis; `config.ts`: `buildLayerInferrer` supports globs; `DEFAULT_LAYER_MAPPINGS` has `hooks: ["hooks/**"]` before `shared` so `hooks/lib/*.sh` resolves to `hooks` layer (2026-05-29); `VALID_LAYERS = Object.keys(DEFAULT_LAYER_MAPPINGS)` — derived valid `scope.layers` set (2026-06-05). **Overlay trust boundary (ADR-0026/ADR-0027):** `overlay-untrusted-text.ts` — opaque `UntrustedText` box type; `brandUntrusted` stamps at load, `renderUntrusted*` fence at model-facing sink, `rawUntrustedForStructuralUse` is the audited escape hatch, `mapUntrusted` is brand-preserving transform. `overlay-closed-domain.ts` — shared charset constants + `filterLayers`/`filterFilePatterns`/`filterTagArray`; both writers (`parser.ts` and `matcher.ts`) import from here to prevent second-writer bypass. `glob-matcher.ts` — linear-time O(m·n) DP wildcard matcher; `matchGlob(pattern, path)` replaces `globToRegex`+`new RegExp` everywhere, eliminating throw-DoS and ReDoS classes. See `src/shared/.claude/CLAUDE.md`.

**Flow schema** (`flow-schema.ts`) — `StateDefinitionSchema` is a `z.discriminatedUnion` with 5 type schemas; all new fields MUST be `.optional()`; `WavePolicy` defaults: isolation=worktree, merge=sequential, on_conflict=hitl.

**`computeAnalytics(projectDir)`** (`platform/storage/drift/analytics.ts`) — async wrapper over `DriftDb.computeAnalytics()`; returns `FlowAnalytics`; entries without gate data excluded from `avg_gate_pass_rate`.

**Step journaling** — `log_step` / `batch_log_steps` record step completion in `journal.json`; quality signals and discovery fields accumulate across steps (append, not replace).

**Orchestration harness tools:**

| Tool | Purpose |
|------|---------|
| `open_artifact` | Open an HTML artifact from `${workspace}/artifacts/` in browser; reads file, registers with HTTP server, opens fire-and-forget; returns `{ url }`; path traversal blocked; `UNEXPECTED` when HTTP server not running. Added 2026-05-25. |
| `init_workspace` | Create or resume a workspace; seeds `progress.md`; creates build worktree at `{workspace}/worktree` on `canon/{slug}` branch (returned as `worktree_path`/`worktree_branch`); `preflight: true` checks git status, stale sessions, file claims (non-blocking); when preflight issues found, returns `workspace: ""` + `candidate_workspace` + `preflight_issues` — callers must check `preflight_issues`; resume checks `{workspace}/worktree` first, then legacy `.canon/worktrees/{slug}`; `expectedTask` mismatch blocks resume (slug-collision guard); OPTIONAL `session_id` (value of `CLAUDE_CODE_SESSION_ID`) + `job_id` (first 8 chars of `basename($CLAUDE_JOB_DIR)`) — used to acquire the workspace mutex (`.lock`); when a live foreign lock is detected returns `lock_gated: true` + `lock_owner: LockRecord` — caller MUST NOT proceed, must HITL; when a stale lock is reclaimed returns `lock_reclaimed: "ttl" \| "pid_dead" \| "corrupt_and_stale"` — informational, proceed normally <!-- last-updated: 2026-06-24 --> |
| `write_plan_index` | Write a structured `INDEX.md` for wave execution to `{workspace}/plans/{slug}/INDEX.md`; validates task IDs (`/^[a-zA-Z0-9_-]+$/`), wave ≥ 1, no duplicates; returns `{ path, task_count, wave_count }` — added 2026-04-01 |
| `finalize_workspace` | Close the flow: verifies journal completeness, releases file claims for the workflow slug, releases the workspace mutex (`.lock`), aggregates gate/postcondition/violation/test metrics into `FlowRunEntry`; populates `diff_stat` + `total_files_changed` via `tryComputeDiffStats`; archives workspace (copy only) via `archiveWorkspaceOnly` — **no destructive teardown** (no `git worktree remove`, no `git branch -D`, no `rmSync`); returns `teardown_deferred: true` + `teardown_owner` (post-ship janitor path) when archive runs (ADR-0016); OPTIONAL `session_id` — used to release the workspace mutex; omitting releases unconditionally (single-session backward compat); `lock_released: boolean` in all responses <!-- last-updated: 2026-06-24 --> |
| `log_step` | Record a single step execution (status, artifacts, agent ID) in `journal.json` |
| `record_agent_metrics` | Record performance counters into execution state; `INVALID_INPUT` if no fields; `WORKSPACE_NOT_FOUND` if state absent — ADR-003a 2026-04-01 |
| `post_event` | Structured activity logging via `appendEvent`; returns `{ ok: true }` or error codes — added 2026-04-07 |
| `batch_log_steps` | Log multiple steps in one journal read-modify-write; fail-closed (batch rejected if any `step_id` empty); parallel transcript capture for completed entries with `agent_id` — added 2026-04-30 |
| `capture_transcript` | Best-effort transcript capture; reads CC agent JSONL, writes `TranscriptEntry[]` to `{workspace}/transcripts/`; warning (never error) when source not found; `source_path` primary, `agent_id` glob fallback; `persist_path: true` records path for `get_transcript` (fail-open) — added 2026-04-26, updated 2026-05-30 |
| `compute_autonomy_tier` | autonomous/light-touch/supervised from build history + blast radius + compliance; fail-safe: defaults to supervised on error; logs `auto_decision`; returns `{ tier, score, reasoning, signals_used }` |
| `get_next_escalation_strategy` | Next fallback strategy on agent failure; cascade: add_primer → increase_budget → escalate_model → narrow_scope → hitl; 2-minute cumulative timeout; `skip_strategies` per-flow config; logs `auto_decision`; returns `EscalationResult` with `strategy`, `is_terminal` |
| `reconcile_workspace` | Cliff detection; `{ workspace, emit_telemetry?, source?, projectDir? }`; `source` accepts `"resume" \| "post_subagent" \| "loop"` (pass `"loop"` when called from loop runner); returns `{ incomplete_steps[], needs_recovery }`; flags `started`/`planned` steps with missing or partial-skeleton artifacts; `completed` and empty-`artifacts_expected` planned steps never flagged; `emit_telemetry: true` appends fail-open `cliff_detected` event to orchestration.db AND upserts rows to drift.db `cliff_events` table via `CliffEventsDao` (dual fail-open write-through; `projectDir` required for drift.db write, injected by `register-journal.ts` via `resolveScope`); `WORKSPACE_NOT_FOUND` when journal absent — added 2026-05-29, dual-write 2026-06-08, `source:"loop"` 2026-06-11 |
| `log_decision` | Append a timestamped orchestrator decision to the durable event log (`orchestrator_decision` event type). **Authoritative write** — returns a `ToolResult` error on store failure (NOT fail-open). Call at each consequential decision: plan-approval outcome, review-verdict acceptance/override, scope cuts, AC changes, tier overrides, merge-conflict resolutions, manual-verification confirmations. |
| `get_decisions` | Read the orchestrator decisions ledger (`getEventsByType("orchestrator_decision")`); returns `{ decisions: DecisionRecord[], rendered: string }` — structured array + rendered markdown table. Use before HITL gates and on resume to rehydrate decided state. |
| `write_orchestrator_checkpoint` | Write a derived compact resume-state snapshot to `${workspace}/checkpoint.md` (current/completed/pending steps + recent decisions + next action). **Best-effort-observable** — write failure returns a `ToolResult` error (never silent success). Refresh per completed step (alongside `log_step(...completed)`) and at each HITL gate. |

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
| `sync_indexes` | Regenerate sentinel-delimited `## Artifact Inventory` blocks in the 6 sibling artifact-class indexes (`rules/`, `principles/`, `agents/`, `templates/`, `references/`, `primers/`); skips indexes without sentinels; returns `{ synced[], skipped[] }` |
| `check_context_staleness` | Compare installed artifact corpus against committed `context-manifest.json`; returns `StalenessReport` with `drifted[]`, `missing[]`, `extra[]` entries; `INVALID_INPUT/MANIFEST_NOT_FOUND` when manifest unreadable |
| `graph_query` | Query codebase knowledge graph — callers, callees, blast radius, dead code, search |
| `search_knowledge` | Top-K relevance retrieval over the markdown knowledge corpus (principles, references, `.canon/principles`, `.canon/proposed-learnings`, build digests); calls `ensureDocCorpusFresh` on first call; `corpus` + `trust` filters (default `internal`); returns `content`, `corpus`, `doc_path`, `heading_path`, `distance`; distinct `DOC_CORPUS_NOT_INDEXED` error when DB absent |
| `store_pr_review` | Store a PR review result; accepts optional `craft_profile` (persists one row per distinct subsystem area to `craft_profiles` with `source:"review"`) |
| `get_context` | Batch context for multiple files — composes principles, file_context, drift, graph, signals in one call |

**History tools** (`src/features/history/`):

| Tool | Purpose |
|------|---------|
| `get_build_history` | List archived build runs with metadata |
| `get_historical_artifacts` | Retrieve archived artifacts from a previous build |
| `get_cross_run_analysis` | Cross-run meta-analysis for the learner; includes `craft_drift: CraftDrift` (`by_dimension[]`, `by_area[]`, `profile_count`) and `cliff_events: CliffEventsDimension`; runs fail-open `sweepCliffEvents(project_dir)` before analysis |

**Loop tools** (`src/features/loops/`): <!-- last-updated: 2026-06-11 -->

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

**Evolution tools** (`src/features/evolution/`): <!-- last-updated: 2026-07-01 -->

| Tool | Purpose |
|------|---------|
| `evaluate_candidate` | Inject candidate text into a temp-dir copy of the eval surface or a full-plugin sandbox (ADR-0025 dual injection mode; see below), run `run-evals.sh` per split, apply §7 strict-holdout gate; returns `EvaluateCandidateResult` (`baseline_score`, `candidate_score`, `per_split`, `accepted`, `regressed`, `size_delta`, `judge_votes_holdout`); fail-closed on subprocess error or timeout; public `EvaluateCandidateInputSchema`/`EvaluateCandidateResult` contract UNCHANGED (additive-optional `guard_rejection?: { reason, fields? }` — see frontmatter-reject guard below); registered via `register-evolution.ts` |
| `attribute_failure` | Join recorded `context_provenance` events with review violations + cliff events to localize each failure to the in-context artifact; accepts `workspace` OR `archive_id` + `project_dir`; returns `AttributeFailureResult` with `attributions[]`, `unattributed[]`, `flagged[]`, `ambiguous[]`; content_hash byte-identity re-check (fail-closed); fail-open on absent provenance/reviews → partial result; `FailureKind = "review_violation" \| "cliff_event"` (ADR-0024); `join_basis` now has 3 values — `"cliff_step_id"`, `"principle_id==artifact_id"`, and `"code_author_agent_def"` (ADR-0032, a `review_violation` may attribute to BOTH the rule edge AND the code-author agent-def edge); artifact re-read (hash verify) resolves project_dir-first, pluginDir-fallback for trusted plugin-tier paths via `resolveArtifactReadPath` (Codex P2 #1; `pluginDir` is a handler-internal param, not a schema field) |
| `select_mutation_targets` | Deterministic (no model calls): composes `attribute_failure` pipeline, applies selection policy (`hash_verified` + `confidence:high` + `gate_eligible`) + budget (`max_targets_per_pass`, default 3), reads baseline bodies, returns bounded `MutationTarget[]` with `gate_eligible` + `baseline_body`; ineligible/skipped paths land in typed `gate_ineligible[]` / `skipped[]` buckets; accepts `workspace` OR `archive_id` + `project_dir`; registered via `register-evolution.ts`; the `agent-def` artifact class already resolves to `artifact_class: "agent"` + `gate_eligible: true` (ADR-0025 admits `agents/`) — no code change needed for ADR-0031's new kind; baseline-body read shares the same project_dir-first/pluginDir-fallback resolver as `attribute_failure` (Codex P2 #1); `MutationTarget.principle_id` for an `agent-def` target is the VIOLATED principle from the attribution, not the agent name (`derivePrincipleId`, Codex P2 #2) |

**`evaluate_candidate` dual injection mode (ADR-0025):** mode auto-selected from `target_path` — no caller change needed.
- **Eval-surface mode** (ADR-0022, unchanged): `target_path` under `skills/canon/evals/` → copies only `skills/canon/evals/` into a temp dir.
- **Guardrail mode** (ADR-0025, new): `target_path` under any plugin artifact root (`rules/`, `primers/`, `agents/`, `templates/`, `principles/`, `skills/`, `references/`) but NOT under the eval surface → copies the full plugin markdown tree (`PLUGIN_ARTIFACT_ROOTS`) into a temp sandbox and passes `--plugin-dir <sandbox> --setting-sources project` to `claude -p` via the `EVAL_PLUGIN_DIR` env var in `run-evals.sh`. Tool-descriptions (TypeScript in `register-*.ts`) are NOT plugin-loaded → they remain gate-ineligible (`GateIneligibleTarget.reason = "tool_description_not_loadable"`).
- **Public contract unchanged**: callers pass the same `{ candidate_text, target_path, project_dir, splits? }` — the handler dispatches internally via `isGuardrailTarget(targetPath)`.

**`evaluate_candidate` runtime frontmatter-reject guard (ADR-0031 amendment):** when `target_path`'s first segment is `agents` (an agent-def target), `checkFrontmatterImmutable` (`services/frontmatter-guard.ts`) runs BEFORE `checkScriptReachable`/any subprocess — a raw byte-for-byte comparison of the `---\n...\n---` frontmatter block against baseline. Differing blocks → rejects with `guard_rejection: { reason: "frontmatter_modified", fields? }` (best-effort list of changed top-level YAML keys); unparseable frontmatter on either side → fail-closed reject with `reason: "frontmatter_unverifiable"`; never throws. Body-only edits pass through to normal scoring unaffected.

## Dependencies
<!-- last-updated: 2026-06-24 -->

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | MCP server/client implementation |
| `zod` | Runtime schema validation |
| `yaml` | YAML frontmatter parsing via `splitFrontmatter`/`readFrontmatter` seam in `shared/lib/frontmatter.ts` (replaced `gray-matter` — R0) |
| `tsx` | TypeScript execution (runtime dependency — server launched via boot.sh → tsx) |
| `vitest` | Unit testing (dev) |

## Invariants
<!-- last-updated: 2026-06-12 -->

- **no-cross-feature-internal-import** (ADR-0005, ADR-0006): Features must not import internal modules from other features; enforced by `mcp-server/.dependency-cruiser.cjs` `no-cross-feature-internal-import` rule (error severity, 0 violations); sole exception: `^src/features/knowledge-graph/` is a designated foundational service features may depend on (see `docs/adr/0005-knowledge-graph-is-a-foundational-service.md`). Added 2026-06-12.
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
<!-- last-updated: 2026-07-02 -->

**Recursive filesystem scanners — root threading**: Scanners that exclude paths by relative prefix must thread the original scan root through all recursive calls. Never update the root to the current directory. Pattern: `scanFn(currentDir, rootDir)` where `rootDir` never changes. The bug class (root-drift) is silent — exclusion logic passes at depth 0 and silently fails at depth 1+. See `tools/wiki-lint.ts` (`FindFilesCtx.originalRoot`) and `services/doc-gap-detect.ts` as reference implementations.

**Integration tests must use an isolated `projectDir`, never `process.cwd()`**: any test that drives the real `finalizeWorkspace` path (directly or via helpers that call it) must pass an isolated `mkdtemp` temp dir as `projectDir`. Passing `process.cwd()` reaches `appendFlowRun` -> `getDriftDb(projectDir)`, which opens `.canon/drift.db` at that literal path and writes a real `flow_runs` row into the repo's live drift DB. Enforced by the global `drift-db-leak-guard` (see Scripts / `src/tests/drift-db-leak-guard.ts`), which fails the suite on any growth in either protected `.canon/drift.db` (repo root or `mcp-server/`). Added 2026-07-02.

## Scripts
<!-- last-updated: 2026-07-02 -->

- `scripts/dead-wire-internal-use.mjs` — TS compiler-API same-file use resolver; invoked by `hooks/dead-wire-gate.sh` as `node dead-wire-internal-use.mjs <file> <symbol>`; returns integer code-ref count on stdout + exit 0 on success, non-zero on any error (fail-closed); counts an identifier as a use ONLY when `ts.TypeChecker.getSymbolAtLocation` resolves it to the top-level exported binding — member-property names, shadowing locals, declaration sites, strings, and comments are all correctly excluded by construction; bails fail-closed on non-empty `sourceFile.parseDiagnostics` (syntactic parse errors) before building the Program; no tsconfig dependency (`noResolve/noLib/types:[]` in-memory Program). <!-- last-updated: 2026-06-24 -->
- `scripts/regen-context-manifest.ts` — regenerates `context-manifest.json` at repo root; invoked as `npm run regen:context-manifest`; calls `buildContextManifest` from `features/diagnostics/services/context-manifest.ts`; committed output is the source-of-truth for `check_context_staleness`. Added 2026-06-25.
- `scripts/purge-synthetic-flow-runs.mjs` — safely deletes synthetic test-fixture rows from a `.canon/drift.db` `flow_runs` table; `node purge-synthetic-flow-runs.mjs [dbPath] [--flow=<name>]` (defaults: repo-root `.canon/drift.db`, `--flow=test-flow`); hard guard asserts zero target rows look like real activity (`total_spawns > 0 OR total_duration_ms > 1000`) before deleting anything — exits non-zero without deleting if any offending row is found; idempotent (second run against an already-purged target deletes 0 rows, exits 0). Added 2026-07-02.

## Development
<!-- last-updated: 2026-06-09 -->

```bash
npm install          # Install dependencies
npm run build        # Emit TypeScript declarations only (.d.ts via tsc emitDeclarationOnly; no runnable dist/ produced)
npm start            # Run server via tsx (tsx is a runtime dependency; loaded by boot.sh in production)
npm test             # Run vitest unit tests
```

Node.js 24+ required. Enforced at runtime by `boot.sh` Step 12.5 (fail-closed, actionable error) and declared in `package.json` `engines.node`. No `.tool-versions` pin is shipped — `boot.sh` validates the floor against the user's ambient Node.

**Vitest policy** — `vitest.config.ts` sets `testTimeout: 20000` (20s) and `maxWorkers: 4` project-wide; do not add per-test `timeout` overrides — the config-level policy covers subprocess-heavy suites (git, depcruise, embeddings). `setupFiles: ["./src/tests/vitest-setup-drift-guard.ts"]` registers a global per-file `beforeAll`/`afterAll` fixture-leak guard (`installDriftDbLeakGuard`, `src/tests/drift-db-leak-guard.ts`) that fails the suite if either protected `.canon/drift.db` (repo root or `mcp-server/`) grows a `flow_runs` row during the run — see Conventions. Added 2026-07-02.

**CI supply-chain gate** — `.github/workflows/ci.yml` runs `npm audit --omit=dev --audit-level=high` after `npm ci`; high+ production-dependency vulnerabilities fail CI.
