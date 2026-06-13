# Canon MCP Server — Bounded Context Map

## Overview

The Canon MCP server is organized into nine bounded contexts. The **Flows Context** owns all flow/state/fragment schema types and status vocabulary. The **Orchestration Context** owns execution lifecycle, board state, session management, DAG-based parallel dispatch, and spawn/HITL mechanics. The **Knowledge Graph Context** owns the file entity graph, import/export edge relationships, and semantic search. The **Drift/Review Context** owns review persistence, violation tracking, and compliance analytics. The **Messages Context** owns unified inter-agent messaging, event payloads, and event validation. The **File Context** owns file-level structural analysis, entity queries, and blast radius reporting. The **Diagnostics/Analytics Context** owns flow run analytics, agent metrics recording, and convergence checking. The **Shared Kernel** is a foundation layer providing cross-cutting types and constants that ≥3 contexts depend on. A thin **Platform/Infrastructure layer** (`src/platform/`, `src/app/`) wires contexts together at startup and provides storage adapters — it is not a bounded context.

---

## Contexts

### 1. Flows Context

- **Directory**: `mcp-server/src/domains/flows/`
- **Responsibility**: Flow definition schemas, state/fragment/gate type contracts, status vocabulary, skip/stuck conditions, quality gate contracts, board and session state types
- **Key types**: `FlowDefinition`, `ResolvedFlow`, `StateDefinition`, `Board`, `Session`, `GateResult`, `STATUS_KEYWORDS`, `STATUS_ALIASES`, `BaseStateFields`
- **Depends on**: Shared Kernel (`zod`, constants) only

The Flows Context is the shared vocabulary of the system. Every other context imports types from here — it is effectively a published language module. The schema split is complete: `mcp-server/src/domains/flows/` contains `flow-definition-schemas.ts`, `board-state-schemas.ts`, and `transcript-schemas.ts`, which consumers import directly; `flow-schema.ts` no longer exists.

### 2. Orchestration Context

- **Directories**: `mcp-server/src/features/orchestration/`, `mcp-server/src/domains/workspaces/`, `mcp-server/src/domains/board/`
- **Responsibility**: Flow execution engine, state transitions, effects, convergence detection, board persistence, session management, spawn request assembly, HITL breakpoints, domain events, gate execution, DAG-based parallel task dispatch
- **Key types**: `SpawnRequest`, `HitlBreakpoint`, `ExecutionStore`, `FlowEventBus`, `EffectResult`, `BoardStateEntry`
- **Depends on**: Flows Context (type imports), Messages Context (messaging coordination), Shared Kernel

Orchestration drives the runtime — it is the largest context. Board mutation helpers (`board.ts`) are pure functions that return new `Board` values. `ExecutionStore` is the SQLite-backed persistence layer for board and session state.

**Current boundary violations** (to be resolved via repository interfaces):

| File | Violating import | Direction |
|------|-----------------|-----------|
| `mcp-server/src/features/orchestration/tools/report.ts` | `import { DriftStore } from "@platform/storage/drift/store.ts"` | Orchestration → Drift (concrete coupling) |

The planned fix is a repository interface (`IDriftStore`) in `domains/drift/` so Orchestration imports the interface only, not the concrete storage class. The `IKgStore` interface definition lives in `mcp-server/src/domains/knowledge-graph/` (planned — `kg-store.interface.ts` not yet written); when complete, it will eliminate any future concrete `KgStore` coupling from Orchestration.

### 3. Knowledge Graph Context

- **Directory**: `mcp-server/src/graph/`
- **Responsibility**: Codebase indexing, file entity and edge storage, import/export parsing, structural metrics (in/out degree, hubs, cycles, layer violations), blast radius, semantic search, file summaries
- **Key types**: `KgStore`, `KgQuery`, `FileMetrics`, `FileInsightMaps`, `FileEntity`, `EntityEdge`, `LayerViolation`
- **Depends on**: Shared Kernel (constants) only

`KgStore` provides typed CRUD against the SQLite knowledge graph database (`knowledge-graph.db`). `KgQuery` provides higher-level analytical queries: degrees, adjacency lists, structural metrics, subgraph extraction. All storage is SQLite-only since ADR-005 (2026-04-01); the former `graph-data.json` and `summaries.json` artifacts are no longer written.

A planned `IKgStore` interface in `mcp-server/src/domains/knowledge-graph/` will allow Orchestration to depend on the interface rather than the concrete class.

### 4. Drift/Review Context

- **Directories**: `mcp-server/src/platform/storage/drift/`, `mcp-server/src/features/pr-review/`
- **Responsibility**: Review persistence, PR review storage, compliance trends, violation tracking over time
- **Key types**: `DriftStore`, `DriftDb`, `ReviewEntry`, `FlowRunEntry`, `WeeklyTrendPoint`
- **Depends on**: Shared Kernel (`ReviewEntry` from `shared/schema.ts`, constants) only

`DriftStore` is an async Promise-based facade over the synchronous `DriftDb` (SQLite-backed). The public interface is `DriftStore`; callers do not interact with `DriftDb` directly. All reviews persist to `drift.db` in the `.canon/` directory. A planned `IDriftStore` interface in `mcp-server/src/domains/drift/` will let Orchestration depend on the interface boundary rather than the concrete storage class.

### 5. Messages Context

- **Directory**: `mcp-server/src/domains/messages/`
- **Responsibility**: Unified inter-agent messaging via SQLite rows, event payloads, event bus lifecycle, variable interpolation for agent prompts, message coordination instructions
- **Key types**: `Message`, `CanonEvent`, `EventBus`, `FlowEventChannel`
- **Depends on**: Orchestration Context (uses `ExecutionStore` for message persistence), Shared Kernel

Messages was previously bundled under the Orchestration Context in earlier versions of this map. It has its own domain directory and owns a distinct capability: typed flow lifecycle events, the event bus, and variable substitution for spawn prompt templates. Message persistence via `ExecutionStore` was removed in 2026-05-16; the Messages context no longer reads or writes board-state storage directly. The relationship with Orchestration is now event-bus only — a **Partnership** via the `FlowEventBus` singleton.

### 6. File Context

- **Directory**: `mcp-server/src/features/file-context/`
- **Responsibility**: File-level structural analysis, entity and import/export queries, blast radius reporting, file summary enrichment, layer inference for a single target file
- **Key types**: `FileContextInput`, `FileContextResult`, `UnifiedBlastRadiusReport`
- **Depends on**: Knowledge Graph Context (direct: `KgStore`, `KgQuery`, blast radius), Drift/Review Context (direct: `DriftStore`), Shared Kernel

File Context is a feature-layer boundary: it aggregates data from Knowledge Graph and Drift/Review into a unified file-level report. It conforms to the types defined by Knowledge Graph rather than defining its own equivalent types — this is a **Conformist** relationship. The coupling to `DriftStore` is a known cross-context import that follows the same concrete-coupling pattern as Orchestration; it is not yet guarded by an interface.

### 7. Diagnostics/Analytics Context

- **Directory**: `mcp-server/src/features/diagnostics/`, `mcp-server/src/platform/storage/drift/analytics.ts`, `mcp-server/src/platform/storage/drift/drift-analytics-types.ts`
- **Responsibility**: Flow run analytics, agent metrics recording, convergence checking, drift report generation, failure categorization, summary storage
- **Key types**: `FlowAnalytics`, `FlowRunEntry`, `AgentMetrics`, `ConvergenceReport`, `WeeklyTrendPoint`
- **Depends on**: Drift/Review Context (stores analytics in `drift.db` via `DriftStore`), Shared Kernel

Diagnostics wraps Drift/Review storage with domain logic for flow analytics. It was previously grouped under the Drift/Review Context in this map, but its tool implementations (`record-agent-metrics`, `get-drift-report`, `check-convergence`, `categorize-failures`, `store-summaries`) constitute a distinct analytical capability separate from pure review/violation persistence. Diagnostics conforms to the types exposed by Drift/Review — a **Conformist** relationship.

### 8. Loop Registry Context

- **Directories**: `mcp-server/src/features/loops/`, `loops/`
- **Responsibility**: Loop-as-Artifact framework MCP layer — loop-definition schema, registry loading, `list_loops`/`get_loop_definition` tools; the `loops/` directory at the repo root IS the registry
- **Key types**: `LoopDefinition`, `ParseLoopResult` (from `loop-schema.ts`); `loadLoopsFromDir` returns `{ valid, invalid, validBodies }`
- **Depends on**: Shared Kernel (`ToolResult<T>`, `CanonErrorCode`) only; no dependency on other contexts

Phase A shipped the schema, loader, and both MCP tools. Phase B added `loops/ship-watch.md` — the first real loop — and introduced the `observe.shell_commands` read-only-shell carve-out (decision loops-phase-b-01). Phase C (current) ships session-watch + self-paced mode (`ScheduleWakeup`) and resilient inline dispatch (ADR-0007). The `loops/` registry directory is read at query time (directory-as-registry, mirrors `principles/`). dc-05 guardrails enforced at parse time by `parseLoopDefinition`. The non-declarative constraint (dc-06): authoring a `loops/*.md` file registers a loop definition; it does NOT start the loop — only the orchestrator initiates `CronCreate` (interval) or `ScheduleWakeup` (self-paced) at a named lifecycle moment.

### 10. Shared Kernel

- **Directory**: `mcp-server/src/shared/`
- **Responsibility**: Cross-cutting types, error contracts, constants, utility libraries used by ≥3 contexts; the foundation layer
- **Key types/exports**: `ToolResult<T>`, `CanonToolError`, `CanonErrorCode`, `ReviewEntry`, `LAYER_CENTRALITY`, `CANON_DIR`, `CANON_FILES`, `toolError()`, `toolOk()`, `isToolError()`, `assertOk()`
- **Depends on**: Nothing (leaf node — no imports from other Canon contexts)

The Shared Kernel must not contain domain-specific logic. `ReviewEntry` lives here (not in the Drift context) because it is used by both Drift storage and the Orchestration effects pipeline. `LAYER_CENTRALITY` lives here because both Knowledge Graph and PR Review use it for impact scoring. Adding something to the Shared Kernel requires that it genuinely be used across ≥3 contexts; domain-specific types belong in their own context.

---

## Platform / Infrastructure Layer

`mcp-server/src/platform/` and `mcp-server/src/app/` are **not** bounded contexts. They are infrastructure:

| Directory | Role |
|-----------|------|
| `src/app/` | Entry point (`index.ts`) — tool registration, wires all contexts to the MCP server |
| `src/platform/adapters/` | Subprocess adapters (`git-adapter.ts`, `process-adapter.ts`); only these files may import `node:child_process` (ADR-002) |
| `src/platform/jobs/` | Background job manager |
| `src/platform/workers/` | Worker threads |
| `src/platform/storage/drift/` | Concrete `DriftStore`/`DriftDb` implementation (belongs to Drift context) |

---

## Context Dependency Rules

| From → To | Allowed? | Mechanism |
|-----------|----------|-----------|
| Orchestration → Flows | Yes | Direct type imports |
| Orchestration → Shared Kernel | Yes | Direct imports |
| Orchestration → Messages | Yes | Direct imports (co-evolving partnership) |
| Orchestration → Knowledge Graph | Planned via interface | `IKgStore` in `domains/knowledge-graph/` — interface definition planned, not yet written |
| Orchestration → Drift | Planned via interface | `IDriftStore` in `domains/drift/` — interface definition planned; `tools/report.ts` currently a concrete-coupling violation |
| Messages → Orchestration | Yes | Event-bus partnership; `ExecutionStore` coupling removed 2026-05-16 |
| File Context → Knowledge Graph | Yes | Conformist — direct concrete imports |
| File Context → Drift/Review | Yes | Conformist — direct concrete imports |
| Diagnostics → Drift/Review | Yes | Conformist — direct concrete imports |
| Knowledge Graph → Flows | No | KG has no dependency on flow types |
| Knowledge Graph → Orchestration | No | Forbidden |
| Knowledge Graph → Shared Kernel | Yes | Direct imports (constants) |
| Drift → Flows | No | Drift has no dependency on flow types |
| Drift → Orchestration | No | Forbidden |
| Drift → Shared Kernel | Yes | Direct imports (`ReviewEntry`, constants) |
| Flows → Shared Kernel | Yes | Direct imports (zod, constants) |
| Shared Kernel → any context | No | Shared Kernel is a leaf node |
| Any → Platform adapters | No | Only `src/platform/adapters/` may import `node:child_process` |

---

## Relationship Patterns

Every inter-context relationship is labeled with its DDD integration pattern.

| From | To | DDD Pattern | Notes |
|------|----|-------------|-------|
| All contexts | Flows | **Published Language / Open Host Service** | Flows publishes schema types consumed by all contexts; all callers conform to the published vocabulary |
| Orchestration | Flows | **Customer/Supplier** | Orchestration is the downstream customer consuming Flows' published types; Flows is the upstream supplier |
| Orchestration | Knowledge Graph | **Anti-Corruption Layer** (planned) | `IKgStore` interface in `domains/knowledge-graph/` will translate between the two contexts once written; no current direct concrete import from Orchestration |
| Orchestration | Drift/Review | **Anti-Corruption Layer** (planned) | `IDriftStore` interface in `domains/drift/` will translate between the two contexts; `tools/report.ts` currently holds the concrete import violation |
| All contexts | Shared Kernel | **Shared Kernel** | Explicitly shared types: `ToolResult<T>`, `CanonErrorCode`, `ReviewEntry`; governed by the ≥3 consumers rule |
| Drift/Review | Shared Kernel | **Conformist** | Drift conforms to `ReviewEntry` as defined by the Shared Kernel; Drift does not own this type |
| File Context | Knowledge Graph | **Conformist** | File Context uses `FileMetrics`, `KgStore`, `KgQuery` types directly without translation |
| File Context | Drift/Review | **Conformist** | File Context imports `DriftStore` directly; conforms to Drift's concrete interface |
| Diagnostics | Drift/Review | **Conformist** | Diagnostics analytics tools conform to `DriftStore`/`FlowRunEntry` types defined by Drift/Review |
| Messages | Orchestration | **Partnership** | Co-evolving via event bus: Messages publishes lifecycle events (`FlowEventBus`) consumed by the Orchestration engine; `ExecutionStore` coupling removed 2026-05-16 |

---

## Shared Kernel Contents

Types in the Shared Kernel must be genuinely cross-cutting (used by ≥3 contexts). Current contents and their consumers:

| Export | File | Consumers |
|--------|------|-----------|
| `ToolResult<T>`, `CanonToolError`, `CanonErrorCode` | `shared/lib/tool-result.ts` | All contexts (universal error/result contract) |
| `toolError()`, `toolOk()`, `isToolError()`, `assertOk()` | `shared/lib/tool-result.ts` | All contexts (result construction helpers) |
| `ReviewEntry` | `shared/schema.ts` | Drift/Review, Orchestration (effects pipeline), Diagnostics |
| `LAYER_CENTRALITY` | `shared/constants.ts` | Knowledge Graph, PR Review (impact scoring) |
| `CANON_DIR`, `CANON_FILES` | `shared/constants.ts` | All contexts (canonical path references) |
| `buildLayerInferrer`, `loadLayerMappings` | `shared/lib/config.ts` | Knowledge Graph, File Context, Orchestration |

**Rule**: Adding a type to the Shared Kernel requires demonstrating ≥3 context consumers. Types used by only 1–2 contexts belong in the owning context's domain directory, with the other context importing across the boundary explicitly.

---

## Acknowledged Mismatches

These are known placement issues where types or modules live in the "wrong" context by strict DDD rules. Each is documented with the rationale for the current placement.

### 1. Board types in `domains/flows/`

`board-state-schemas.ts` lives in `domains/flows/` but defines `Board` and `Session` types used primarily by the Board aggregate in `domains/board/`. This is a known placement issue. Board types are part of the Flows published language because they are defined by flow state schemas — the shape of a `Board` is prescribed by how flows transition between states. The logical owner would be `domains/board/`, but moving the types would break the Published Language contract. This is a tracked work item.

### 2. `WeeklyTrendPoint` leaking from storage into interfaces

`WeeklyTrendPoint` is defined in `@platform/storage/drift/drift-db.ts` (a concrete storage implementation) but leaks into the planned `IDriftStore` interface definition. This violates the principle that interfaces should not expose storage-layer types. The type should be promoted to `domains/drift/` and re-exported from there. Tracked for resolution alongside the `IDriftStore` interface work.

### 3. Knowledge Graph types leaking into `IKgStore`/`IKgQuery` interfaces

`FileMetrics`, `FileRow`, and `SummaryRow` are defined in `@graph/` (the concrete Knowledge Graph implementation) but are referenced in the planned `IKgStore` and `IKgQuery` interface definitions. These types should live in `domains/knowledge-graph/` so that the interface boundary does not depend on the implementation package. Tracked as a work item alongside the `IKgStore` interface implementation.

### 4. File Context crossing multiple context boundaries without ACL

`features/file-context/tools/get-file-context.ts` imports directly from both `@graph/` (Knowledge Graph) and `@platform/storage/drift/` (Drift/Review) without translation. This is a **Conformist** pattern currently — File Context adopts the shapes defined by both contexts — but it means changes to either context's internal types propagate into File Context without a buffer. An Anti-Corruption Layer or facade interface would be the correct long-term fix.

---

## Integration Patterns

- **Orchestration → Knowledge Graph**: The planned pattern is `IKgStore` interface in `domains/knowledge-graph/` injected into orchestration services. The interface definition (`kg-store.interface.ts`) is planned but not yet written; no current concrete `KgStore` import exists in Orchestration.
- **Orchestration → Drift**: The planned pattern is `IDriftStore` interface in `domains/drift/` injected into the reporting path. Currently `tools/report.ts` directly imports `DriftStore` from the platform storage path — the concrete coupling is the remaining violation.
- **All → Flows**: Direct type imports. Flows is the shared vocabulary layer; all contexts that participate in flow execution import from `mcp-server/src/domains/flows/` (via `flow-definition-schemas.ts`, `board-state-schemas.ts`, `transcript-schemas.ts`).
- **All → Shared Kernel**: Direct imports. No restriction — this is the foundation.
- **Messages ↔ Orchestration**: The Messages context owns flow lifecycle event types, the event bus, and variable substitution. Message persistence was removed from this context (2026-05-16); messages are no longer stored via `ExecutionStore`. The partnership coupling is now event-bus only.

---

## Context Map (ASCII)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Orchestration Context                             │
│       features/orchestration/  domains/workspaces/  domains/board/         │
│                                                                             │
│       SpawnRequest · HitlBreakpoint · ExecutionStore · FlowEventBus        │
└───┬──────────────────┬──────────────────────────┬────────────────┬──────────┘
    │ Customer/Supplier │ [planned: IDriftStore]   │ [planned:      │ Partnership
    │ (type imports)    │ Anti-Corruption Layer    │  IKgStore ACL] │
    ▼                   ▼                          ▼                ▼
┌──────────┐  ┌─────────────────┐  ┌────────────────────┐  ┌───────────────┐
│  Flows   │  │  Drift/Review   │  │  Knowledge Graph   │  │   Messages    │
│ Context  │  │  Context        │  │  Context           │  │   Context     │
│          │  │                 │  │                    │  │               │
│ domains/ │  │ platform/       │  │  graph/            │  │ domains/      │
│ flows/   │  │ storage/drift/  │  │                    │  │ messages/     │
│          │  │ features/       │  │  KgStore · KgQuery │  │               │
│ FlowDef  │  │ pr-review/      │  │  FileMetrics       │  │ Message       │
│ Resolved │  │                 │  │  FileInsightMaps   │  │ CanonEvent    │
│ Flow     │  │ DriftStore      │  │  LayerViolation    │  │ EventBus      │
│ Board    │  │ ReviewEntry     │  │                    │  │               │
│ Session  │  │ FlowRunEntry    │  └──────────┬─────────┘  └───────────────┘
│ GateRes  │  │ WeeklyTrend     │             │ Conformist
│ STATUS_* │  └────────┬────────┘             │
└────┬─────┘           │ Conformist           │
     │ PL/OHS          │                      │
     └────────┐    ┌───┴──────────────────────┤
              │    │                          │
              ▼    ▼                          ▼
     ┌─────────────────────────────────────────────┐
     │              Shared Kernel                  │
     │              shared/                        │
     │                                             │
     │  ToolResult<T> · CanonToolError             │
     │  CanonErrorCode · ReviewEntry               │
     │  CANON_DIR · CANON_FILES                    │
     │  LAYER_CENTRALITY                           │
     └──────────────────┬──────────────────────────┘
                        │ Shared Kernel (foundation)
           ┌────────────┴────────────┐
           ▼                         ▼
┌──────────────────┐      ┌──────────────────────────┐
│   File Context   │      │  Diagnostics/Analytics   │
│   Context        │      │  Context                 │
│                  │      │                          │
│ features/        │      │ features/diagnostics/    │
│ file-context/    │      │ platform/storage/drift/  │
│                  │      │   analytics.ts           │
│ FileContextInput │      │                          │
│ FileContext      │      │ FlowAnalytics            │
│   Result         │      │ AgentMetrics             │
│ UnifiedBlast     │      │ ConvergenceReport        │
│   RadiusReport   │      │                          │
└──────────────────┘      └──────────────────────────┘
  Conformist → KG                Conformist → Drift
  Conformist → Drift
```

**Published Language / Open Host Service**: Flows Context publishes schema types consumed by all other contexts.
**Customer/Supplier**: Orchestration is the downstream customer of Flows.
**Anti-Corruption Layer** (planned): Orchestration ↔ KG and Orchestration ↔ Drift, via `IKgStore`/`IDriftStore`.
**Shared Kernel**: All contexts use `shared/` types directly.
**Conformist**: File Context, Diagnostics, and Drift adopt types from upstream contexts without translation.
**Partnership**: Messages ↔ Orchestration co-evolve around `ExecutionStore`.

---

## Enforcement

Dependency rules are enforced in CI by `dependency-cruiser`. Run locally with:

```bash
npm run lint:deps
```

The `.dependency-cruiser.cjs` config encodes the boundary rules above as forbidden import patterns. The one current violation (`tools/report.ts → DriftStore`) is listed as a known exception with a tracking comment until the `IDriftStore` interface lands.

---

## Living Document Notes

- **Interfaces section** will be expanded once `IKgStore` (`domains/knowledge-graph/kg-store.interface.ts`), `IDriftStore` (`domains/drift/`), and `IExecutionStore` (`domains/workspaces/`) are written.
- The one current violation (`tools/report.ts → DriftStore`) is a tracked work item, not a permanent exception.
- **Messages Context** was previously listed as part of Orchestration in this document. It has its own domain directory (`domains/messages/`) and is now documented as a separate context.
- **Diagnostics/Analytics Context** was previously grouped with Drift/Review. It is now a separate context with a Conformist relationship to Drift/Review.
- **File Context** was previously not documented as a bounded context. It is now documented with its cross-context Conformist dependencies.
