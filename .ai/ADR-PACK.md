# Canon Architecture Decision Records

Status: Proposed | 2026-03-29

---

## ADR-001: SQLite as Canonical Local Store

### Context

Workflow state is distributed across board.json, session.json, progress.md, message files, reviews.jsonl, log.jsonl, and flow-runs.jsonl. Each has its own read/write logic, locking strategy, rotation rules, and failure modes. Resume requires reconciling multiple files. The knowledge graph already uses SQLite (better-sqlite3).

### Decision

Adopt SQLite as the single canonical store for all runtime state. No file projections — the prompt pipeline reads SQLite and injects formatted context directly. Agent work-product files (DESIGN.md, SUMMARY.md, REVIEW.md, etc.) remain as files since they are the substance of the work, not orchestration metadata.

**Moves to SQLite:**

| Current | SQLite | Notes |
|---------|--------|-------|
| board.json + session.json | `executions`, `execution_states`, `iterations` | Transactional writes replace file locking |
| progress.md | `progress_entries` | Prompt pipeline formats on the fly via `${progress}` |
| messages/{channel}/*.md | `messages` | Prompt pipeline injects directly, agents never read files |
| reviews.jsonl | `reviews`, `violations` | Indexed queries replace full-scan + filter |
| flow-runs.jsonl | `flow_runs` | Cross-flow analytics become SQL |
| log.jsonl | `events` | Structured events with correlation IDs |

**Stays as files (agent work product):**
- `plans/{slug}/DESIGN.md`, `*-PLAN.md`, `*-SUMMARY.md`, `INDEX.md`
- `plans/{slug}/REVIEW.md`, `TEST-REPORT.md`
- `research/*.md`, `decisions/*.md`

**Eliminated entirely:**
- File locking (O_EXCL, stale lock detection, 2-hour expiry)
- Backup-before-write for board
- JSONL read/write/rotation logic
- Sequence counter files and lock directories for messages
- Board reconciliation on resume
- atomicWriteFile for orchestration state (still used for agent artifacts)

**Human inspection:** Users who want to see execution state use `canon-inspector` or a `diagnose` tool that queries SQLite and produces formatted output. No stale projection files.

### Consequences

Positive: single transactional store, atomic resume, proper indexing, schema versioning via migrations, cross-entity queries, massive code deletion.

Negative: SQLite becomes a hard dependency, agent artifacts and execution state live in different storage systems, debugging requires a query tool rather than `cat board.json`.

### Implementation

- Design schema: `executions`, `execution_states`, `iterations`, `progress_entries`, `messages`, `reviews`, `violations`, `events`, `flow_runs`
- Implement `execution-store.ts` with transaction-wrapped mutations
- Migrate `update_board`, `report_result`, `enter_and_prepare_state` to use store
- Rewrite prompt pipeline to read `${progress}` from SQL instead of file
- Rewrite message injection to read from SQL instead of files
- Migrate drift store from JSONL to SQLite tables
- Delete: file locking, JSONL rotation, board backup, sequence counters, message lock dirs

---

## ADR-002: Shell and Git as Privileged Adapters

### Context

Subprocess calls (git, test runners, gate commands) are scattered across orchestration code with inconsistent timeout, error handling, and retry behavior. This blocks clean diagnostic instrumentation — you can't emit consistent events from scattered call sites.

### Decision

Centralize all subprocess execution behind adapter modules with standardized timeout, error mapping, output capture, and retry behavior.

### Consequences

Positive: single risk boundary, consistent errors, clean test mocking, natural instrumentation point for ADR-003.

Negative: refactoring scattered calls, may surface inconsistent legacy behavior.

### Implementation

- Introduce `git-adapter.ts` (worktree, merge, diff, status) and `process-adapter.ts` (gate commands, test runners, arbitrary shell)
- Decompose gate-runner.ts: resolution (domain) vs execution (adapter)
- Route all orchestration subprocess calls through adapters
- Standardize: default timeouts, output truncation limits, error shapes, retry policy

---

## ADR-003: Diagnostics over Platform Observability

### Context

Canon needs strong local diagnostics — why a flow is stuck, what happened, how to recover. Tests are strong but runtime diagnostics are weaker than orchestration complexity warrants.

### Decision

Structured local diagnostics via correlation IDs, execution events, and diagnostic queries. Events stored in SQLite (ADR-001). Adapters (ADR-002) provide the instrumentation seam.

### Consequences

Positive: debuggability, user trust, recovery workflows.

Negative: event modeling discipline, diagnostic surface area.

### Implementation

- Add `correlation_id` (execution ID) to every event
- Standardize event shapes in `events` table
- Instrument adapter calls with timing and outcome events
- Stuck detection evaluation results become queryable events ("compared X to Y, not stuck because Z")
- Evolve `canon-inspector` to query SQLite events
- Add `diagnose` command: reads events + execution state, produces actionable report

---

## ADR-004: Flow Validation and Execution Model

### Context

The flow system has five sources of brittleness:

1. **Fragment params are string interpolation** — typos produce literal `${typo}` in output, silently
2. **Transitions are unchecked strings** — `done: implement` doesn't validate `implement` exists
3. **Spawn instructions match by markdown heading** — orphaned headings and missing prompts are silent
4. **Stuck detection depends on caller-provided history shapes** — missing fields fail silently
5. **Wave execution semantics are implicit** — type: wave triggers complex orchestrator behavior with no flow-level configuration

### Decision

Keep the YAML+MD format. Add strict load-time validation and move execution state management to SQLite.

**Load-time validation (strict):**
- Every transition target resolves to a real state ID or `hitl`
- Every non-terminal state has a matching spawn instruction heading
- Fragment params are typed (`state_id`, `string`, `number`, `boolean`); `state_id` params validated against resolved state map
- Variable references in spawn instructions checked against declared availability per state type
- Reachability analysis: warn on unreachable states
- Unresolved `${...}` references after substitution are errors, not silent pass-through

**Stuck detection moves to SQL:**

Instead of callers constructing shaped history entries, the execution store records raw state results. Stuck detection becomes a query comparing the last two iterations. Eliminates the "caller forgot a field" failure mode entirely.

**Wave policy becomes explicit:**

```yaml
implement:
  type: wave
  agent: canon-implementor
  wave_policy:
    isolation: worktree        # worktree | branch | none
    merge_strategy: sequential  # sequential | rebase | squash
    gate: test-suite
    on_conflict: hitl           # hitl | replan | retry-single
  consultations:
    before: [plan-review]
    between: [pattern-check]
    after: [impl-handoff]
```

**Discriminated state schemas (from original ADR-005):**
- Per-type Zod schemas: `SingleStateSchema`, `WaveStateSchema`, `ParallelStateSchema`, `ParallelPerStateSchema`, `TerminalStateSchema`
- `z.discriminatedUnion("type", [...])` for StateDefinitionSchema
- Fragment schema derived via helper that relaxes numeric fields for param placeholders
- YAML surface syntax unchanged — tightening happens at parse/validation time

### Consequences

Positive: flow authoring errors caught at load time, stuck detection can't silently fail, wave behavior is explicit and configurable, agent-authored flows validated strictly.

Negative: existing flows must pass stricter validation (migration), fragment param syntax changes (auto-migratable), wave_policy is new surface area.

### Implementation

- Add validation pass to `load_flow`: transitions, spawn instructions, params, reachability
- Implement typed fragment params with backward-compatible migration from `param: ~`
- Implement discriminated union state schemas
- Move stuck detection from caller-constructed history to SQL query in execution store
- Add `wave_policy` to WaveStateSchema with defaults matching current behavior
- Run all existing flows through strict validation as acceptance test

---

## ADR-005: Knowledge Graph Consolidation

### Context

Two parallel graph representations: file-level (graph-data.json, in-memory queries) and entity-level (knowledge-graph.db, SQLite). A view-materializer bridges them. This is the same dual-representation problem ADR-001 solves for workflow state.

### Decision

SQLite KG is the sole graph representation. Eliminate graph-data.json and the legacy in-memory query path. All consumers (codebase_graph, graph_query, get_file_context, UI) read from SQLite via KgQuery.

### Consequences

Positive: one query API, transactional updates, no consistency drift, entity-level precision everywhere.

Negative: migration for any consumers reading graph-data.json directly, view-materializer deletion.

### Implementation

- Migrate `query.ts` (in-memory graph) consumers to KgQuery
- Migrate UI components to read via MCP tools backed by KgQuery
- Delete view-materializer.ts, graph-data.json generation, reverse-deps.json
- Add any missing query methods to KgQuery (degree analysis, layer violations currently in insights.ts)
- graph-data.json consumers get a deprecation period with warnings before removal

---

## ADR-006: Agent Prompt Assembly Pipeline

### Context

`get-spawn-prompt.ts` is ~500 lines with 9 implicit composition layers. The ordering is hardcoded and the trust boundary (escapeDollarBrace) is a single function that must be called correctly at every agent-text injection site. This is the highest-surface-area security boundary in Canon.

### Decision

Explicit named pipeline stages with defined execution order. Agent-sourced text enters pre-escaped by the stage that reads it (structural guarantee, not caller discipline). Each stage is independently testable.

**Pipeline stages (ordered):**

1. **resolve-context** — read injected context from prior states (SQLite)
2. **resolve-progress** — format execution history from SQLite as `${progress}`
3. **resolve-messages** — read relevant messages from SQLite, format for injection
4. **substitute-variables** — flow-level and wave-level variable replacement
5. **inject-templates** — append template instructions
6. **inject-wave-briefing** — assemble briefing from prior wave data (SQLite)
7. **fanout** — expand single prompt into N prompts (parallel roles, wave items, compete lenses, diff clusters)
8. **inject-coordination** — append messaging and guidance instructions
9. **validate** — check for unresolved `${...}` references (error, not silent)

Stages 1-3 read from SQLite and escape all agent-sourced text at the read boundary. Stage 9 catches any variable that fell through.

### Consequences

Positive: adding a stage is additive, trust boundary is structural, per-stage unit testing, prompt construction is auditable.

Negative: pipeline abstraction adds indirection, must migrate ~500 lines of implicit logic.

### Implementation

- Define `PromptStage` interface: `(context: PromptContext) => PromptContext`
- Implement each stage as a pure function
- Wire stages in `get-spawn-prompt.ts` as a pipeline
- Move escape responsibility to read-boundary stages (1-3)
- Add stage 9 validation (unresolved references = error)
- Delete the monolithic composition logic

---

## ADR-008: Context Assembly Policy

### Context

Agents (researchers, implementors, etc.) spend significant tool calls grepping to orient themselves — finding file locations, discovering patterns, tracing dependencies, understanding conventions. This data already exists in Canon's knowledge graph (ADR-005), summaries system, and file context tools, but nothing bridges it into agent spawn prompts automatically. The prompt assembly pipeline (ADR-006) has explicit injection stages but no policy for what project context to inject.

### Decision

Define a context assembly policy that the prompt pipeline (ADR-006) executes at spawn time:

1. **File affinity resolution** — When a task plan references specific files, pipeline stage 1 (resolve-context) resolves `get_file_context` for each file and injects summaries, imports, exports, blast radius. The architect writes the affected-files list to a structured board variable.
2. **KG summary injection** — Pipeline stage 6 (inject-wave-briefing) queries SQLite KG (ADR-005) for file-level summaries of files in task scope. Compact format replaces verbose research prose.
3. **Project topology variable** — `${project_structure}` computed at workspace init from KG layer/degree data: layer breakdown, hub files (high in-degree), recent changes since base branch.
4. **Conventions pre-indexing** — Lightweight scan at workspace init captures test framework, import style, error handling patterns into a `${conventions}` variable. This is the scribe's CONVENTIONS.md content, but computed before implementation rather than after.
5. **Budget-aware injection** — Each pipeline stage has a configurable token budget cap. When context exceeds budget, prioritize by blast radius (highest impact files first). Prevents prompt overflow.
6. **graph_query as agent default** — Agent definition files (.md) explicitly instruct agents to prefer `graph_query` MCP tool over Grep for dependency/caller/callee questions. Zero system changes, convention update only.

### Consequences

Positive: agents arrive pre-oriented, fewer grep/glob/read calls, faster execution, reduced token usage, better context quality (structured vs. discovered).

Negative: stale context risk if KG/summaries are outdated (mitigated by ADR-007 background refresh), budget tuning required, affected-files extraction adds architect responsibility.

### Implementation

- Add `inject_context` source type `file_context` to pipeline stage 1
- Add KG summary query to stage 6 wave briefing assembly
- Implement `${project_structure}` variable computation at workspace init
- Implement `${conventions}` variable via lightweight pattern scan at workspace init
- Add per-stage token budget configuration to flow schema
- Update researcher and implementor agent .md files to prefer graph_query
- Acceptance: measure grep/glob call reduction in agent runs before/after

### Dependencies

ADR-001 (SQLite foundation), ADR-005 (KG as single graph source), ADR-006 (prompt assembly pipeline stages)

---

## ADR-007: Local Background Jobs for Heavy Analysis

### Context

Heavy operations (codebase graph generation, impact analysis) run inline with interactive orchestration and degrade responsiveness.

### Decision

Local background job model using child processes (not worker threads — shared memory complexity isn't justified). Persist job status and cached outputs in SQLite (ADR-001).

### Consequences

Positive: responsiveness, retry/caching, control-plane isolation.

Negative: local runtime complexity, job lifecycle rules, cache invalidation.

### Implementation

- Add job abstraction: submit, poll, result, cancel
- Split codebase_graph into submit/poll/materialize
- Cache by repo + config fingerprint in SQLite
- Job status visible via diagnostic tools (ADR-003)
- Synchronous fallback for CI environments
- Principle cache isolation: background jobs get their own cache instance

---

## Adoption Order

| Order | ADR | Rationale |
|-------|-----|-----------|
| 1 | 001 SQLite Store | Foundation — everything reads/writes through this |
| 2 | 002 Adapters | Low risk, prerequisite for diagnostics |
| 3 | 004 Flow Revamp | Parallel with 002, high impact on authoring quality |
| 4 | 003 Diagnostics | Builds on adapter seam (002) + SQLite events (001) |
| 5 | 005 KG Consolidation | Extends 001 to the graph layer |
| 6 | 006 Prompt Pipeline | Needs stable flow schema (004) and SQLite reads (001) |
| 7 | 008 Context Assembly | Needs pipeline stages (006) + KG (005) + SQLite (001) |
| 8 | 007 Background Jobs | Lowest priority, highest new-complexity cost; KG freshness (007) mitigates stale-context risk from 008 |

ADRs 002, 003, 004 can progress in parallel once 001 is in place. ADR 005 is independent of 002-004. ADR 006 depends on 001 + 004. ADR 008 depends on 006 + 005 + 001 and should land before or alongside ADR 007. ADR 007 is last.

## Decision Summary

- SQLite as the single canonical store — no file projections for orchestration state
- Agent work-product files remain (DESIGN.md, SUMMARY.md, etc.)
- Shell/git behind adapter boundaries
- Structured local diagnostics via SQLite events
- Strict flow validation at load time, SQL-backed stuck detection, explicit wave policy
- Single graph representation (SQLite KG)
- Explicit prompt assembly pipeline with structural escaping
- Context assembly policy: pre-orient agents via file affinity, KG summaries, topology variable, conventions pre-indexing, and budget-aware injection
- Background jobs via child processes for heavy analysis
