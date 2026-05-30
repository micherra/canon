# features/ — Feature Modules

This directory contains Canon's MCP tool implementations, organized by bounded context. Each subdirectory owns a distinct capability area and is an independent vertical slice of the codebase.

## How it is organized

Each feature is a bounded context with its own tools, optional services, optional engine, and tests. Features do not import from each other — they share types through `@domains/*` and utilities through `@shared/*`.

```
features/
├── diagnostics/        # Drift analytics — flow runs, compliance rates, drift reports
├── file-context/       # File context — structural metrics, imports, blast radius
├── knowledge-graph/    # Codebase graph — scanning, KG queries, git intelligence
├── orchestration/      # Orchestration runtime — journal, workspace lifecycle, and all harness tools
├── pr-review/          # PR review — change analysis, violations, review persistence
├── principles/         # Principles — loading, matching, compliance queries
└── prompt-pipeline/    # Prompt assembly — worktree settings, spawn enrichment
```

## Feature subdirectories

### `diagnostics/`

Drift tracking and analytics. Owns the `get_drift_report` and `get_compliance` tools. Reads from the JSONL drift store and the SQLite orchestration database to surface compliance rates, most-violated principles, hotspot directories, and trend data.

### `file-context/`

File context tool. Owns `get_file_context`. Aggregates structural data for a single file: imports and exports, blast radius, KG metrics, git hotspot scores, and co-change partners.

### `knowledge-graph/`

Codebase graph construction and querying. Owns `codebase_graph` and `graph_query`. Includes a git intelligence pipeline (`git-intel/`) that computes file churn, co-change pairs, and hotspot scores from git history. Services handle import resolution, entity extraction, and KG freshness management.

### `orchestration/`

Orchestration runtime and all Canon harness tools. Owns every orchestration tool (`tools/`) — workspace lifecycle, journal (`log_step` / `batch_log_steps`), transcript capture, artifact writing, agent skill resolution — and the services that support them (`services/`). See `orchestration/README.md` for full details.

### `pr-review/`

PR review pipeline. Owns `show_pr_impact` and `store_pr_review`. Analyzes git diffs, classifies files by risk, surfaces principle violations, and computes blast radius. Review results are persisted to the drift store for trend analysis.

### `principles/`

Principle loading and querying. Owns `get_principles`, `list_principles`, and `review_code`. Loads principles from both the plugin directory and the project's `.canon/principles/` directory. Delegates matching logic to `@shared/matcher.ts`.

### `prompt-pipeline/`

Prompt assembly and agent spawn enrichment. Owns worktree settings injection (`services/worktree-settings.ts`) and the model resolution pipeline. Determines which tools and permission modes to use when spawning agents.

## Adding a new feature

1. Create a directory under `features/` named after the bounded context (kebab-case).
2. Add a `tools/` subdirectory for MCP tool handlers.
3. Add `services/` if business logic warrants separation from handlers.
4. Add `__tests__/` for tests.
5. Register tool handlers in `mcp-server/src/app/index.ts`.
6. Never import from another feature directly — use `@domains/*` types as the shared contract.

## Dependency rules

| Allowed imports | Disallowed |
|-----------------|-----------|
| `@shared/*` — shared kernel utilities | Other features (e.g., `@features/orchestration/`) |
| `@domains/*` — shared domain types | `platform/` internals directly |
| External npm packages | Relative imports that cross feature boundaries |
