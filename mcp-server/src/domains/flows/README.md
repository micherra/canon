# Flows Bounded Context

**Directory**: `mcp-server/src/domains/flows/`

The Flows Context is the shared vocabulary of the Canon MCP server. It owns the schema contracts for quality gate results, postcondition contracts, and board/session runtime state. Every other context that participates in flow execution imports types from here — this context is a published language module, not an execution engine.

---

## What This Context Owns

- **Quality gate contracts** — `GateResult`, `DiscoveredGate`, `PostconditionAssertion`, `PostconditionResult`, `ViolationSeverities`, `TestResults`
- **Stuck-detection enum** — `StuckWhen` (used by the execution store)
- **Board and session state schemas** — `Board`, `Session`, `BoardStateEntry`, `StateMetrics`, `WaveResult`, iteration history, and stuck-detection history entry variants
- **Event schemas** — `TranscriptEntry` (ADR-015)

---

## What This Context Does NOT Own

- **Flow definition schemas** — `FlowDefinition`, `ResolvedFlow`, `StateDefinition`, fragment schemas, and the status vocabulary were deleted 2026-05-05 when the `flows/` YAML directory was removed
- **Flow execution / orchestration** — state transitions, drive-flow loop, spawn request assembly, HITL breakpoints, convergence detection, competition/debate protocols → `features/orchestration/`
- **Board persistence** — reading/writing `board.json` to disk, `ExecutionStore`, workspace lifecycle → `domains/workspaces/`
- **Wave coordination runtime** — wave event injection, wave briefing assembly, worktree merge → `features/orchestration/`
- **Effects pipeline** — `persist_review`, `check_postconditions` side effects → `features/orchestration/engine/effects.ts`
- **Messaging** — workspace channels, unified messaging → `domains/messages/`

---

## Public Interface

### `flow-definition-schemas.ts`

Quality gate contracts and execution control enums.

| Export | Purpose |
|--------|---------|
| `GateResult` / `GateResultSchema` | Gate execution result: `{ gate, passed, command?, output?, exitCode? }` |
| `DiscoveredGate` / `DiscoveredGateSchema` | Agent-reported gate discovery: `{ command, source }` |
| `PostconditionAssertion` / `PostconditionAssertionSchema` | Typed assertion declaration |
| `PostconditionResult` / `PostconditionResultSchema` | Assertion evaluation result |
| `ViolationSeverities` / `ViolationSeveritiesSchema` | `{ blocking, warning }` counts |
| `TestResults` / `TestResultsSchema` | `{ passed, failed, skipped }` counts |
| `StuckWhen` / `StuckWhenSchema` | Enum of stuck-detection strategy names |

### `board-state-schemas.ts`

| Export | Purpose |
|--------|---------|
| `Board` / `BoardSchema` | Full board state for a flow execution |
| `Session` / `SessionSchema` | Session lifecycle record (branch, status, slug, tier) |
| `BoardStateEntry` / `BoardStateEntrySchema` | Per-state execution record including metrics, gate results, wave results |
| `StateMetrics` / `StateMetricsSchema` | Performance and quality metrics recorded per state; optional `stage_metrics` field (added 2026-07-06) namespaces counters under a stage label for a single-window agent reporting per-stage measurements (e.g. `reviewer`'s Measured-Step Module Contracts) |
| `WaveResult` / `WaveResultSchema` | Wave execution summary including consultation results and worktree entries |
| `AgentMetrics` / `AgentMetricsSchema` | Agent-reported performance counters (ADR-003a) |
| `IterationEntry` / `IterationEntrySchema` | Iteration count and stuck-detection history for a state |
| `HistoryEntry` variants | `ViolationHistoryEntry`, `FileTestHistoryEntry`, `StatusHistoryEntry`, `ProgressHistoryEntry`, `GateProgressHistoryEntry` |

### `transcript-schemas.ts`

| Export | Purpose |
|--------|---------|
| `TranscriptEntry` / `TranscriptEntrySchema` | Agent transcript record (ADR-015) |

---

## Allowed Dependencies

| Dependency | Allowed | Notes |
|-----------|---------|-------|
| `zod` | Yes | Schema validation |
| `@shared/*` (constants, utilities) | Yes | Cross-cutting constants |
| `features/orchestration/` | No | Orchestration depends on Flows, not the reverse |
| `graph/` | No | Knowledge Graph context is independent |
| `platform/storage/drift/` | No | Drift context is independent |
