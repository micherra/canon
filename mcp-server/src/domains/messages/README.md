# Messages Bounded Context

Part of the **Orchestration Context** (see `docs/bounded-context-map.md`).

---

## What This Context Owns

- **Flow lifecycle event types and schemas** — `FlowEventType`, `FlowEventMap`, `EventPayloadSchemas`: the full set of named flow lifecycle events (`state_entered`, `state_completed`, `agent_spawned`, `hitl_triggered`, `flow_started`, `flow_completed`, `board_updated`, `wave_event_injected`, `wave_event_resolved`, `stuck_detected`, `tool_scope_audit`) and their Zod validation schemas.
- **Event bus** — `FlowEventBus` (extends `EventEmitter` with typed `emit`/`on` overloads), `flowEventBus` singleton, `validateEventPayload`, `createMetricsAccumulator`.
- **Variable substitution** — `substituteVariables`: `${key}` pattern replacement for spawn prompt templates. `buildTemplateInjection`: builds agent template usage instructions.

---

## What This Context Does NOT Own

- **Message persistence** — removed 2026-05-16. The Messages context no longer reads or writes `ExecutionStore`. Board and session state are owned exclusively by `domains/workspaces/`.
- **Message delivery / transport** — routing, ordering, and sequencing is managed by the Orchestration flow engine (`features/orchestration/`). Messages are passive data rows; the orchestrator controls who reads them and when.
- **Board and session state** — owned by `domains/board/` and `domains/workspaces/`.
- **Flow definition schemas** — owned by `domains/flows/`. This context imports `GateResult`, `PostconditionResult`, `TestResults`, `ViolationSeverities`, `ConcernEntry`, and `HistoryEntry` from the Flows Context; it does not define them.

---

## Public Interface

### `events.ts`

| Export | Kind | Description |
|--------|------|-------------|
| `FlowEventType` | type | Union of 12 lifecycle event names |
| `FlowEventMap` | type | Typed payload shapes keyed by `FlowEventType` |
| `EventPayloadSchemas` | const | Zod schemas for all 12 event payloads; used for runtime validation |
| `validateEventPayload(type, payload)` | fn | Validate a payload against its schema; returns `{ valid, errors? }` — never throws |
| `FlowEventBus` | class | `EventEmitter` subclass with typed `emit`/`on` overloads |
| `createMetricsAccumulator()` | fn | Returns an `{ handler, getMetrics }` pair that accumulates spawn/duration metrics from events |

### `event-bus-instance.ts`

| Export | Kind | Description |
|--------|------|-------------|
| `flowEventBus` | const | Singleton `FlowEventBus` shared across the Orchestration Context |

### `variables.ts`

| Export | Kind | Description |
|--------|------|-------------|
| `substituteVariables(template, vars)` | fn | Replace `${key}` patterns; escaped `\${key}` pass through unchanged |
| `buildTemplateInjection(templates, pluginDir)` | fn | Build template usage instruction lines for agent prompts |

---

## Allowed Dependencies

| Dependency | Allowed | Notes |
|------------|---------|-------|
| `@domains/flows/*` | Yes | Type imports only (`GateResult`, `PostconditionResult`, etc.) |
| `@domains/workspaces/execution-store.ts` | No | Message persistence removed 2026-05-16; no longer used |
| `@shared/*` | Yes | Cross-cutting utilities and constants |
| `zod` | Yes | Event payload schema validation |
| `node:events` | Yes | `EventEmitter` base for `FlowEventBus` |
| `features/orchestration/` | No | Messages must not depend on the orchestration engine |
| `graph/` (Knowledge Graph context) | No | No dependency on KG types or storage |
| `platform/storage/` | No | Storage access goes through `domains/workspaces/`, not directly to platform adapters |
