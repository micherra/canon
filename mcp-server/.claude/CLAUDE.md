# Canon MCP Server — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
TypeScript MCP (Model Context Protocol) server that provides tools for managing, enforcing, and tracking engineering principles across a codebase.

## Architecture
<!-- last-updated: 2026-03-22 -->

ES module TypeScript project using `@modelcontextprotocol/sdk` and `zod` for schema validation.

```
src/
├── index.ts              # Entry point — registers all MCP tools
├── parser.ts             # Frontmatter parsing for principle markdown files
├── matcher.ts            # Principle matching (layer/file_pattern/tags filtering)
├── schema.ts             # Zod schemas for report input
├── constants.ts          # Shared constants (layers, extensions, CANON_DIR)
├── tools/                # Tool implementations (one file per tool)
├── drift/                # Drift tracking — decisions, reviews, patterns (JSONL persistence)
├── graph/                # Dependency graph — scanner, import/export parsing, priority scoring
├── orchestration/        # Flow execution — board, bulletin, variables, gates, consultations
├── utils/                # Config loading, path handling, atomic writes, ID generation
└── __tests__/            # Vitest unit tests
```

**Key subsystems:**
- **Drift tracking** (`drift/`) — JSONL-backed store for decisions, patterns, reviews with auto-rotation
- **Dependency graph** (`graph/`) — Scans imports/exports (JS/TS/Python), computes in/out degree, detects cycles and hubs
- **Principle matching** (`matcher.ts`) — Context-aware filtering by layers, file patterns, tags, severity
- **Orchestration** (`orchestration/`) — Flow state machine runtime: board persistence, wave bulletin, variable resolution, gate execution, consultation preparation, wave briefing assembly

## Contracts
<!-- last-updated: 2026-03-25 -->

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
- Returns `UnifiedPrOutput` — `prep: PrReviewDataOutput` (always present), `has_review: boolean` (UI layout signal; `true` when a stored Canon review exists in DriftStore, `false` otherwise), plus `review?`, `blastRadius?`, `hotspots`, `subgraph`, `decisions` (populated when stored review exists, empty when not)
- `status` is always `"ok"` — no more `"no_review"` status; review field being absent signals no stored review
- Resource URI: `ui://canon/pr-review` (was `ui://canon/pr-impact`); HTML entry: `pr-review.html`

**`get_drift_report` tool** (`src/tools/get-drift-report.ts`):
- Output field `pr_reviews` is `ReviewEntry[]` (was `PrReviewEntry[]` until 2026-03-25); entries are filtered by `pr_number !== undefined || branch !== undefined`

**File Context** (`src/tools/get-file-context.ts`):
- `FileContextOutput` interface — fields: `file_path`, `layer`, `content`, `imports`, `imported_by`, `exports`, `violation_count`, `last_verdict`, `summary`, `violations`, `imports_by_layer`, `imported_by_layer`, `layer_stack`, `role`, `shape`, `project_max_impact`, `graph_metrics?`, `entities?`, `blast_radius?`
- `imported_by_layer: Record<string, string[]>` — mirrors `imports_by_layer`; groups reverse-dependency paths by their inferred layer
- `shape: { label: string; description: string }` — derived by `deriveShape(metrics)`: Sink (`in_degree>8, out_degree<4`), High fan-out hub (`in_degree<3, out_degree>8`), Central hub (`in_degree>5, out_degree>5`), Leaf (`in_degree===0`), Internal (default); label prefixed with `"Cycle member — "` when `in_cycle` is true
- `project_max_impact: number` — max `computeImpactScore()` across all graph nodes; `0` when no cached graph
- `FileBlastRadiusEntry` interface — fields: `name`, `qualified_name`, `kind`, `depth`, `file_path` (path of the file containing the entity; `""` if lookup fails)

**PR Review Data** (`src/tools/pr-review-data.ts`) — pure function module; `get_pr_review_data` MCP tool removed 2026-03-25 (absorbed into `show_pr_impact`); `getPrReviewData` function called internally by `showPrImpact`:
- `PrViolation` interface — `{ principle_id: string; severity: "rule"|"strong-opinion"|"convention"; message?: string }`
- `PrFileInfo` interface — fields: `path`, `layer`, `status`, `priority_score?`, `priority_factors?`, `bucket: "needs-attention"|"worth-a-look"|"low-risk"`, `reason: string`, `violations?: PrViolation[]`
- `PrReviewDataOutput` interface — fields: `files`, `layers`, `total_files`, `incremental`, `last_reviewed_sha?`, `diff_command`, `prioritized_files?`, `graph_data_age_ms?`, `error?`, `narrative: string`, `blast_radius: BlastRadiusEntry[]`
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
- Unified progressive container; no props — all data from `bridge.callTool("show_pr_impact")`
- Always renders: `NarrativeSummary`, `ChangeStoryGrid`, `ImpactTabs` (prep analysis from `data.prep.*`)
- Conditionally renders when `has_review` is true: `HotspotList` (panel-left) | `SubGraph` (panel-center) | `PrDetailPanel` (panel-right), plus `VerdictStrip`
- When no stored review: shows "Run Review" button that calls `bridge.sendMessage()`
- Staleness warning banner shown when `graph_data_age_ms > 3_600_000`
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
| `get_drift_report` | `ui://canon/drift-report` | Drift analysis: violations, trends, hotspots, PR reviews |
| `get_compliance` | `ui://canon/compliance` | Per-principle compliance stats, trend chart |
| `get_file_context` | `ui://canon/file-context` | File dependencies, entities, blast radius, metrics |
| `graph_query` | `ui://canon/graph-query` | Call trees, blast radius, dead code, search |

**Text-only principle/review tools:**

| Tool | Purpose |
|------|---------|
| `get_principles` | Find applicable principles for context (file, layer, task) |
| `list_principles` | Browse principle index (metadata only) |
| `review_code` | Surface principles for code review + code content |
| `report` | Log decisions/patterns/reviews (drift tracking) |
| `store_summaries` | Persist file summaries to disk |
| `get_decisions` | Grouped intentional deviations |
| `get_patterns` | Observed codebase patterns (grouped) |
| `store_pr_review` | Store a PR review result for drift tracking |

**Orchestration harness tools:**

| Tool | Purpose |
|------|---------|
| `load_flow` | Load and resolve a flow definition |
| `validate_flows` | Validate flow definitions |
| `init_workspace` | Create or resume a workspace; seeds `progress.md` (header `## Progress: {task}`) on new workspace creation |
| `enter_and_prepare_state` | **Combined hot-path tool**: check_convergence + update_board(enter_state) + get_spawn_prompt in one call; returns `{ can_enter, skip_reason, prompts }`; replaces the three-step sequence for the main state loop |
| `update_board` | Mutate board state (still used for skip_state, block, unblock, complete_flow, set_wave_progress) |
| `get_spawn_prompt` | Resolve spawn prompt; reads `progress.md` from disk and injects as `${progress}` when `flow.progress` is set; degrades gracefully to empty string if file absent |
| `report_result` | Record agent result and evaluate transitions |
| `check_convergence` | Check iteration limits |
| `list_overlays` | List available role overlays |
| `post_wave_bulletin` | Post inter-agent message during parallel waves |
| `get_wave_bulletin` | Read wave bulletin messages |
| `inject_wave_event` | Inject user events into running wave execution |
| `get_flow_analytics` | Flow execution analytics and bottleneck identification |

## Dependencies
<!-- last-updated: 2026-03-22 -->

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | MCP server/client implementation |
| `zod` | Runtime schema validation |
| `tsx` | TypeScript execution (dev) |
| `vitest` | Unit testing (dev) |

## Invariants
<!-- last-updated: 2026-03-24 -->

- All data persists to `.canon/` directory (decisions.jsonl, patterns.jsonl, reviews.jsonl, graph-data.json, summaries.json)
- JSONL files auto-rotate when exceeding size limits
- Atomic file writes prevent corruption on concurrent access
- `CANON_PROJECT_DIR` env var sets project root (defaults to `process.cwd()`)
- `CANON_PLUGIN_DIR` env var sets plugin directory (defaults to parent of mcp-server)
- Workspace subdirectories created by `initWorkspace`: `research/`, `decisions/`, `plans/`, `reviews/` — `notes/` is NOT created (removed 2026-03-24)
- `progress.md` is seeded at workspace creation and appended by the orchestrator after each `report_result`; agents treat it as read-only

## Development
<!-- last-updated: 2026-03-22 -->

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript (tsc → dist/)
npm start            # Run server with tsx (hot TypeScript execution)
npm test             # Run vitest unit tests
```

Node.js 24+ required.
