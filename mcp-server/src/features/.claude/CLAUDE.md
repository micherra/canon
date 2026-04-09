# features/ — Feature Modules

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
Container for Canon's MCP tool implementations, organized by bounded context. Each subdirectory owns a distinct slice of Canon's capability surface.

## Architecture
<!-- last-updated: 2026-04-09 -->
Features are structured around bounded contexts. Each feature directory is an independent vertical slice with its own tools, services, and tests.

**Feature directories:**

| Directory | Description |
|-----------|-------------|
| `diagnostics/` | Drift tracking tools — flow run analytics, compliance rates, drift reports |
| `file-context/` | File context tool — structural metrics, imports/exports, blast radius, hotspot data |
| `knowledge-graph/` | Codebase graph — scanner, KG query, import resolution, git intelligence pipeline |
| `orchestration/` | Flow execution engine — state machine runtime, all orchestration MCP tools and services |
| `pr-review/` | PR review tools — change analysis, blast radius, violation surfacing, review persistence |
| `principles/` | Principle tools — loading, matching, compliance querying, drift integration |
| `prompt-pipeline/` | Prompt assembly — worktree settings injection, spawn request enrichment, briefing pipeline |

**Typical internal layout:**

```
{feature}/
├── tools/          # MCP tool handlers (thin wrappers calling services)
├── services/       # Business logic and domain operations
├── engine/         # State machines or complex computation engines (optional)
└── __tests__/      # Vitest unit tests
```

## Invariants
<!-- last-updated: 2026-04-09 -->
- Features must not import directly from each other — use `@domains/*` types as shared contracts
- All tool handlers must be thin wrappers; logic lives in services
- All tool handlers must be wrapped with `wrapHandler` from `@shared/lib/wrap-handler.ts`

## Conventions
<!-- last-updated: 2026-04-09 -->
- Tool files are named after their MCP tool name (e.g., `drive-flow.ts` for the `drive_flow` tool)
- Services are named for their function (e.g., `context-budget.ts`, `wave-briefing.ts`)
- Tests live in `__tests__/` adjacent to what they test
- New feature directories must follow the same `tools/`, optional `services/`, optional `engine/`, `__tests__/` layout
