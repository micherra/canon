# Canon MCP Server — Bounded Context Map

## Overview

The Canon MCP server is organized into five bounded contexts. The **Flows Context** owns all flow/state/fragment schema types and status vocabulary. The **Orchestration Context** owns execution lifecycle, board state, session management, wave coordination, and spawn/HITL mechanics. The **Knowledge Graph Context** owns the file entity graph, import/export edge relationships, and semantic search. The **Drift/Review Context** owns review persistence, violation tracking, and compliance analytics. The **Shared Kernel** is a foundation layer providing cross-cutting types and constants that ≥3 contexts depend on. A thin **Platform/Infrastructure layer** (`src/platform/`, `src/app/`) wires contexts together at startup and provides storage adapters — it is not a bounded context.

---

## Contexts

### 1. Flows Context

- **Directory**: `mcp-server/src/domains/flows/`
- **Responsibility**: Flow definition schemas, state/fragment/gate type contracts, status vocabulary, skip/stuck conditions, quality gate contracts, board and session state types
- **Key types**: `FlowDefinition`, `ResolvedFlow`, `StateDefinition`, `Board`, `Session`, `GateResult`, `STATUS_KEYWORDS`, `STATUS_ALIASES`, `BaseStateFields`
- **Depends on**: Shared Kernel (`zod`, constants) only

The Flows Context is the shared vocabulary of the system. Every other context imports types from here — it is effectively a published language module. `flow-schema.ts` is the primary export; a planned split (ddd-03) will decompose it into `flow-definition-schemas.ts`, `board-state-schemas.ts`, and `event-schemas.ts` with a barrel re-export that preserves the 116 existing import paths.

### 2. Orchestration Context

- **Directories**: `mcp-server/src/features/orchestration/`, `mcp-server/src/domains/workspaces/`, `mcp-server/src/domains/board/`, `mcp-server/src/domains/messages/`
- **Responsibility**: Flow execution engine, state transitions, effects, convergence detection, wave lifecycle, board persistence, session management, unified messaging, spawn request assembly, HITL breakpoints, domain events, gate execution
- **Key types**: `SpawnRequest`, `HitlBreakpoint`, `ExecutionStore`, `FlowEventBus`, `EffectResult`, `BoardStateEntry`
- **Depends on**: Flows Context (type imports), Shared Kernel

Orchestration drives the runtime — it is the largest context. Board mutation helpers (`board.ts`) are pure functions that return new `Board` values. `ExecutionStore` is the SQLite-backed persistence layer for board and session state. The event bus (`flow-event-channel.ts`) broadcasts lifecycle events to subscribers within this context.

**Current boundary violations** (to be resolved via ddd-03 interfaces):

| File | Violating import | Direction |
|------|-----------------|-----------|
| `engine/effects.ts` | `import { DriftStore } from "@platform/storage/drift/store.ts"` | Orchestration → Drift (concrete coupling) |
| `services/inject-context.ts` | `import { KgStore } from "@graph/kg-store.ts"` | Orchestration → Knowledge Graph (concrete coupling) |

Both violations are known. The planned fix is repository interfaces (`IDriftStore`, `IKgStore`) in `domains/drift/` and `domains/knowledge-graph/` respectively. The concrete classes satisfy the interfaces structurally; Orchestration will import the interface only.

### 3. Knowledge Graph Context

- **Directory**: `mcp-server/src/graph/`
- **Responsibility**: Codebase indexing, file entity and edge storage, import/export parsing, structural metrics (in/out degree, hubs, cycles, layer violations), blast radius, semantic search, file summaries
- **Key types**: `KgStore`, `KgQuery`, `FileMetrics`, `FileInsightMaps`, `FileEntity`, `EntityEdge`, `LayerViolation`
- **Depends on**: Shared Kernel (constants) only

`KgStore` provides typed CRUD against the SQLite knowledge graph database (`knowledge-graph.db`). `KgQuery` provides higher-level analytical queries: degrees, adjacency lists, structural metrics, subgraph extraction. All storage is SQLite-only since ADR-005 (2026-04-01); the former `graph-data.json` and `summaries.json` artifacts are no longer written.

A planned `IKgStore` interface in `mcp-server/src/domains/knowledge-graph/` will allow Orchestration to depend on the interface rather than the concrete class.

### 4. Drift/Review Context

- **Directories**: `mcp-server/src/platform/storage/drift/`, `mcp-server/src/features/pr-review/`, `mcp-server/src/features/diagnostics/`
- **Responsibility**: Review persistence, PR review storage, compliance trends, flow run analytics, drift analytics, violation tracking over time
- **Key types**: `DriftStore`, `DriftDb`, `ReviewEntry`, `FlowRunEntry`, `WeeklyTrendPoint`, `FlowAnalytics`
- **Depends on**: Shared Kernel (`ReviewEntry` from `shared/schema.ts`, constants) only

`DriftStore` is an async Promise-based facade over the synchronous `DriftDb` (SQLite-backed). The public interface is `DriftStore`; callers do not interact with `DriftDb` directly. All reviews persist to `drift.db` in the `.canon/` directory. A planned `IDriftStore` interface in `mcp-server/src/domains/drift/` will let Orchestration depend on the interface boundary rather than the concrete storage class.

### 5. Shared Kernel

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
| Orchestration → Knowledge Graph | Planned via interface | `IKgStore` (ddd-03) — currently a violation |
| Orchestration → Drift | Planned via interface | `IDriftStore` (ddd-03) — currently a violation |
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

## Integration Patterns

- **Orchestration → Knowledge Graph**: The planned pattern is `IKgStore` interface in `domains/knowledge-graph/` injected into orchestration services. Currently `inject-context.ts` directly instantiates `KgStore` — the DI step is deferred to future work.
- **Orchestration → Drift**: The planned pattern is `IDriftStore` interface in `domains/drift/` injected into `effects.ts`. Currently `effects.ts` directly imports `DriftStore` from the platform storage path.
- **All → Flows**: Direct type imports. Flows is the shared vocabulary layer; all contexts that participate in flow execution import from `@domains/flows/flow-schema.ts`.
- **All → Shared Kernel**: Direct imports. No restriction — this is the foundation.

---

## Context Map (ASCII)

```
┌──────────────────────────────────────────────────────────────────┐
│                      Orchestration Context                       │
│  features/orchestration/  domains/workspaces/  domains/board/   │
│  domains/messages/                                               │
│                                                                  │
│  SpawnRequest · HitlBreakpoint · ExecutionStore · FlowEventBus  │
└──────┬────────────────┬───────────────────────────┬─────────────┘
       │ type imports   │ [planned: IDriftStore]    │ [planned: IKgStore]
       ▼                ▼                           ▼
┌──────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│  Flows       │  │   Drift/Review       │  │  Knowledge Graph     │
│  Context     │  │   Context            │  │  Context             │
│              │  │                      │  │                      │
│  domains/    │  │  platform/storage/   │  │  graph/              │
│  flows/      │  │  drift/              │  │                      │
│              │  │  features/pr-review/ │  │  KgStore · KgQuery   │
│  FlowDef     │  │  features/           │  │  FileMetrics         │
│  ResolvedFlow│  │  diagnostics/        │  │  FileInsightMaps     │
│  Board       │  │                      │  │  LayerViolation      │
│  Session     │  │  DriftStore          │  │                      │
│  GateResult  │  │  ReviewEntry         │  │                      │
│  STATUS_*    │  │  FlowRunEntry        │  │                      │
└──────┬───────┘  └──────────┬───────────┘  └──────────┬───────────┘
       │                     │                          │
       └──────────┬──────────┘                          │
                  │                                     │
                  ▼                                     │
          ┌───────────────────────────────────────┐    │
          │           Shared Kernel               │◄───┘
          │           shared/                     │
          │                                       │
          │  ToolResult<T> · CanonToolError        │
          │  CanonErrorCode · ReviewEntry          │
          │  CANON_DIR · CANON_FILES               │
          │  LAYER_CENTRALITY                      │
          └───────────────────────────────────────┘
```

---

## Enforcement

Dependency rules are enforced in CI by `dependency-cruiser`. Run locally with:

```bash
npm run lint:deps
```

The `.dependency-cruiser.cjs` config encodes the five boundary rules above as forbidden import patterns. The two current violations (`effects.ts → DriftStore`, `inject-context.ts → KgStore`) are listed as known exceptions with tracking comments until ddd-03 lands the repository interfaces.

---

## Living Document Notes

- **Interfaces section** will be expanded once ddd-03 adds `IKgStore`, `IDriftStore`, and `IExecutionStore` to `domains/knowledge-graph/`, `domains/drift/`, and `domains/workspaces/` respectively.
- **Enforcement section** will be updated once `.dependency-cruiser.cjs` is committed (ddd-05).
- The two current violations under Orchestration Context are tracked work items, not permanent exceptions.
