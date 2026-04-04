# Canon MCP Server

TypeScript MCP server providing 24 tools for principle enforcement and build orchestration. This is the runtime core of Canon — it powers principle matching, drift tracking, codebase graph analysis, and the flow state machine that drives multi-agent builds.

This document is for contributors and power users. The main project README links here for internals.

## Architecture

ES module TypeScript project using `@modelcontextprotocol/sdk` and `zod` for schema validation. Communicates over stdio using the Model Context Protocol.

```
src/
├── index.ts              # Entry point — registers all MCP tools
├── parser.ts             # Frontmatter parsing for principle markdown files
├── matcher.ts            # Principle matching by layer, file pattern, and tags
├── schema.ts             # Zod schemas for the report tool input
├── constants.ts          # Shared constants (layers, extensions, CANON_DIR)
├── tools/                # One file per MCP tool implementation
├── drift/                # JSONL-backed stores: decisions, patterns, reviews
├── graph/                # Dependency graph: scanner, import/export parsing, priority scoring
├── orchestration/        # Flow state machine runtime: board, messaging, variables, gates, effects
├── utils/                # Config loading, path handling, atomic writes, ID generation
└── __tests__/            # Vitest unit tests
```

### Key subsystems

**`tools/`** — One file per MCP tool. Each tool file exports a single function that takes validated input and returns a plain object. `index.ts` registers them all with `server.registerTool()` and wraps results in a standard JSON response envelope.

**`drift/`** — JSONL-backed persistence for reviews. `jsonl-store.ts` handles append and rotation at 500 entries. `analyzer.ts` and `reporter.ts` compute drift statistics and trend analysis from the raw JSONL data.

**`graph/`** — Dependency graph scanner for JS/TS/Python source files. `scanner.ts` walks the directory tree. `import-parser.ts` and `export-parser.ts` extract dependency edges. `degree.ts` computes in-degree and out-degree for each node. `priority.ts` scores files by graph centrality (used to prioritize review effort). `insights.ts` detects cycles, hub files, and orphaned modules.

**`orchestration/`** — Flow state machine runtime used by the orchestrator agent.
- `board.ts` — Reads and writes `board.json` (the persistent state machine record for a workspace)
- `messages.ts` — Unified inter-agent messaging via workspace channels
- `variables.ts` — Resolves `{{variable}}` substitutions in spawn prompts, pulling values from board state, session, and wave context
- `gate-runner.ts` — Evaluates between-wave gate conditions before advancing to the next wave
- `flow-parser.ts` — Parses flow YAML frontmatter and markdown spawn instructions, resolves fragment includes
- `transitions.ts` — Evaluates transition conditions and selects the next state based on agent status keywords
- `convergence.ts` — Tracks iteration counts to enforce loop limits and detect stuck agents
- `wave-briefing.ts` — Assembles per-agent context packages for parallel wave execution
- `effects.ts` — Executes declarative drift effects after state completion: parses agent artifacts (REVIEW.md) and persists to JSONL drift stores. Activated via `effects:` declarations in flow/fragment YAML (e.g., `persist_review` on review states)

**`utils/`** — Shared helpers: `atomic-write.ts` (write-then-rename to prevent corruption), `config.ts` (loads `.canon/config.json` and builds layer inferrers), `paths.ts` (workspace and CANON_DIR resolution), `id.ts` (ID generation for drift records).

**`matcher.ts`** — Context-aware principle filtering. Given a file path, layers, and tags, it walks the `principles/` directory (across severity subdirectories: `rules/`, `strong-opinions/`, `conventions/`), applies glob patterns and layer mappings, and returns matched principles ranked by severity. Caches compiled glob regexes to avoid recompilation on repeated calls.

**`parser.ts`** — Extracts YAML frontmatter from principle markdown files and parses principle metadata (id, severity, layers, tags, summary, body).

## Tools

### Principle and review tools (11)

| Tool | Description |
|------|-------------|
| `get_principles` | Returns Canon principles relevant to the current coding context. Call before generating code. |
| `list_principles` | Browse the full Canon principle index. Returns metadata only (no full body) for efficient browsing. |
| `review_code` | Returns Canon principles relevant to a file for review. The calling agent evaluates compliance — this tool provides the matched principles and code. |
| `get_compliance` | Returns compliance stats for a specific Canon principle. Shows violation counts, compliance rate, and trend. |
| `report` | Log a Canon observation: a code review result. Feeds into drift tracking and the learning loop. |
| `get_drift_report` | Returns a full drift report — compliance rates, most violated principles, hotspot directories, trend, and recommendations. |
| `codebase_graph` | Generate a dependency graph of the codebase with Canon compliance overlay. Full graph is persisted to `.canon/graph-data.json`. Returns a compact summary. |
| `get_file_context` | Get rich context for a source file — contents (up to 200 lines), graph relationships (imports/imported_by), exported names, layer, and compliance data. |
| `store_summaries` | Store file summaries to `.canon/summaries.json`. Merges with existing summaries so you can generate them incrementally. |
| `store_pr_review` | Store a PR review result for drift tracking. Server generates `review_id` and timestamp. |
| `show_pr_impact` | Open the PR Review MCP App view with change story, impact analysis, and review results. |

### Graph query tools (1)

| Tool | Description |
|------|-------------|
| `graph_query` | Query the dependency graph — call trees, blast radius, dead code detection, and entity search. |

### Orchestration harness tools (10)

| Tool | Description |
|------|-------------|
| `load_flow` | Load and resolve a Canon flow definition. Returns the resolved flow with fragment resolution, spawn instructions, and a state adjacency graph. |
| `init_workspace` | Initialize a Canon workspace for flow execution. Creates workspace directory, `session.json`, `board.json`, and `progress.md`. Resumes from existing board if present. |
| `update_board` | Perform board state mutations. Supports entering, skipping, blocking, unblocking states, completing flow, and setting wave progress. |
| `drive_flow` | Drive the flow state machine for a single state. Returns a `SpawnRequest` or `HitlBreakpoint` for the orchestrator to process. |
| `report_result` | Report an agent's result. Normalizes status, evaluates transitions, updates board state, executes drift effects (persist_review), and checks stuck detection. Returns next state and whether HITL is required. |
| `post_message` | Post a message to a workspace channel for inter-agent communication. Messages are markdown files that agents read at spawn time. |
| `get_messages` | Read messages from a workspace channel. Returns messages ordered by sequence number. Optionally includes pending wave events. |
| `inject_wave_event` | Inject a user event into a running wave execution. Allows the user to steer, pause, or redirect agents mid-wave. |
| `resolve_wave_event` | Resolve a pending injected wave event (`apply`/`reject`) and return orchestrator routing hints. |
| `resolve_after_consultations` | Resolve and return `after` consultation prompts for a state after final wave completion. |

## Data persistence

All runtime data lives under `.canon/` in the project root:

| File | Written by | Purpose |
|------|-----------|---------|
| `reviews.jsonl` | `report` tool, flow effects | Code review results (violations, scores, verdicts) |
| `graph-data.json` | `codebase_graph` tool | Full dependency graph snapshot |
| `summaries.json` | `store_summaries` tool | File-level summaries |
| `workspaces/{slug}/board.json` | `init_workspace`, `update_board` | Flow state machine record |
| `workspaces/{slug}/session.json` | `init_workspace` | Session metadata (flow, branch, tier) |
| `workspaces/{slug}/progress.md` | `init_workspace`, orchestrator | Append-only cross-state learnings; injected into spawn prompts via `${progress}` |
| `workspaces/{slug}/messages/{channel}/*.md` | `post_message` | Inter-agent messages during parallel wave execution |

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
