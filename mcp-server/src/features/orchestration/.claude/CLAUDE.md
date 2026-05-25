# orchestration/ — Orchestration Tools

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
Orchestration tools and services — workspace lifecycle, transcript capture, artifact writing, and agent skill resolution. This bounded context owns every harness tool that the orchestrator calls to advance workflow state.

## Architecture
<!-- last-updated: 2026-05-15 -->

**`tools/`** — MCP tool handlers. All handlers are thin wrappers calling services.
<!-- last-updated: 2026-05-25 (open-artifact.ts added) -->

| Tool file | MCP tool name |
|-----------|--------------|
| `capture-transcript.ts` | `capture_transcript` |
| `get-transcript.ts` | `get_transcript` |
| `init-workspace.ts` | `init_workspace` |
| `invoke-janitor.ts` | `invoke_janitor` |
| `open-artifact.ts` | `open_artifact` — reads `${workspace}/artifacts/${artifact_name}`, registers with HTTP server, opens browser fire-and-forget; returns `{ url }`; `INVALID_INPUT` on path traversal or missing file; `UNEXPECTED` when HTTP server not running |
| `orchestration-journal.ts` | `log_step` / `batch_log_steps` |
| `post-event.ts` | `post_event` |
| `present-artifact.ts` | `present_artifact` — fire-and-forget; serves HTML, opens browser, returns `{ url }` immediately (does not block) |
| `report.ts` | `report` |
| `resolve-agent-skills.ts` | `resolve_agent_skills` — **async** since 2026-05-20; calls `applyAgentSkillsDisclosure` when `projectDir` provided; accepts `options?: { filePaths?, workspace? }` — when `filePaths` provided, appends "Known Pitfalls" section to `preload_prompt` and logs `pitfall_injected` audit event. Updated 2026-05-22. |
| `resolve-agent-skills-disclosure.ts` | (helper module, not a tool) — progressive disclosure for `resolve_agent_skills`; exports `summarizeAgentSkills(data)` and `applyAgentSkillsDisclosure(result, projectDir)`; when `preload_prompt` exceeds 12k chars, writes full JSON to `.canon/artifacts/` and returns slim result with file pointer |
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
<!-- last-updated: 2026-05-25 (openArtifact added) -->
Key tool functions (all return `ToolResult<T>` — see `@shared/lib/tool-result.ts`):

- `openArtifact(input: OpenArtifactInput)` → `Promise<ToolResult<{ url: string }>>` — reads `${workspace}/artifacts/${artifact_name}` (appends `.html` if no extension), validates no path traversal, registers with HTTP server, opens browser fire-and-forget; `INVALID_INPUT` on traversal or missing file; `UNEXPECTED` when HTTP server not running
- `initWorkspace(input)` — create or resume workspace; preflight checks when `preflight: true`; `tryResumeWorkspace` accepts optional `expectedTask` to block resume on task-identity mismatch (slug-collision defense)
- `captureTranscript(input: CaptureTranscriptInput)` → `Promise<ToolResult<CaptureTranscriptResult>>` — best-effort; reads CC agent JSONL from `{CLAUDE_CONFIG_DIR}/projects/{projectId}/{sessionId}/subagents/agent-{agentId}.jsonl`, transforms to Canon format, writes to `{workspace}/transcripts/{step_id}--{agent_type}--{iso}.jsonl`; returns `warning` (never an error) when source file not found
- `transformClaudeCodeTranscript(entries: ClaudeCodeEntry[])` → `TranscriptEntry[]` — pure function; maps CC JSONL content blocks to Canon transcript entries; malformed entries skipped silently; exported from `services/transcript-transformer.ts`
- `resolveAgentSkills(input, pluginDir, projectDir?)` → `Promise<ToolResult<ResolveAgentSkillsResult>>` — **async** since 2026-05-20; when `projectDir` provided, runs progressive disclosure via `applyAgentSkillsDisclosure`; `ResolveAgentSkillsResult.full_data_path?: string` is set when disclosure truncated the payload (path to full JSON in `.canon/artifacts/`); `input.options?: { filePaths?: string[]; workspace?: string }` — when `filePaths` provided, queries pitfall data from drift DB and appends formatted "Known Pitfalls" section to `preload_prompt`; audit event `pitfall_injected` logged via `appendEvent` when pitfalls found. Updated 2026-05-22.

## Invariants
<!-- last-updated: 2026-05-15 -->
- Must not import directly from other features — uses `@domains/*` types as shared contracts
- All tool handlers are wrapped with `wrapHandler` from `@shared/lib/wrap-handler.ts`

## Conventions
<!-- last-updated: 2026-05-15 -->
- Tool file names match MCP tool names (snake_case → kebab-case)
