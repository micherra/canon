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
<!-- last-updated: 2026-05-16 (inject-wave-event.ts and resolve-wave-event.ts deleted) -->

| Tool file | MCP tool name |
|-----------|--------------|
| `invoke-janitor.ts` | `invoke_janitor` |
| `init-workspace.ts` | `init_workspace` |
| `report.ts` | `report` |
| `post-message.ts` | `post_message` |
| `get-messages.ts` | `get_messages` |
| `resolve-after-consultations.ts` | `resolve_after_consultations` |
| `post-event.ts` | `post_event` |
| `write-plan-index.ts` | `write_plan_index` |
| `get-transcript.ts` | `get_transcript` |
| `capture-transcript.ts` | `capture_transcript` |
| `write-design-brief.ts` | `write_design_brief` |
| `write-implementation-summary.ts` | `write_implementation_summary` |
| `write-review.ts` | `write_review` |
| `write-test-report.ts` | `write_test_report` |

**`services/`** — Business logic backing tools and engine.
<!-- last-updated: 2026-05-16 (wave-briefing.ts deleted) -->

| File | Responsibility |
|------|---------------|
| `janitor.ts` | `runJanitor(projectDir)` — gate checks (enabled, time, lock), WAL checkpoint, prune detection; returns `JanitorResult` |
| `context-budget.ts` | Token budget tracking for agent context windows |
| `diff-cluster.ts` | Clusters changed files by prefix, layer, and change type |
| `inject-context.ts` | Injects context from after-consultation summaries into next state |
| `kg-context-formatter.ts` | Formats KG data for inclusion in agent prompts |
| `scope-resolver.ts` | Resolves task scope from board state and flow definition |
| `transcript-transformer.ts` | `transformClaudeCodeTranscript(entries)` — pure; converts CC JSONL entries to Canon `TranscriptEntry[]`; exports `ClaudeCodeEntry` type |

## Contracts
<!-- last-updated: 2026-04-26 -->
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
- `captureTranscript(input: CaptureTranscriptInput)` → `Promise<ToolResult<CaptureTranscriptResult>>` — best-effort; reads CC agent JSONL from `{CLAUDE_CONFIG_DIR}/projects/{projectId}/{sessionId}/subagents/agent-{agentId}.jsonl`, transforms to Canon format, writes to `{workspace}/transcripts/{step_id}--{agent_type}--{iso}.jsonl`; returns `warning` (never an error) when source file not found
- `transformClaudeCodeTranscript(entries: ClaudeCodeEntry[])` → `TranscriptEntry[]` — pure function; maps CC JSONL content blocks to Canon transcript entries; malformed entries skipped silently; exported from `services/transcript-transformer.ts`

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
