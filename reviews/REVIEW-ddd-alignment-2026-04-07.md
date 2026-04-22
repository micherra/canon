---
verdict: "WARNING"
agent: reviewer
timestamp: "2026-04-07T00:00:00Z"
files-reviewed: 134
principles-checked: 6
---

## Canon Review — Verdict: WARNING

### Principle Compliance

#### Violations

| Principle | Severity | File | Description | Fix |
|-----------|----------|------|-------------|-----|
| simplicity-first | strong-opinion | `mcp-server/src/features/orchestration/services/inject-context.ts` | `inject-context.ts` imports `IKgStore`/`IKgQuery` interfaces on lines 3-4 but still directly instantiates the concrete `KgQuery` and `KgStore` classes on lines 7-9 (via `@graph/` imports). The interfaces are typed locally (`const kgQuery: IKgQuery = new KgQuery(db)`) but the concrete class imports remain. This means the interface layer adds indirection without yet delivering testability or boundary enforcement — the file simultaneously imports both the interface and the concrete class. | Either (a) complete the DI migration so `inject-context.ts` receives `IKgStore`/`IKgQuery` via parameter injection and drops the concrete imports entirely, or (b) remove the interface type annotations until injection is wired. The current halfway state adds complexity without the payoff. This is a documented known gap (graph/README.md notes it); the fix should be tracked. |
| bounded-context-boundaries | strong-opinion | `mcp-server/src/features/orchestration/engine/effects.ts:11` | `effects.ts` imports `IDriftStore` from `@domains/drift/` (correct) but also imports the concrete `DriftStore` from `@platform/storage/drift/store.ts` on line 11 as the fallback. This is an acknowledged partial migration: the interface is used as the type, but the fallback `new DriftStore(projectDir)` still creates a concrete cross-context coupling from orchestration to platform storage. | Wire `DriftStore` at the composition root (e.g., `app/index.ts` or tool registration) and inject it as the `driftStore` option. Remove the direct `DriftStore` import from `effects.ts`. |

#### Honored

- **decompose-by-domain-not-layer**: The monolithic `flow-schema.ts` has been split into 3 domain-aligned schema files (`flow-definition-schemas.ts`, `board-state-schemas.ts`, `event-schemas.ts`). All 116+ importers have been migrated. The original file is deleted. The split follows clear semantic boundaries: flow definitions, runtime board state, and event contracts.
- **information-hiding**: Repository interfaces (`IDriftStore`, `IKgStore`, `IKgQuery`, `IExecutionStore`) expose only the capability contract needed by cross-context callers. SQLite internals, prepared statements, and row types remain hidden behind the concrete classes.
- **backward-compatible-schema-changes**: The `drive_flow` schema now defaults `result.status` to `"done"` when absent (`.optional().default("done")`). This is backward compatible — existing callers that provide status continue to work, and callers that omit it (HITL resume) no longer fail with a validation error.
- **prefer-constructor-injection**: The `effects.ts` change introduces an optional `driftStore?: IDriftStore` parameter on `ExecuteEffectsOpts`, enabling constructor-style injection with a fallback to the concrete class. While partial, the injection path is wired and tested.

#### Score

| Layer | Rules | Opinions | Conventions |
|-------|-------|----------|-------------|
| domain | 0/0 | 4/6 | 1/1 |

### Code Quality (Advisory)

#### Suggestions

- **inject-context.ts dual imports**: The file imports both the interface (`IKgStore`/`IKgQuery` from `@domains/knowledge-graph/`) and the concrete classes (`KgStore`/`KgQuery` from `@graph/`). This is a transitional pattern documented in `graph/README.md`, but it creates a code path where the interface annotations are cosmetic — the actual boundary enforcement depends on the `dependency-cruiser` exceptions list, not the type system. The concrete imports should be tracked for removal.
- **migrate-summaries.ts — non-null assertion**: `fileRow.file_id!` on lines ~62 and ~75 of `migrate-summaries.ts` uses non-null assertions after checking `fileRow?.file_id === undefined`. While the control flow guarantees safety, a stricter approach would use early-return or destructuring to eliminate the `!`.
- **tool_scope_audit removal in events.ts**: The `ddd-01c` summary notes removing a duplicate `tool_scope_audit` key from `EventPayloadSchemas`. The removal is visible in the diff (lines 2341-2354). However, `FlowEventType` union (line 2340 area) still includes `"tool_scope_audit"` if it was there before — the `satisfies Record<FlowEventType, z.ZodTypeAny>` check would catch a mismatch. The removal appears correct (it was blocking the build), but the reviewer notes this was out of scope for a migration task.
- **getOrientationRatio not in IExecutionStore**: The new `getOrientationRatio` method added to `ExecutionStore` is not included in `IExecutionStore`. This is acceptable if it is only used internally within the workspaces context, but if orchestration callers need it, it should be added to the interface.

#### Strengths

- Excellent test coverage: new `schema-split-completeness.test.ts` and `new-schema-files-parse.test.ts` provide regression guards for the split. Structural typing tests verify interface compatibility at compile time.
- The `ddd-alignment-integration.test.ts` is a well-structured cross-task integration test that validates all done criteria (schema deletion, interface placement, drift injection, READMEs, boundary enforcement).
- The `result.status` default-to-done fix is a practical defense against a real orchestrator failure mode (HITL resume without explicit status).
- Tool profile expansions in `tool-profiles.ts` are well-tested with per-agent assertions.

### Compliance Cross-Check

#### Discrepancies

None found. All implementor summaries that declared COMPLIANT are confirmed compliant by this review.

#### Unnecessary Deviations

None found.

#### Confirmed Fixes

- **ddd-01c**: Implementor declared removing the duplicate `tool_scope_audit` key as a build-blocking fix. Confirmed — the removal is correct and the `satisfies Record<FlowEventType, z.ZodTypeAny>` constraint in `events.ts` validates completeness.

#### Cross-Check Summary

All declarations aligned across 13 implementor summaries. The two boundary violations found in Stage 1 (`inject-context.ts` and `effects.ts` concrete imports) are documented known gaps in the ddd-03 and ddd-04 summaries — not missed violations.

### Drift from Plan

**Unplanned files changed:**

- `mcp-server/src/app/index.ts` — status schema default change (HITL defense); not in plan scope
- `mcp-server/src/features/orchestration/services/drive-flow-types.ts` — status default change; not in plan scope
- `mcp-server/src/features/orchestration/__tests__/drive-flow-e2e.test.ts` — HITL resume test; not in plan scope
- `mcp-server/src/features/knowledge-graph/services/migrate-summaries.ts` — new legacy summary migration service; not in plan scope
- `mcp-server/src/features/knowledge-graph/__tests__/migrate-summaries.test.ts` — tests for above; not in plan scope
- `mcp-server/src/features/orchestration/tools/init-workspace.ts` — wires migrate-summaries call; not in plan scope
- `mcp-server/src/features/prompt-pipeline/model/tool-profiles.ts` — MCP tool profile expansions; not in plan scope
- `mcp-server/src/features/prompt-pipeline/__tests__/tool-profiles.test.ts` — tests for tool profile changes; not in plan scope
- `mcp-server/src/features/prompt-pipeline/__tests__/integration.test.ts` — ADR-006a comment addition; not in plan scope
- `mcp-server/src/domains/workspaces/__tests__/execution-store.test.ts` — getOrientationRatio tests; not in plan scope
- `mcp-server/src/domains/workspaces/execution-store.ts` — getOrientationRatio method; not in plan scope
- `mcp-server/src/domains/flows/__tests__/new-schema-files-parse.test.ts` — additional parse tests beyond plan scope

**Missing planned work:**

- `docs/bounded-context-map.md` — listed as ddd-02 in plan but not in the scoped diff (may exist outside `mcp-server/src/`)

Note: The unplanned files fall into three categories: (1) HITL resume defense fixes (status default), (2) legacy migration utility (migrate-summaries), and (3) tool profile improvements. None are scope creep in the DDD sense — they are adjacent improvements made during the same branch. The bounded-context-map may exist outside the `mcp-server/src/` scope of this review.
