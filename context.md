## Workspace Context: ADR-004 Flow Validation

### Goal
Harden Canon flow loading with strict schema validation, hard-blocking error throws, SQL-based stuck detection, and typed fragment params.

### Architecture Summary
- `StateDefinitionSchema` is a `z.discriminatedUnion("type", [...])` — five per-type schemas; per-type TS types exported
- `loadAndResolveFlow` now throws on hard errors (spawn coverage, unresolved refs); no `errors` field on return
- `LoadFlowResult.errors` removed; `load-flow.ts` catches thrown errors and returns `FLOW_PARSE_ERROR`/`FLOW_NOT_FOUND`
- SQL-based stuck detection: `ExecutionStore.recordIterationResult` + `ExecutionStore.isStuck` backed by new `iteration_results` table (schema v2, auto-migrated)
- `write_plan_index` MCP tool writes normalized `INDEX.md` for wave execution; round-trips through `parseTaskIdsForWave`
- Fragment params migrated from null-marker `~` to typed declarations (`type: state_id|string|number|boolean, default?`)
- `parseTaskIdsForWave` now accepts backtick-wrapped task IDs in addition to plain IDs

### Key Patterns
- All new Zod schema fields use `.optional()` for backward compat
- Reachability warnings (non-blocking) use `"Warning:"` prefix; hard errors do not
- DB schema migrations version-gated via `meta.schema_version`; all DDL uses `IF NOT EXISTS`

### Known Issues
- None
