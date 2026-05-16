# Canon MCP Server — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
TypeScript MCP (Model Context Protocol) server that provides tools for managing, enforcing, and tracking engineering principles across a codebase.

## Architecture
<!-- last-updated: 2026-05-16 (build approval dashboard view added: BuildDashboard.svelte, DagGraph.svelte, TaskPlanCard.svelte, DecisionCard.svelte, build-dashboard.html, build-dashboard.ts, build-dashboard-types.ts, dag-layout.ts) -->

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
│   ├── orchestration/    # Orchestration tools — init_workspace, report, write-review, capture-transcript, etc.
│   ├── pr-review/        # show_pr_impact, review_code, store_pr_review
│   └── principles/       # get_principles, list_principles, get_compliance
├── graph/                # Legacy graph scanner — import/export parsing (being migrated to features/knowledge-graph)
├── orchestration/        # Legacy orchestration — execution store and schemas
├── platform/             # Infrastructure: adapters (git, process), job manager, workers, storage
├── shared/               # Shared kernel: constants, parser, matcher, schema, lib/ utilities
├── tests/                # Cross-cutting test helpers
└── ui/                   # Svelte frontend — MCP App (Sigma.js graph, PR review UI, build approval dashboard)
```

**Key subsystems:**
- **Drift tracking** (`platform/storage/drift/`) — JSONL-backed store for reviews with auto-rotation
- **Dependency graph** (`graph/`, `features/knowledge-graph/`) — SQLite KG via `KgQuery`/`KgStore`; scans imports/exports (JS/TS/Python), computes in/out degree, detects cycles and hubs; `graph/query.ts` and `graph/view-materializer.ts` deleted (ADR-005, 2026-04-01)
- **Community detection** (`graph/kg-community.ts`) — Louvain algorithm assigns `community_id` to each file in the KG; added 2026-05-02
- **Tag propagation** (`graph/kg-tags.ts`) — 4-signal pipeline (directory, imports, community, cross-ref) writes computed tags to `file_tags` table; used by `get-principles` and `get-file-context`; added 2026-05-02
- **Principle matching** (`shared/matcher.ts`) — Context-aware filtering by layers, file patterns, tags, severity; OR semantics: matches if layers OR scope.tags intersect (updated 2026-05-02)
- **Orchestration** (`orchestration/`, `features/orchestration/`) — Workspace lifecycle, board persistence, unified messaging, transcript capture, artifact writing tools

## Contracts
<!-- last-updated: 2026-05-16 (build-dashboard view: BuildDashboardData type + computeDagLayout added; VIEW_MAP extended; present_artifact type param updated) -->

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
- `graphQuery(input)` → `ToolResult<GraphQueryOutput>` (was `GraphQueryOutput`; `KG_NOT_INDEXED` is `recoverable: true`)
- `getFileContext(input)` → `Promise<ToolResult<FileContextOutput>>` (was `Promise<FileContextOutput>`)

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

**`CANON_FILES` constants** (`src/shared/constants.ts`) — updated ADR-005 2026-04-01; updated 2026-05-12 (principle overrides):
- `CANON_FILES.GRAPH_DATA` — REMOVED; `graph-data.json` no longer written
- `CANON_FILES.REVERSE_DEPS` — REMOVED; `reverse-deps.json` no longer written
- `CANON_FILES.SUMMARIES` — REMOVED; `summaries.json` no longer written
- Remaining keys: `CONFIG`, `KNOWLEDGE_DB`, `ORCHESTRATION_DB`, `DRIFT_DB`, `PRINCIPLE_OVERRIDES`
- `CANON_FILES.PRINCIPLE_OVERRIDES` — added 2026-05-12; value `"principle-overrides.yaml"`; path relative to `.canon/` in the project root

**`get-principles` tool** — loads KG computed tags via `loadKgFileData` and passes `computed_tags` to `matchPrinciples`; updated 2026-05-02

**Principle matcher** (`src/shared/matcher.ts`) — updated 2026-05-02; updated 2026-05-12 (principle overrides):
- `MatchFilters` type gained `computed_tags?: string[]` — KG-computed tags for the file being matched
- `matchPrinciples(principles, filters)` — now uses OR semantics: a principle matches if its layers intersect the file's layers OR its `scope.tags` intersect the file's `computed_tags`; previously layers-only
- `loadAllPrinciples(projectDir, pluginDir)` — behavior updated 2026-05-12: after merging project + plugin principles, reads `.canon/principle-overrides.yaml` (if present) and applies overrides before caching; signature unchanged; cache key now includes override file mtime
- Override actions supported: `disable` (omits principle entirely), `override-severity` (replaces severity), `narrow-scope` (replaces `principle.scope` — `layers` + `file_patterns`); unknown actions pass through unchanged
- Override file absence or malformed YAML returns empty overrides (no error); structural filter validates `principle_id`, `action`, and action-specific fields before applying
- `matchesScopeTags(principle, computedTags: string[]): boolean` — new export; returns `true` when principle `scope.tags` and `computedTags` share at least one tag

**`graph_query` tool** — entity results now include `computed_tags?`; new optional `min_confidence?` param; updated 2026-05-02

**Principles — Batch** (`get-principles.ts`) — `getPrinciplesBatch(input, projectDir, pluginDir)` deduplicates across files; returns `GetPrinciplesBatchOutput` with `principles[]`, `total_matched`, `total_in_canon`, `graph_context_by_file` — added 2026-04-30

**Tools with MCP App UIs** (each has its own `ui://canon/*` resource):

| Tool | UI Resource | Purpose |
|------|-------------|---------|
| `show_pr_impact` | `ui://canon/pr-review` | PR Review — change analysis (always), blast radius, hotspots, violations, subgraph (when stored review exists) |
| `codebase_graph` | `ui://canon/codebase-graph` | Interactive dependency graph with compliance overlay |
| `get_file_context` | `ui://canon/file-context` | File dependencies, entities, blast radius, metrics |
| `present_artifact` (build-dashboard) | `ui://canon/build-dashboard` | Build approval dashboard — brief summary, acceptance criteria, runbook, task DAG, task plans, design decisions, research notes; orchestrator passes `BuildDashboardData` payload |

**Build dashboard types** (`src/ui/stores/build-dashboard-types.ts`) — added 2026-05-16:
- `BuildDashboardData` — top-level payload delivered via `BridgeAdapter.loadData<BuildDashboardData>()`; fields: `brief: BriefSummary`, `acceptance_criteria: DashboardCriterion[]`, `runbook_steps: RunbookStep[]`, `dag: { nodes: DagNode[]; edges: DagEdge[] }`, `task_plans: TaskPlanEntry[]`, `design_decisions: DesignDecisionEntry[]`, `research_notes?: string`
- `BriefSummary` — `{ title: string; outcome: "GREENLIGHT" | "CAUTION" | "STOP"; effort: string; value: string }`
- `DashboardCriterion` — `{ index: number; text: string; type: "mechanical" | "manual" }`
- `DagNode` — `{ id: string; wave: number; files: string[]; depends_on: string[] }`
- `DagEdge` — `{ source: string; target: string }` (derived from `depends_on`)
- `TaskPlanEntry` — `{ task_id: string; wave: number; title: string; body: string; files: string[]; principles: string[] }`
- `DesignDecisionEntry` — `{ decision_id: string; title: string; status: string; body: string }`
- Imports `RunbookStep` from `planning-brief-types.ts` (no duplication)

**`computeDagLayout`** (`src/ui/lib/dag-layout.ts`) — added 2026-05-16:
- `computeDagLayout(nodes, options?): Map<string, { x: number; y: number }>` — pure function; Kahn's topological-layer algorithm; assigns Y by layer depth, X by even spacing within layer; `options: { layerSpacing?, nodeSpacing? }` (both default 100); unknown `depends_on` IDs are ignored (node treated as root); returns empty `Map` for empty input

**`present_artifact` VIEW_MAP** (`src/features/orchestration/tools/present-artifact.ts`) — updated 2026-05-16:
- `VIEW_MAP` now includes `"build-dashboard": "build-dashboard.html"` (in addition to `"planning-brief"`)
- `type` parameter description updated to enumerate both supported compiled view values

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

**`finalize_workspace` tool — `FinalizeWorkspaceResult`** (`src/features/orchestration/tools/orchestration-journal.ts`) — updated 2026-05-11:
- `digest_written?: boolean` — new optional field; present only when `complete` is true; true when build digest was written to Claude Code auto-memory directory; false on any write failure (best-effort, never throws); absent when `complete` is false

**`digest-writer` service** (`src/features/orchestration/services/digest-writer.ts`) — added 2026-05-11:
- `tryWriteBuildDigest(workspace: string): Promise<boolean>` — public entry point; best-effort, never throws; writes `build-digest-{date}-{slug}.md` to `~/.claude/projects/{dashed-project-path}/memory/` and appends an entry to `MEMORY.md`; returns false when auto-memory dir is missing, journal is malformed, or any write fails
- `resolveAutoMemoryDir(projectPath: string): string | null` — converts absolute project path to Claude Code dashed format; returns `null` when directory does not exist
- `extractDigestData(workspace: string): DigestData` — reads `journal.json`, `planning-brief.md`, and `reviews/*.md`; returns defaults when files are missing
- `formatDigestMarkdown(data: DigestData): string` — formats digest as Claude Code auto-memory markdown with YAML frontmatter (`metadata.type: project`)
- `formatMemoryIndexEntry(data: DigestData): string` — formats one-line MEMORY.md entry; truncates to 150 chars
- `DigestData` — local type (not in `history-types.ts`); fields: `slug`, `date`, `branch`, `totalDurationMs`, `totalSteps`, `stepsCompleted`, `stepsSkipped`, `fixIterations`, `reviewVerdict`, `violationCount`, `effortEstimate`, `valueEstimate`, `outcome`

**`capture_transcript` tool** (`src/features/orchestration/tools/capture-transcript.ts`) — added 2026-04-26 (NF-12):
- `CaptureTranscriptInput` — `{ workspace: string; step_id: string; agent_type: string; agent_id: string; session_id?: string; project_id?: string }`
- `CaptureTranscriptResult` — `{ transcript_path: string; entry_count: number; warning?: string }`
- `captureTranscript(input: CaptureTranscriptInput)` → `Promise<ToolResult<CaptureTranscriptResult>>`; best-effort: always returns `ok: true`; missing source emits `warning`, not error
- Output path is always inside `{workspace}/transcripts/` (path-traversal guard via `isPathContained`)
- `project_id` derived from `CANON_PROJECT_DIR` env var when not supplied; `session_id` from `CLAUDE_SESSION_ID`

**`resolve_after_consultations` tool** — pure resolution; reads `flow.states[state_id].consultations.after`; returns `ConsultationPromptEntry[]` for orchestrator to spawn; call after last wave before `report_result` — added 2026-03-26

**Analytics** (`src/platform/storage/drift/analytics.ts`) — added 2026-03-26:
- `FlowAnalytics` interface — `{ avg_gate_pass_rate?, avg_postcondition_pass_rate?, total_runs, runs_with_gate_data }`
- `computeAnalytics(entries: FlowRunEntry[])` — pure function; aggregates metrics across flow run entries; skips entries without gate data when computing averages
- `FlowRunEntry` new optional fields: `gate_pass_rate`, `postcondition_pass_rate`, `total_violations`, `total_test_results`, `total_files_changed`

**Orchestration harness tools:**

| Tool | Purpose |
|------|---------|
| `init_workspace` | Create or resume a workspace; seeds `progress.md` (header `## Progress: {task}`) on new workspace creation; creates build worktree at `{workspace}/worktree` on `canon/{slug}` branch (returned as `worktree_path` and `worktree_branch`); optional `preflight: true` checks git status, stale sessions, and active file claims before creating; when preflight finds issues, returns `workspace: ""` (empty string) and puts the candidate path in `candidate_workspace` — callers must check `preflight_issues` before using `workspace`; claim check is informational (non-blocking); resume checks `{workspace}/worktree` first, then legacy `.canon/worktrees/{slug}` fallback |
| `report` | Log reviews (drift tracking) |
| `write_plan_index` | Write a structured `INDEX.md` for wave execution to `{workspace}/plans/{slug}/INDEX.md`; validates task IDs (`/^[a-zA-Z0-9_-]+$/`), wave ≥ 1, no duplicates; returns `{ path, task_count, wave_count }` — added 2026-04-01 |
| `write_design_brief` | Write the architect's design brief to `{workspace}/plans/{slug}/` |
| `write_implementation_summary` | Write agent implementation summary to workspace artifacts |
| `write_review` | Write a review artifact to `{workspace}/reviews/` |
| `write_test_report` | Write a test report artifact to the workspace |
| `post_message` | Post a message to a workspace channel (unified messaging) |
| `get_messages` | Read messages from a workspace channel; supports `include_events` for wave events |
| `post_event` | Agent-callable tool for structured activity logging; input: `{ workspace, agent, action: "start"\|"complete", detail, artifacts?: string[] }`; stores `agent_activity` event in execution store's event log via `appendEvent`; returns `{ ok: true; event_type; agent; action; timestamp }` or `WORKSPACE_NOT_FOUND`/`INVALID_INPUT` on error — added 2026-04-07 |
| `batch_log_steps` | Log multiple steps in a single journal read-modify-write cycle; input: `{ workspace, steps: Array<{ step_id, status, agent_type?, artifacts_expected?, domain_skills_loaded?, outcome?, agent_id? }> }`; validates all entries upfront (fail-closed: entire batch rejected if any `step_id` is empty); runs transcript captures in parallel for completed entries with `agent_id`; returns `{ results: LogStepResult[] }`; registered only when `CANON_AGENT_TEAMS_MODE=on` — added 2026-04-30 |
| `log_step` | Log a single step in the orchestration journal (`orchestration-journal.ts`) |
| `capture_transcript` | Best-effort transcript capture; input: `{ workspace, step_id, agent_type, agent_id, session_id?, project_id? }`; reads CC agent JSONL from `{CLAUDE_CONFIG_DIR}/projects/{projectId}/{sessionId}/subagents/agent-{agentId}.jsonl`, transforms to Canon `TranscriptEntry[]`, writes to `{workspace}/transcripts/{step_id}--{agent_type}--{iso}.jsonl`; output: `{ transcript_path, entry_count, warning? }`; returns warning (never error) when source not found; `project_id` defaults to `CANON_PROJECT_DIR`-derived value; `session_id` defaults to `CLAUDE_SESSION_ID` env var — added 2026-04-26 (NF-12) |
| `get_transcript` | Read a captured transcript from the workspace |
| `resolve_agent_skills` | Resolve preloaded agent skill content (rules, references, primers, templates) for a given agent name |
| `invoke_janitor` | Run Canon janitor — WAL checkpoint, prune detection, lock cleanup |
| `seed_workspace` | Seed a workspace with initial content |
| `present_artifact` | Present an artifact to the user via the MCP App UI |

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

## Invariants
<!-- last-updated: 2026-05-12 (principle overrides graceful-degradation invariant added) -->

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
- `progress.md` is seeded at workspace creation; agents treat it as read-only
- All new schema fields in `flow-schema.ts` MUST be `.optional()` — `BoardSchema.parse()` must not throw on existing workspace `board.json` files
- **ADR-004 SQL stuck detection**: `ExecutionStore.recordIterationResult` must be called after each iteration before `isStuck` is queried; `isStuck` returns `false` (not stuck) when fewer than 2 results exist — added 2026-04-01
- **ADR-005 KG sole data source**: `graph/query.ts` and `graph/view-materializer.ts` deleted; SQLite KG (via `KgQuery`/`KgStore`) is the exclusive store for graph and summary data; no JSON artifacts are written for graph or summary data — added 2026-04-01
- **ADR-005 computeFileInsightMaps call pattern**: call `computeFileInsightMaps(db)` once per request and pass the `FileInsightMaps` result into `KgQuery.getFileMetrics()`; do not call `getFileMetrics()` in a loop without pre-computing insight maps — added 2026-04-01
- **worktree_path is the sole isolation signal** (2026-04-08; updated 2026-04-27): `SpawnPromptEntry` no longer carries `isolation`; `resolveToolProfile` permission_mode fallback uses `worktreePath ? "auto" : "prompt"` (not `isolation`); wave SpawnRequests with `worktree_path` are emitted with `isolation: "none"` — Canon owns the worktree lifecycle; `persistWaveTaskResult` stores the convention branch (`canon-wave/{task_id}`) unconditionally. **Build worktrees** are now created at `{workspace}/worktree` (was `.canon/worktrees/{slug}`); `tryResumeWorkspace` checks new path first with legacy fallback; agent-teams orchestrator passes `worktree_path` + `isolation: "none"` to all code-writing agents
- **file claims non-blocking** (2026-04-09): all claim operations in `init_workspace`, `update_board`, and `inject-coordination.ts` are wrapped in try/catch; claim failures never block workflow execution; overlap warnings are advisory strings in board metadata (`claim_warnings`), not errors
- **file claims lifecycle** (2026-04-09): claims are registered by `update_board set_metadata` (when `affected_files` is provided), checked as informational warnings by `init_workspace` preflight, and released by `update_board complete_flow`; do not call `file-claims.ts` functions directly from feature code outside these three integration points
- **optimistic locking on all board mutations** (2026-04-09): all `update_board` handlers read `version` once at entry via `store.getVersion()` and pass it to `store.updateExecutionVersioned()`; a stale version returns `BOARD_LOCKED` (recoverable: true); do not use `store.updateExecution()` in handler code — use `store.updateExecutionVersioned()` instead
- **syncBoardToStore is atomic** (2026-04-09): all writes in `syncBoardToStore` are wrapped in a single `store.transaction()`; partial writes cannot land — a version conflict aborts the entire sync and returns `{ ok: false, error: "version_conflict" }`; callers must check `result.ok`
- **SQLITE_BUSY is transparent to callers** (2026-04-09): `store.transaction()` internally retries via `withRetry`; callers do not need to handle `SQLITE_BUSY` themselves; `withRetry` does not retry other error codes
- **principle-overrides.yaml is optional and fail-open** (2026-05-12): absence of `.canon/principle-overrides.yaml` is not an error — `loadAllPrinciples` returns the unmodified merged set; malformed YAML and unreadable files also produce empty overrides (no throw); only structurally valid entries (with `principle_id`, `action`, and action-specific fields) are applied

## Development
<!-- last-updated: 2026-03-22 -->

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript (tsc → dist/)
npm start            # Run server with tsx (hot TypeScript execution)
npm test             # Run vitest unit tests
```

Node.js 24+ required.
