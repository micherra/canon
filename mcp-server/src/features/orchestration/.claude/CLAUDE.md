# orchestration/ — Orchestration Tools

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
Orchestration tools and services — workspace lifecycle, transcript capture, artifact writing, and agent skill resolution. This bounded context owns every harness tool that the orchestrator calls to advance workflow state.

## Architecture
<!-- last-updated: 2026-05-15 -->

**`tools/`** — MCP tool handlers. All handlers are thin wrappers calling services.

| Tool file | MCP tool name |
|-----------|--------------|
| `capture-transcript.ts` | `capture_transcript` |
| `get-messages.ts` | `get_messages` |
| `get-transcript.ts` | `get_transcript` |
| `init-workspace.ts` | `init_workspace` |
| `invoke-janitor.ts` | `invoke_janitor` |
| `orchestration-journal.ts` | `log_step` / `batch_log_steps` |
| `post-event.ts` | `post_event` |
| `post-message.ts` | `post_message` |
| `present-artifact.ts` | `present_artifact` |
| `report.ts` | `report` |
| `resolve-agent-skills.ts` | `resolve_agent_skills` |
| `seed-workspace.ts` | `seed_workspace` |
| `write-design-brief.ts` | `write_design_brief` |
| `write-implementation-summary.ts` | `write_implementation_summary` |
| `write-plan-index.ts` | `write_plan_index` |
| `write-review.ts` | `write_review` |
| `write-test-report.ts` | `write_test_report` |

**`services/`** — Business logic backing tools.
<!-- last-updated: 2026-05-15 -->

| File | Responsibility |
|------|---------------|
| `janitor.ts` | `runJanitor(projectDir)` — gate checks (enabled, time, lock), WAL checkpoint, prune detection; returns `JanitorResult` |
| `transcript-transformer.ts` | `transformClaudeCodeTranscript(entries)` — pure; converts CC JSONL entries to Canon `TranscriptEntry[]`; exports `ClaudeCodeEntry` type |
| `workspace-cleanup.ts` | Workspace cleanup utilities |

## Contracts
<!-- last-updated: 2026-05-15 -->
Key tool functions (all return `ToolResult<T>` — see `@shared/lib/tool-result.ts`):

- `initWorkspace(input)` — create or resume workspace; preflight checks when `preflight: true`
- `postMessage(input)` / `getMessages(input)` — unified workspace channel messaging
- `captureTranscript(input: CaptureTranscriptInput)` → `Promise<ToolResult<CaptureTranscriptResult>>` — best-effort; reads CC agent JSONL from `{CLAUDE_CONFIG_DIR}/projects/{projectId}/{sessionId}/subagents/agent-{agentId}.jsonl`, transforms to Canon format, writes to `{workspace}/transcripts/{step_id}--{agent_type}--{iso}.jsonl`; returns `warning` (never an error) when source file not found
- `transformClaudeCodeTranscript(entries: ClaudeCodeEntry[])` → `TranscriptEntry[]` — pure function; maps CC JSONL content blocks to Canon transcript entries; malformed entries skipped silently; exported from `services/transcript-transformer.ts`

## Invariants
<!-- last-updated: 2026-05-15 -->
- Must not import directly from other features — uses `@domains/*` types as shared contracts
- All tool handlers are wrapped with `wrapHandler` from `@shared/lib/wrap-handler.ts`

## Conventions
<!-- last-updated: 2026-05-15 -->
- Tool file names match MCP tool names (snake_case → kebab-case)
