# Workspaces Bounded Context

Part of the **Orchestration Context** (`features/orchestration/`, `domains/workspaces/`, `domains/board/`, `domains/messages/`).

---

## What this context owns

The Workspaces context is responsible for **workspace initialization and execution-state persistence**. It owns everything needed to create a workspace on disk and to record the full runtime state of a flow execution:

- **Workspace directory initialization** — creates the canonical `.canon/workspaces/<sanitized>/` tree with subdirectories (`artifacts/`, `plans/`, `reviews/`, `transcripts/`)
- **Execution store (SQLite)** — durable, synchronous CRUD for all orchestration state that previously lived in flat files: `board.json`, `progress.md`, per-channel messages, and the event log. One `orchestration.db` per workspace
- **Schema versioning and migration** — `initExecutionDb` / `runMigrations` maintain the SQLite schema across upgrades (currently at v9)
- **`IExecutionStore` interface** — the dependency-inversion boundary that lets `features/orchestration/` depend on a capability contract rather than the concrete DAO

---

## What this context does NOT own

| Concern | Owned by |
|---------|----------|
| Flow execution logic and state transitions | `features/orchestration/` |
| Board mutation helpers (pure functions that return new `Board` values) | `domains/board/` |
| Unified messaging tools (`post_message`, `get_messages` MCP tools) | `domains/messages/` |
| Flow definition schemas, `Board`/`Session` types, `STATUS_KEYWORDS` | `domains/flows/` |
| Cross-cutting utilities (`ToolResult<T>`, `CanonToolError`, constants) | `shared/` |

---

## Public interface

### Core exports

| Export | File | Purpose |
|--------|------|---------|
| `IExecutionStore` | `execution-store.interface.ts` | Capability interface — the boundary callers outside this context depend on |
| `ExecutionStore` | `execution-store.ts` | Concrete SQLite DAO; satisfies `IExecutionStore`; all statements prepared once at construction |
| `getExecutionStore(workspace)` | `execution-store.ts` | Factory — opens (or creates) the `orchestration.db` for a workspace path |
| `initWorkspace(projectDir, sanitized)` | `workspace.ts` | Creates the workspace directory tree; returns the workspace root path |
| `sanitizeBranch(branch)` | `workspace.ts` | Converts a git branch name to a filesystem-safe string |
| `generateSlug(task)` | `workspace.ts` | Converts a task description to a URL-style slug |
| `checkSlugCollision(parentDir, slug)` | `workspace.ts` | Returns a deduplicated slug (appends `-2`, `-3`, …) if the candidate already exists |
| `ContextProvenanceRecord` / `ContextProvenanceSummary` | `context-provenance.ts` | Types for agent-context provenance (hashes + spans, never content); consumed by `run-summary-builder.ts` |
| `hashContent(s)` | `context-provenance.ts` | Deterministic sha256 hex digest of a string |
| `buildContextProvenanceRecord(opts)` | `context-provenance.ts` | Pure builder — hashes + char spans per artifact; blanked artifacts get `char_span:null` + sidecar fields; fail-open (ADR-0018) |

### Schema

| Export | File | Purpose |
|--------|------|---------|
| `initExecutionDb(dbPath)` | `execution-schema.ts` | Opens or creates the SQLite DB, applies DDL, runs pending migrations |
| `runMigrations(db)` | `execution-schema.ts` | Runs version-gated migrations; idempotent |
| `SCHEMA_VERSION` | `execution-schema.ts` | Current DB schema version string (currently `"9"`) |
| `columnExists(db, table, column)` | `execution-schema.ts` | PRAGMA helper used by migrations to guard `ALTER TABLE` calls |

---

## Allowed dependencies

| Dependency | Allowed? | Notes |
|------------|----------|-------|
| `@domains/flows/*` | Yes | Schema types only: `Board`, `Session`, `BoardStateEntry`, `StuckWhen`, etc. |
| `@domains/messages/events.ts` | Yes | `validateEventPayload` for event validation |
| `@shared/*` | Yes | Constants (`CANON_FILES`), utilities |
| `zod` | Yes | Runtime schema validation (via flows schemas) |
| `better-sqlite3` | Yes | SQLite persistence |
| `features/orchestration/` | **No** | Orchestration depends on this context, not the reverse |
| `graph/` | **No** | No knowledge-graph dependency |
| `platform/storage/drift/` | **No** | No drift-store dependency |
