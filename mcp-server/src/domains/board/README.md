# Board Bounded Context

Part of the **Orchestration Context** (`features/orchestration/`, `domains/workspaces/`, `domains/board/`, `domains/messages/`).

---

## What This Context Owns

- **Board mutation logic** — pure functions that take a `Board` value and return a new `Board` value (immutable pattern). This includes state entry creation (`initBoard`), status transitions (`enterState`, `completeState`, `setBlocked`), and wave-level result recording (`recordConsultationResult`, `recordGateResult`).
- **Board sync** — the `syncBoardToStore` utility that writes a mutated `Board` back to `ExecutionStore` (SQLite). Extracted so that orchestration handlers can call it without duplicating logic (ADR-009a).

---

## What This Context Does NOT Own

| Concern | Owned by |
|---------|---------|
| `Board` and `BoardStateEntry` type definitions | `domains/flows/board-state-schemas.ts` (Flows Context) |
| Board persistence to SQLite (schema, migrations, CRUD) | `domains/workspaces/execution-store.ts` (Orchestration — workspaces subdomain) |
| Flow execution decisions (state transitions, convergence) | `features/orchestration/` |
| Session state | `domains/workspaces/execution-store.ts` |

---

## Public Interface

### `board.ts` — Board mutation helpers

All functions are **pure** — they accept a `Board` and return a new `Board`. No I/O.

| Function | Purpose |
|----------|---------|
| `initBoard(flow, task, baseCommit)` | Create a new `Board` from a resolved flow definition |
| `enterState(board, stateId)` | Set a state to `in_progress`, increment entries and iteration count |
| `completeState(board, stateId, result, artifacts?)` | Set a state to `done`, record result and optional artifact paths |
| `setBlocked(board, stateId, reason)` | Mark a state and the board as blocked |
| `recordConsultationResult(board, stateId, opts)` | Record a consultation result into a wave result entry |
| `recordGateResult(board, stateId, opts)` | Record a gate name and output into a wave result entry |

### `board-sync.ts` — Board persistence helper

| Function | Purpose |
|----------|---------|
| `syncBoardToStore(store, board)` | Write a mutated `Board` to `ExecutionStore` — updates execution fields, states, and iterations |

---

## Allowed Dependencies

| Dependency | Allowed? | Reason |
|-----------|----------|--------|
| `@domains/flows/*` | Yes | Type imports (`Board`, `ResolvedFlow`, `ConsultationResult`) from the Flows Context shared vocabulary |
| `@shared/*` | Yes | Shared Kernel — foundation layer |
| `@domains/workspaces/*` | Type-only | `board-sync.ts` imports the `getExecutionStore` return type for its parameter signature; no runtime coupling |
| `features/orchestration/` | No | Board context must not depend on the engine that calls it |
| `graph/` | No | No knowledge-graph dependency |

---

## Notes

- File I/O (`readBoard`, `writeBoard`) was removed from `board.ts` in a prior refactor. `ExecutionStore` (SQLite) is the sole persistence path.
- `board-sync.ts` depends on the `ExecutionStore` type via `ReturnType<typeof getExecutionStore>`. This is a type-level dependency only; the concrete store instance is always injected by the caller.
