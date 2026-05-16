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
| `orchestration/` | Orchestration tools — workspace lifecycle, transcript capture, artifact writing, and agent skill resolution |
| `pr-review/` | PR review tools — change analysis, blast radius, violation surfacing, review persistence |
| `principles/` | Principle tools — loading, matching, compliance querying, drift integration |

**Typical internal layout:**

```
{feature}/
├── tools/          # MCP tool handlers (thin wrappers calling services)
├── services/       # Business logic and domain operations (optional)
└── __tests__/      # Vitest unit tests
```

## Invariants
<!-- last-updated: 2026-04-09 -->
- Features must not import directly from each other — use `@domains/*` types as shared contracts
- All tool handlers must be thin wrappers; logic lives in services
- All tool handlers must be wrapped with `wrapHandler` from `@shared/lib/wrap-handler.ts`

## Conventions
<!-- last-updated: 2026-05-15 -->
- Tool files are named after their MCP tool name (e.g., `init-workspace.ts` for the `init_workspace` tool)
- Services are named for their function (e.g., `janitor.ts`, `transcript-transformer.ts`)
- Tests live in `__tests__/` adjacent to what they test
- New feature directories must follow the same `tools/`, optional `services/`, `__tests__/` layout
