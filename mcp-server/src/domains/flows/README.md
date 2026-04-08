# Flows Bounded Context

**Directory**: `mcp-server/src/domains/flows/`

The Flows Context is the shared vocabulary of the Canon MCP server. It owns the schema contracts for flow definitions, state types, board/session state, and event types. Every other context that participates in flow execution imports types from here — this context is a published language module, not an execution engine.

---

## What This Context Owns

- **Flow definition schemas** — `FlowDefinition`, `ResolvedFlow`, `StateDefinition` (single, wave, parallel, parallel-per, terminal), fragment schemas, and the status vocabulary (`STATUS_KEYWORDS`, `STATUS_ALIASES`)
- **Board and session state schemas** — `Board`, `Session`, `BoardStateEntry`, `StateMetrics`, `WaveResult`, iteration history, and stuck-detection history entry variants
- **Quality gate contracts** — `GateResult`, `DiscoveredGate`, `PostconditionAssertion`, `PostconditionResult`, `ViolationSeverities`, `TestResults`
- **Event schemas** — `TranscriptEntry` (ADR-015) and `WaveEvent` / `WaveEventType` for wave coordination
- **Flow parsing** — reading `.md` flow files, resolving fragment includes, and producing a validated `ResolvedFlow`
- **Gate runner** — resolving gate names to shell commands (3-tier: direct commands > named references > agent-discovered), running gates, and re-exporting `GateResult`
- **Skip-when evaluation** — evaluating `skip_when` conditions (`no_contract_changes`, `no_fix_requested`, `auto_approved`, `no_open_questions`) against board state and git history
- **Flow event channel** — draining and interpreting structured events from the `flow-events` channel (insert, skip, escalate effects)

---

## What This Context Does NOT Own

- **Flow execution / orchestration** — state transitions, drive-flow loop, spawn request assembly, HITL breakpoints, convergence detection, competition/debate protocols → `features/orchestration/`
- **Board persistence** — reading/writing `board.json` to disk, `ExecutionStore`, workspace lifecycle → `domains/workspaces/`
- **Wave coordination runtime** — wave event injection, wave briefing assembly, worktree merge → `features/orchestration/`
- **Effects pipeline** — `persist_review`, `check_postconditions` side effects → `features/orchestration/engine/effects.ts`
- **Messaging** — workspace channels, unified messaging → `domains/messages/`

---

## Public Interface

### `flow-definition-schemas.ts`

Core schema file. All other files in this context import from here.

| Export | Purpose |
|--------|---------|
| `FlowDefinition` / `FlowDefinitionSchema` | Parsed (unresolved) flow — states may contain fragment includes |
| `ResolvedFlow` / `ResolvedFlowSchema` | Flow after full fragment resolution; `entry` and `states` are guaranteed present |
| `StateDefinition` / `StateDefinitionSchema` | Discriminated union of all five state types |
| `SingleState`, `WaveState`, `ParallelState`, `ParallelPerState`, `TerminalState` | Per-type narrowed state types |
| `WavePolicy` / `WavePolicySchema` | Wave isolation, merge strategy, and conflict config |
| `FragmentDefinition` / `FragmentDefinitionSchema` | Fragment file schema with relaxed param placeholder fields |
| `BaseStateFields` | Shared field set used across all state type schemas |
| `STATUS_KEYWORDS` | Tuple of all recognized agent status keywords |
| `STATUS_ALIASES` | Maps agent-reported statuses to canonical transition conditions |
| `GateResult` / `GateResultSchema` | Gate execution result: `{ gate, passed, command?, output?, exitCode? }` |
| `DiscoveredGate` / `DiscoveredGateSchema` | Agent-reported gate discovery: `{ command, source }` |
| `PostconditionAssertion` / `PostconditionAssertionSchema` | Typed assertion declaration |
| `PostconditionResult` / `PostconditionResultSchema` | Assertion evaluation result |
| `ViolationSeverities` / `ViolationSeveritiesSchema` | `{ blocking, warning }` counts |
| `TestResults` / `TestResultsSchema` | `{ passed, failed, skipped }` counts |
| `SkipWhen` / `SkipWhenSchema` | Enum of skip condition names |
| `StuckWhen` / `StuckWhenSchema` | Enum of stuck-detection strategy names |
| `CompeteConfig`, `DebateConfig` | Competitive execution and debate protocol config |
| `ToolOverrides` / `ToolOverridesSchema` | Per-state tool permission overrides (ADR-014) |
| `RequiredArtifact` / `RequiredArtifactSchema` | Required artifact declaration (ADR-010) |

### `board-state-schemas.ts`

| Export | Purpose |
|--------|---------|
| `Board` / `BoardSchema` | Full board state for a flow execution |
| `Session` / `SessionSchema` | Session lifecycle record (branch, status, slug, tier) |
| `BoardStateEntry` / `BoardStateEntrySchema` | Per-state execution record including metrics, gate results, wave results |
| `StateMetrics` / `StateMetricsSchema` | Performance and quality metrics recorded per state |
| `WaveResult` / `WaveResultSchema` | Wave execution summary including consultation results and worktree entries |
| `AgentMetrics` / `AgentMetricsSchema` | Agent-reported performance counters (ADR-003a) |
| `IterationEntry` / `IterationEntrySchema` | Iteration count and stuck-detection history for a state |
| `HistoryEntry` variants | `ViolationHistoryEntry`, `FileTestHistoryEntry`, `StatusHistoryEntry`, `ProgressHistoryEntry`, `GateProgressHistoryEntry` |

### `event-schemas.ts`

| Export | Purpose |
|--------|---------|
| `TranscriptEntry` / `TranscriptEntrySchema` | Agent transcript record (ADR-015) |
| `WaveEventType` | Union of wave event type literals |
| `WaveEvent` | Wave event record with lifecycle fields (`status`, `applied_at`, etc.) |
| `WaveEventResolution` | Resolution payload type |

### `flow-parser.ts`

| Export | Purpose |
|--------|---------|
| `parseFlowContent(content)` | Splits a `.md` flow file into YAML frontmatter and spawn instructions |
| `loadAndResolveFlow(pluginDir, flowName, projectDir?)` | Loads a flow file, resolves all fragment includes, validates, returns `ResolvedFlow`; throws on hard errors |
| `validateSpawnCoverage(flow)` | Returns error strings for non-terminal states missing spawn instructions |
| `analyzeReachability(flow)` | Returns warning strings for unreachable states |
| `checkUnresolvedRefs(flow)` | Returns error strings for spawn instructions containing unresolved `${param}` references |
| `VIRTUAL_SINKS` | Set of virtual sink state names exempt from reachability checks |
| `RUNTIME_VARIABLES` | Set of known runtime variable names exempt from ref checks |

### `gate-runner.ts`

| Export | Purpose |
|--------|---------|
| `resolveGateCommand(gateName, flow, cwd?)` | Resolves a gate name to a shell command via 3-tier lookup |
| `runGate(gateName, flow, cwd)` | Runs a single named gate; fail-closed — unresolved name returns `{ passed: false }` |
| `runGates(stateDef, flow, cwd, boardState?)` | Runs all gates declared on a state; returns `GateResult[]` |
| `normalizeGates(stateDef, flow, cwd, boardState?)` | Resolves gates without executing; returns `{ commands, source }` |
| `GateResult` | Re-exported from `flow-definition-schemas.ts` |

### `skip-when.ts`

| Export | Purpose |
|--------|---------|
| `evaluateSkipWhen(condition, workspace, board)` | Evaluates a `skip_when` condition against board state and git history |
| `matchGlob(pattern, filePath)` | Simple glob matching used by `no_contract_changes` evaluation |

### `flow-event-channel.ts`

| Export | Purpose |
|--------|---------|
| `drainFlowEvents(params)` | Drains the `flow-events` channel since a watermark; returns first actionable effect and updated watermark |
| `FlowEventEffect` | Discriminated union: `none`, `insert`, `skip`, `escalate` |
| `DrainFlowEventsParams` / `DrainFlowEventsResult` | Input/output types for `drainFlowEvents` |

---

## Allowed Dependencies

| Dependency | Allowed | Notes |
|-----------|---------|-------|
| `zod` | Yes | Schema validation |
| `yaml` | Yes | YAML parsing in `flow-parser.ts` |
| `node:fs/promises`, `node:path` | Yes | File I/O in `flow-parser.ts` only |
| `@shared/*` (constants, utilities) | Yes | Cross-cutting constants |
| `@platform/adapters/*` | Yes | `git-adapter.ts` in `skip-when.ts`, `process-adapter.ts` in `gate-runner.ts` |
| `@domains/workspaces/execution-store` | Structural only | `flow-event-channel.ts` imports `ExecutionStore` as a `Pick<>` interface type — no runtime dependency |
| `features/orchestration/` | No | Orchestration depends on Flows, not the reverse |
| `graph/` | No | Knowledge Graph context is independent |
| `platform/storage/drift/` | No | Drift context is independent |

> The import of `ExecutionStore` in `flow-event-channel.ts` is a structural `Pick<>` type-only import (no runtime value). It exists to type the `store` parameter of `drainFlowEvents` without pulling in the concrete class.
