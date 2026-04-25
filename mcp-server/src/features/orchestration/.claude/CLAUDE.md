# orchestration/ — Flow Execution Engine

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
Flow execution engine and all Canon orchestration MCP tools. This bounded context owns the state machine runtime that drives Canon's build flows, plus every harness tool that the orchestrator calls to advance workflow state.

## Architecture
<!-- last-updated: 2026-04-09 -->

**`engine/`** — Pure state machine logic. No I/O except through injected dependencies.

| File | Responsibility |
|------|---------------|
| `transitions.ts` | State transition evaluation — stuck detection, parallel aggregation, convergence checks |
| `convergence.ts` | Convergence loop — iteration limit enforcement, state progression rules |
| `effects.ts` | Effect execution — applies declared effects (check_postconditions, etc.) after state entry |
| `compete.ts` | Competitive flow protocol — parallel agent competition, winner selection |
| `debate.ts` | Debate protocol — structured multi-agent deliberation |
| `consultation-executor.ts` | Consultation execution — runs before/after consultation prompts |

**`tools/`** — MCP tool handlers. All handlers are thin wrappers calling services or engine functions.
<!-- last-updated: 2026-04-23 -->

| Tool file | MCP tool name |
|-----------|--------------|
| `invoke-janitor.ts` | `invoke_janitor` |
| `drive-flow.ts` | `drive_flow` |
| `init-workspace.ts` | `init_workspace` |
| `load-flow.ts` | `load_flow` |
| `report-result.ts` | `report_result` |
| `update-board.ts` | `update_board` |
| `enter-and-prepare-state.ts` | `enter_and_prepare_state` |
| `report.ts` | `report` |
| `post-message.ts` | `post_message` |
| `get-messages.ts` | `get_messages` |
| `inject-wave-event.ts` | `inject_wave_event` |
| `resolve-wave-event.ts` | `resolve_wave_event` |
| `resolve-after-consultations.ts` | `resolve_after_consultations` |
| `record-agent-metrics.ts` | `record_agent_metrics` |
| `post-event.ts` | `post_event` |
| `write-plan-index.ts` | `write_plan_index` |
| `simulate-flow.ts` | `simulate_flow` |
| `get-spawn-prompt.ts` | `get_spawn_prompt` |
| `get-transcript.ts` | `get_transcript` |
| `write-design-brief.ts` | `write_design_brief` |
| `write-implementation-summary.ts` | `write_implementation_summary` |
| `write-research-synthesis.ts` | `write_research_synthesis` |
| `write-review.ts` | `write_review` |
| `write-test-report.ts` | `write_test_report` |

**`services/`** — Business logic backing tools and engine.
<!-- last-updated: 2026-04-23 -->

| File | Responsibility |
|------|---------------|
| `janitor.ts` | `runJanitor(projectDir)` — gate checks (enabled, time, lock), WAL checkpoint, prune detection; returns `JanitorResult` |
| `context-budget.ts` | Token budget tracking for agent context windows |
| `context-enrichment.ts` | Enriches spawn prompts with KG context and file summaries |
| `contract-checker.ts` | Evaluates postcondition assertions after state completion |
| `diff-cluster.ts` | Clusters changed files by prefix, layer, and change type |
| `drive-flow-types.ts` | Shared types for drive_flow inputs and outputs |
| `inject-context.ts` | Injects context from after-consultation summaries into next state |
| `kg-context-formatter.ts` | Formats KG data for inclusion in agent prompts |
| `learn-gate.ts` | Auto-learn gate evaluation at flow completion |
| `scope-resolver.ts` | Resolves task scope from board state and flow definition |
| `wave-briefing.ts` | Assembles wave briefing payloads for parallel task agents |

## Contracts
<!-- last-updated: 2026-04-09 -->
Key tool functions (all return `ToolResult<T>` — see `@shared/lib/tool-result.ts`):

- `driveFlow(input, pluginDir, projectDir?)` — advance flow state machine; returns `SpawnRequest | HitlBreakpoint | { action: "done" }`
- `initWorkspace(input)` — create or resume workspace; preflight checks when `preflight: true`
- `loadFlow(input, pluginDir, projectDir?)` — load and resolve flow definition; throws on hard validation errors
- `reportResult(input)` — record agent result and evaluate transitions; appends to `progress.md` via `progress_line`
- `updateBoard(input)` — mutate board state (skip, block, unblock, complete_flow, set_wave_progress)
- `enterAndPrepareState(input)` — enter a state and assemble its spawn prompt
- `postMessage(input)` / `getMessages(input)` — unified workspace channel messaging
- `resolveWaveEvent(input)` — apply or reject a pending wave event
- `resolveAfterConsultations(input)` — resolve after-consultation prompts for a state

## Invariants
<!-- last-updated: 2026-04-09 -->
- Must not import directly from other features — uses `@domains/*` types as shared contracts
- Tool handlers are thin wrappers; all logic lives in `engine/` or `services/`
- All tool handlers are wrapped with `wrapHandler` from `@shared/lib/wrap-handler.ts`
- Engine functions are pure (no I/O) except through explicitly injected dependencies
- `loadAndResolveFlow` throws on spawn coverage errors or unresolved refs (hard-blocking)
- Gate runner is fail-closed: unresolvable gate names return `{ passed: false }`, never silently pass

## Conventions
<!-- last-updated: 2026-04-09 -->
- Tool file names match MCP tool names (snake_case → kebab-case)
- `drive-flow-types.ts` holds shared types that cross the tool/service/engine boundary within this feature
- New effects added to `effects.ts` require a corresponding case in the exhaustive switch; TypeScript enforces this
- Fragment typed params (`state_id` type) are validated at load time by `flow-parser.ts`
