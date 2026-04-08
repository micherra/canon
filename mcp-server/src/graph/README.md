# Knowledge Graph Context — `graph/`

This directory is the **Knowledge Graph bounded context**. It owns the SQLite-backed codebase knowledge graph: file indexing, entity and edge storage, structural metrics, blast-radius computation, and semantic search.

---

## What this context owns

- **`KgStore`** (`kg-store.ts`) — typed CRUD against the SQLite `knowledge-graph.db` database. All writes go through here: files, entities, edges, file-level edges, and AI-generated summaries. Statements are prepared once at construction time. All operations are synchronous (`better-sqlite3`).
- **`KgQuery`** (`kg-query.ts`) — read-only analytical queries: callers/callees, blast radius (recursive CTEs), full-text search (FTS5), dead-code detection, in/out degree, subgraph extraction, and KG freshness.
- **`KgTypes`** (`kg-types.ts`) — pure TypeScript type definitions for SQLite row shapes (`FileRow`, `EntityRow`, `EdgeRow`, `FileEdgeRow`, `SummaryRow`), ingestion pipeline types (`AdapterResult`, `LanguageAdapter`), and query result types (`FileMetrics`, `LayerViolation`, `BlastRadiusResult`, `SearchResult`, etc.).
- **`KgSchema`** (`kg-schema.ts`) — SQLite DDL, PRAGMA configuration, schema versioning (`SCHEMA_VERSION`), and `runMigrations()`.
- **`KgPipeline`** (`kg-pipeline.ts`) — codebase indexing entry point. Ties together file scanning, language-adapter parsing, import resolution, Canon entity linking, and DB persistence via `runPipeline()` and `reindexFile()`.
- **`Scanner`** (`scanner.ts`) — recursive file system scan with symlink-loop detection and configurable include/exclude rules.
- **Language adapters** (`kg-adapter-*.ts`) — pluggable per-language parsers (TypeScript, Markdown, YAML) registered via `kg-adapter-registry.ts`.
- **`Insights` / `Degree` / `Priority`** (`insights.ts`, `degree.ts`, `priority.ts`) — structural analytics: hub detection, cycle detection, layer-violation analysis, and impact scoring.
- **`KgBlastRadius`** (`kg-blast-radius.ts`) — blast-radius analysis at the entity and file levels.
- **`KgDeadCode`** (`kg-dead-code.ts`) — unreferenced entity detection.
- **`KgEmbedding` / `KgVectorStore` / `KgVectorQuery`** — embedding generation and vector similarity search (optional, requires `sqlite-vec`).
- **`KgWasmParser`** (`kg-wasm-parser.ts`) — WebAssembly-based tree-sitter parser initialization.
- **Import/export parsers** (`import-parser.ts`, `export-parser.ts`, `md-relations.ts`) — specifier resolution for JS/TS/Python/Markdown import and export statements.

---

## What this context does NOT own

- **Cross-context interface definitions** — `IKgStore` and `IKgQuery` live in `domains/knowledge-graph/` (see below). That directory is the published interface boundary; this directory is the implementation.
- **Orchestration flow logic** — the flow engine, state transitions, board state, and spawn mechanics all live in `features/orchestration/`.
- **Drift and review data** — review persistence, compliance analytics, and PR-review storage live in `platform/storage/drift/` and `features/pr-review/`.
- **MCP tool registration** — the `codebase_graph`, `graph_query`, and `semantic_search` MCP tools live in `features/knowledge-graph/`. They call into this context but are not part of it.

---

## Public interface for cross-context callers

Cross-context callers (e.g. `features/orchestration/services/inject-context.ts`) must import the **interfaces** from `domains/knowledge-graph/`, not the concrete classes from `graph/` directly.

| Interface | Location | Implemented by |
|-----------|----------|----------------|
| `IKgStore` | `domains/knowledge-graph/kg-store.interface.ts` | `KgStore` in `graph/kg-store.ts` |
| `IKgQuery` | `domains/knowledge-graph/kg-store.interface.ts` | `KgQuery` in `graph/kg-query.ts` |

Both interfaces expose only the subset of methods needed by cross-context consumers:

```typescript
// domains/knowledge-graph/kg-store.interface.ts
interface IKgStore {
  getFile(path: string): FileRow | undefined;
  getSummaryByFile(fileId: number): SummaryRow | undefined;
}

interface IKgQuery {
  getFileMetrics(filePath: string, insightMaps: FileInsightMaps): FileMetrics | null;
  getKgFreshnessMs(): number | null;
}
```

Code inside `graph/` may use `KgStore` and `KgQuery` directly — the interface boundary applies only when crossing into another context.

---

## Key exported types

| Type | File | Purpose |
|------|------|---------|
| `KgStore` | `kg-store.ts` | Entity/edge/file/summary CRUD |
| `KgQuery` | `kg-query.ts` | Read-only analytical queries |
| `FileMetrics` | `kg-types.ts` | In/out degree, hub, cycle, layer-violation, impact score |
| `FileInsightMaps` | `kg-query.ts` | Batch hub/cycle/violation precompute result (pass to `getFileMetrics`) |
| `LayerViolation` | `kg-types.ts` | A single layer-dependency rule violation |
| `EntityKind` | `kg-types.ts` | Union of all entity kinds (`function`, `class`, `interface`, …) |
| `EdgeType` | `kg-types.ts` | Union of all edge types (`imports`, `calls`, `extends`, …) |
| `FileRow` | `kg-types.ts` | SQLite `files` table row shape |
| `EntityRow` | `kg-types.ts` | SQLite `entities` table row shape |
| `AdapterResult` | `kg-types.ts` | Output contract for language adapters |
| `LanguageAdapter` | `kg-types.ts` | Pluggable per-language parser interface |
| `BlastRadiusResult` | `kg-types.ts` | Entity-level blast radius query row |
| `FileBlastRadiusResult` | `kg-types.ts` | File-level blast radius query row |
| `computeImpactScore` | `kg-query.ts` | Impact score formula (exported for PR-review context) |
| `computeFileInsightMaps` | `kg-query.ts` | Batch precompute helper (call once per request) |
| `PipelineResult` | `kg-pipeline.ts` | Indexing run summary |
| `runPipeline` | `kg-pipeline.ts` | Full codebase indexing entry point |
| `reindexFile` | `kg-pipeline.ts` | Incremental single-file reindex |

---

## Allowed dependencies

| Dependency | Allowed? | Notes |
|------------|----------|-------|
| `@shared/*` (`constants`, `matcher`) | Yes | Layer inference, file extensions, `CANON_DIR`/`CANON_FILES` constants |
| `better-sqlite3` | Yes | SQLite driver |
| `zod` | Yes | Input validation in pipeline options |
| `features/orchestration/` | No | Context boundary — forbidden |
| `domains/flows/` | No | Context boundary — KG has no dependency on flow types |
| `platform/` (except via `@shared`) | No | Context boundary — forbidden |

---

## Integration note

The `inject-context.ts` service in `features/orchestration/` currently instantiates `KgStore` directly — a known boundary violation tracked as a work item. The planned fix is constructor injection via `IKgStore`/`IKgQuery`. Until that lands, the concrete import is an approved exception in `.dependency-cruiser.cjs`.

Storage is SQLite-only (`knowledge-graph.db` in `.canon/`). The former `graph-data.json`, `summaries.json`, and `reverse-deps.json` artifacts are no longer written (removed in ADR-005, 2026-04-01).
