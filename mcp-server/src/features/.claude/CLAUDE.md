# features/ — Feature Modules

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
Container for Canon's MCP tool implementations, organized by bounded context. Each subdirectory owns a distinct slice of Canon's capability surface.

## Architecture
<!-- last-updated: 2026-06-24 -->
Features are structured around bounded contexts. Each feature directory is an independent vertical slice with its own tools, services, and tests.

**Feature directories:**

| Directory | Description |
|-----------|-------------|
| `diagnostics/` | Drift tracking tools — flow run analytics, compliance rates, drift reports |
| `evolution/` | Trace-driven evolution — `evaluate_candidate` fitness gate (§7 holdout, ADR-0022) + `attribute_failure` attribution consumer (provenance⋈failure join, content_hash byte-identity, ADR-0024). See `.claude/CLAUDE.md`. |
| `file-context/` | File context tool — structural metrics, imports/exports, blast radius, hotspot data |
| `history/` | Cross-run analysis — `get_build_history`, `get_historical_artifacts`, `get_cross_run_analysis`; services split across `cross-run-analyzer.ts`, `cross-run-craft-drift.ts`, `cross-run-patterns.ts` |
| `knowledge-graph/` | Codebase graph — scanner, KG query, import resolution, git intelligence pipeline |
| `loops/` | Loop framework — loop-definition schema, registry loader, `list_loops`, `get_loop_definition` (Phase A) |
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
<!-- last-updated: 2026-06-12 -->
- Features must not import internal modules from each other — mechanically enforced by `mcp-server/.dependency-cruiser.cjs` `no-cross-feature-internal-import` rule (error severity); sole exception: `knowledge-graph/` is a foundational service features may depend on (ADR-0005)
- All tool handlers must be thin wrappers; logic lives in services
- All tool handlers must be wrapped with `wrapHandler` from `@shared/lib/wrap-handler.ts`

## Conventions
<!-- last-updated: 2026-05-15 -->
- Tool files are named after their MCP tool name (e.g., `init-workspace.ts` for the `init_workspace` tool)
- Services are named for their function (e.g., `janitor.ts`, `transcript-transformer.ts`)
- Tests live in `__tests__/` adjacent to what they test
- New feature directories must follow the same `tools/`, optional `services/`, `__tests__/` layout
