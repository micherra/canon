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
| `resolve-agent-skills.ts` | `resolve_agent_skills` — **async** since 2026-05-20; calls `applyAgentSkillsDisclosure` when `projectDir` provided; accepts `options?: { filePaths?, workspace?, step_id? }` — when `filePaths` provided, appends "Known Pitfalls", "Area Memory", and "Hot-File Caution" sections; emits `context_provenance` event post-disclosure when `workspace` + `step_id` both present (fail-open when absent); logs `pitfall_injected` or `area_enrichment_injected` audit events when data found. Updated 2026-06-24. |
| `resolve-agent-skills-disclosure.ts` | (helper module, not a tool) — progressive disclosure for `resolve_agent_skills`; exports `summarizeAgentSkills(data)` and `applyAgentSkillsDisclosure(result, projectDir)`; when `preload_prompt` exceeds 12k chars, writes full JSON to `.canon/artifacts/` and returns slim result with file pointer |
| `resolve-agent-skills-provenance.ts` | (helper module, not a tool) — `emitContextProvenance(opts)` builds a `ContextProvenanceRecord` (hashes + spans only, no content) and writes a `context_provenance` event to the execution store; fail-open on absent workspace; called from `resolve-agent-skills.ts` post-disclosure. Added 2026-06-24. |
| `seed-workspace.ts` | `seed_workspace` |
| `write-implementation-summary.ts` | `write_implementation_summary` — accepts optional `decisions?: DecisionRecord[]`; renders decisions as markdown table, stores in meta JSON, logs `agent_decision` events; extracts area observations from `deviations`; fail-open. Updated 2026-05-29. |
| `write-plan-index.ts` | `write_plan_index` |
| `write-review.ts` | `write_review` — extracts area observations from BLOCKING/WARNING reviews into `area_observations` via injected `areaMemoryWriter`; fail-open; no observations for CLEAN. Updated 2026-05-29. |
| `write-test-report.ts` | `write_test_report` |

**`services/`** — Business logic backing tools.
<!-- last-updated: 2026-06-24 (finalize-helpers.ts + transcript-capture-hook.ts: extracted from orchestration-journal.ts; context-provenance-backfill.ts: agent_id back-fill for context_provenance events) -->

| File | Responsibility |
|------|---------------|
| `artifact-matching.ts` | Pure artifact-path resolution — `artifactExists`, `scanArtifactList`, `classifyArtifact`, `scanArtifacts` (+ `ArtifactScan` type), `computeSummaryGlobFallback`. Extracted from `orchestration-journal.ts` for line-count compliance + compute/effect separation. |
| `cliff-ledger.ts` | Per-session surface-once de-dupe ledger for cliff detection — `readLedger`, `appendLedger`, `filterUnsurfaced`, `cliffSignature`; stored at `${workspace}/.cliff-surfaced.json`; fail-open (ENOENT → empty set); atomic rename write; used by loop runner to suppress repeated cliff surfacing across ticks. <!-- last-updated: 2026-06-11 --> |
| `context-provenance-backfill.ts` | `backfillContextProvenanceAgentId(workspace, stepId, agentId)` — back-fills `agent_id` on the `context_provenance` event keyed by `step_id`; called from `log_step`/`batch_log_steps` when a step completes with an `agent_id`; fail-open. Added 2026-06-24. |
| `finalize-helpers.ts` | Pure compute helpers extracted from `orchestration-journal.ts` for 600-line compliance: `computeFlowOutcome`, `computeTotalDurationMs`, `getStepsMissingSkipReason`. `workspace-cleanup.ts` imports `computeFlowOutcome` directly from here (not via barrel). Added 2026-06-24. |
| `janitor.ts` | `runJanitor(projectDir)` — gate checks (enabled, time, lock), then `runJanitorTasks`: WAL checkpoint, prune worktrees, prune workspaces, prune empty husk dirs; reaps a workspace only when: `.lock` absent AND `journal.json` has a `ship` step `status:"completed"` (primary post-ship gate, fail-closed on absent/malformed journal) AND age exceeds `max_abandoned_workspace_age_hours`; exports `isShipComplete(steps)` pure helper; `DEFAULT_JANITOR_CONFIG.max_abandoned_workspace_age_hours` = 24h; calls `unlinkWorktreeNodeModulesSymlink` (Guard 1) before each `git worktree remove` (ADR-0016) <!-- last-updated: 2026-06-14 --> |
| `transcript-capture-hook.ts` | `tryTranscriptCapture(workspace, step)` — extracted from `orchestration-journal.ts` for 600-line compliance; thin wrapper calling `captureTranscript` for completed steps with an `agent_id`. Added 2026-06-24. |
| `transcript-transformer.ts` | `transformClaudeCodeTranscript(entries)` — pure; converts CC JSONL entries to Canon `TranscriptEntry[]`; exports `ClaudeCodeEntry` type |
| `review-confidence-adapter.ts` | Pure compute function; returns `ConfidenceAnnotation` for a violation from severity_tier, violation_history, path_effects, base_sample signals; zero-confidence for undefined file_path |
| `workspace-cleanup.ts` | Workspace cleanup + finalize-time diff stats: exports `DiffStatFields`, `DiffStatSeams`, `parseShortstat` (pure), `tryComputeDiffStats`; `archiveWorkspaceOnly(workspace, projectDir)` — archive-only (copy to archive dir, **no** `git worktree remove`, **no** `git branch -D`, **no** `rmSync`), returns `{ archived: boolean; teardown_deferred: true }`; `tryAppendAnalytics` spreads diff stats into `FlowRunEntry`; cleans up `.cliff-surfaced.json` ledger at finalize; imports `computeFlowOutcome` from `finalize-helpers.ts` (direct sibling import). (ADR-0016) <!-- last-updated: 2026-06-24 --> |
| `area-memory-enrichment.ts` | `queryAreaObservations`, `formatAreaMemorySection`, `buildAreaMemorySection`; fail-open; queries drift.db area_observations for recent build context to inject into agent prompts. Relocated from `features/diagnostics/services/` (ADR-0006). |
| `hot-file-detection.ts` | `detectHotFiles`, `formatHotFileSection`, `buildHotFileSection`; threshold ≥ 3 appearances in last 14 days; queries drift.db flow_runs to flag frequently-modified files. Relocated from `features/diagnostics/services/` (ADR-0006). |
| `pitfall-enrichment.ts` | `queryDriftSignalPitfalls`, `queryErrorFixPitfalls`, `formatPitfallsSection`, `countPitfalls`, `buildPitfallsSection`; fail-open; queries drift.db for historical violation patterns and error→fix pairs. Relocated from `features/diagnostics/services/` (ADR-0006). |

## Contracts
<!-- last-updated: 2026-06-24 (resolve-agent-skills: step_id? option + context_provenance emit; context-provenance-backfill: agent_id back-fill; finalize-helpers: computeFlowOutcome moved here) -->
Key tool functions (all return `ToolResult<T>` — see `@shared/lib/tool-result.ts`):

- **`artifact-matching.ts` SUMMARY fallback contract**: `artifactExists(workspace, artifact)` checks both `workspace/` and `workspace/worktree/` via `globSync`. For a literal `*-SUMMARY.md` entry that misses on exact match, `computeSummaryGlobFallback` retries with a directory-scoped `*-SUMMARY.md` glob — the only artifact type with a caller-unpredictable (slug/task_id-variable) filename. Fixed-stem artifacts (`DESIGN.md`, `REVIEW.md`, `TEST-REPORT.md`) are NOT subject to fallback — a genuine miss still fails. `ArtifactScan` type: `{ expected, missing, skipped_unresolved }`.
- `openArtifact(input: OpenArtifactInput)` → `Promise<ToolResult<{ url: string }>>` — reads `${workspace}/artifacts/${artifact_name}` (appends `.html` if no extension), validates no path traversal, registers with HTTP server, opens browser fire-and-forget; `INVALID_INPUT` on traversal or missing file; `UNEXPECTED` when HTTP server not running
- `initWorkspace(input)` — create or resume workspace; preflight checks when `preflight: true`; `tryResumeWorkspace` accepts optional `expectedTask` to block resume on task-identity mismatch (slug-collision defense)
- `linkWorktreeNodeModules(worktreePath, projectDir)` — **exported** best-effort helper; symlinks `<worktree>/mcp-server/node_modules` → `realpathSync(<projectDir>/mcp-server/node_modules)` after worktree creation so the LSP tool resolves TypeScript imports; Guard 2: target is `realpathSync` output (absolute, outside worktree — non-circular by construction); no-op when main node_modules absent or link site already exists; never throws (warns on failure, build proceeds)
- `captureTranscript(input: CaptureTranscriptInput)` → `Promise<ToolResult<CaptureTranscriptResult>>` — best-effort; reads CC agent JSONL from `{CLAUDE_CONFIG_DIR}/projects/{projectId}/{sessionId}/subagents/agent-{agentId}.jsonl`, transforms to Canon format, writes to `{workspace}/transcripts/{step_id}--{agent_type}--{iso}.jsonl`; returns `warning` (never an error) when source file not found
- `transformClaudeCodeTranscript(entries: ClaudeCodeEntry[])` → `TranscriptEntry[]` — pure function; maps CC JSONL content blocks to Canon transcript entries; malformed entries skipped silently; exported from `services/transcript-transformer.ts`
- `resolveAgentSkills(input, pluginDir, projectDir?)` → `Promise<ToolResult<ResolveAgentSkillsResult>>` — **async** since 2026-05-20; when `projectDir` provided, runs progressive disclosure via `applyAgentSkillsDisclosure`; `ResolveAgentSkillsResult.full_data_path?: string` when disclosure truncated the payload; `input.options?: { filePaths?: string[]; workspace?: string; step_id?: string }` — when `filePaths` provided, appends "Known Pitfalls", "Area Memory", and "Hot-File Caution" sections; when both `workspace` and `step_id` present, emits a `context_provenance` event post-disclosure (fail-open when either absent); section order: base → corrections → pitfalls → area memory → hot-file caution. Updated 2026-06-24.
- `backfillContextProvenanceAgentId(workspace, stepId, agentId)` — `services/context-provenance-backfill.ts`; back-fills `agent_id` on the `context_provenance` execution-store event keyed by `step_id`; called on `log_step`/`batch_log_steps` step completion; fail-open. Added 2026-06-24.

## Invariants
<!-- last-updated: 2026-06-14 -->
- Must not import directly from other features — uses `@domains/*` types as shared contracts
- All tool handlers are wrapped with `wrapHandler` from `@shared/lib/wrap-handler.ts`
- **Guard 1 (symlink teardown)**: `janitor.ts` MUST call `unlinkWorktreeNodeModulesSymlink` (using `lstatSync` — never `statSync`) before any `git worktree remove` call; `workspace-cleanup.ts` does NOT call `git worktree remove` (no-teardown by design, ADR-0016) — Guard 1 no longer applies to it.

## Conventions
<!-- last-updated: 2026-05-15 -->
- Tool file names match MCP tool names (snake_case → kebab-case)
