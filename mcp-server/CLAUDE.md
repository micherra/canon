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
<!-- last-updated: 2026-03-22 -->

Exposes 24 MCP tools (14 principle/review + 10 orchestration harness):

**Principle and review tools:**

| Tool | Purpose |
|------|---------|
| `get_principles` | Find applicable principles for context (file, layer, task) |
| `list_principles` | Browse principle index (metadata only) |
| `review_code` | Surface principles for code review + code content |
| `get_compliance` | Compliance stats for a specific principle |
| `report` | Log decisions/patterns/reviews (drift tracking) |
| `get_pr_review_data` | PR review prep (files, layers, diff commands, priorities) |
| `codebase_graph` | Generate dependency graph with compliance overlay |
| `get_file_context` | Rich file context (contents, imports, compliance) |
| `store_summaries` | Persist file summaries to disk |
| `get_dashboard_selection` | Current user focus from dashboard |
| `get_drift_report` | Full drift analysis (violations, trends, stats) |
| `get_decisions` | Grouped intentional deviations |
| `get_patterns` | Observed codebase patterns (grouped) |
| `store_pr_review` | Store a PR review result for drift tracking |

**Orchestration harness tools:**

| Tool | Purpose |
|------|---------|
| `load_flow` | Load and resolve a flow definition |
| `validate_flows` | Validate flow definitions |
| `init_workspace` | Create or resume a workspace |
| `update_board` | Mutate board state |
| `get_spawn_prompt` | Resolve spawn prompt for a state |
| `report_result` | Record agent result and evaluate transitions |
| `check_convergence` | Check iteration limits |
| `list_overlays` | List available role overlays |
| `post_wave_bulletin` | Post inter-agent message during parallel waves |
| `get_wave_bulletin` | Read wave bulletin messages |

## Dependencies
<!-- last-updated: 2026-03-22 -->

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | MCP server/client implementation |
| `zod` | Runtime schema validation |
| `tsx` | TypeScript execution (dev) |
| `vitest` | Unit testing (dev) |

## Invariants
<!-- last-updated: 2026-03-22 -->

- All data persists to `.canon/` directory (decisions.jsonl, patterns.jsonl, reviews.jsonl, graph-data.json, summaries.json)
- JSONL files auto-rotate when exceeding size limits
- Atomic file writes prevent corruption on concurrent access
- `CANON_PROJECT_DIR` env var sets project root (defaults to `process.cwd()`)
- `CANON_PLUGIN_DIR` env var sets plugin directory (defaults to parent of mcp-server)

## Development
<!-- last-updated: 2026-03-22 -->

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript (tsc → dist/)
npm start            # Run server with tsx (hot TypeScript execution)
npm test             # Run vitest unit tests
```

Node.js 24+ required.
