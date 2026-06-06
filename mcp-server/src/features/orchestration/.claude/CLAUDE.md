# orchestration/ — Orchestration Tools

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
Orchestration tools and services — workspace lifecycle, transcript capture, artifact writing, and agent skill resolution. This bounded context owns every harness tool that the orchestrator calls to advance workflow state.

## Architecture
<!-- last-updated: 2026-05-15 -->

**`tools/`** — MCP tool handlers. All handlers are thin wrappers calling services.
<!-- last-updated: 2026-05-29 (write-review, write-implementation-summary: area memory observation extraction + decisions field) -->

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
| `resolve-agent-skills.ts` | `resolve_agent_skills` — **async** since 2026-05-20; calls `applyAgentSkillsDisclosure` when `projectDir` provided; accepts `options?: { filePaths?, workspace? }` — when `filePaths` provided, appends "Known Pitfalls", "Area Memory", and "Hot-File Caution" sections; logs `pitfall_injected` or `area_enrichment_injected` audit events when data found. Updated 2026-05-29. |
| `resolve-agent-skills-disclosure.ts` | (helper module, not a tool) — progressive disclosure for `resolve_agent_skills`; exports `summarizeAgentSkills(data)` and `applyAgentSkillsDisclosure(result, projectDir)`; when `preload_prompt` exceeds 12k chars, writes full JSON to `.canon/artifacts/` and returns slim result with file pointer |
| `seed-workspace.ts` | `seed_workspace` |
| `write-implementation-summary.ts` | `write_implementation_summary` — accepts optional `decisions?: DecisionRecord[]`; renders decisions as markdown table, stores in meta JSON, logs `agent_decision` events; extracts area observations from `deviations`; fail-open. Updated 2026-05-29. |
| `write-plan-index.ts` | `write_plan_index` |
| `write-review.ts` | `write_review` — extracts area observations from BLOCKING/WARNING reviews into `area_observations` via injected `areaMemoryWriter`; fail-open; no observations for CLEAN. Updated 2026-05-29. |
| `write-test-report.ts` | `write_test_report` |

**`services/`** — Business logic backing tools.
<!-- last-updated: 2026-06-05 (janitor: prune_husk_dirs task added) -->

| File | Responsibility |
|------|---------------|
| `artifact-matching.ts` | Pure artifact-path resolution — `artifactExists`, `scanArtifactList`, `classifyArtifact`, `scanArtifacts` (+ `ArtifactScan` type), `computeSummaryGlobFallback`. Extracted from `orchestration-journal.ts` for line-count compliance + compute/effect separation. |
| `janitor.ts` | `runJanitor(projectDir)` — gate checks (enabled, time, lock), then `runJanitorTasks`: WAL checkpoint, prune worktrees, prune workspaces, prune empty husk dirs under `.canon/workspaces/`; returns `JanitorResult` <!-- last-updated: 2026-06-05 --> |
| `transcript-transformer.ts` | `transformClaudeCodeTranscript(entries)` — pure; converts CC JSONL entries to Canon `TranscriptEntry[]`; exports `ClaudeCodeEntry` type |
| `review-confidence-adapter.ts` | Pure compute function; returns `ConfidenceAnnotation` for a violation from severity_tier, violation_history, path_effects, base_sample signals; zero-confidence for undefined file_path |
| `workspace-cleanup.ts` | Workspace cleanup utilities |

## Contracts
<!-- last-updated: 2026-06-02 (artifact-matching module: SUMMARY auto-discovery fallback) -->
Key tool functions (all return `ToolResult<T>` — see `@shared/lib/tool-result.ts`):

- **`artifact-matching.ts` SUMMARY fallback contract**: `artifactExists(workspace, artifact)` checks both `workspace/` and `workspace/worktree/` via `globSync`. For a literal `*-SUMMARY.md` entry that misses on exact match, `computeSummaryGlobFallback` retries with a directory-scoped `*-SUMMARY.md` glob — the only artifact type with a caller-unpredictable (slug/task_id-variable) filename. Fixed-stem artifacts (`DESIGN.md`, `REVIEW.md`, `TEST-REPORT.md`) are NOT subject to fallback — a genuine miss still fails. `ArtifactScan` type: `{ expected, missing, skipped_unresolved }`.
- `openArtifact(input: OpenArtifactInput)` → `Promise<ToolResult<{ url: string }>>` — reads `${workspace}/artifacts/${artifact_name}` (appends `.html` if no extension), validates no path traversal, registers with HTTP server, opens browser fire-and-forget; `INVALID_INPUT` on traversal or missing file; `UNEXPECTED` when HTTP server not running
- `initWorkspace(input)` — create or resume workspace; preflight checks when `preflight: true`; `tryResumeWorkspace` accepts optional `expectedTask` to block resume on task-identity mismatch (slug-collision defense)
- `captureTranscript(input: CaptureTranscriptInput)` → `Promise<ToolResult<CaptureTranscriptResult>>` — best-effort; reads CC agent JSONL from `{CLAUDE_CONFIG_DIR}/projects/{projectId}/{sessionId}/subagents/agent-{agentId}.jsonl`, transforms to Canon format, writes to `{workspace}/transcripts/{step_id}--{agent_type}--{iso}.jsonl`; returns `warning` (never an error) when source file not found
- `transformClaudeCodeTranscript(entries: ClaudeCodeEntry[])` → `TranscriptEntry[]` — pure function; maps CC JSONL content blocks to Canon transcript entries; malformed entries skipped silently; exported from `services/transcript-transformer.ts`
- `resolveAgentSkills(input, pluginDir, projectDir?)` → `Promise<ToolResult<ResolveAgentSkillsResult>>` — **async** since 2026-05-20; when `projectDir` provided, runs progressive disclosure via `applyAgentSkillsDisclosure`; `ResolveAgentSkillsResult.full_data_path?: string` when disclosure truncated the payload; `input.options?: { filePaths?: string[]; workspace?: string }` — when `filePaths` provided, appends "Known Pitfalls" (drift signals + error_fixes), "Area Memory" (`area_observations`), and "Hot-File Caution" (files in 3+ recent builds) sections; audit events `pitfall_injected` and `area_enrichment_injected` logged when data found; section order: base → corrections → pitfalls → area memory → hot-file caution. Updated 2026-05-29.

## Invariants
<!-- last-updated: 2026-05-15 -->
- Must not import directly from other features — uses `@domains/*` types as shared contracts
- All tool handlers are wrapped with `wrapHandler` from `@shared/lib/wrap-handler.ts`

## Conventions
<!-- last-updated: 2026-05-15 -->
- Tool file names match MCP tool names (snake_case → kebab-case)
