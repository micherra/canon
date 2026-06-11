# Knowledge Graph Bounded Context — Interface Directory

This directory is the **anti-corruption layer** between the Knowledge Graph bounded context and its cross-context consumers (primarily the Orchestration context). It contains capability interface definitions only — no implementations, no SQL, no business logic.

---

## What This Context Owns

The Knowledge Graph context owns **codebase intelligence**: the file entity graph, import/export edge relationships, structural metrics, and semantic search. Authoritative responsibilities:

- File entity and edge storage (the `files`, `entities`, `edges`, `file_edges` SQLite tables in `knowledge-graph.db`)
- Import/export parsing for JS/TS/Python/Markdown source files (`mcp-server/src/graph/kg-adapter-*.ts`)
- Structural metrics: in/out degree, hub detection, cycle detection, layer violations, blast radius
- Community detection: Louvain `community_id` per file (`mcp-server/src/graph/kg-community.ts`)
- Computed tag propagation: 4-signal tag inference to `file_tags` table (`mcp-server/src/graph/kg-tags.ts`)
- Embedding generation and vector search over file and entity embeddings (`mcp-server/src/graph/kg-embedding.ts`, `mcp-server/src/graph/kg-vector-store.ts`)
- File summaries (persisted to the `summaries` table — ADR-005; no JSON artifacts)
- Knowledge graph freshness tracking (`last_indexed_at`)

**This directory** owns the interface definitions (`IKgStore`, `IKgQuery`) that express the subset of those capabilities that cross-context callers are allowed to depend on.

---

## What This Context Does NOT Own

| Responsibility | Owner |
|---------------|-------|
| Concrete `KgStore` / `KgQuery` implementations | `mcp-server/src/graph/` |
| Graph indexing pipeline and scanning | `mcp-server/src/graph/` |
| SQLite schema and migrations | `mcp-server/src/graph/kg-schema.ts` |
| Entity/edge persistence DAO | `mcp-server/src/graph/kg-store.ts` |
| Analytical query engine | `mcp-server/src/graph/kg-query.ts` |
| Language-specific parse adapters | `mcp-server/src/graph/kg-adapter-*.ts` |
| Flow execution, board state, orchestration | `mcp-server/src/features/orchestration/` |
| Drift/review tracking | `mcp-server/src/platform/storage/drift/` |

---

## Public Interface

### `IKgStore` — file/summary access

```typescript
export interface IKgStore {
  getFile(path: string): FileRow | undefined;
  getSummaryByFile(fileId: number): SummaryRow | undefined;
}
```

Provides the read operations cross-context callers need to retrieve a file record and its associated summary without holding a reference to the concrete `KgStore` class or the underlying `better-sqlite3` `Database`.

### `IKgQuery` — metrics and freshness queries

```typescript
export interface IKgQuery {
  getFileMetrics(filePath: string, insightMaps: FileInsightMaps): FileMetrics | null;
  getKgFreshnessMs(): number | null;
}
```

Exposes structural metrics for a single file and the milliseconds-since-oldest-index freshness value. `getKgFreshnessMs()` returns `null` when the database is empty.

### Imported types (type-only)

The interfaces above depend on types from the Knowledge Graph context's implementation directory:

| Type | Source |
|------|--------|
| `FileRow` | `@graph/kg-types.ts` |
| `SummaryRow` | `@graph/kg-types.ts` |
| `FileMetrics` | `@graph/kg-types.ts` |
| `FileInsightMaps` | `@graph/kg-query.ts` |

These are **type-only imports** (`import type …`). No runtime code from `graph/` enters this directory.

---

## Allowed Dependencies

| Import | Allowed | Notes |
|--------|---------|-------|
| `@graph/kg-types.ts` | Yes — type-only | Source of `FileRow`, `SummaryRow`, `FileMetrics` |
| `@graph/kg-query.ts` | Yes — type-only | Source of `FileInsightMaps` |
| `@graph/kg-store.ts` (concrete class) | No | Consumers must use `IKgStore` |
| `features/orchestration/` | No | Orchestration depends on KG, not vice versa |
| `domains/flows/` | No | KG has no dependency on flow types |
| `platform/` | No | Platform is infrastructure; KG context does not wire itself |
| `shared/` | Yes — direct imports | Constants (`LAYER_CENTRALITY`, `CANON_DIR`) are Shared Kernel |

---

## Dependency Rules for Consumers

Callers that need Knowledge Graph capabilities **must** import from this directory, not from `graph/` directly:

```typescript
// Good — depend on the interface boundary
import type { IKgStore, IKgQuery } from "@domains/knowledge-graph/kg-store.interface.ts";

// Bad — cross-context concrete coupling (triggers dependency-cruiser violation)
import { KgStore } from "@graph/kg-store.ts";
```

The concrete classes `KgStore` and `KgQuery` in `graph/` satisfy these interfaces structurally. The Orchestration context receives them via constructor injection — it never instantiates them directly.

Dependency rules are enforced in CI by `dependency-cruiser`:

```bash
npm run lint:deps
```

---

## Context Relationship (Boundary Map)

```
Orchestration Context (cross-context callers)
        │
        │  import type { IKgStore, IKgQuery }  ← planned; kg-store.interface.ts not yet written
        ▼
┌───────────────────────────────────────────┐
│  domains/knowledge-graph/                 │  ← this directory (ACL boundary)
│  kg-store.interface.ts  (planned)         │
│    IKgStore · IKgQuery                    │
└───────────────────────────────────────────┘
        │
        │  implements (structurally)
        ▼
┌───────────────────────────────────────────┐
│  graph/                                   │  ← implementation (not importable cross-context)
│  KgStore · KgQuery · kg-pipeline          │
│  kg-community · kg-tags · kg-embedding    │
│  SQLite knowledge-graph.db                │
└───────────────────────────────────────────┘
```

---

## Files in This Directory

| File | Purpose |
|------|---------|
| `kg-store.interface.ts` | `IKgStore` and `IKgQuery` interface definitions (planned — not yet written) |
| `README.md` | This document |
