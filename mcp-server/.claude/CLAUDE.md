# Canon MCP Server — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
TypeScript MCP (Model Context Protocol) server that provides tools for managing, enforcing, and tracking engineering principles across a codebase.

## Architecture
<!-- last-updated: 2026-04-01 (ADR-005: query.ts + view-materializer.ts deleted; KgQuery is sole graph query path) -->

ES module TypeScript project using `@modelcontextprotocol/sdk` and `zod` for schema validation.

```
src/
├── index.ts              # Entry point — registers all MCP tools (all handlers wrapped via wrapHandler)
├── parser.ts             # Frontmatter parsing for principle markdown files
├── matcher.ts            # Principle matching (layer/file_pattern/tags filtering)
├── schema.ts             # Zod schemas for report input
├── constants.ts          # Shared constants (layers, extensions, CANON_DIR)
├── tools/                # Tool implementations (one file per tool)
├── adapters/             # Privileged subprocess adapters (ADR-002): git-adapter.ts, git-adapter-async.ts, process-adapter.ts
├── drift/                # Drift tracking — reviews (JSONL persistence)
├── graph/                # Dependency graph — scanner, import/export parsing, priority scoring
├── orchestration/        # Flow execution — board, messaging, variables, gates, consultations, compete, debate
├── utils/                # Config loading, path handling, atomic writes, ID generation, tool-result.ts, wrap-handler.ts
└── __tests__/            # Vitest unit tests
```

**Key subsystems:**
- **Drift tracking** (`drift/`) — JSONL-backed store for reviews with auto-rotation
 - **Dependency graph** (`graph/`) — SQLite KG via `KgQuery`/`KgStore`; scans imports/exports (JS/TS/Python), computes in/out degree, detects cycles and hubs; `graph/query.ts` and `graph/view-materializer.ts` deleted (ADR-005, 2026-04-01)
- **Principle matching** (`matcher.ts`) — Context-aware filtering by layers, file patterns, tags, severity
- **Orchestration** (`orchestration/`) — Flow state machine runtime: board persistence, unified messaging, variable resolution, gate execution, consultation preparation, wave briefing assembly, competitive flows, debate protocol

## Contracts
<!-- last-updated: 2026-04-01 (ADR-003a: record_agent_metrics tool; widened metrics schema; updateStateMetrics on ExecutionStore; metrics footer in get_spawn_prompt) -->

**Tool error types** (`src/utils/tool-result.ts`) — added 2026-03-31 (ADR-002):
- `CanonErrorCode` — union of 9 string literals: `WORKSPACE_NOT_FOUND`, `FLOW_NOT_FOUND`, `FLOW_PARSE_ERROR`, `KG_NOT_INDEXED`, `BOARD_LOCKED`, `CONVERGENCE_EXCEEDED`, `INVALID_INPUT`, `PREFLIGHT_FAILED`, `UNEXPECTED`
- `CanonToolError` — `{ ok: false; error_code: CanonErrorCode; message: string; recoverable: boolean; context?: Record<string, unknown> }`
- `ToolResult<T>` — discriminated union `({ ok: true } & T) | CanonToolError`; all tool functions now return this type instead of throwing for expected errors
- `ProcessResult` — shared subprocess result: `{ ok: boolean; stdout: string; stderr: string; exitCode: number; timedOut: boolean }`
- `toolError(code, message, recoverable?, context?)` — constructs `CanonToolError`
- `toolOk<T>(data)` — constructs `{ ok: true } & T`; fields spread flat (no nested `data` wrapper)
- `isToolError(result)` — type guard; returns `true` when `ok === false` and `error_code` present
- `assertOk<T>(result)` — asserts `result is { ok: true } & T`; throws if error; intended for tests and callers that know the call must succeed

**Top-level MCP catch-all** (`src/utils/wrap-handler.ts`) — added 2026-03-31 (ADR-002):
- `wrapHandler<T>(handler)` — wraps any tool handler; catches unexpected throws and returns them as typed `UNEXPECTED` `CanonToolError`; all tool registrations in `index.ts` use this wrapper

**Subprocess adapters** (`src/adapters/`) — added 2026-03-31 (ADR-002); only files in this directory may import `node:child_process`:
- `git-adapter.ts`: `gitExec(args, cwd, timeout?)` → `ProcessResult` (sync, `shell` never `true`); `gitDiff(args, cwd, timeout?)` → `ProcessResult`; `gitStatus(cwd, timeout?)` → `ProcessResult`; default 30s timeout
- `git-adapter-async.ts`: `gitExecAsync(args, cwd, timeout?)` → `Promise<ProcessResult>`; never rejects; default 30s timeout
- `process-adapter.ts`: `runShell(command, cwd, timeout?)` → `ProcessResult` (sync, `shell: true`); 512KB maxBuffer; default 30s timeout

**Tool return types updated to `ToolResult<T>`** (ADR-002, 2026-03-31; ADR-004 updates 2026-04-01):
- `loadFlow(input, pluginDir, projectDir?)` → `Promise<ToolResult<LoadFlowResult>>` (was `Promise<LoadFlowResult>`); `LoadFlowResult.errors` field removed 2026-04-01 — validation errors now throw inside `loadAndResolveFlow`; `load-flow.ts` catches and returns `FLOW_PARSE_ERROR` or `FLOW_NOT_FOUND`
- `updateBoard(input)` → `Promise<ToolResult<UpdateBoardResult>>` (was `Promise<UpdateBoardResult>`)
- `graphQuery(input)` → `ToolResult<GraphQueryOutput>` (was `GraphQueryOutput`; `KG_NOT_INDEXED` is `recoverable: true`)
- `getFileContext(input)` → `Promise<ToolResult<FileContextOutput>>` (was `Promise<FileContextOutput>`)
- `enterAndPrepareState(input)` → `Promise<ToolResult<EnterAndPrepareStateResult>>` (was `Promise<EnterAndPrepareStateResult>`)
- `reportResult(input)` / `reportResultLocked(input)` → `Promise<ToolResult<ReportResultResult>>` (was `Promise<ReportResultResult>`)

**Flow parser** (`src/orchestration/flow-parser.ts`) — updated 2026-04-01 (ADR-004):
- `loadAndResolveFlow(pluginDir, flowName, projectDir?)` → `Promise<ResolvedFlow>` — **breaking**: was `Promise<{ flow: ResolvedFlow; errors: string[] }>`; now throws `Error` when hard validation errors exist; reachability warnings are non-blocking (prefixed `"Warning:"`)
- `validateSpawnCoverage(flow: ResolvedFlow): string[]` — new export; returns error strings for non-terminal states with no spawn instruction
- `analyzeReachability(flow: ResolvedFlow): string[]` — new export; returns `"Warning:"` prefixed strings for unreachable states; does not include `hitl` / `no_items` virtual sinks
- `checkUnresolvedRefs(flow: ResolvedFlow): string[]` — new export; returns error strings for spawn instructions or transition targets containing unresolved `${param}` references
- `validateStateIdParams(flow, fragmentParams, fragmentName)` — new export; validates that `state_id`-typed fragment params resolve to real states
- `VIRTUAL_SINKS: Set<string>` — new export; `{ "hitl", "no_items" }`
- `RUNTIME_VARIABLES: Set<string>` — new export; known runtime variable names exempt from ref checks

**Execution store** (`src/orchestration/execution-store.ts`) — updated 2026-04-01 (ADR-004); updated 2026-04-01 (ADR-003a):
- `ExecutionStore.recordIterationResult(stateId, iteration, status, data)` — new method; records raw iteration result in `iteration_results` table; `INSERT OR REPLACE` on `(state_id, iteration)` unique key
- `ExecutionStore.isStuck(stateId, stuckWhen: StuckWhen): boolean` — new method; SQL-based stuck detection; reads last two rows from `iteration_results`; returns `false` when fewer than 2 results exist; mirrors `stuck_when` logic for all 5 strategies
- Pure `isStuck` functions in `transitions.ts` are deprecated; prefer `ExecutionStore.isStuck`
- `ExecutionStore.updateStateMetrics(stateId, metrics: Record<string, number|string>): boolean` — added 2026-04-01 (ADR-003a); merges provided fields into existing `metrics` JSON via targeted SQL `UPDATE`; preserves orchestrator-written fields (`duration_ms`, `spawns`, `model`); returns `true` when row found and updated, `false` when state not found

**Execution schema** (`src/orchestration/execution-schema.ts`) — updated 2026-04-01 (ADR-004):
- `SCHEMA_VERSION = '3'` — new export; current DB schema version
- `runMigrations(db)` — new export; runs pending migrations against the given database; version-gated; each migration wrapped in a transaction for atomicity; safe to call repeatedly
- Migration v3 adds `iteration_results` table: `(id, state_id, iteration, status, data TEXT DEFAULT '{}', timestamp)` with `UNIQUE(state_id, iteration)` constraint and index on `state_id`

**Fragment param syntax** (`flows/fragments/*.md`) — updated 2026-04-01 (ADR-004):
- Typed param declarations replace null-marker `~` syntax in all 7 fragments with params; format: `param_name: { type: state_id|string|number|boolean, default?: value }`
- Old null-marker `~` format still accepted by `FragmentParamValueSchema` (backward compat); new typed format is canonical going forward
- `state_id`-typed params are validated against real state names by `validateStateIdParams` during `loadAndResolveFlow`

**Drift Store** (`src/drift/store.ts`):
- `ReviewEntry` — unified type for all reviews (principle and PR); optional PR fields: `pr_number?: number`, `branch?: string`, `last_reviewed_sha?: string`, `file_priorities?: Array<{ path: string; priority_score: number }>`
- `PrReviewEntry` — DELETED 2026-03-25; callers use `ReviewEntry` with optional PR fields
- `DriftStore.getReviews(options?: { principleId?: string; branch?: string; prNumber?: number }): Promise<ReviewEntry[]>` — all options AND-filter; old positional-string signature removed
- `DriftStore.getLastReviewForPr(prNumber: number): Promise<ReviewEntry | null>` — returns last matching entry or null
- `DriftStore.getLastReviewForBranch(branch: string): Promise<ReviewEntry | null>` — returns last matching entry or null
- `PrStore` class — DELETED 2026-03-25; all review persistence unified under `DriftStore` via `reviews.jsonl`

**`store_pr_review` tool** (`src/tools/store-pr-review.ts`):
- Output field: `review_id` (was `pr_review_id` until 2026-03-25); ID prefix is `rev_`

**`show_pr_impact` tool** (`src/tools/show-pr-impact.ts`):
- Unified tool — merges `show_pr_impact` and `get_pr_review_data` (removed 2026-03-25)
- Accepts optional `options?: { branch?: string; pr_number?: number; diff_base?: string; incremental?: boolean }` — all four exposed as top-level MCP input fields
- Always calls `getPrReviewData` internally for live diff analysis; optionally overlays stored review impact data when a Canon review exists in DriftStore
- Returns `UnifiedPrOutput` — `prep: PrReviewDataOutput` (always present), `has_review: boolean` (UI layout signal; `true` when a stored Canon review exists in DriftStore, `false` otherwise), plus `review?`, `blastRadius?`, `hotspots`, `subgraph` (populated when stored review exists)
- `status` is always `"ok"` — no more `"no_review"` status; review field being absent signals no stored review
- Resource URI: `ui://canon/pr-review` (was `ui://canon/pr-impact`); HTML entry: `pr-review.html`

**`get_drift_report` tool** (`src/tools/get-drift-report.ts`):
- Output field `pr_reviews` is `ReviewEntry[]` (was `PrReviewEntry[]` until 2026-03-25); entries are filtered by `pr_number !== undefined || branch !== undefined`

**Knowledge Graph types** (`src/graph/kg-types.ts`) — updated ADR-005 2026-04-01:
- `FileMetrics` interface — `{ in_degree, out_degree, is_hub, in_cycle, cycle_peers: string[], layer, layer_violation_count, layer_violations: LayerViolation[], impact_score }`
- `LayerViolation` interface — `{ target: string; source_layer: string; target_layer: string }`

**KgQuery** (`src/graph/kg-query.ts`) — updated ADR-005 2026-04-01:
- `computeImpactScore(inDegree, violationCount, isChanged, layer)` → `number` — re-exported (moved from deleted `query.ts`); uses `LAYER_CENTRALITY` from `constants.ts`
- `FileInsightMaps` interface — `{ hubPaths: Set<string>; cycleMemberPaths: Map<string, string[]>; layerViolationsByPath: Map<string, LayerViolation[]> }`
- `computeFileInsightMaps(db)` → `FileInsightMaps` — batch helper; call once per request, pass result to `getFileMetrics()` to avoid N+1 queries
- `KgQuery.getFileDegrees(fileId)` → `{ in_degree, out_degree }` — per-file degree from `file_edges`
- `KgQuery.getAllFileDegrees()` → `Map<number, { in_degree, out_degree }>` — all file degrees in one query
- `KgQuery.getFileAdjacencyList()` → `Map<number, number[]>` — full file-level adjacency list
- `KgQuery.getFileMetrics(filePath, insightMaps?, changedFiles?)` → `FileMetrics | null` — full structural metrics; `null` when file not in DB
- `KgQuery.getKgFreshnessMs()` → `number | null` — ms since oldest `last_indexed_at`; `null` when DB empty
- `KgQuery.getSubgraph(filePaths)` → `{ nodes, edges }` — subgraph for PR impact UI; nodes include `file_id` and `layer`

**`store-summaries.ts`** (`src/tools/store-summaries.ts`) — updated ADR-005 2026-04-01:
- `inferLanguageFromExtension(filePath)` → `string` — new export; maps `.ts`/`.tsx` → `"typescript"`, `.js`/`.jsx` → `"javascript"`, `.py` → `"python"`, `.md` → `"markdown"`, default `"unknown"`
- `loadSummariesFile` — REMOVED 2026-04-01 (ADR-005); DB is sole summary read path
- `flattenSummaries` — REMOVED 2026-04-01 (ADR-005); no longer needed
- `StoreSummariesOutput.path` — now returns SQLite DB path (was `summaries.json` path)
- `storeSummaries` — DB-only write; auto-stubs missing file rows via `upsertFile`; inits DB if absent; no JSON fallback

**`CANON_FILES` constants** (`src/constants.ts`) — updated ADR-005 2026-04-01:
- `CANON_FILES.GRAPH_DATA` — REMOVED; `graph-data.json` no longer written
- `CANON_FILES.REVERSE_DEPS` — REMOVED; `reverse-deps.json` no longer written
- `CANON_FILES.SUMMARIES` — REMOVED; `summaries.json` no longer written
- Remaining keys: `CONFIG`, `KNOWLEDGE_DB`, `ORCHESTRATION_DB`, `DRIFT_DB`

**File Context** (`src/tools/get-file-context.ts`):
- `FileContextOutput` interface — fields: `file_path`, `layer`, `content`, `imports`, `imported_by`, `exports`, `violation_count`, `last_verdict`, `summary`, `violations`, `imports_by_layer`, `imported_by_layer`, `layer_stack`, `role`, `shape`, `project_max_impact`, `graph_metrics?`, `entities?`, `blast_radius?`
- `imported_by_layer: Record<string, string[]>` — mirrors `imports_by_layer`; groups reverse-dependency paths by their inferred layer
- `shape: { label: string; description: string }` — derived by `deriveShape(metrics)`: Sink (`in_degree>8, out_degree<4`), High fan-out hub (`in_degree<3, out_degree>8`), Central hub (`in_degree>5, out_degree>5`), Leaf (`in_degree===0`), Internal (default); label prefixed with `"Cycle member — "` when `in_cycle` is true
- `project_max_impact: number` — max `computeImpactScore()` across all graph nodes; `0` when no cached graph
- `FileBlastRadiusEntry` interface — fields: `name`, `qualified_name`, `kind`, `depth`, `file_path` (path of the file containing the entity; `""` if lookup fails)

**PR Review Data** (`src/tools/pr-review-data.ts`) — pure function module; `get_pr_review_data` MCP tool removed 2026-03-25 (absorbed into `show_pr_impact`); `getPrReviewData` function called internally by `showPrImpact`:
- `PrViolation` interface — `{ principle_id: string; severity: "rule"|"strong-opinion"|"convention"; message?: string }`
- `PrFileInfo` interface — fields: `path`, `layer`, `status`, `priority_score?`, `priority_factors?`, `bucket: "needs-attention"|"worth-a-look"|"low-risk"`, `reason: string`, `violations?: PrViolation[]`
- `PrFileSummary` interface — `{ path: string; layer: string; status: "added"|"modified"|"deleted"|"renamed" }` — lightweight entry for clustering
- `PrReviewDataOutput` interface — fields: `files: PrFileSummary[]` (lightweight), `impact_files: PrFileInfo[]` (needs-attention OR priority_score >= 15 OR has violations), `layers`, `total_files`, `total_violations`, `net_new_files`, `incremental`, `last_reviewed_sha?`, `diff_command`, `kg_freshness_ms?` (was `graph_data_age_ms?`, renamed ADR-005 2026-04-01), `error?`, `narrative: string`, `blast_radius: BlastRadiusEntry[]`
- `BlastRadiusEntry` interface — `{ file: string; affected: Array<{ path: string; depth: number }> }`
- `classifyFile(file: Omit<PrFileInfo, "bucket"|"reason">)` — pure function; returns `{ bucket, reason }`; thresholds: needs-attention = `violation_count > 0` OR (`in_degree >= 5` AND `is_changed`); worth-a-look = `priority_score >= 5`; low-risk = else
- `generateNarrative(files, layers)` — pure function; returns human-readable summary string
- `buildFileViolationMap(reviews: ReviewEntry[]): Map<string, PrViolation[]>` — pure function; maps per-file violation lists from drift store reviews; no I/O

**UI clustering** (`ui/lib/clustering.ts`):
- `ClusterInput` type — `{ path: string; status: "added"|"modified"|"deleted"|"renamed"; layer?: string }`
- `Cluster` type — `{ id: string; title: string; description: string; type: "new-feature"|"removal"|"prefix-group"|"layer-group"|"other"; files: ClusterInput[] }`
- `clusterFiles(files: ClusterInput[]): Cluster[]` — pure function; groups files into <= 30-file clusters via 6-step algorithm (new-feature, removal, prefix, layer, merge-small, split-large); no cluster exceeds 30 files
- `findCommonPrefix(names: string[]): string | null` — pure; detects shared prefix up to `-`, `_`, or `.` boundary
- `synthesizeDescription(cluster: Cluster): string` — pure; returns human-readable cluster description
- `clusterIcon(type: Cluster["type"]): string` — returns emoji icon for cluster type

**UI bridge** (`ui/stores/bridge.ts`):
- `bridge.sendMessage(text: string): Promise<void>` — sends a user-role message via `app.sendMessage()`; throws if bridge not initialized; added 2026-03-25

**UI components** (`ui/components/`):
- `NarrativeSummary.svelte` — props: `narrative`, `totalFiles`, `layerCount`, `netNewFiles`, `violationCount`; pure display, no interactivity
- `ImpactRow.svelte` — props: `file` (PrFileInfo), `maxScore`, `onPrompt`; click fires `"Show me {filePath} and explain what changed"`
- `ViolationCard.svelte` — props: `file` (path), `violation` (PrViolation), `onPrompt`; severity pill colors from `SEVERITY_COLORS` in `constants.ts`; click fires `"Explain the {principleId} violation in {filePath} and how to fix it"`
- `DepRow.svelte` — props: `dep` (path), `relationship`, `riskAnnotation?`, `onPrompt`; click fires `"What breaks if {filePath} regresses? Show me the dependents"`
- `ChangeStoryGrid.svelte` — props: `files` (ClusterInput[]), `onPrompt`; computes `clusterFiles()` via `$derived`; renders 2-col card grid
- `ImpactTabs.svelte` — props: `files` (PrFileInfo[]), `blastRadius` (BlastRadiusEntry[]), `onPrompt`; three tabs: High Impact (`priority_score >= 15`), Violations (sorted rule > strong-opinion > convention), Critical Deps (files not in diff appearing in blast radius)

**PrReview.svelte** (`ui/PrReview.svelte`) — added 2026-03-25; replaces deleted `PrReviewPrep.svelte` and `PrImpact.svelte`:
- Unified progressive container; no props — all data from `bridge.waitForToolResult()` (via `useDataLoader`)
- Prep-only mode (`has_review === false`): run-review banner + header bar + `NarrativeSummary`, `ChangeStoryGrid`, staleness warning (when stale), `ImpactTabs`
- Review mode (`has_review === true`): `VerdictBanner`, `StatsRow`, then a 2-column grid dashboard — Row 1: `FixBeforeMerge` (left), `ViolationsByPrinciple` + `ComplianceScore` stacked (right); Row 2: `BlastRadiusChart` (left), `LayerChart` + `SubsystemsPanel` stacked (right)
- When no stored review: shows "Run Review" button that calls `bridge.sendMessage("Run a Canon review on this PR")`
- Staleness warning banner shown when `kg_freshness_ms > 3_600_000` (field renamed from `graph_data_age_ms` ADR-005 2026-04-01)
- `PrReviewPrep.svelte` — DELETED 2026-03-25 (absorbed into `PrReview.svelte`)
- `PrImpact.svelte` — DELETED 2026-03-25 (absorbed into `PrReview.svelte`)

**Config utilities** (`src/utils/config.ts`):
- `buildLayerInferrer(mappings)` — now supports glob patterns (`*`, `**`, `?`) in addition to plain directory name segments; globs are anchored to path start
- `loadLayerMappingsStrict(projectDir)` — throws if no layer mappings configured in `.canon/config.json` (strict variant of `loadLayerMappings`)
- `loadGraphCompositionConfig(projectDir)` — reads `config.graph.composition` block; returns typed `GraphCompositionConfig` with defaults (`enabled: false`, `min_confidence: 0.5`, `max_refs_per_file: 50`)

**Tools with MCP App UIs** (each has its own `ui://canon/*` resource):

| Tool | UI Resource | Purpose |
|------|-------------|---------|
| `show_pr_impact` | `ui://canon/pr-review` | PR Review — change analysis (always), blast radius, hotspots, violations, subgraph (when stored review exists) |
| `codebase_graph` | `ui://canon/codebase-graph` | Interactive dependency graph with compliance overlay |
| `get_file_context` | `ui://canon/file-context` | File dependencies, entities, blast radius, metrics |

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

**`resolve_after_consultations` tool** (`src/tools/resolve-after-consultations.ts`) — added 2026-03-26:
- Input: `ResolveAfterConsultationsInput` — `{ workspace: string; state_id: string; flow: ResolvedFlow; variables: Record<string, string> }`
- Output: `ResolveAfterConsultationsResult` — `{ consultation_prompts: ConsultationPromptEntry[]; warnings: string[] }`
- Pure resolution function — no board reads, no state entry, no convergence check; runs at the post-wave lifecycle breakpoint
- Reads `flow.states[state_id].consultations.after`; unresolvable names produce warnings (not errors) and are skipped
- Call after the last wave completes and before `report_result`; orchestrator spawns the returned consultation agents, records results with breakpoint `"after"`, then proceeds to `report_result`
- After-consultation summaries are automatically picked up by the next state's `enterAndPrepareState` via the briefing injection pipeline

**`resolve_wave_event` tool** (`src/tools/resolve-wave-event.ts`) — added 2026-03-26:
- Input: `ResolveWaveEventInput` — `{ workspace: string; event_id: string; action: "apply"|"reject"; resolution?: Record<string, unknown>; reason?: string }`
- Output: `ResolveWaveEventResult` — `{ event_id, action, agents: string[], descriptions: Record<string, string>, pending_count: number }`
- Validates: `action === "reject"` requires `reason`; throws `"Event not found"` if `event_id` absent; throws `"Event {id} is already {status}"` if event is not pending
- Calls `markEventApplied` (with optional `resolution`) or `markEventRejected` (with `reason`) then `resolveEventAgents(event.type)`
- Emits `wave_event_resolved` on event bus after mutation; acquires board lock for full duration
- `resolveEventAgents("guidance")` returns `{ agents: [], descriptions: {} }` — guidance events are mechanical orchestrator operations, no agent spawn needed (changed from `["canon-guide"]` 2026-03-26)

**Event bus** (`src/orchestration/events.ts`):
- `FlowEventType` union includes `"wave_event_resolved"` (added 2026-03-26, after `"wave_event_injected"`)
- `FlowEventMap["wave_event_resolved"]` — `{ eventId, eventType, action: "apply"|"reject", workspace, timestamp }`

**Gate runner** (`src/orchestration/gate-runner.ts`):
- `normalizeGates(stateDef, flow, cwd, boardState?)` — resolves gate commands via 3-tier priority: `stateDef.gates[]` (direct shell commands) > `stateDef.gate` (named reference via `resolveGateCommand()`) > `boardState.discovered_gates[]` (agent-reported); returns `{ commands, source }` where source ∈ `"gates"|"gate"|"discovered"|"none"`
- `runGates(stateDef, flow, cwd, boardState?)` — executes all normalized gates via `runShell` (process-adapter); returns `GateResult[]`; empty array when no gates declared
- `runGate(gateName, flow, cwd)` — run a single named gate; **fail-closed**: unresolved gate name returns `{ passed: false, exitCode: 1 }` (changed from `passed: true` 2026-03-26)
- `GateResult` type — re-exported from `flow-schema.ts`; `{ passed, gate, command, output, exitCode }`

**Contract checker** (`src/orchestration/contract-checker.ts`) — added 2026-03-26:
- `resolvePostconditions(explicit?, discovered?)` — explicit YAML array takes priority over agent-discovered; returns empty array when neither present
- `evaluatePostconditions(assertions, cwd, baseCommit?)` — evaluates all assertions deterministically; returns `PostconditionResult[]`; never throws
- Assertion types: `file_exists`, `file_changed`, `pattern_match`, `no_pattern`, `bash_check`
- `bash_check` denylist: `rm`, `sudo`, `curl`, `wget`, `chmod`, `chown`, `mkfs`, `dd` — blocked before execution

**Flow schema types** (`src/orchestration/flow-schema.ts`) — added 2026-03-26; updated 2026-04-01 (ADR-004):
- `GateResultSchema` / `GateResult` — gate execution result; source of truth (replaces former local interface in gate-runner)
- `DiscoveredGateSchema` / `DiscoveredGate` — `{ command: string; source: string }` for agent-reported gate discovery
- `PostconditionAssertionSchema` / `PostconditionAssertion` — typed assertion `{ type, target, pattern?, command? }`
- `PostconditionResultSchema` / `PostconditionResult` — `{ passed, name, type, output }`
- `ViolationSeveritiesSchema` / `ViolationSeverities` — `{ blocking: number; warning: number }`
- `TestResultsSchema` / `TestResults` — `{ passed: number; failed: number; skipped: number }`
- `StateDefinitionSchema` now accepts `gates?: string[]` and `postconditions?: PostconditionAssertion[]`
- `EffectTypeSchema` now includes `"check_postconditions"` — triggers contract checker on the state's postconditions
- `StateMetricsSchema` fields (`duration_ms`, `spawns`, `model`) are now `.optional()`; 7 optional contract-checker fields: `gate_results`, `postcondition_results`, `violation_count`, `violation_severities`, `test_results`, `files_changed`, `revision_count`; 7 optional agent-performance fields added 2026-04-01 (ADR-003a): `tool_calls`, `orientation_calls`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `turns` — all accepted by `report_result` and `report_and_enter_next_state`; `tool_calls`, `orientation_calls`, `turns` also writable via `record_agent_metrics` tool
- `BoardStateEntrySchema` new optional fields: `gate_results`, `postcondition_results`, `discovered_gates`, `discovered_postconditions`
- `StateDefinitionSchema` is now a `z.discriminatedUnion("type", [...])` — updated 2026-04-01 (ADR-004); five per-type schemas exported: `SingleStateSchema`, `WaveStateSchema`, `ParallelStateSchema`, `ParallelPerStateSchema`, `TerminalStateSchema`; corresponding TS types also exported: `SingleState`, `WaveState`, `WavePolicy`, `ParallelState`, `ParallelPerState`, `TerminalState`
- `WavePolicySchema` / `WavePolicy` — optional config on `WaveStateSchema`; fields: `isolation` (`"worktree"|"branch"|"none"`, default `"worktree"`), `merge_strategy` (`"sequential"|"rebase"|"squash"`, default `"sequential"`), `on_conflict` (`"hitl"|"replan"|"retry-single"`, default `"hitl"`), `gate?`, `coordination?`; defaults applied at parse time; absent `wave_policy` on a wave state uses these defaults
- `TypedParamSchema` / `TypedParam` — fragment typed param declaration: `{ type: "state_id"|"string"|"number"|"boolean"; default?: string|number|boolean }`
- `FragmentParamValueSchema` / `FragmentParamValue` — accepts both old null-marker format and new typed format; backward compatible
- `FragmentStateDefinitionSchema` — discriminated union mirroring `StateDefinitionSchema` with relaxed fields for fragment substitution

**Analytics** (`src/drift/analytics.ts`) — added 2026-03-26:
- `FlowAnalytics` interface — `{ avg_gate_pass_rate?, avg_postcondition_pass_rate?, total_runs, runs_with_gate_data }`
- `computeAnalytics(entries: FlowRunEntry[])` — pure function; aggregates metrics across flow run entries; skips entries without gate data when computing averages
- `FlowRunEntry` new optional fields: `gate_pass_rate`, `postcondition_pass_rate`, `total_violations`, `total_test_results`, `total_files_changed`

**`report_result` tool** (`src/tools/report-result.ts`) — new optional input fields added 2026-03-26:
- Quality signal fields: `gate_results?: GateResult[]`, `postcondition_results?: PostconditionResult[]`, `violation_count?: number`, `violation_severities?: ViolationSeverities`, `test_results?: TestResults`, `files_changed?: number`
- Discovery fields: `discovered_gates?: DiscoveredGate[]`, `discovered_postconditions?: PostconditionAssertion[]` — accumulated (append, not replace) on `BoardStateEntry`
- `gate_results` and `postcondition_results` stored both in `metrics` and top-level `BoardStateEntry` for quick access
- `revision_count` auto-computed from `board.iterations[state_id].count` — not caller-supplied
- Backward compat: callers providing no new fields get exactly the old behavior (no `metrics` entry written)
- Optional role handling (added 2026-03-26): when aggregating parallel results, roles marked `optional: true` in `stateDef.roles` are excluded from blocking and cannot_fix determination; only required roles determine the aggregated condition

**Parallel transitions** (`src/orchestration/transitions.ts`) — updated 2026-03-26:
- `isRoleOptional(entry: string | { name: string; optional?: boolean }): boolean` — exported helper; returns `true` if entry has `optional: true`
- `aggregateParallelPerResults(results, optionalRoles?: Set<string>)` — second parameter added; results whose `item` name is in `optionalRoles` are excluded from blocking/cannot_fix/done determination; all-required-done or zero required roles resolves to `"done"`

**Orchestration harness tools:**

| Tool | Purpose |
|------|---------|
| `init_workspace` | Create or resume a workspace; seeds `progress.md` (header `## Progress: {task}`) on new workspace creation; optional `preflight: true` checks git status and stale sessions before creating; when preflight finds issues, returns `workspace: ""` (empty string) and puts the candidate path in `candidate_workspace` — callers must check `preflight_issues` before using `workspace` |
| `load_flow` | Load and resolve a flow definition; throws (hard-blocking) on validation errors since ADR-004; reachability issues emit non-blocking warnings |
| `write_plan_index` | Write a structured `INDEX.md` for wave execution to `{workspace}/plans/{slug}/INDEX.md`; validates task IDs (`/^[a-zA-Z0-9_-]+$/`), wave ≥ 1, no duplicates; returns `{ path, task_count, wave_count }` — added 2026-04-01 |
| `enter_and_prepare_state` | **Combined hot-path tool**: check_convergence + update_board(enter_state) + get_spawn_prompt in one call; returns `{ can_enter, skip_reason, prompts }`; replaces the three-step sequence for the main state loop; briefing injection scans all three breakpoints: `before`, `between`, and `after` |
| `update_board` | Mutate board state (still used for skip_state, block, unblock, complete_flow, set_wave_progress); at `complete_flow` aggregates gate/postcondition/violation/test metrics from board states into `FlowRunEntry` |
| `get_spawn_prompt` | Resolve spawn prompt; reads progress from `ExecutionStore.getProgress()` (SQLite) and injects as `${progress}` when `flow.progress` is set; degrades gracefully to empty string if absent; appends metrics instruction footer to every prompt entry (added 2026-04-01 ADR-003a) — footer contains concrete `workspace` and `state_id` values so agents receive a runnable `record_agent_metrics` invocation example. Internally uses a 9-stage prompt assembly pipeline (ADR-006). `consultation_outputs` no longer require pre-escaping — the pipeline handles escaping at read boundaries (stage 6). |
| `report_result` | Record agent result and evaluate transitions; optional `progress_line` appends to progress.md server-side; accepts quality signal and discovery fields (see Contracts above) |
| `check_convergence` | Check iteration limits |
| `post_message` | Post a message to a workspace channel (unified messaging) |
| `get_messages` | Read messages from a workspace channel; supports `include_events` for wave events |
| `inject_wave_event` | Inject user events into running wave execution |
| `resolve_wave_event` | Resolve a pending wave event (apply or reject); wraps `markEventApplied`/`markEventRejected`/`resolveEventAgents`; emits `wave_event_resolved` on event bus |
| `resolve_after_consultations` | Resolve "after" consultation prompts for a state; call after last wave, before `report_result`; returns `ConsultationPromptEntry[]` for orchestrator to spawn |
| `record_agent_metrics` | Agent-callable tool to record performance counters (`tool_calls`, `orientation_calls`, `turns`) directly into execution state metrics; merges with existing metrics preserving orchestrator fields; returns `INVALID_INPUT` if no fields provided, `WORKSPACE_NOT_FOUND` if state not found — added 2026-04-01 (ADR-003a) |
| `write_handoff` | Write a structured handoff file to `{workspace}/handoffs/{type}.md`; validates content against a per-type Zod schema selected from a schema map (CONTENT_SCHEMAS) via safeParse; returns `{ path, type }` |

## Dependencies
<!-- last-updated: 2026-03-26 -->

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | MCP server/client implementation |
| `zod` | Runtime schema validation |
| `gray-matter` | YAML frontmatter parsing in `parser.ts` (replaced hand-rolled parser 2026-03-26) |
| `tsx` | TypeScript execution (dev) |
| `vitest` | Unit testing (dev) |

## Invariants
<!-- last-updated: 2026-04-01 (ADR-005: KG sole data source, computeFileInsightMaps call pattern) -->

- **ADR-002 subprocess isolation**: Only files in `src/adapters/` may import `node:child_process`; all `tools/` and `orchestration/` code must use adapter functions (`gitExec`, `gitExecAsync`, `runShell`) — added 2026-03-31
- **ADR-002 ToolResult contract**: Tools return `ToolResult<T>` for all expected error conditions; unexpected errors are caught by `wrapHandler` and returned as `UNEXPECTED` `CanonToolError`; tools never throw for expected conditions — added 2026-03-31
- **ADR-002 security boundary**: `git-adapter.ts` never sets `shell: true`; `process-adapter.ts` sets `shell: true` for arbitrary shell commands; the two adapters must not be interchanged for git operations — added 2026-03-31
- All subprocess adapters enforce a default 30s timeout; callers may pass an explicit timeout override — added 2026-03-31
- All data persists to `.canon/` directory (reviews.jsonl, knowledge-graph.db, orchestration.db, drift.db); `graph-data.json`, `summaries.json`, `reverse-deps.json` no longer written (removed ADR-005 2026-04-01)
- JSONL files auto-rotate when exceeding size limits
- Atomic file writes prevent corruption on concurrent access
- `CANON_PROJECT_DIR` env var sets project root (defaults to `process.cwd()`)
- `CANON_PLUGIN_DIR` env var sets plugin directory (defaults to parent of mcp-server)
- Workspace subdirectories created by `initWorkspace`: `research/`, `decisions/`, `plans/`, `reviews/`, `transcripts/`, `handoffs/` — `notes/` is NOT created (removed 2026-03-24)
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

## Development
<!-- last-updated: 2026-03-22 -->

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript (tsc → dist/)
npm start            # Run server with tsx (hot TypeScript execution)
npm test             # Run vitest unit tests
```

Node.js 24+ required.
