# platform/

Infrastructure layer — job management, storage backends, and background task execution.

## What this context owns

The `platform/` directory provides concrete infrastructure implementations that the rest of the application depends on:

- **Job management** (`jobs/`) — Background task lifecycle: submit, poll, cancel, cleanup. `JobManager` orchestrates `JobStore`, fingerprinting, and IPC with child processes. `JobStore` is the SQLite CRUD layer for `jobs` and `job_cache` tables. `job-fingerprint.ts` computes git-based deduplication keys.
- **Drift storage** (`storage/drift/`) — Concrete SQLite persistence for code-review and flow-run records. `DriftDb` is a synchronous better-sqlite3 DAO. `DriftStore` is the async Promise-based facade that callers use. The `drift-schema.ts` module initializes the `drift.db` schema. `analytics.ts` and `analyzer.ts` compute aggregate compliance metrics.
- **Adapters** (`adapters/`) — Privileged subprocess adapters: `job-adapter.ts` (fork/kill/IPC helpers for child processes), `git-adapter.ts` (synchronous git commands), `git-adapter-async.ts` (async git commands), `process-adapter.ts` (arbitrary shell commands). Only files in `adapters/` may import `node:child_process`.
- **Workers** (`workers/`) — Child process entry points. `graph-worker.ts` runs the knowledge-graph pipeline in a forked subprocess and communicates progress/completion back to `JobManager` via IPC.

## What this context does NOT own

- **Cross-context interface definitions for drift** — The `IDriftStore` interface (the contract consumers depend on) lives in `domains/drift/`. Cross-context callers must import the interface from there, not the concrete class from here.
- **Orchestration logic** — Flow state machine, board state, gate evaluation, and convergence logic live in `features/orchestration/` and `domains/`.
- **Flow schemas** — `ResolvedFlow`, `StateDefinition`, and related types belong to `domains/flows/`.
- **Knowledge-graph query/scan logic** — `KgStore`, `KgQuery`, and the KG pipeline live under `graph/`. The `graph-worker.ts` in `workers/` is the subprocess entry point that delegates to `graph/kg-pipeline.ts`; it does not own KG logic itself.

## Public interface

| Export | File | Description |
|--------|------|-------------|
| `JobManager` | `jobs/job-manager.ts` | Singleton manager: `submit`, `poll`, `cancel`, `cleanup` |
| `initJobManager` | `jobs/job-manager.ts` | Initialize the singleton at server startup |
| `getJobManager` | `jobs/job-manager.ts` | Retrieve the singleton (returns `null` if not yet initialized) |
| `getOrCreateJobManager` | `jobs/job-manager.ts` | Lazy-init accessor (for tool handlers) |
| `SubmitResult` | `jobs/job-manager.ts` | Return type from `JobManager.submit()` |
| `PollResult` | `jobs/job-manager.ts` | Return type from `JobManager.poll()` |
| `JobStatus` | `jobs/job-store.ts` | `"pending" \| "running" \| "complete" \| "failed" \| "cancelled" \| "timed_out"` |
| `DriftStore` | `storage/drift/store.ts` | Async facade for drift persistence (`getReviews`, `appendReview`, `getComplianceTrend`, etc.) |
| `DriftDb` | `storage/drift/drift-db.ts` | Synchronous SQLite DAO (use `DriftStore` unless you need sync access) |
| `getDriftDb` | `storage/drift/drift-db.ts` | Project-scoped singleton accessor for `DriftDb` |
| `WeeklyTrendPoint` | `storage/drift/store.ts` | Re-exported type: `{ week, pass_rate, violations, reviews }` |
| `JobMessage` | `adapters/job-adapter.ts` | IPC message union: `JobProgressMessage \| JobCompleteMessage \| JobErrorMessage` |
| `WorkerInput` | `adapters/job-adapter.ts` | IPC start command sent to forked workers |

## Allowed dependencies

`platform/` code may import from:

- `@shared/*` — schema types, constants, utility libs (`tool-result.ts`, `env.ts`, etc.)
- `better-sqlite3` — SQLite engine for `DriftDb` and `JobStore`
- `zod` — schema validation
- `node:child_process` — **only within `adapters/`** (ADR-002 invariant)
- `@graph/kg-pipeline.ts` — the graph worker delegates to the KG pipeline (subprocess boundary)
- `@domains/workspaces/execution-schema.ts` — `JobManager` opens `orchestration.db` via this initializer

`platform/` code must NOT import from:

- `features/orchestration/` — orchestration logic is a consumer of platform, not a dependency
- `domains/flows/` — flow schema types are not platform concerns
- `features/knowledge-graph/` — the KG feature layer is a consumer; the worker only imports `@graph/kg-pipeline.ts` directly

## Cross-context access pattern

When feature code in `features/` or `domains/` needs drift storage, it should depend on the `IDriftStore` interface from `domains/drift/` rather than importing `DriftStore` directly. This keeps the domain layer free of concrete infrastructure dependencies and allows the storage backend to be swapped or mocked.

```
features/diagnostics/   →  IDriftStore (domains/drift/)
                                  ↑ implements
                             DriftStore (platform/storage/drift/)
```

The `JobManager` is a singleton initialized at server startup (`app/index.ts`) and accessed by feature tools via `getJobManager()`.
