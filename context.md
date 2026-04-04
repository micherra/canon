## Workspace Context: ADR-004 Flow Validation

### Goal
Harden Canon flow loading with strict schema validation, hard-blocking error throws, SQL-based stuck detection, and typed fragment params.

### Architecture Summary
- `StateDefinitionSchema` is a `z.discriminatedUnion("type", [...])` — five per-type schemas; per-type TS types exported
- `loadAndResolveFlow` now throws on hard errors (spawn coverage, unresolved refs); no `errors` field on return
- `LoadFlowResult.errors` removed; `load-flow.ts` catches thrown errors and returns `FLOW_PARSE_ERROR`/`FLOW_NOT_FOUND`
- SQL-based stuck detection: `ExecutionStore.recordIterationResult` + `ExecutionStore.isStuck` backed by new `iteration_results` table (schema v3, auto-migrated)
- `write_plan_index` MCP tool writes normalized `INDEX.md` for wave execution; round-trips through `parseTaskIdsForWave`
- Fragment params migrated from null-marker `~` to typed declarations (`type: state_id|string|number|boolean, default?`)
- `parseTaskIdsForWave` now accepts backtick-wrapped task IDs in addition to plain IDs

### Key Patterns
- All new Zod schema fields use `.optional()` for backward compat
- Reachability warnings (non-blocking) use `"Warning:"` prefix; hard errors do not
- DB schema migrations version-gated via `meta.schema_version`; all DDL uses `IF NOT EXISTS`; current version: `'5'` (v4 = `cache_prefix` on `execution` via ADR-006a; v5 = `transcript_path` on `execution_states` via ADR-015)
- Agent self-reporting metrics: `drive_flow` injects a `record_agent_metrics` footer into every prompt; agents call the tool before returning status; metrics merge into execution state, preserving orchestrator fields
- Agent transcript recording (ADR-015): each workspace has a `transcripts/` subdir; `report_result` accepts optional `transcript_path` (best-effort); `get_transcript` MCP tool reads stored JSONL transcripts in `full` or `summary` (assistant-only) mode; `TranscriptEntry` type lives in `flow-schema.ts`

### Known Issues
- None
