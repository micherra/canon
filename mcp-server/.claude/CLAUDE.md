# Canon MCP Server — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
TypeScript MCP (Model Context Protocol) server that provides tools for managing, enforcing, and tracking engineering principles across a codebase.

## Architecture
<!-- last-updated: 2026-05-26 -->

ES module TypeScript project using `@modelcontextprotocol/sdk` and `zod` for schema validation.

```
src/
├── app/                  # Entry point — tool registration (index.ts, register-*.ts, all handlers via wrapHandler)
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
<!-- last-updated: 2026-05-27 (resolveGitRoot added to resolve-project-dir.ts; wiki_lint tool added; confidence scoring: ConfidenceAnnotation type, OutcomeStore, drift schema v7, review/drift adapters, write_review/get_compliance updated) -->

**`resolveGitRoot(cwd, gitTopLevelFn)`** (`src/app/resolve-project-dir.ts`) — returns git repo root for `cwd`; falls back to `cwd` when not in a git repo or git is unavailable; errors are logged and swallowed (never throws).

**`present_artifact` MCP tool** — `html` parameter required; serves the provided HTML directly via HTTP server; returns `{ url: string }` (fire-and-forget; does not block). Updated 2026-05-16.

**`present_review` MCP tool** — thin composition: `showPrImpact` → read pre-rendered `${workspace}/artifacts/review.html` → `presentArtifact`; returns `{ url: string }`; `INVALID_INPUT` when `review.html` missing or `has_review === false`. Added 2026-05-15, updated 2026-05-16.

**Tool error types** (`src/shared/lib/tool-result.ts`) — ADR-002, 2026-03-31: `ToolResult<T>` is a discriminated union `({ ok: true } & T) | CanonToolError`; all tools return this (never throw for expected errors). `CanonErrorCode` has 9 values (see source). `wrapHandler<T>` in `wrap-handler.ts` catches unexpected throws as `UNEXPECTED` errors. All major tool functions updated to return `ToolResult<T>` — see source for signatures.

**Subprocess adapters** (`src/platform/adapters/`) — ADR-002; only files here may import `node:child_process`. Three adapters: `git-adapter.ts` (sync, shell never true, 30s default), `git-adapter-async.ts` (async, never rejects), `process-adapter.ts` (shell: true, 512KB maxBuffer). See source for signatures.

**Flow parser** (`src/orchestration/flow-parser.ts`) — ADR-004, 2026-04-01: `loadAndResolveFlow` now throws on hard validation errors (was returning `errors` array). Exports: `validateSpawnCoverage`, `analyzeReachability`, `checkUnresolvedRefs`, `validateStateIdParams`, `VIRTUAL_SINKS`, `RUNTIME_VARIABLES` (see source).

**Execution store** (`src/domains/workspaces/execution-store.ts`) — concurrency update 2026-04-09: optimistic locking via `updateExecutionVersioned(fields, expectedVersion)` (returns `{ updated: true|false }`), transparent `SQLITE_BUSY` retry via `withRetry`, all board mutations use `updateExecutionVersioned` (not `updateExecution` directly). `isStuck` is SQL-based (see source). SCHEMA_VERSION = '11'. See Invariants for caller obligations.

**KG schema** (`src/graph/kg-schema.ts`) — SCHEMA_VERSION = "5"; v5 adds `community_id` (INTEGER NULL on `files`), `file_tags` table, `hotspot_scores` table, `co_change_edges` table (see source for columns).

**Execution schema** (`src/domains/workspaces/execution-schema.ts`) — SCHEMA_VERSION = '11'; `runMigrations(db)` is idempotent. v3 adds `iteration_results` table, v11 adds `version` column to `execution` table.

**Board sync** (`src/domains/board/board-sync.ts`) — `syncBoardToStore` returns `SyncResult` (`{ ok: true; newVersion } | { ok: false; error: "version_conflict" }`); wraps all writes in single transaction; callers must check `result.ok`.

**Fragment param syntax** — typed params (`param_name: { type: state_id|string|number|boolean, default? }`) replace null-marker `~`; backward compat retained; `state_id` params validated at load time.

**Drift DB schema** (`src/platform/storage/drift/drift-schema.ts`) — DRIFT_SCHEMA_VERSION = "7"; v4 adds `file_violation_history` + `path_effects` tables; v6 adds `error_fixes` table; v7 adds `violation_outcomes` table (PK: file_path + principle_id + slug; columns: action CHECK('fix','acknowledge','defer'), slug, timestamp); idempotent migrations. Updated 2026-05-26.

**OutcomeStore** (`src/platform/storage/drift/outcome-store.ts`) — sync DAO for `violation_outcomes`; methods: `recordOutcome(input: ViolationOutcome)`, `getOutcomesForPrinciple(principleId)`, `getOutcomeStats(principleIds?)`, `getOutcomesForFiles(filePaths)`. Added 2026-05-25, updated 2026-05-26.

**DriftDbSignals DAO** (`src/platform/storage/drift/drift-db-signals.ts`) — sync DAO for `file_violation_history`, `path_effects`, and `error_fixes`; methods: `getFileViolationHistory`, `upsertFileViolation`, `markFixed`, `getPathEffects`, `upsertPathEffect`, `getErrorFixes(filePaths)`, `upsertErrorFix(input)`, `getAllFileViolationHistory()`. `DriftDb.getSignals()` is a lazy cached accessor. Updated 2026-05-22.

**Drift Store** (`src/platform/storage/drift/store.ts`) — `ReviewEntry` is the unified type for all reviews (principle + PR); `PrStore` deleted 2026-03-25. `DriftStore.getReviews(options?)` AND-filters by principleId/branch/prNumber (see source for full signature).

**`show_pr_impact`** — unified PR analysis tool; returns `UnifiedPrOutput` with `has_review` boolean; `status` always `"ok"`; resource URI: `ui://canon/pr-review`
**`get_drift_report`** — `pr_reviews` field uses `ReviewEntry[]` (unified type); filters by pr_number/branch presence
**KgQuery** (`src/graph/kg-query.ts`) — `computeImpactScore`, `computeFileInsightMaps` (call once per request), `getFileMetrics`, `getSubgraph`; must call `computeFileInsightMaps` before `getFileMetrics` in loops (see source for full API)
**Git Intelligence** (`src/features/knowledge-graph/git-intel/`) — pipeline: git log → parse → churn scoring → co-change detection → persist atomically; `ensureGitIntelFresh` is the main entry point (no-op when fresh)
**Wiki lint services** (`src/features/diagnostics/services/wiki-lint.ts`, `doc-gap-detect.ts`) — pure functions: `checkContradictions`, `checkOrphanPrinciples`, `checkStaleRefs`, `checkMissingExamples`, `assembleWikiLintOutput(AssembleWikiLintInput)`; `detectDocGaps(entries)`, `scanDirectories(rootDir, excludeDirs?)`; all accept pre-loaded data (no I/O except `scanDirectories`). Added 2026-05-26.
**Signal Compiler** (`src/features/diagnostics/services/signal-compiler.ts`) — `compileSignals(filePaths, driftDbSignals)` reads violation history + path effects, scores by priority, fits within per-file token budget; read-only
**Pitfall Enrichment** (`src/features/diagnostics/services/pitfall-enrichment.ts`) — added 2026-05-22; exports `queryDriftSignalPitfalls(filePaths, signals)`, `queryErrorFixPitfalls(filePaths, signals)`, `formatPitfallsSection(drift, errorFix)`, `countPitfalls(drift, errorFix)`; pure functions (no DB calls); `formatPitfallsSection` returns `""` when both arrays empty
**Backfill Error Fixes** (`src/features/diagnostics/services/backfill-error-fixes.ts`) — added 2026-05-22; script that mines `file_violation_history` to populate the `error_fixes` table; call once per project to seed historical data
**`store-summaries`** — DB-only write path (JSON removed ADR-005); `inferLanguageFromExtension` maps extensions to language strings
**`CANON_FILES` constants** — remaining keys: `CONFIG`, `KNOWLEDGE_DB`, `ORCHESTRATION_DB`, `DRIFT_DB`
**Principle matcher** (`src/shared/matcher.ts`) — OR semantics: matches if layers OR scope.tags intersect; `matchesScopeTags` checks tag overlap
**`get-principles`** — loads KG computed tags and passes to `matchPrinciples`; tag matching active when KG indexed
**`get-file-context`** — surfaces `computed_tags`, `hotspot_score`, `co_change_partners`; `shape` derived from graph metrics (see `deriveShape` in source)
**PR Review Data** (`pr-review-data.ts`) — pure functions: `classifyFile` (bucket assignment), `generateNarrative`, `buildFileViolationMap`, `assembleOutput(AssembleParams): PrReviewDataOutput` (extracted 2026-05-25); `PrFileInfo.bucket` thresholds: needs-attention = violations OR high in_degree; worth-a-look = priority >= 5; `getPrReviewData` returns `{ error }` (not throw) for invalid `pr_number`
**Correction Reader** (`features/orchestration/services/correction-reader.ts`) — `readCorrections(projectDir, filePaths?, maxAge?): ReadCorrectionsResult`; `ReadCorrectionsResult` = `{ ok: true; records: CorrectionRecord[] } | { ok: false; error: string }`; ENOENT → `ok:true, records:[]`; other I/O errors → `ok:false`; updated 2026-05-25
**Confidence engine** (`src/shared/lib/confidence.ts`) — exports `ConfidenceAnnotation`, `ConfidenceTier`, `ConfidenceBasis`, `ConfidenceInput` types + `ConfidenceAnnotationSchema` Zod schema; `deriveTier(score, sampleSize): ConfidenceTier` (returns `"insufficient"` for sparse data, never throws); `computeConfidenceAnnotation(inputs: ConfidenceInput[]): ConfidenceAnnotation` (returns zero-confidence annotation for empty inputs). Added 2026-05-25.

**Review confidence adapter** (`src/features/orchestration/services/review-confidence-adapter.ts`) — pure compute function; composes severity_tier, violation_history, path_effects, base_sample signals from drift DB; returns `ConfidenceAnnotation`; zero-confidence for undefined file_path. Added 2026-05-25.

**Drift confidence adapter** (`src/platform/storage/drift/drift-confidence-adapter.ts`) — pure compute function; composes sample_size (weight 0.5), trend_stability (weight 0.3), rate_stability (weight 0.2) signals; placed in `platform/storage/drift/` to avoid cross-feature circular imports. Added 2026-05-25.

**`write_review` tool** — updated 2026-05-25: accepts optional `confidence` annotation per violation; when `confidenceAdapter` (injected via `register-orchestration.ts`) is present, auto-annotates violations from drift DB signals; backward compatible when adapter absent.

**`get_compliance` tool** — updated 2026-05-26: returns `confidence: ConfidenceAnnotation` in response; uses per-principle confidence from `analyzeDrift` when available, falls back to drift confidence adapter (sample_size + trend_stability + rate_stability signals).

**`get_drift_report` tool** — updated 2026-05-25: confidence tier rendered inline as `[confidence: TIER]` per violation in formatted output.

**Shared libs** — `token-budget.ts`: `fitWithinBudget` greedy selector by priority; `violation-patterns.ts`: 8 extracted pure functions for violation analysis; `config.ts`: `buildLayerInferrer` supports globs

**Composite context tool:**

| Tool | Purpose |
|------|---------|
| `get_context` | Batch context for multiple files — composes `getPrinciplesBatch`, `getFileContext` (per-file), `getDriftReport`, `graphQuery`, `compileSignals` in a single call; `include` param gates sections (default: all 5) |

**`get_context` tool** (`src/app/register-knowledge.ts`) — added 2026-04-30; updated 2026-05-15 (signals section):
<!-- last-updated: 2026-05-15 (signals section added to get_context) -->
- Input: `file_paths: string[]` (required), `include?: Array<"principles"|"file_context"|"drift"|"graph"|"signals">` (defaults to all 5 sections)
- Returns `{ file_paths, include, principles?, file_context?, drift?, graph?, signals? }` — sections present only when included
- `signals` section: calls `compileSignals(filePaths, driftDb.getSignals())`; fails open (errors skipped, matching graph section behavior); returns `FileSignals[]`
- `IncludeSection` type union now includes `"signals"`; `ALL_SECTIONS` constant updated
- `file_context` errors propagated (fail-closed); graph/signals query failures skipped gracefully
- `GetContextOutput` type exported for test assertions

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
**Orchestration tools** — `resolve_after_consultations`: pure resolution, call after last wave before `finalize_workspace`; `resolve_wave_event`: apply/reject pending events, emits `wave_event_resolved`; `resolve_agent_skills`: **async** since 2026-05-20; applies progressive disclosure when `projectDir` provided — if `preload_prompt` exceeds 12k chars, full JSON is written to `.canon/artifacts/agent-skills-*.json` and result contains a compact summary + `full_data_path` pointer; accepts optional `options?: { filePaths?: string[]; workspace?: string }` — when `filePaths` provided, appends "Known Pitfalls" section to `preload_prompt` (from drift signals + error_fixes) and logs `pitfall_injected` audit event to execution store. Updated 2026-05-22.
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
| `tsx` | TypeScript execution (dev) |
| `vitest` | Unit testing (dev) |

**Worktree settings injection** (`src/features/prompt-pipeline/services/worktree-settings.ts`) — added 2026-04-08:
- `profileToAllowRules(tools: string[]): string[]` — filters tool names to the `BUILTIN_CLAUDE_TOOLS` set (`Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `NotebookEdit`, `WebFetch`); MCP tools are excluded (already covered by project-level `settings.json`)
- `buildWorktreeSettings(allowRules: string[]): { permissions: { allow: string[] } }` — builds the `settings.local.json` structure; empty rules produce `{ permissions: { allow: [] } }` (no extra permissions)
- `injectWorktreeSettings(worktreePath: string, tools: string[]): Promise<boolean>` — atomically writes `.claude/settings.local.json` into the worktree (write-to-temp + rename); validates absolute path; returns `false` on any failure without throwing; creates `.claude/` dir if absent; idempotent (second call overwrites first)

**Agent Provenance** (`src/shared/lib/commit-trailers.ts`, `src/shared/lib/file-claims.ts`) — added 2026-04-09:
<!-- last-updated: 2026-04-09 (agent provenance system: commit trailers + file claims) -->
- `TrailerOpts` — `{ workflow: string; agent: string; state: string; taskId?: string }`
- `formatCommitTrailers(opts: TrailerOpts): string` — returns trailer block string; returns `""` when any required field is missing
- `buildCommitMessage(subject, body, trailerOpts): string` — full commit message: subject + optional body + trailers + Co-Authored-By
- Trailer format: `Canon-Workflow: {slug}` / `Canon-Agent: {agent-type}` / `Canon-State: {state-id}` / `Canon-Task: {task-id}` (wave only)
- `ClaimsFile` — `{ version: 1; claims: Record<string, ClaimEntry[]> }`; persisted to `.canon/claims.json`
- `ClaimEntry` — `{ workflow: string; claimed_at: string }` (ISO-8601)
- `ClaimOverlap` — `{ file_path: string; workflows: string[] }`
- `readClaims(projectDir): ClaimsFile` — prunes stale entries (>24h TTL); returns empty structure on any error
- `registerClaims(projectDir, workflow, filePaths): void` — idempotent; duplicate workflow+file pairs are no-ops
- `releaseClaims(projectDir, workflow): void` — removes all entries for a workflow; no-op for unknown workflows
- `checkClaimOverlaps(projectDir, workflow, filePaths): ClaimOverlap[]` — returns overlaps from OTHER workflows only
- Spawn prompts now include a `## Commit Provenance` section (injected by `inject-coordination.ts`) with the pre-formatted trailer block for the agent's state

**`injectSettingsIntoRequests`** (`src/features/orchestration/tools/drive-flow.ts`) — exported helper added 2026-04-08:
- `injectSettingsIntoRequests(requests: SpawnRequest[]): Promise<void>` — iterates spawn requests sequentially; calls `injectWorktreeSettings(req.worktree_path, req.tools)` when `req.permission_mode === "auto"` AND `req.worktree_path` AND `req.tools` are all present; sequential (not `Promise.all`) for error isolation — one failure does not abort others; never throws

## Invariants
<!-- last-updated: 2026-05-27 (cwd fallback now resolves to git root via resolveGitRoot before resolveProjectDir) -->

- **ADR-002 subprocess isolation**: Only files in `src/platform/adapters/` may import `node:child_process`; all `features/` and `orchestration/` code must use adapter functions (`gitExec`, `gitExecAsync`, `runShell`) — added 2026-03-31
- **ADR-002 ToolResult contract**: Tools return `ToolResult<T>` for all expected error conditions; unexpected errors are caught by `wrapHandler` and returned as `UNEXPECTED` `CanonToolError`; tools never throw for expected conditions — added 2026-03-31
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
<!-- last-updated: 2026-03-22 -->

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript (tsc → dist/)
npm start            # Run server with tsx (hot TypeScript execution)
npm test             # Run vitest unit tests
```

Node.js 24+ required.
