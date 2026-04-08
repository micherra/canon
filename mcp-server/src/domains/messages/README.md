# Messages Bounded Context

Part of the **Orchestration Context** (see `docs/bounded-context-map.md`).

---

## What This Context Owns

- **Inter-agent messaging** — `Message` type, `writeMessage`, `readMessages`, `readChannelAsContext`: read/write of agent coordination messages stored in the SQLite messages table via `ExecutionStore`.
- **Wave coordination prompt injection** — `buildMessageInstructions`: builds the `## Wave Coordination` instructions that are injected into wave agent prompts, telling agents how to call `post_message`/`get_messages` to share discoveries and avoid duplicate work.
- **Flow lifecycle event types and schemas** — `FlowEventType`, `FlowEventMap`, `EventPayloadSchemas`: the full set of named flow lifecycle events (`state_entered`, `state_completed`, `agent_spawned`, `hitl_triggered`, `flow_started`, `flow_completed`, `board_updated`, `wave_event_injected`, `wave_event_resolved`, `stuck_detected`, `tool_scope_audit`) and their Zod validation schemas.
- **Event bus** — `FlowEventBus` (extends `EventEmitter` with typed `emit`/`on` overloads), `flowEventBus` singleton, `validateEventPayload`, `createMetricsAccumulator`.
- **Variable substitution** — `substituteVariables`: `${key}` pattern replacement for spawn prompt templates. `buildTemplateInjection`: builds agent template usage instructions.

---

## What This Context Does NOT Own

- **Message persistence** — messages are stored by `ExecutionStore` in `domains/workspaces/execution-store.ts`. The Messages context delegates all reads and writes through `getExecutionStore(workspace)`.
- **Message delivery / transport** — routing, ordering, and sequencing is managed by the Orchestration flow engine (`features/orchestration/`). Messages are passive data rows; the orchestrator controls who reads them and when.
- **Board and session state** — owned by `domains/board/` and `domains/workspaces/`.
- **Flow definition schemas** — owned by `domains/flows/`. This context imports `GateResult`, `PostconditionResult`, `TestResults`, `ViolationSeverities`, `ConcernEntry`, and `HistoryEntry` from the Flows Context; it does not define them.

---

## Public Interface

### `messages.ts`

| Export | Kind | Description |
|--------|------|-------------|
| `Message` | type | `{ from, timestamp, content }` — a single agent-to-agent message |
| `writeMessage(workspace, channel, from, content)` | async fn | Persist a message to a channel |
| `readMessages(workspace, channel, options?)` | async fn | Retrieve messages ordered by insertion; optional `since` filter |
| `readChannelAsContext(workspace, channel, options?)` | async fn | Render all messages as a single markdown string for prompt injection |
| `buildMessageInstructions(channel, peerCount, workspace)` | fn | Build wave coordination instructions for agent prompts |

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
| `@domains/workspaces/execution-store.ts` | Yes | For message persistence (via `getExecutionStore`) |
| `@shared/*` | Yes | Cross-cutting utilities and constants |
| `zod` | Yes | Event payload schema validation |
| `node:events` | Yes | `EventEmitter` base for `FlowEventBus` |
| `features/orchestration/` | No | Messages must not depend on the orchestration engine |
| `graph/` (Knowledge Graph context) | No | No dependency on KG types or storage |
| `platform/storage/` | No | Storage access goes through `domains/workspaces/`, not directly to platform adapters |
