# Workspaces Bounded Context

Part of the **Orchestration Context** (`features/orchestration/`, `domains/workspaces/`, `domains/board/`, `domains/messages/`).

---

## What this context owns

The Workspaces context is responsible for **workspace initialization and execution-state persistence**. It owns everything needed to create a workspace on disk and to record the full runtime state of a flow execution:

- **Workspace directory initialization** — creates the canonical `.canon/workspaces/<sanitized>/` tree with subdirectories (`artifacts/`, `plans/`, `reviews/`, `transcripts/`)
- **Execution store (SQLite)** — durable, synchronous CRUD for all orchestration state that previously lived in flat files: `board.json`, `progress.md`, per-channel messages, wave events, and the event log. One `orchestration.db` per workspace
- **Wave event storage** — `postWaveEvent`, `getWaveEvents`, `updateWaveEvent` for in-flight agent coordination signals (`add_task`, `skip_task`, `guidance`, `inject_context`, `pause`, `reprioritize`)
- **Wave lifecycle** — git worktree creation (`createWaveWorktrees`), sequential merge (`mergeWaveResults`), and best-effort cleanup (`cleanupWorktrees`)
- **Wave variable resolution** — reads plan files, prior-wave summaries, and `git diff HEAD~1` to populate the `${wave_plans}`, `${wave_summaries}`, `${wave_files}`, `${wave_diff}`, `${all_summaries}` variables injected into agent spawn prompts
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
| Wave event type definitions (`WaveEvent`, `WaveEventType`) | `domains/flows/event-schemas.ts` |
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

### Wave event helpers

| Export | File | Purpose |
|--------|------|---------|
| `resolveEventAgents(eventType)` | `wave-events.ts` | Pure lookup — which agents (if any) handle a given wave event type |
| `WaveEvent`, `WaveEventType`, `WaveEventResolution` | `wave-events.ts` | Re-exported from `domains/flows/event-schemas.ts` for callers that import via this module |

### Wave lifecycle

| Export | File | Purpose |
|--------|------|---------|
| `createWaveWorktrees(tasks, projectDir)` | `wave-lifecycle.ts` | Creates a git worktree per wave task under `.canon/worktrees/<task_id>` |
| `mergeWaveResults(tasks, projectDir, strategy)` | `wave-lifecycle.ts` | Sequentially merges completed wave branches; returns structured error on conflict |
| `cleanupWorktrees(tasks, projectDir)` | `wave-lifecycle.ts` | Best-effort removal of worktrees and tracking branches |
| `getProjectDir(workspace)` | `wave-lifecycle.ts` | Derives the project root from a workspace path |

### Wave variable resolution

| Export | File | Purpose |
|--------|------|---------|
| `resolveWaveVariables(workspace, opts)` | `wave-variables.ts` | Resolves the five wave-boundary variables for spawn prompt injection |
| `parseTaskIdsForWave(indexContent, wave)` | `wave-variables.ts` | Parses `INDEX.md` to find task IDs for a given wave number |
| `extractFilePaths(content)` | `wave-variables.ts` | Extracts file paths from summary text |
| `escapeDollarBrace(text)` | `wave-variables.ts` | Trust-boundary sanitizer — escapes `${` in agent-sourced text before it enters the variables map |

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
| `@domains/flows/*` | Yes | Schema types only: `Board`, `Session`, `BoardStateEntry`, `WaveEvent`, `StuckWhen`, etc. |
| `@domains/messages/events.ts` | Yes | `validateEventPayload` for wave event validation |
| `@shared/*` | Yes | Constants (`CANON_FILES`), utilities |
| `zod` | Yes | Runtime schema validation (via flows schemas) |
| `better-sqlite3` | Yes | SQLite persistence |
| `@platform/adapters/git-adapter.ts` | Yes | Sync git operations in `wave-variables.ts` |
| `@platform/adapters/git-adapter-async.ts` | Yes | Async git operations in `wave-lifecycle.ts` |
| `features/orchestration/` | **No** | Orchestration depends on this context, not the reverse |
| `graph/` | **No** | No knowledge-graph dependency |
| `platform/storage/drift/` | **No** | No drift-store dependency |

> **Subprocess isolation (ADR-002)**: `wave-lifecycle.ts` and `wave-variables.ts` import from `@platform/adapters/` only. Neither file imports `node:child_process` directly.
