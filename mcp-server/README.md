# Canon MCP Server

TypeScript MCP server providing 24 tools for principle enforcement and build orchestration. This is the runtime core of Canon — it powers principle matching, drift tracking, codebase graph analysis, and the flow state machine that drives multi-agent builds.

This document is for contributors and power users. The main project README links here for internals.

## Architecture

ES module TypeScript project using `@modelcontextprotocol/sdk` and `zod` for schema validation. Communicates over stdio using the Model Context Protocol.

```
src/
├── index.ts              # Entry point — registers all 24 MCP tools
├── parser.ts             # Frontmatter parsing for principle markdown files
├── matcher.ts            # Principle matching by layer, file pattern, and tags
├── schema.ts             # Zod schemas for the report tool input
├── constants.ts          # Shared constants (layers, extensions, CANON_DIR)
├── tools/                # One file per MCP tool implementation
├── drift/                # JSONL-backed stores: decisions, patterns, PR reviews
├── graph/                # Dependency graph: scanner, import/export parsing, priority scoring
├── orchestration/        # Flow state machine runtime: board, bulletin, variables, gates
├── utils/                # Config loading, path handling, atomic writes, ID generation
└── __tests__/            # Vitest unit tests
```

### Key subsystems

**`tools/`** — One file per MCP tool. Each tool file exports a single function that takes validated input and returns a plain object. `index.ts` registers them all with `server.registerTool()` and wraps results in a standard JSON response envelope.

**`drift/`** — JSONL-backed persistence for the three observation types: decisions (intentional deviations), patterns (observed code conventions), and PR reviews. `jsonl-store.ts` handles append and rotation at 500 entries. `analyzer.ts` and `reporter.ts` compute drift statistics and trend analysis from the raw JSONL data.

**`graph/`** — Dependency graph scanner for JS/TS/Python source files. `scanner.ts` walks the directory tree. `import-parser.ts` and `export-parser.ts` extract dependency edges. `degree.ts` computes in-degree and out-degree for each node. `priority.ts` scores files by graph centrality (used to prioritize review effort). `insights.ts` detects cycles, hub files, and orphaned modules.

**`orchestration/`** — Flow state machine runtime used by the orchestrator agent.
- `board.ts` — Reads and writes `board.json` (the persistent state machine record for a workspace)
- `bulletin.ts` — Appends to and reads `bulletin.jsonl` for inter-agent messaging during parallel wave execution
- `variables.ts` — Resolves `{{variable}}` substitutions in spawn prompts, pulling values from board state, session, and wave context
- `gate-runner.ts` — Evaluates between-wave gate conditions before advancing to the next wave
- `flow-parser.ts` — Parses flow YAML frontmatter and markdown spawn instructions, resolves fragment includes
- `transitions.ts` — Evaluates transition conditions and selects the next state based on agent status keywords
- `convergence.ts` — Tracks iteration counts to enforce loop limits and detect stuck agents
- `wave-briefing.ts` — Assembles per-agent context packages for parallel wave execution

**`utils/`** — Shared helpers: `atomic-write.ts` (write-then-rename to prevent corruption), `config.ts` (loads `.canon/config.json` and builds layer inferrers), `paths.ts` (workspace and CANON_DIR resolution), `id.ts` (ID generation for drift records).

**`matcher.ts`** — Context-aware principle filtering. Given a file path, layers, and tags, it walks the `principles/` directory (across severity subdirectories: `rules/`, `strong-opinions/`, `conventions/`), applies glob patterns and layer mappings, and returns matched principles ranked by severity. Caches compiled glob regexes to avoid recompilation on repeated calls.

**`parser.ts`** — Extracts YAML frontmatter from principle markdown files and parses principle metadata (id, severity, layers, tags, summary, body).

## Tools

### Principle and review tools (14)

| Tool | Description |
|------|-------------|
| `get_principles` | Returns Canon principles relevant to the current coding context. Call before generating code. |
| `list_principles` | Browse the full Canon principle index. Returns metadata only (no full body) for efficient browsing. |
| `review_code` | Returns Canon principles relevant to a file for review. The calling agent evaluates compliance — this tool provides the matched principles and code. |
| `get_compliance` | Returns compliance stats for a specific Canon principle. Shows violation counts, compliance rate, and trend. |
| `report` | Log a Canon observation: an intentional deviation (decision), an observed codebase pattern, or a code review result. All feed into drift tracking and the learning loop. |
| `get_drift_report` | Returns a full drift report — compliance rates, most violated principles, hotspot directories, trend, and recommendations. |
| `get_decisions` | Returns intentional deviation decisions grouped by principle, with category counts. |
| `get_patterns` | Returns observed codebase patterns logged by agents, grouped and deduplicated. |
| `get_pr_review_data` | Get PR review data — file list, layer grouping, diff command, and graph-aware review priority for a pull request or branch review. |
| `codebase_graph` | Generate a dependency graph of the codebase with Canon compliance overlay. Full graph is persisted to `.canon/graph-data.json`. Returns a compact summary. |
| `get_file_context` | Get rich context for a source file — contents (up to 200 lines), graph relationships (imports/imported_by), exported names, layer, and compliance data. |
| `store_summaries` | Store file summaries to `.canon/summaries.json`. Merges with existing summaries so you can generate them incrementally. |
| `store_pr_review` | Store a PR review result for drift tracking. Server generates `pr_review_id` and timestamp. |
| `get_dashboard_selection` | Returns the user's current focus from the Canon dashboard — selected graph node and active editor file with matched principles. |

### Orchestration harness tools (10)

| Tool | Description |
|------|-------------|
| `load_flow` | Load and resolve a Canon flow definition. Returns the resolved flow with fragment resolution, spawn instructions, and a state adjacency graph. |
| `validate_flows` | Validate Canon flow definitions. Checks parsing, fragment resolution, transition targets, reachability, and terminal state accessibility. |
| `init_workspace` | Initialize a Canon workspace for flow execution. Creates workspace directory, `session.json`, and `board.json`. Resumes from existing board if present. |
| `update_board` | Perform board state mutations. Supports entering, skipping, blocking, unblocking states, completing flow, and setting wave progress. |
| `get_spawn_prompt` | Resolve spawn prompts for a flow state. Substitutes variables, applies templates, and fans out by state type (single/parallel/wave/parallel-per). |
| `report_result` | Report an agent's result. Normalizes status, evaluates transitions, updates board state, checks stuck detection. Returns next state and whether HITL is required. |
| `check_convergence` | Check whether a state can be re-entered based on iteration limits. Returns iteration count, max, cannot-fix items, and history. |
| `list_overlays` | List available role overlays. Overlays are expertise lenses injected into agent spawn prompts. Optionally filter by target agent. |
| `post_wave_bulletin` | Post a message to the wave bulletin for inter-agent communication during parallel execution. |
| `get_wave_bulletin` | Read messages from the wave bulletin. Returns messages posted by other agents in the same wave, optionally filtered by timestamp or type. |

## Data persistence

All runtime data lives under `.canon/` in the project root:

| File | Written by | Purpose |
|------|-----------|---------|
| `decisions.jsonl` | `report` tool | Intentional deviation records |
| `patterns.jsonl` | `report` tool | Observed codebase patterns |
| `reviews.jsonl` | `store_pr_review` tool | PR review results |
| `graph-data.json` | `codebase_graph` tool | Full dependency graph snapshot |
| `summaries.json` | `store_summaries` tool | File-level summaries |
| `workspaces/{slug}/board.json` | `init_workspace`, `update_board` | Flow state machine record |
| `workspaces/{slug}/session.json` | `init_workspace` | Session metadata (flow, branch, tier) |
| `workspaces/{slug}/bulletin.jsonl` | `post_wave_bulletin` | Wave inter-agent messages |

JSONL files auto-rotate when they exceed 500 entries. Atomic writes (write-then-rename) prevent corruption on concurrent access.

## Development

Node.js 24+ required.

```bash
# Install dependencies
npm install

# Compile TypeScript to dist/
npm run build

# Run server with tsx (hot TypeScript execution, no build step)
npm start

# Run unit tests with vitest
npm test
```

Tests live in `src/__tests__/`. The test suite uses Vitest and runs against the TypeScript source directly via `tsx`.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CANON_PROJECT_DIR` | `process.cwd()` | Root of the user's project. Used to locate `.canon/` data directory and resolve project-relative file paths. Relative values are resolved to absolute. |
| `CANON_PLUGIN_DIR` | Parent of `mcp-server/` | Root of the Canon plugin repo. Used to locate `principles/`, `flows/`, `agents/`, and `skills/` directories. |

When running in development with the Canon repo as both the plugin and the project, both variables may point to the same directory. In production (Canon installed as a plugin into a user's project), `CANON_PROJECT_DIR` points to the user's repo and `CANON_PLUGIN_DIR` points to the Canon installation.
