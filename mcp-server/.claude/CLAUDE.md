# Canon MCP Server — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
TypeScript MCP (Model Context Protocol) server that provides tools for managing, enforcing, and tracking engineering principles across a codebase.

## Architecture
<!-- last-updated: 2026-05-16 (post_message + get_messages MCP tools removed; messages.ts deleted) -->

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
│   ├── diagnostics/      # Drift reports, agent metrics, summary storage
│   ├── file-context/     # get_file_context tool
│   ├── knowledge-graph/  # graph_query, semantic_search, codebase_graph, git-intel
│   ├── orchestration/    # Flow engine, drive_flow, init_workspace, report_result, all orchestration tools
│   ├── pr-review/        # show_pr_impact, review_code, store_pr_review, present_review
│   ├── principles/       # get_principles, list_principles, get_compliance
│   └── prompt-pipeline/  # Prompt assembly, context enrichment, consultation pipeline
├── graph/                # Legacy graph scanner — import/export parsing (being migrated to features/knowledge-graph)
├── orchestration/        # Legacy orchestration — flow parser, execution store, schemas (being migrated to features/orchestration)
├── platform/             # Infrastructure: adapters (git, process), job manager, workers, storage
├── shared/               # Shared kernel: constants, parser, matcher, schema, lib/ utilities
├── tests/                # Cross-cutting test helpers
└── ui/
    └── snippets/         # HTML/CSS component recipes for agent-composed artifacts (9 files: verdict-banner, stats-card, bar-chart-row, severity-badge, compliance-bars, file-detail-card, file-summary-card, blast-radius-rings, blast-radius-tree); file-detail-card.html is Canvas-based (bezier dependency graph, 4-metric stat bar, entity table, blast radius panel) updated 2026-05-17; blast-radius-tree.html added 2026-05-17; DESIGN-SYSTEM.md is authoritative reference
```

**Key subsystems:**
- **Drift tracking** (`platform/storage/drift/`) — JSONL-backed store for reviews with auto-rotation
- **Dependency graph** (`graph/`, `features/knowledge-graph/`) — SQLite KG via `KgQuery`/`KgStore`; scans imports/exports (JS/TS/Python), computes in/out degree, detects cycles and hubs; `graph/query.ts` and `graph/view-materializer.ts` deleted (ADR-005, 2026-04-01)
- **Community detection** (`graph/kg-community.ts`) — Louvain algorithm assigns `community_id` to each file in the KG; added 2026-05-02
- **Tag propagation** (`graph/kg-tags.ts`) — 4-signal pipeline (directory, imports, community, cross-ref) writes computed tags to `file_tags` table; used by `get-principles` and `get-file-context`; added 2026-05-02
- **Principle matching** (`shared/matcher.ts`) — Context-aware filtering by layers, file patterns, tags, severity; OR semantics: matches if layers OR scope.tags intersect (updated 2026-05-02)
- **Orchestration** (`orchestration/`, `features/orchestration/`) — Flow state machine runtime: board persistence, variable resolution, gate execution, consultation preparation, wave briefing assembly, competitive flows, debate protocol


## Contracts
<!-- last-updated: 2026-05-16 (present_artifact + present_review fire-and-forget; Decision type + POST decision route removed) -->

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

**Drift DB schema** (`src/platform/storage/drift/drift-schema.ts`) — DRIFT_SCHEMA_VERSION = "4"; v4 adds `file_violation_history` (PK: file_path + principle_id) and `path_effects` (PK: file_path) tables; idempotent migrations. Updated 2026-05-15.

**DriftDbSignals DAO** (`src/platform/storage/drift/drift-db-signals.ts`) — sync DAO for `file_violation_history` and `path_effects`; methods: `getFileViolationHistory`, `upsertFileViolation`, `markFixed`, `getPathEffects`, `upsertPathEffect`. `DriftDb.getSignals()` is a lazy cached accessor. Added 2026-05-15.

**Drift Store** (`src/platform/storage/drift/store.ts`) — `ReviewEntry` is the unified type for all reviews (principle + PR); `PrStore` deleted 2026-03-25. `DriftStore.getReviews(options?)` AND-filters by principleId/branch/prNumber (see source for full signature).

**`show_pr_impact`** — unified PR analysis tool; returns `UnifiedPrOutput` with `has_review` boolean; `status` always `"ok"`; resource URI: `ui://canon/pr-review`
**`get_drift_report`** — `pr_reviews` field uses `ReviewEntry[]` (unified type); filters by pr_number/branch presence
**KgQuery** (`src/graph/kg-query.ts`) — `computeImpactScore`, `computeFileInsightMaps` (call once per request), `getFileMetrics`, `getSubgraph`; must call `computeFileInsightMaps` before `getFileMetrics` in loops (see source for full API)
**Git Intelligence** (`src/features/knowledge-graph/git-intel/`) — pipeline: git log → parse → churn scoring → co-change detection → persist atomically; `ensureGitIntelFresh` is the main entry point (no-op when fresh)
**Signal Compiler** (`src/features/diagnostics/services/signal-compiler.ts`) — `compileSignals(filePaths, driftDbSignals)` reads violation history + path effects, scores by priority, fits within per-file token budget; read-only
**`store-summaries`** — DB-only write path (JSON removed ADR-005); `inferLanguageFromExtension` maps extensions to language strings
**`CANON_FILES` constants** — remaining keys: `CONFIG`, `KNOWLEDGE_DB`, `ORCHESTRATION_DB`, `DRIFT_DB`
**Principle matcher** (`src/shared/matcher.ts`) — OR semantics: matches if layers OR scope.tags intersect; `matchesScopeTags` checks tag overlap
**`get-principles`** — loads KG computed tags and passes to `matchPrinciples`; tag matching active when KG indexed
**`get-file-context`** — surfaces `computed_tags`, `hotspot_score`, `co_change_partners`; `shape` derived from graph metrics (see `deriveShape` in source)
**PR Review Data** (`pr-review-data.ts`) — pure functions: `classifyFile` (bucket assignment), `generateNarrative`, `buildFileViolationMap`; `PrFileInfo.bucket` thresholds: needs-attention = violations OR high in_degree; worth-a-look = priority >= 5
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
| `graph_query` | Query codebase knowledge graph — callers, callees, blast radius, dead code, search |
| `store_pr_review` | Store a PR review result for drift tracking |

**Transcript capture** — best-effort; always returns `ok: true`; writes to `{workspace}/transcripts/`; path-traversal guarded
**Orchestration tools** — `resolve_after_consultations`: pure resolution, call after last wave before `report_result`; `resolve_wave_event`: apply/reject pending events, emits `wave_event_resolved`; `resolve_agent_skills`: **async** since 2026-05-20; applies progressive disclosure when `projectDir` provided — if `preload_prompt` exceeds 12k chars, full JSON is written to `.canon/artifacts/agent-skills-*.json` and result contains a compact summary + `full_data_path` pointer
**Gate runner** — `normalizeGates` resolves via 3-tier priority (direct > named > discovered); **fail-closed**: unresolved gate → `{ passed: false }`; `bash_check` denylist: `rm`, `sudo`, `curl`, `wget`, `chmod`, `chown`, `mkfs`, `dd`
**Flow schema** (`flow-schema.ts`) — `StateDefinitionSchema` is a `z.discriminatedUnion` with 5 type schemas; all new fields MUST be `.optional()`; `WavePolicy` defaults: isolation=worktree, merge=sequential, on_conflict=hitl
**`report_result`** — accepts quality signals (gate_results, postconditions, violations, tests, files_changed) + discovery fields (accumulated, not replaced); optional roles excluded from aggregation
**Analytics** — `computeAnalytics(entries)` aggregates flow run metrics; skips entries without gate data

**Orchestration harness tools:**

| Tool | Purpose |
|------|---------|
| `init_workspace` | Create or resume a workspace; seeds `progress.md` (header `## Progress: {task}`) on new workspace creation; creates build worktree at `{workspace}/worktree` on `canon/{slug}` branch (returned as `worktree_path` and `worktree_branch`); optional `preflight: true` checks git status, stale sessions, and active file claims before creating; when preflight finds issues, returns `workspace: ""` (empty string) and puts the candidate path in `candidate_workspace` — callers must check `preflight_issues` before using `workspace`; claim check is informational (non-blocking); resume checks `{workspace}/worktree` first, then legacy `.canon/worktrees/{slug}` fallback; `tryResumeWorkspace` accepts optional `expectedTask` — when provided and stored `session.task` differs, resume is blocked (returns null) to prevent slug-collision mismatches from `generateSlug` truncation |
| `load_flow` | Load and resolve a flow definition; throws (hard-blocking) on validation errors since ADR-004; reachability issues emit non-blocking warnings |
| `write_plan_index` | Write a structured `INDEX.md` for wave execution to `{workspace}/plans/{slug}/INDEX.md`; validates task IDs (`/^[a-zA-Z0-9_-]+$/`), wave ≥ 1, no duplicates; returns `{ path, task_count, wave_count }` — added 2026-04-01 |
| `drive_flow` | Drive the flow state machine for a single state; returns a `SpawnRequest` or `HitlBreakpoint` for the orchestrator to process; `{ action: "done" }` response includes optional `learn_gate_passed?: boolean` (ADR-016, 2026-04-08) — true only when auto-learn gates all pass at flow completion; absent when gate not evaluated or any gate failed |
| `update_board` | Mutate board state (still used for skip_state, block, unblock, complete_flow, set_wave_progress, set_metadata); `set_metadata` with `affected_files` (JSON array string) calls `registerClaims` + stores overlap warnings in board metadata as `claim_warnings`; `complete_flow` releases all file claims for the workflow slug before recording analytics — aggregates gate/postcondition/violation/test metrics from board states into `FlowRunEntry` |
| `report_result` | Record agent result and evaluate transitions; optional `progress_line` appends to progress.md server-side; accepts quality signal and discovery fields (see Contracts above) |
| `inject_wave_event` | Inject user events into running wave execution |
| `resolve_wave_event` | Resolve a pending wave event (apply or reject); wraps `markEventApplied`/`markEventRejected`/`resolveEventAgents`; emits `wave_event_resolved` on event bus |
| `resolve_after_consultations` | Resolve "after" consultation prompts for a state; call after last wave, before `report_result`; returns `ConsultationPromptEntry[]` for orchestrator to spawn |
| `record_agent_metrics` | Agent-callable tool to record performance counters (`tool_calls`, `orientation_calls`, `turns`) directly into execution state metrics; merges with existing metrics preserving orchestrator fields; returns `INVALID_INPUT` if no fields provided, `WORKSPACE_NOT_FOUND` if state not found — added 2026-04-01 (ADR-003a) |
| `post_event` | Agent-callable tool for structured activity logging; input: `{ workspace, agent, action: "start"\|"complete", detail, artifacts?: string[] }`; stores `agent_activity` event in execution store's event log via `appendEvent`; returns `{ ok: true; event_type; agent; action; timestamp }` or `WORKSPACE_NOT_FOUND`/`INVALID_INPUT` on error — added 2026-04-07 |
| `batch_log_steps` | Log multiple steps in a single journal read-modify-write cycle; input: `{ workspace, steps: Array<{ step_id, status, agent_type?, artifacts_expected?, domain_skills_loaded?, outcome?, agent_id? }> }`; validates all entries upfront (fail-closed: entire batch rejected if any `step_id` is empty); runs transcript captures in parallel for completed entries with `agent_id`; returns `{ results: LogStepResult[] }` — added 2026-04-30 |
| `capture_transcript` | Best-effort transcript capture; input: `{ workspace, step_id, agent_type, agent_id, session_id?, project_id? }`; reads CC agent JSONL from `{CLAUDE_CONFIG_DIR}/projects/{projectId}/{sessionId}/subagents/agent-{agentId}.jsonl`, transforms to Canon `TranscriptEntry[]`, writes to `{workspace}/transcripts/{step_id}--{agent_type}--{iso}.jsonl`; output: `{ transcript_path, entry_count, warning? }`; returns warning (never error) when source not found; `project_id` defaults to `CANON_PROJECT_DIR`-derived value; `session_id` defaults to `CLAUDE_SESSION_ID` env var — added 2026-04-26 (NF-12) |

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
- Workspace subdirectories created by `initWorkspace`: `artifacts/`, `decisions/`, `handoffs/`, `plans/`, `research/`, `reviews/`, `transcripts/` — `notes/` is NOT created (removed 2026-03-24); `artifacts/` added 2026-05-16 for HTML artifact storage
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
- **worktree_path is the sole isolation signal** (2026-04-08; updated 2026-04-27): `SpawnPromptEntry` no longer carries `isolation`; `resolveToolProfile` permission_mode fallback uses `worktreePath ? "auto" : "prompt"` (not `isolation`); wave SpawnRequests with `worktree_path` are emitted with `isolation: "none"` — Canon owns the worktree lifecycle; `persistWaveTaskResult` stores the convention branch (`canon-wave/{task_id}`) unconditionally. **Build worktrees** are now created at `{workspace}/worktree` (was `.canon/worktrees/{slug}`); `tryResumeWorkspace` checks new path first with legacy fallback; agent-teams orchestrator passes `worktree_path` + `isolation: "none"` to all code-writing agents
- **auto-approve settings injection** (2026-04-08): `injectSettingsIntoRequests` is called in all three spawn paths (`startNextWave`, `enterWaveState`, `tryEnterSingleState`) before returning `{ action: "spawn" }`; injection is conditional on `req.permission_mode === "auto"` AND `req.worktree_path` AND `req.tools`; `injectWorktreeSettings` failure returns `false` and never blocks spawn (fail-closed); agents that would have received auto-approve simply fall back to standard prompting
- **file claims non-blocking** (2026-04-09): all claim operations in `init_workspace`, `update_board`, and `inject-coordination.ts` are wrapped in try/catch; claim failures never block workflow execution; overlap warnings are advisory strings in board metadata (`claim_warnings`), not errors
- **file claims lifecycle** (2026-04-09): claims are registered by `update_board set_metadata` (when `affected_files` is provided), checked as informational warnings by `init_workspace` preflight, and released by `update_board complete_flow`; do not call `file-claims.ts` functions directly from feature code outside these three integration points
- **optimistic locking on all board mutations** (2026-04-09): all `update_board` handlers read `version` once at entry via `store.getVersion()` and pass it to `store.updateExecutionVersioned()`; a stale version returns `BOARD_LOCKED` (recoverable: true); do not use `store.updateExecution()` in handler code — use `store.updateExecutionVersioned()` instead
- **syncBoardToStore is atomic** (2026-04-09): all writes in `syncBoardToStore` are wrapped in a single `store.transaction()`; partial writes cannot land — a version conflict aborts the entire sync and returns `{ ok: false, error: "version_conflict" }`; callers must check `result.ok`
- **SQLITE_BUSY is transparent to callers** (2026-04-09): `store.transaction()` internally retries via `withRetry`; callers do not need to handle `SQLITE_BUSY` themselves; `withRetry` does not retry other error codes

## Development
<!-- last-updated: 2026-03-22 -->

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript (tsc → dist/)
npm start            # Run server with tsx (hot TypeScript execution)
npm test             # Run vitest unit tests
```

Node.js 24+ required.
