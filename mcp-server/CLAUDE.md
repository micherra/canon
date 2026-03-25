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
<!-- last-updated: 2026-03-24 -->

**Config utilities** (`src/utils/config.ts`):
- `buildLayerInferrer(mappings)` — now supports glob patterns (`*`, `**`, `?`) in addition to plain directory name segments; globs are anchored to path start
- `loadLayerMappingsStrict(projectDir)` — throws if no layer mappings configured in `.canon/config.json` (strict variant of `loadLayerMappings`)
- `loadGraphCompositionConfig(projectDir)` — reads `config.graph.composition` block; returns typed `GraphCompositionConfig` with defaults (`enabled: false`, `min_confidence: 0.5`, `max_refs_per_file: 50`)

**Tools with MCP App UIs** (each has its own `ui://canon/*` resource):

| Tool | UI Resource | Purpose |
|------|-------------|---------|
| `show_pr_impact` | `ui://canon/pr-impact` | PR blast radius, hotspots, violations, subgraph |
| `codebase_graph` | `ui://canon/codebase-graph` | Interactive dependency graph with compliance overlay |
| `get_drift_report` | `ui://canon/drift-report` | Drift analysis: violations, trends, hotspots, PR reviews |
| `get_compliance` | `ui://canon/compliance` | Per-principle compliance stats, trend chart |
| `get_file_context` | `ui://canon/file-context` | File dependencies, entities, blast radius, metrics |
| `get_pr_review_data` | `ui://canon/pr-review-prep` | PR file list by layer, priority scores, diff metadata |
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
| `update_board` | Mutate board state |
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
