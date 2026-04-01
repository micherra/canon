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

Centralize all subprocess execution behind adapter modules with standardized timeout, error mapping, output capture, and retry behavior. Extend the same error contract to the MCP tool boundary — typed, discriminated error shapes replace ad-hoc throws and stringly-typed error arrays.

**Subprocess adapters:**

Standardized modules for git and shell execution with consistent timeout, error mapping, output capture, and retry behavior.

**Typed error contract at the MCP tool boundary:**

Tools currently surface errors in three inconsistent shapes: plain `throw new Error(...)` (converted to untyped MCP error responses), soft `errors: string[]` fields in success-shaped responses, and silent empty results for invalid input. The orchestrator infers recoverability from text patterns.

Define a `CanonToolError` discriminated union returned from all tool functions for expected error conditions:

```typescript
type ToolResult<T> = { ok: true; /* ...T fields */ } | CanonToolError;

interface CanonToolError {
  ok: false;
  error_code: CanonErrorCode;
  message: string;
  recoverable: boolean;
  context?: Record<string, unknown>;
}

type CanonErrorCode =
  | "WORKSPACE_NOT_FOUND"    // workspace doesn't exist or is corrupt
  | "FLOW_NOT_FOUND"         // flow YAML file doesn't exist
  | "FLOW_PARSE_ERROR"       // YAML parse or schema validation failure
  | "KG_NOT_INDEXED"         // knowledge-graph.db absent
  | "BOARD_LOCKED"           // workspace locked by another process
  | "CONVERGENCE_EXCEEDED"   // max iterations reached
  | "INVALID_INPUT"          // caller passed invalid parameters
  | "PREFLIGHT_FAILED";      // pre-flight checks blocked workspace creation
```

Only truly unexpected conditions (bugs, I/O failures) throw. The top-level MCP handler catches throws and wraps them as `{ ok: false, error_code: "UNEXPECTED", recoverable: false }`. Orchestrator protocol becomes a typed branch (`if !result.ok → check recoverable → HITL or abort`) instead of text-pattern matching. Recoverable errors like `KG_NOT_INDEXED` can trigger automatic recovery actions.

### Consequences

Positive: single risk boundary for subprocesses, consistent typed errors across all tool boundaries, clean test mocking, natural instrumentation point for ADR-003, orchestrator error handling becomes a code contract rather than text inference.

Negative: refactoring scattered calls, may surface inconsistent legacy behavior, every tool return type changes (migration cost).

### Implementation

- Introduce `git-adapter.ts` (worktree, merge, diff, status) and `process-adapter.ts` (gate commands, test runners, arbitrary shell)
- Decompose gate-runner.ts: resolution (domain) vs execution (adapter)
- Route all orchestration subprocess calls through adapters
- Standardize: default timeouts, output truncation limits, error shapes, retry policy
- Define `CanonToolError` type and `CanonErrorCode` enum in shared types
- Replace `errors: string[]` in `LoadFlowResult` with discriminated union
- Replace plain throws in `update_board`, `graph_query`, `init_workspace` with typed error returns
- Replace silent empty results in `get_file_context` with typed `INVALID_INPUT` error
- Add top-level MCP handler catch-all that wraps unexpected throws
- Update orchestrator agent instructions to use `result.ok` branching instead of text-pattern checks
- Migration: introduce for new tools first, sweep existing tools in a single pass

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

Keep the YAML+MD format. Add strict load-time validation, move execution state management to SQLite, and validate agent-produced artifacts that drive execution.

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

**Agent-produced artifact validation (INDEX.md):**

Wave execution depends on the architect producing INDEX.md with a specific markdown table format, parsed by regex in `wave-variables.ts`. If the architect writes backtick-wrapped IDs or different formatting, the wave runner silently gets zero task IDs and proceeds with empty wave plans — a silent, catastrophic failure.

Two-phase remediation:

1. **Immediate safety net** — Harden the `parseTaskIdsForWave` regex to handle backtick-wrapped IDs. Add a `validate_plan_index` check between architect state and first wave — if zero tasks parsed, block flow and surface the error instead of proceeding silently.

2. **Structured write path** — Create a `write_plan_index` MCP tool that accepts a typed structure and produces normalized markdown:

```typescript
interface PlanIndexInput {
  workspace: string;
  slug: string;
  tasks: Array<{
    task_id: string;       // validated: /^[a-zA-Z0-9_-]+$/
    wave: number;          // validated: >= 1
    depends_on?: string[];
    files?: string[];
    principles?: string[];
  }>;
}
```

The architect calls this tool instead of writing raw markdown. The regex always sees clean input because the tool controls the output format. The `plan-index.md` template becomes documentation only.

### Implementation

- Add validation pass to `load_flow`: transitions, spawn instructions, params, reachability
- Implement typed fragment params with backward-compatible migration from `param: ~`
- Implement discriminated union state schemas
- Move stuck detection from caller-constructed history to SQL query in execution store
- Add `wave_policy` to WaveStateSchema with defaults matching current behavior
- Harden `parseTaskIdsForWave` regex to handle backtick-wrapped IDs and extra whitespace
- Add `validate_plan_index` orchestrator check between architect and wave states (zero tasks = block, not proceed)
- Implement `write_plan_index` MCP tool with typed input and normalized markdown output
- Update architect spawn instructions to call `write_plan_index` instead of writing raw INDEX.md
- Run all existing flows through strict validation as acceptance test

---

## ADR-005: Knowledge Graph Consolidation

### Context

Two parallel graph representations: file-level (graph-data.json, in-memory queries) and entity-level (knowledge-graph.db, SQLite). A view-materializer bridges them. This is the same dual-representation problem ADR-001 solves for workflow state.

### Decision

SQLite KG is the sole graph representation. Eliminate graph-data.json, summaries.json, and the legacy in-memory query path. All consumers (codebase_graph, graph_query, get_file_context, store_summaries, UI) read from and write to SQLite via KgQuery.

**`summaries.json` has the same dual-representation problem.** Currently `store_summaries` writes JSON to disk first (primary), then attempts a best-effort DB write (secondary, silently skipped if the DB doesn't exist or the file isn't indexed). `get_file_context` reads DB-first, falls back to JSON. The write path is JSON-primary but the read path is DB-primary — they diverge permanently for projects without a full KG index. The `writeSummariesToDb` guard that skips files not in the KG's `files` table makes the JSON file permanently indispensable.

### Consequences

Positive: one query API, transactional updates, no consistency drift, entity-level precision everywhere, summaries always in sync with the graph.

Negative: migration for any consumers reading graph-data.json or summaries.json directly, view-materializer deletion, one-time migration needed for existing summaries.json files.

### Implementation

- Migrate `query.ts` (in-memory graph) consumers to KgQuery
- Migrate UI components to read via MCP tools backed by KgQuery
- Delete view-materializer.ts, graph-data.json generation, reverse-deps.json
- Add any missing query methods to KgQuery (degree analysis, layer violations currently in insights.ts)
- graph-data.json consumers get a deprecation period with warnings before removal
- **Summaries migration:**
  - Flip `store_summaries` write primary: SQLite first (in transaction), JSON as optional export
  - Remove the file-must-exist guard in `writeSummariesToDb` — upsert a stub file row (with `mtime_ms: 0`, `content_hash: "unknown"`) so summaries can be stored without a full KG index
  - Add one-time migration: on first `storeSummaries` call, read `summaries.json` and upsert missing entries into DB, rename to `summaries.json.migrated`
  - Remove `loadSummariesFile` fallback from `get-file-context.ts`
  - Delete: `loadSummariesFile`, `flattenSummaries` exports

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

Canon is a Claude Code plugin. Agents are Claude Code subagents with 200k-token context windows. The real cost of agent disorientation isn't tokens — it's **tool-call round-trips**. Each Grep/Glob/Read call burns a turn in the agent's conversation, and discovered context inflates the window, pushing toward compression and competing with the agent's working attention for the actual task.

Currently ~25–35% of each agent's instruction weight is **orientation protocol** — steps like "read your plan", "load principles", "check context.md" that exist because agents arrive cold. This data already exists in Canon's knowledge graph (ADR-005), summaries system, and file context tools, but nothing bridges it into spawn prompts automatically. The prompt assembly pipeline (ADR-006) has explicit injection stages but no policy for what project context to inject.

The current pipeline has essentially no budget model. The only hard limit is a 4,000-char cap on wave message injection. Everything else — injected artifacts, progress, wave briefings — concatenates unbounded with no tokenizer or size guard.

### Decision

Define a context assembly policy that the prompt pipeline (ADR-006) executes at spawn time. The goal is **tool-call reduction**, not token minimization — spend tokens upfront on pre-computed context to avoid sequential discovery tool calls.

**Context injection mechanisms:**

1. **File affinity resolution** — When a task plan references specific files, pipeline stage 1 (resolve-context) resolves `get_file_context` for each and injects summaries, imports, exports, blast radius. The architect writes the affected-files list to a structured board variable. Eliminates 3–5 Read/Glob/Grep calls per file.
2. **KG summary injection** — Pipeline stage 6 (inject-wave-briefing) queries SQLite KG (ADR-005) for file-level summaries of files in task scope. Compact format replaces verbose research prose. Eliminates the "read callers, read callees, understand blast radius" discovery cluster.
3. **Project topology variable** — `${project_structure}` computed at workspace init from KG layer/degree data: layer breakdown, hub files (high in-degree), recent changes since base branch. Low injection cost, eliminates "where does this kind of file live?" orientation.
4. **Conventions pre-indexing** — Lightweight scan at workspace init captures test framework, import style, error handling patterns into a `${conventions}` variable. This is the scribe's CONVENTIONS.md content, but computed before implementation rather than after. Eliminates the "read CLAUDE.md + grep for patterns" cluster.
5. **graph_query as agent default** — Agent definition files (.md) explicitly instruct agents to prefer `graph_query` MCP tool over Grep for dependency/caller/callee questions. Zero system changes, convention update only.

**Injection budgeting (item-count, not token-count):**

The 200k context window is not the constraint — **attention efficiency** is. Pre-injecting 2,000 tokens of structured context to avoid 8–10 tool calls is always worthwhile. Budget by item count rather than token count:

- File affinity: max N files (ordered by blast radius), where N is configurable per flow tier (e.g., 5 for hotfix, 15 for feature, 30 for epic)
- KG summaries: one line per file in scope, capped at the same N
- `${project_structure}`: fixed-size snapshot, always injected
- `${conventions}`: fixed-size snapshot, always injected

No tokenizer needed. Item-count caps naturally bound injection size as a side effect.

**Agent instruction compression (consequence, not prerequisite):**

Once context injection is reliable, agent `.md` files can be revised to remove orientation protocol (~25–35% of current instruction weight) and retain only behavioral constraints, process steps, and output format requirements. This is a follow-on task — do not compress instructions until the pipeline reliably delivers the context they compensate for.

### Consequences

Positive: agents arrive pre-oriented, tool calls per agent run drop significantly (target: 50%+ reduction in orientation Grep/Glob/Read), faster execution, better attention efficiency (structured context vs. discovered context competing in the window).

Negative: stale context risk if KG/summaries are outdated (mitigated by ADR-007 background refresh), affected-files extraction adds architect responsibility, agent instruction compression requires careful sequencing (only after reliable delivery).

### Implementation

- Add `inject_context` source type `file_context` to pipeline stage 1
- Add KG summary query to stage 6 wave briefing assembly
- Implement `${project_structure}` variable computation at workspace init
- Implement `${conventions}` variable via lightweight pattern scan at workspace init
- Add item-count caps per flow tier to flow schema (not token budgets)
- Update researcher and implementor agent `.md` files to prefer `graph_query`
- Acceptance metric: measure tool calls per agent run (Grep + Glob + Read) before/after, target 50%+ reduction in orientation calls
- Follow-on: compress agent `.md` orientation sections once injection is proven reliable

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

## ADR-009: Server-Side State Machine Execution

### Context

The orchestrator's inner loop — enter state, check can_enter, spawn agents, report result, read next_state, repeat — is fully mechanical. The LLM adds zero judgment to this loop, yet every state costs an LLM round-trip. Only three steps require LLM judgment: intent classification at start, HITL decision points, and fan-out fixer categorization (grouping test failures by root cause). Current flows have 6–14 states; a typical feature flow burns 8–12 LLM calls where 1–2 would suffice.

**Claude Code reference:** `src/coordinator/coordinatorMode.ts` (Coordinator Mode — pure dispatcher that spawns workers and collects results; workers report back via task-notifications; coordinator synthesizes between phases). The `drive_flow` tool generalizes this pattern: server-side mechanical loop, LLM only for judgment calls. Claude Code's `SpawnRequest`-equivalent is the `Agent` tool call with `subagent_type`, `prompt`, and `isolation` fields.

### Decision

Implement a `drive_flow` MCP tool that executes the state machine loop mechanically. The server enters states, resolves spawn prompts, and returns agent spawn instructions to the caller. The LLM orchestrator is invoked only for: (1) initial intent classification and flow selection, (2) HITL breakpoints requiring user decisions, (3) fan-out fixer categorization. This reduces orchestrator LLM calls from O(states) to O(hitl_points).

`drive_flow` operates on a turn-by-turn protocol:
- **Caller sends:** `{ workspace, flow, result? }` (result absent on first call)
- **Server returns:** one of three response shapes:
  - `{ action: "spawn", requests: SpawnRequest[] }` — caller spawns agents, sends results back
  - `{ action: "hitl", breakpoint: HitlBreakpoint }` — caller presents to user, sends decision back
  - `{ action: "done", terminal_state, summary }` — flow complete

```typescript
interface SpawnRequest {
  agent_type: string;   // e.g. "canon-implementor"
  prompt: string;       // fully-resolved spawn prompt
  isolation: string;    // worktree | branch | none
  role?: string;        // for parallel/wave states
  task_id?: string;     // for wave tasks
}

interface HitlBreakpoint {
  reason: string;       // why human judgment is needed
  context: string;      // formatted summary for user
  options?: string[];   // suggested responses
}
```

Wave execution (worktree creation, sequential merge, gate running) becomes server-side orchestration rather than LLM-interpreted prose. The wave loop runs entirely within the server on each `drive_flow` call — the caller sees only `SpawnRequest[]` for wave tasks, not the orchestration mechanics.

Fan-out fixer categorization is extracted into a dedicated `categorize_failures` tool that accepts a test report and returns grouped failure buckets. The orchestrator LLM calls this once and returns the result to `drive_flow` as part of the HITL response for that state.

### Consequences

Positive: massive cost reduction (most flows have 0–1 HITL points), faster execution (no LLM latency per state transition), deterministic loop behavior, orchestrator agent `.md` files shrink dramatically to: intent classification rules, HITL handling instructions, brief flow descriptions.

Negative: agent spawning still requires the caller (Claude Code) since the server cannot invoke tools on external processes, so the server returns spawn requests rather than executing them; HITL interaction model needs careful UX design; `categorize_failures` extraction adds a new tool; wave-level complexity (worktree conflicts, selective merge) moves into server code where it is harder to inspect.

### Dependencies

ADR-001 (SQLite state — server loop reads/writes execution state atomically), ADR-002 (typed errors — clean branching on recoverable vs. fatal conditions), ADR-004 (validated flows — safe mechanical execution requires transition targets to be verified at load time).

### Implementation

- Implement `drive_flow` tool: state entry, convergence check, spawn prompt resolution, result acceptance, transition evaluation, loop or break on HITL/terminal
- Define `SpawnRequest` and `HitlBreakpoint` return types in shared types
- Move wave execution protocol (worktree lifecycle, merge sequencing, gate running) from orchestrator prose to server-side handlers keyed on `wave_policy` (ADR-004)
- Implement `categorize_failures` tool: accepts `TestReportInput` (ADR-010), returns `FailureCategory[]` with root cause groupings
- Migrate orchestrator agent `.md` to: intent classification rules, HITL decision logic, `drive_flow` usage instructions, `categorize_failures` invocation for fix states
- Add `drive_flow` e2e test with simulated agent results for a 3-state flow

---

## ADR-010: Structured Agent Output Contracts

### Context

ADR-004 solves INDEX.md parsing fragility with `write_plan_index`. Every other agent-to-agent boundary has the same problem. The reviewer produces REVIEW.md parsed by 5 regex patterns in `effects.ts` (`parseReviewArtifact`). The tester produces a `### Issues Found` markdown table parsed by the orchestrator to spawn fixers. The implementor produces `### Coverage Notes` with expected subsections consumed by the tester. If any agent formats differently, downstream consumers silently get nothing. `resolveAndRead` in `effects.ts` returns null on missing artifacts and logs an error but does not block the flow — silent catastrophic failure.

### Decision

Generalize the `write_plan_index` pattern: structured write MCP tools for all agent output boundaries. Each tool accepts a typed structure and produces normalized markdown. Downstream consumers parse tool-produced output (guaranteed format) rather than free-form agent prose.

**Structured write tools:**

| Tool | Writer | Readers |
|------|--------|---------|
| `write_plan_index` (ADR-004) | Architect | Wave runner |
| `write_test_report` | Tester | Fixer (failure grouping), reviewer (coverage check) |
| `write_review` | Reviewer | Fixer (blocking violations), shipper (go/no-go) |
| `write_implementation_summary` | Implementor | Tester (coverage notes), reviewer (risk areas) |

```typescript
interface TestReportInput {
  workspace: string;
  slug: string;
  passed: number;
  failed: number;
  skipped: number;
  issues: Array<{
    test_name: string;
    file: string;
    error: string;
    category?: string;    // for fan-out fixer grouping
  }>;
  coverage_gaps: string[];
  risk_areas: string[];
}

interface ReviewInput {
  workspace: string;
  slug: string;
  verdict: "approved" | "approved_with_concerns" | "changes_required" | "blocked";
  violations: Array<{ principle_id: string; severity: string; file?: string; message: string }>;
  honored: string[];
  scores: { rules: number; opinions: number; conventions: number };
  blocking_issues: string[];
  concerns: string[];
}

interface ImplementationSummaryInput {
  workspace: string;
  slug: string;
  files_changed: string[];
  tests_written: string[];
  coverage_notes: string;
  risk_areas: string[];
  compliance: Array<{ principle_id: string; status: string; note: string }>;
}
```

**Server-side artifact validation in `report_result`:** When `report_result` is called, check that required artifacts for the state's agent type exist and are parseable. Missing or malformed required artifacts block the transition instead of silently proceeding. Declare required artifacts per state type in the flow schema via a `required_artifacts` field.

### Consequences

Positive: eliminates all regex parsing of agent output (5 patterns in `effects.ts`, issue table parsing in orchestrator, subsection parsing in tester), agent output format is a code contract not LLM compliance, mandatory artifact validation catches missing outputs before they cause silent downstream failures.

Negative: agents must use tools instead of free-form writing (reduced flexibility for edge cases), migration cost for all existing agent `.md` instructions, additional MCP tool surface area, agents lose the ability to add ad-hoc sections to reports.

### Dependencies

ADR-002 (typed error contract — validation failures return `INVALID_INPUT`, not throw), ADR-004 (`write_plan_index` establishes the pattern; `required_artifacts` field added to state schema).

### Implementation

- Implement `write_test_report` tool with `TestReportInput` schema; output: `TEST-REPORT.md` in normalized format
- Implement `write_review` tool with `ReviewInput` schema; output: `REVIEW.md` in normalized format
- Implement `write_implementation_summary` tool with `ImplementationSummaryInput` schema; output: `*-SUMMARY.md` in normalized format
- Add artifact validation to `report_result`: check required artifacts per state agent type, return `INVALID_INPUT` on missing/malformed
- Replace `parseReviewArtifact` regex parsing in `effects.ts` with structured read from `write_review` output
- Add `required_artifacts` field to `StateDefinitionSchema` (optional, backward compat)
- Update tester, reviewer, and implementor agent `.md` files to call structured write tools

---

## ADR-011: Flow Composition Model

### Context

Fragments exist but are string interpolation only. Flows compose bottom-up via `includes:` with `with:`, `as:`, and `overrides:`. There is no top-down extension model. Adding a new quality gate to all medium+ flows requires editing every flow file individually. The `test-fix-loop` and `verify-fix-loop` fragments are structurally identical (try state → fix state → context-sync state → retry) but share no common skeleton because fragments cannot include other fragments. Transition wiring across fragment boundaries uses string params that create implicit coupling — a fragment author must know what state names the consuming flow will provide.

### Decision

Three additions to the composition model:

**1. Flow extension:** A flow declares `extends: <flow-name>` to inherit all states and spawn instructions from a parent flow. The child flow's states merge with the parent's (child wins on conflict). Spawn instructions merge similarly. This enables a `standard-medium` base flow that `feature`, `refactor`, and `migrate` extend, adding only their variant states.

**2. Composite fragments:** Fragments can include other fragments via the same `includes:` mechanism flows use. A `try-fix-retry` meta-fragment containing the common skeleton of test/fix/retry can be shared between `test-fix-loop` and `verify-fix-loop`, with the differing state (context-sync-fix vs. verify-fix) supplied as a param.

**3. Typed fragment ports:** Fragments declare explicit exit points via a `ports:` block instead of relying on string params for transition targets. The consuming flow or fragment wires ports to state IDs at inclusion time.

```yaml
# Fragment declaration
fragment: try-fix-retry
ports:
  exit_success:
    required: true
    description: State to enter when all retries pass
  exit_blocked:
    required: false
    description: State to enter when max iterations exhausted (default: hitl)
states:
  attempt: ...
  fix: ...
  retry: ...
    transitions:
      done: ${port.exit_success}
      blocked: ${port.exit_blocked}

# Fragment inclusion with port wiring
includes:
  - fragment: try-fix-retry
    as: test-loop
    with:
      max_iterations: 3
    ports:
      exit_success: ship
      exit_blocked: hitl
```

Unwired required ports are a load-time error (ADR-004 validation). `${port.exit_blocked}` without a wiring falls back to `hitl` when the port declares no default.

### Consequences

Positive: single-point-of-change for pipeline patterns (add a gate to `standard-medium`, all child flows inherit it), fragment duplication eliminated, fragment boundaries become explicit contracts (port wiring is checked at load time), flow variants are trivially expressible.

Negative: inheritance resolution adds complexity to flow-parser (cycle detection, conflict resolution order must be specified), port syntax is new surface area for flow authors, existing fragments need migration to port syntax.

### Dependencies

ADR-004 (load-time validation catches unwired required ports and circular inheritance chains; `StateDefinitionSchema` changes apply to inherited states too).

### Implementation

- Add `extends` field to flow schema (optional string); implement inheritance resolution in flow-parser with depth-first merge, child wins on conflict
- Add cycle detection: circular inheritance chains are a load-time error
- Add `includes` support to fragment schema; implement recursive fragment resolution with cycle detection
- Add `ports` block to fragment schema with `required` and optional `default` per port
- Add port wiring syntax to `includes`: `ports: { port_name: state_id }`
- Validate: unwired required ports = load-time error; unwired optional ports use declared default or `hitl`
- Create `standard-medium` base flow from common states of `feature`, `refactor`, `migrate`
- Migrate `test-fix-loop` and `verify-fix-loop` to share a `try-fix-retry` meta-fragment
- Migrate `feature`, `refactor`, `migrate` to `extends: standard-medium`

---

## ADR-012: Conditional State Inclusion

### Context

Flows are static YAML. The `skip_when` mechanism has exactly 5 hardcoded enum values (`no_changes`, `already_done`, `tier_below`, `no_violations`, `no_failures`). Agents cannot signal that a flow needs modification mid-execution — wave events are user-injected only. There is no way to express "skip research if task touches fewer than N files" or "insert security-scan if the change touches `auth/`". If a quick-fix flow discovers mid-execution that it needs a design phase, the only escape is HITL, which requires the user to be present.

### Decision

Two mechanisms:

**1. Extensible `skip_when` with predicate expressions:** Replace the closed enum with an expression evaluator. `skip_when` accepts either the legacy enum values (backward compat) or a predicate expression over board metadata. Predicates are evaluated at state-entry time by the server (not the LLM).

Supported predicates:
- `files_changed < N` — total files modified in diff
- `layers_touched includes "<layer>"` — any changed file belongs to the named layer
- `gate_passed("<gate-name>")` — named gate returned passed in a prior state
- `has_artifact("<artifact-name>")` — named file exists in workspace plans dir
- `metadata.<key> == <value>` — arbitrary board metadata comparison

Multiple predicates can be combined: `files_changed < 5 AND NOT layers_touched includes "auth"`.

**2. Agent-requested flow events via `flow-events` channel:** Extend the wave event mechanism so agents (not just users) can request flow modifications by posting to a `flow-events` channel via `post_message`. The server (ADR-009 driver) evaluates these between states.

```typescript
// Agent posts to flow-events channel:
{ type: "request_state", target: "research", reason: "Found 3 unknown subsystems" }
{ type: "skip_ahead", target: "ship", reason: "No violations found, no fixers needed" }
{ type: "escalate", context: "...", suggested_options: ["add security scan", "proceed"] }
```

`request_state` is subject to a `allowed_insertions` whitelist declared in the flow — agents cannot inject arbitrary states. `skip_ahead` requires a reason and is only evaluated if the target state is reachable from the current state. `escalate` triggers a HITL breakpoint with structured context.

### Consequences

Positive: flows adapt to runtime conditions without requiring user presence, `skip_when` becomes a proper expression language rather than a closed enum, agents can signal complexity escalation through a controlled mechanism, flows become more precise (fewer unnecessary states run).

Negative: expression evaluator adds parsing and security surface (predicates must not be injectable), agent-requested events need careful whitelist enforcement (`request_state` with an un-whitelisted target is a silent no-op, not an error, to avoid agent confusion), testing conditional flows requires simulation (ADR-013).

### Dependencies

ADR-004 (flow schema validation for `allowed_insertions` whitelist and `skip_when` expression syntax), ADR-009 (server-side driver evaluates conditions mechanically between states; agent events are read from `flow-events` channel at each state boundary).

### Implementation

- Implement predicate expression parser for `skip_when`; support legacy enum values as named predicates for backward compat
- Define predicate functions: `files_changed`, `layers_touched`, `gate_passed`, `has_artifact`, `metadata`
- Add `allowed_insertions: string[]` field to flow schema (optional); validate targets exist in flow state map
- Add `flow-events` channel processing in `drive_flow` state loop (ADR-009): read channel between states, evaluate agent events
- Implement `request_state`, `skip_ahead`, `escalate` event processing; enforce whitelist for `request_state`
- Add load-time validation: `skip_when` expressions that reference undefined metadata keys produce warnings
- Update relevant agent `.md` files with guidance on when to use flow events vs. calling `hitl` directly

---

## ADR-013: Flow Simulation and Reachability Analysis

### Context

`validateFlow` checks structural validity (entry exists, transition targets exist, `parallel-per` has `iterate_on`) but cannot simulate execution. Dead-end paths — where certain failure conditions lead to states with no path to a terminal — are discovered only at runtime. `buildStateGraph` exists in `flow-parser.ts` but is unused in validation; it builds adjacency lists from transitions but does not analyze reachability through all possible status conditions. The stuck detection query (ADR-004) tells you a flow is stuck after the fact, not that a flow design will inevitably get stuck under specific conditions.

### Decision

Two capabilities:

**1. Reachability analysis at load time:** For every state, verify that every possible transition condition eventually leads to a terminal state or `hitl` (an acceptable deliberate escape hatch). The analysis follows all transition edges using BFS from every non-terminal state and reports:
- Dead-end states: states reachable from entry with no path to terminal or `hitl`
- Unreachable states: states with no path from the entry state
- Stuck loops: cycles where no edge exits to a terminal or `hitl`

Integrated into `validateFlow` as warnings (not errors, because `hitl` is a valid escape from any state and some flows intentionally use it as a terminal equivalent). Reachability warnings surface during `load_flow` and are included in the `load_flow` response's `warnings` array.

**2. Flow simulation (`simulate_flow` tool):** Walks the state machine with mocked agent results. The caller provides a scenario: a sequence of `(state_id, status_keyword)` pairs. The simulator walks transitions and reports the full execution path.

```typescript
interface SimulateFlowInput {
  flow: string;                    // flow name
  scenario: Array<{
    state_id: string;
    status: string;                // e.g. "done", "blocked", "cannot_fix"
  }>;
  max_steps?: number;              // default 50, prevents infinite loop in simulation
}

interface SimulateFlowOutput {
  ok: boolean;
  path: Array<{
    state_id: string;
    status_input: string;
    next_state: string;
    transition_matched: string;
  }>;
  terminal_state?: string;         // final state reached
  stuck_at?: string;               // state where stuck detection triggered
  dead_end_at?: string;            // state with no matching transition
  iterations_consumed: Record<string, number>;
  warnings: string[];
}
```

No agents are spawned, no workspace is created. The simulator operates purely on the resolved flow definition.

### Consequences

Positive: catches dead-end flow designs before runtime execution, flow authors can verify complex iteration/transition logic in seconds, reachability warnings surface during CI validation of flow YAML files, simulation enables automated flow regression testing when flow logic changes.

Negative: reachability analysis is conservative (warns on paths that are practically unreachable if `skip_when` would prevent them — ADR-012 predicates are not evaluated by the analyzer), simulation does not capture wave-level complexity (only state-level transitions), adding simulation as a CI step requires all flow files to be valid under the stricter load-time validation.

### Dependencies

ADR-004 (builds on `validateFlow` infrastructure; `buildStateGraph` becomes the analysis backbone; `GateResult` and transition schemas provide the edge types for analysis).

### Implementation

- Implement reachability analysis: BFS/DFS from every state through all transition edges to terminal states; use `buildStateGraph` as the starting point
- Report: dead-end states (reachable but no terminal path), unreachable states (no path from entry), stuck loops (cycles with no terminal exit)
- Integrate analysis into `validateFlow`; add results to `warnings` array in `LoadFlowResult`
- Implement `simulate_flow` tool: accepts flow name + scenario, walks transitions deterministically
- Simulator evaluates `stuck_when` conditions using the iteration tracking from ADR-001 execution store schema (simulated in-memory)
- Returns: `SimulateFlowOutput` with full execution trace
- Add `canon flow validate` CLI command that runs `load_flow` (with reachability) on all YAML files in the flows directory and exits non-zero on warnings

---

## ADR-014: Agent Isolation and Tool Scoping

### Context

Canon specialist agents (researcher, implementor, tester, reviewer, fixer) all inherit the same tool set and run with the same permission context. A researcher agent can call `Edit` and modify source code. A reviewer can call `Write` and create files. There is no enforcement boundary — agent role restrictions exist only in prose instructions, which the LLM can misinterpret or ignore under context pressure.

Claude Code solves this with `resolveAgentTools()`, which filters the available tool set based on agent type, async status, and explicit `disallowedTools` lists. The model never sees tools it shouldn't use. Each agent also gets a cloned context with independent file caches, abort controllers, and a no-op state mutator to prevent race conditions.

**Claude Code reference:** `src/tools/AgentTool/agentToolUtils.ts` (resolveAgentTools, filterToolsForAgent), `src/tools/AgentTool/loadAgentsDir.ts` (AgentDefinition with tools/disallowedTools fields), `src/utils/forkedAgent.ts` (createSubagentContext — cloned state with no-op setAppState).

### Decision

Define tool scoping profiles per agent role. The `drive_flow` tool (ADR-009) populates tool scope in each `SpawnRequest`. The caller filters its tool pool before spawning the subagent.

**Proposed profiles:**

| Agent | Allowed | Disallowed | Rationale |
|-------|---------|------------|-----------|
| researcher | Read, Grep, Glob, Bash(read-only), graph_query, get_file_context | Edit, Write, NotebookEdit | Research is read-only |
| architect | Read, Grep, Glob, graph_query, write_plan_index | Edit, Write, Bash | Architects produce plans via tools, not direct file writes |
| implementor | All code tools + write_implementation_summary | — | Full access needed |
| tester | All code tools + write_test_report | — | Writes tests + runs them |
| reviewer | Read, Grep, Glob, Bash, review_code, write_review | Edit, Write | Reviewers observe, don't modify |
| fixer | All code tools | — | Needs full access to fix issues |
| scribe | Read, Grep, Glob, Edit(CLAUDE.md/context.md/CONVENTIONS.md only) | Bash, Write | Scribe updates docs only |
| learner | Read, Grep, Glob, Bash(read-only) | Edit, Write | Learner reads patterns, proposes changes to a staging area |

**SpawnRequest extension:**

```typescript
interface SpawnRequest {
  agent_type: string;
  prompt: string;
  isolation: string;
  role?: string;
  task_id?: string;
  tools?: string[];           // allowlist (if specified, only these)
  disallowed_tools?: string[]; // denylist (filtered from default set)
}
```

Per-state overrides are supported — a flow can grant additional tools to a specific state if the default profile is too restrictive:

```yaml
security-research:
  type: single
  agent: canon-researcher
  tool_overrides:
    allow: [Bash]             # researcher needs Bash for this state
```

### Consequences

Positive: role enforcement becomes structural (not prose), eliminates accidental cross-boundary actions, reduces tool descriptions in agent context (fewer tools = less prompt noise), natural audit trail (agent tried to use disallowed tool = clear violation signal).

Negative: overly restrictive profiles can force agents into workarounds, profile maintenance as new tools are added, edge cases where an agent legitimately needs a tool outside its profile (mitigated by per-state `tool_overrides`).

### Dependencies

ADR-009 (SpawnRequest carries tool scope), ADR-006 (pipeline filters tool descriptions in spawn prompt).

### Implementation

- Define `AgentToolProfile` type mapping agent types to allowed/disallowed tool lists
- Add `tools` and `disallowed_tools` fields to `SpawnRequest` interface
- Add `tool_overrides` field to `StateDefinitionSchema` (optional, per-state)
- Implement profile resolution in `drive_flow`: merge default profile + state overrides
- Update orchestrator agent `.md` to document tool scope in spawn instructions
- Add validation: if caller spawns an agent without filtering tools, log a warning

---

## ADR-014a: Permission Bypass for Orchestrated Agents

### Context (Expansion of ADR-014)

Canon agents spawned by the orchestrator via `drive_flow` (ADR-009) trigger permission prompts for every Bash, Edit, and Write call. When agents run in worktrees (the common case for implementors and fixers), each prompt interrupts the orchestrator flow and requires the user to approve. A typical feature flow with 3 wave tasks generates 30-50 permission prompts — destroying the "Canon should be invisible" principle.

The permission system exists to protect users from unexpected actions. But Canon agents are not unexpected — the orchestrator spawned them with specific instructions, their tool set is scoped (ADR-014), and their changes are isolated in worktrees that can be discarded.

Claude Code addresses this with three mechanisms:
- **`shouldAvoidPermissionPrompts: true`** on the cloned context for background agents — they cannot trigger dialogs; tools that require permission are auto-denied or escalated to the leader
- **Permission bridging** — workers route permission requests to the coordinator's UI via a mailbox; the leader approves once and the decision propagates
- **Blanket allow rules** — `alwaysAllowRules` by source; once allowed at the project level, no agent ever prompts for it

**Claude Code reference:** `src/utils/forkedAgent.ts` (createSubagentContext sets `shouldAvoidPermissionPrompts: true` for async agents), `src/hooks/useCanUseTool.tsx` (hasPermissionsToUseTool checks shouldAvoidPermissionPrompts before showing dialog), `src/utils/permissions/permissions.ts` (blanket allow rules by source with tool name + content pattern matching).

### Decision

Canon agents spawned by `drive_flow` in isolated worktrees get automatic permission approval for their allowed tool set (ADR-014 profile). No permission prompts. Tools outside the profile are silently denied. The worktree is the safety boundary.

**Three-layer safety model:**

| Layer | Mechanism | What it prevents |
|-------|-----------|-----------------|
| 1. Tool scoping (ADR-014) | Agent never sees tools outside its role | Researcher calling Edit, reviewer calling Write |
| 2. Worktree isolation | Changes contained in disposable branch | Implementor corrupting main branch |
| 3. Permission bypass | Allowed tools auto-approved within worktree | Permission prompt wall blocking orchestrator flow |

**Permission bypass conditions (ALL must be true):**
- Agent was spawned by `drive_flow` (not manually by user)
- Agent is operating in an isolated worktree
- The tool is within the agent's ADR-014 profile
- The tool's target is within the worktree directory (no writes outside the worktree)

**What still requires explicit approval:**
- Destructive operations outside the worktree (force push, branch deletion)
- Network operations (API calls, package installs) unless in the agent's profile
- Any tool not in the agent's ADR-014 profile
- Agents not in worktrees (rare — only reviewers and researchers, who are read-only anyway)

**Implementation via `SpawnRequest`:**

```typescript
interface SpawnRequest {
  agent_type: string;
  prompt: string;
  isolation: string;
  tools?: string[];
  disallowed_tools?: string[];
  permission_mode: "auto" | "prompt" | "deny_unknown";
  worktree_path?: string;     // if isolation: "worktree"
}
```

`permission_mode` values:
- **`auto`** — auto-approve tools in the agent's profile when operating in a worktree (default for `drive_flow`-spawned agents)
- **`prompt`** — standard behavior, prompt for each tool call (default for manually spawned agents)
- **`deny_unknown`** — auto-approve profile tools, silently deny everything else (strictest mode, useful for background/unattended flows)

**Caller (Claude Code) implementation:** When the orchestrator receives a `SpawnRequest` with `permission_mode: "auto"` and `worktree_path`, it spawns the subagent with:
- `shouldAvoidPermissionPrompts: true` (no dialogs)
- `alwaysAllowRules` populated from the agent's tool profile
- Working directory set to the worktree path
- Filesystem writes restricted to the worktree directory

**Worktree path enforcement:** Tools that write files (Edit, Write, Bash with redirects) check that the target path is within `worktree_path`. Writes outside the worktree are denied regardless of profile. This prevents an implementor agent from editing files in the main working tree or other worktrees.

### Consequences

Positive: eliminates 30-50 permission prompts per feature flow, Canon flows run uninterrupted, user oversight shifts from per-action approval to per-plan approval (ADR-017) + per-merge review, worktree containment provides equivalent safety to per-action approval for code changes.

Negative: reduced visibility into what agents are doing in real-time (mitigated by transcripts ADR-015 and progress reporting), if tool scoping profiles are wrong the agent has unchecked access within the worktree (mitigated by worktree disposability), users must trust the ADR-014 profiles are correct.

**Risk analysis:** The worst case for a permission-bypassed agent in a worktree is: it makes bad code changes in the worktree. The merge step (orchestrator-controlled, not agent-controlled) is where the user reviews. Bad changes in a worktree are equivalent to a bad PR — reviewable and discardable. This is fundamentally safer than approving 50 individual actions without reviewing the cumulative result.

### Dependencies

ADR-014 (tool profiles define what's auto-approved), ADR-009 (SpawnRequest carries permission_mode), ADR-017 (plan approval shifts user oversight from per-action to per-plan).

### Implementation

- Add `permission_mode` field to `SpawnRequest` interface
- Add `worktree_path` field to `SpawnRequest` (populated by `drive_flow` when isolation is worktree)
- Implement worktree path enforcement: file-writing tools check target is within worktree_path
- Implement auto-approval logic: when `permission_mode: "auto"`, populate `alwaysAllowRules` from ADR-014 profile + set `shouldAvoidPermissionPrompts: true`
- Add `deny_unknown` mode: auto-approve profile, silently deny all else (log denied attempts to transcript)
- Default: `drive_flow`-spawned agents in worktrees get `permission_mode: "auto"`; all others get `"prompt"`
- Update orchestrator agent `.md` to document permission model
- Log all auto-approved and auto-denied decisions to transcript (ADR-015) for audit

---

## ADR-015: Agent Transcript Recording

### Context

Canon records orchestrator-level events in `log.jsonl` (and soon SQLite per ADR-001), but the full reasoning trace of specialist agents is lost. When an implementor makes a surprising design choice or a reviewer misses a violation, there's no way to understand why. `progress.md` captures outcomes ("implementor completed task-01") but not the multi-turn conversation that led there.

Claude Code records every agent's full conversation to a separate JSONL file via `recordSidechainTranscript()`. This enables `--resume` per agent, post-mortem debugging, and learning data for Auto-Dream (which reads transcripts to find patterns).

**Claude Code reference:** `src/tools/AgentTool/runAgent.ts` (recordSidechainTranscript in the message yield loop), `src/tasks/LocalAgentTask/LocalAgentTask.tsx` (LocalAgentTaskState with messages and progress tracking), `src/Task.ts` (TaskStateBase with outputFile symlink at `/tmp/claude-code-output-{taskId}`).

### Decision

Record each specialist agent's full conversation to a structured transcript file in the workspace. Store the transcript path in the execution state (SQLite per ADR-001). The `canon-learner` (ADR-016) reads transcripts to analyze agent patterns.

**Transcript storage:**

```
workspace/transcripts/{state_id}--{agent_type}--{timestamp}.jsonl
```

**Entry format:**

```typescript
interface TranscriptEntry {
  role: "system" | "user" | "assistant" | "tool_use" | "tool_result";
  timestamp: string;           // ISO 8601
  content: string;             // message content or tool call summary
  tool_name?: string;          // for tool_use/tool_result entries
  tokens?: number;             // token count for this entry
  cumulative_tokens?: number;  // running total
  turn_number: number;
}
```

**Recording responsibility:** The caller (Claude Code) records transcripts as agent messages stream back — identical to Claude Code's `runAgent()` which yields messages and records to sidechain. The transcript path is passed to `report_result` and stored in `execution_states.transcript_path`.

**Access patterns:**
- `canon-learner` reads transcripts to analyze agent decision patterns
- `diagnose` command (ADR-003) includes transcript excerpts for failed states
- A new `get_transcript` MCP tool returns formatted transcript for a given state execution
- Workspace cleanup (`/canon:clean`) removes transcripts alongside other workspace artifacts

**Size management:** Transcripts can be large (10-50K tokens per agent run). For agents in fix loops (multiple iterations), each iteration gets its own transcript file. The `get_transcript` tool supports `--summary` mode that returns only assistant messages (no tool calls), reducing output to ~20% of full transcript.

### Consequences

Positive: full debugging capability for agent decisions, learner has rich training data, enables per-agent resume, enables agent performance analysis (turns per task, tool call patterns, retry frequency).

Negative: storage cost (mitigated by workspace cleanup), transcripts may contain sensitive code (same risk as existing workspace artifacts), adds write overhead during agent execution.

### Dependencies

ADR-001 (transcript_path stored in execution_states table), ADR-003 (diagnostics surface transcript excerpts).

### Implementation

- Define `TranscriptEntry` type in shared types
- Add `transcript_path` column to `execution_states` schema (ADR-001)
- Implement transcript recording in the agent spawn caller (write JSONL as messages stream)
- Pass transcript path to `report_result`; store in SQLite
- Implement `get_transcript` MCP tool with full and summary modes
- Update `diagnose` command to include transcript excerpts for failed/stuck states
- Update workspace cleanup to remove `transcripts/` directory

---

## ADR-016: Auto-Triggered Learning

### Context

`canon-learner` is manually invoked via `/canon:learn`. It analyzes codebase patterns and drift data to suggest principle and convention improvements. But learning only happens when the user remembers to ask — which is rarely, since the value of learning is long-term and invisible.

Claude Code's Auto-Dream pattern demonstrates automatic between-session consolidation with carefully designed gating:
- **Time gate:** minimum hours since last consolidation (default 24h)
- **Session gate:** minimum sessions since last consolidation (default 5)
- **Lock file:** prevents concurrent consolidation (mtime = lastConsolidatedAt, body = PID)
- **Restricted permissions:** forked agent with read-only bash, write only to memory directory
- **4-phase prompt:** Orient → Gather → Consolidate → Prune
- **Rollback on failure:** lock mtime rewound if consolidation fails, so next session retries

**Claude Code reference:** `src/services/autoDream/autoDream.ts` (gate evaluation, forked agent spawn), `src/services/autoDream/consolidationLock.ts` (lock acquire/rollback/stale reclaim with PID + mtime), `src/services/autoDream/consolidationPrompt.ts` (4-phase prompt builder), `src/tasks/DreamTask/DreamTask.ts` (UI task registration, progress tracking).

### Decision

Auto-trigger `canon-learner` after flow completion when gating conditions are met. The learner runs as a background job (ADR-007) with restricted permissions (ADR-014). Output goes to a staging area for user review — the learner never modifies principles directly.

**Gating logic (cheapest checks first):**

```typescript
interface LearnGateConfig {
  enabled: boolean;                // default: true
  min_flows_since_last: number;    // default: 5
  min_hours_since_last: number;    // default: 48
  lock_stale_after_hours: number;  // default: 1
}
```

Gate evaluation order:
1. **Feature check:** auto-learn enabled in `.canon/config`
2. **Time gate:** hours since last learn > `min_hours_since_last`
3. **Scan throttle:** if time gate passes but flow gate doesn't, wait 10 minutes before re-checking (prevents repeated scans)
4. **Flow gate:** completed flows since last learn > `min_flows_since_last` (query `flow_runs` table from ADR-001)
5. **Lock gate:** acquire `.canon/learn.lock` (PID + mtime pattern from Auto-Dream)

**Learner input:**
- Recent flow transcripts (ADR-015)
- Flow execution events (ADR-001 events table)
- Drift reports from recent reviews
- Current principles and conventions

**Learner output:**
- Proposed updates written to `.canon/proposed-learnings/{timestamp}/`
- Each proposal is a structured markdown file with: the observation, the proposed change, evidence (transcript excerpts), and confidence level
- Proposals surfaced to user via a notification: "Canon learned 3 patterns from recent flows. Run `/canon:review-learnings` to review."

**Trigger point:** After `report_result` on a terminal state, the server checks the gate. If passed, it includes a `{ learn_gate_passed: true }` signal in the `drive_flow` response. The orchestrator spawns the learner as a background agent.

**Lock mechanism (from Auto-Dream):**
- File: `.canon/learn.lock`
- Body: PID of current learner process
- mtime: timestamp of last successful learning run
- Stale after: 1 hour (dead process reclaim)
- On failure: rollback mtime to pre-acquire value so next flow retries

### Consequences

Positive: principles and conventions improve automatically over time, learning happens consistently, gating prevents noise and thrashing, proposals require human approval (no autonomous principle changes), lock prevents concurrent learners.

Negative: background job overhead, learner quality depends on transcript quality (ADR-015), proposed learnings may accumulate without review if users ignore them (mitigated by periodic reminder notifications).

### Dependencies

ADR-001 (flow_runs table for gate counting, events table for execution data), ADR-007 (background job infrastructure), ADR-014 (learner restricted to read-only tool profile), ADR-015 (transcripts as primary learning input).

### Implementation

- Define `LearnGateConfig` in `.canon/config` schema
- Implement gate evaluation functions: time_gate, flow_gate, lock_gate, scan_throttle
- Implement lock file management (acquire, rollback, stale reclaim) — port Auto-Dream pattern
- Add `learn_gate_passed` field to `drive_flow` terminal response
- Create `.canon/proposed-learnings/` directory structure
- Implement learner output format: observation + proposed change + evidence + confidence
- Add `/canon:review-learnings` command to review and accept/reject proposals
- Add notification mechanism for pending proposals
- Update `canon-learner` agent to accept transcript paths as input and produce structured proposals

---

## ADR-017: Plan Approval Gates

### Context

Canon's architect agent produces a design document (DESIGN.md, INDEX.md) and the orchestrator immediately proceeds to implementation. There is no structured approval step — the user must actively interrupt or the flow runs to completion with the architect's plan.

Claude Code's UltraPlan introduces explicit plan approval via `ExitPlanMode`:
- Architect calls a tool when the plan is ready
- Execution pauses — user sees the plan in a modal
- User can approve, reject with feedback for revision, or redirect execution
- Only after approval does implementation begin

This is distinct from HITL (an error/escalation path). Plan approval is a positive confirmation gate: "I've designed the approach, do you agree?"

**Claude Code reference:** `src/commands/ultraplan.tsx` (polling orchestration, execution target routing), `src/utils/ultraplan/ccrSession.ts` (ExitPlanModeScanner with 3s polling, extractApprovedPlan/extractTeleportPlan), `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx` (task lifecycle with ultraplanPhase tracking).

### Decision

Add an optional `approval_gate` field to flow state definitions. When a state has `approval_gate: true`, the `drive_flow` server (ADR-009) pauses after the agent completes and returns an approval breakpoint instead of automatically transitioning.

```yaml
design:
  type: single
  agent: canon-architect
  approval_gate: true
  transitions:
    done: implement
    blocked: hitl
```

**Approval response shape:**

```typescript
interface ApprovalBreakpoint {
  action: "approve";
  state_id: string;
  agent_type: string;
  artifacts: string[];         // paths to review (DESIGN.md, INDEX.md)
  summary: string;             // formatted summary of what was produced
  options: ["approve", "revise", "reject"];
}
```

**User responses:**
- **approve:** flow transitions normally (done → implement)
- **revise:** agent re-enters the same state with user feedback appended to its context; iteration counter increments; the revised prompt includes the prior plan + user's feedback
- **reject:** flow transitions to HITL or a configured `rejection_target` state

**Difference from HITL:** HITL is triggered by failure/escalation conditions. Approval gates are triggered by successful completion — they're quality checkpoints, not error paths. HITL says "I'm stuck, help." Approval says "here's the plan, confirm it."

**Tier-based defaults:** Flow tiers can set default approval behavior:
- `hotfix` flows: `approval_gate: false` (speed matters)
- `feature` flows: `approval_gate: true` on design state
- `epic` flows: `approval_gate: true` on design + each wave boundary

**Revision budget:** `max_revisions` (default: 3) limits revision cycles. After max revisions, the state transitions to HITL with the full revision history as context.

### Consequences

Positive: users confirm approach before expensive implementation, catches misunderstandings early, natural review point for complex tasks, explicit in the flow definition (not orchestrator prose), revision cycle preserves context.

Negative: adds latency (user must be present to approve), could frustrate users on simple tasks (mitigated by tier-based defaults), revision loop could spin if user feedback is unclear (mitigated by max_revisions).

### Dependencies

ADR-009 (drive_flow returns approval breakpoints), ADR-004 (approval_gate field added to StateDefinitionSchema).

### Implementation

- Add `approval_gate` boolean field to `StateDefinitionSchema` (default: false)
- Add `max_revisions` integer field (default: 3)
- Add `rejection_target` optional string field (default: "hitl")
- Implement `ApprovalBreakpoint` response type in `drive_flow`
- Implement revision loop: re-enter state with prior plan + user feedback, increment iteration
- Add tier-based default `approval_gate` values to flow templates
- Update orchestrator agent `.md` with approval handling instructions
- Add approval state to existing `feature` and `epic` flow definitions

---

## ADR-018: Workspace Communication Structure

### Context

Canon workspaces contain agent work products (DESIGN.md, REVIEW.md, etc.) but the directory structure is implicit — there's no documented contract for where agents write output or how they find prior agents' output. Cross-agent communication happens through the prompt pipeline injecting summaries, but agents also need to discover and read each other's detailed artifacts.

Claude Code's Coordinator Mode uses a **scratchpad directory** — a durable, permission-free shared directory where workers organize files for cross-phase state. The coordinator reads worker findings, synthesizes specs, and writes them back to scratchpad for the next phase. This "never delegate synthesis" pattern ensures clean handoffs.

**Claude Code reference:** `src/coordinator/coordinatorMode.ts` (getCoordinatorUserContext with scratchpadDir injection, system prompt with "never delegate synthesis" rule), `src/tools/AgentTool/prompt.ts` (worker examples, continue-vs-spawn decision heuristics), `src/utils/swarm/spawnUtils.ts` (worker environment setup).

### Decision

Formalize the workspace directory structure as a contract. Define named subdirectories for each phase. The prompt pipeline (ADR-006) and `drive_flow` (ADR-009) use these paths. Introduce a `handoffs/` directory for structured cross-agent communication.

**Canonical workspace structure:**

```
workspace/
├── plans/                        # architect output
│   └── {slug}/
│       ├── DESIGN.md             # architectural design
│       ├── INDEX.md              # task breakdown with wave assignments
│       └── {task_id}-PLAN.md     # per-task implementation plan
├── research/                     # researcher output
│   └── {dimension}.md            # one file per research dimension
├── artifacts/                    # implementation output
│   └── {task_id}-SUMMARY.md      # per-task implementation summary
├── reports/                      # test and review output
│   ├── TEST-REPORT.md            # structured test report (ADR-010)
│   └── REVIEW.md                 # structured review (ADR-010)
├── transcripts/                  # agent conversation logs (ADR-015)
│   └── {state_id}--{agent_type}--{ts}.jsonl
├── handoffs/                     # structured cross-agent communication
│   ├── research-synthesis.md     # researcher findings → architect
│   ├── design-brief.md           # architect specs → implementor
│   ├── impl-handoff.md           # implementor notes → tester
│   └── test-findings.md          # tester failures → fixer
└── decisions/                    # decision records
    └── {decision}.md
```

**Handoff files:** Each handoff file is produced by a structured write tool (ADR-010) and consumed by the next agent via prompt injection (ADR-006). The handoff contract is:

| Handoff | Writer | Tool | Consumer | Content |
|---------|--------|------|----------|---------|
| research-synthesis.md | Researcher | (new) write_research_synthesis | Architect | Key findings, affected subsystems, risk areas, open questions |
| design-brief.md | Architect | write_plan_index + (new) write_design_brief | Implementor | Per-task specs, file targets, constraints, test expectations |
| impl-handoff.md | Implementor | write_implementation_summary | Tester | Files changed, coverage notes, risk areas, compliance status |
| test-findings.md | Tester | write_test_report | Fixer | Failure details, reproduction steps, affected files, categories |

**Prompt injection:** Pipeline stage 1 (resolve-context, ADR-006) reads the relevant handoff file for the current state's agent type and injects it into the spawn prompt. No agent needs to `Read` files to discover prior work — it's pre-injected.

**Handoff validation:** `report_result` (ADR-009) checks that the expected handoff file exists after an agent completes. Missing handoffs produce a warning (not a blocking error) — the next agent can still run but will lack pre-injected context.

### Consequences

Positive: agents know exactly where to find prior work, prompt pipeline can inject handoffs automatically, workspace becomes self-documenting, cleanup is straightforward, eliminates "read the plan file" orientation steps in agent instructions.

Negative: rigid structure may not fit all flow types (mitigated by making handoffs optional, not mandatory), handoff files add write overhead, agents that produce unexpected output have no designated location (mitigated by keeping artifacts/ as a catch-all).

### Dependencies

ADR-006 (pipeline injects handoff content at resolve-context stage), ADR-009 (drive_flow knows workspace structure and validates handoffs), ADR-010 (structured write tools produce handoff files).

### Implementation

- Document canonical workspace structure in `.canon/` reference
- Add handoff path resolution to prompt pipeline stage 1 (ADR-006)
- Implement `write_research_synthesis` MCP tool with typed input
- Implement `write_design_brief` MCP tool with typed input
- Add handoff existence check to `report_result` (warning on missing)
- Update agent `.md` files to reference handoff files instead of artifact paths
- Update workspace cleanup to preserve handoffs until flow completion
- Migrate existing flows to use handoff paths in spawn instructions

---

## ADR-006a: Prompt Cache Prefix Sharing

### Context (Expansion of ADR-006)

Claude Code's `CacheSafeParams` pattern freezes the parent's exact system prompt bytes so all child agents share the same API prompt cache entry. The prefix (system prompt + tools) is byte-identical across all fork children, maximizing cache hits. Canon spawns 5-12 agents per flow, each currently building its own prompt from scratch — missing significant cache savings.

**Claude Code reference:** `src/utils/forkedAgent.ts` (CacheSafeParams type, createSubagentContext with renderedSystemPrompt passthrough), `src/services/api/claude.ts:buildSystemPromptBlocks()` (SYSTEM_PROMPT_DYNAMIC_BOUNDARY splitting global-cacheable vs. session-specific, cache_control scope: 'global' for prefix).

### Decision (Addition to ADR-006)

Split assembled prompts into **shared prefix** and **agent-specific suffix**. The shared prefix is computed once per workspace and frozen for all agent spawns in that flow execution.

**Shared prefix contents (stable across agents):**
- Project context (conventions, principles, topology)
- Progress history
- Workspace metadata

**Agent-specific suffix contents:**
- Role instructions (agent `.md` content)
- Task details and handoff content (ADR-018)
- State-specific context (prior state results, wave briefing)

**Implementation addition:**
- Compute shared prefix at `init_workspace` time; cache as `workspace.prompt_prefix`
- `drive_flow` returns cached prefix bytes alongside each `SpawnRequest`
- Caller passes frozen prefix to agent spawn, ensuring byte-identical API requests for the prefix portion
- Cache invalidated on: workspace metadata change, principle update mid-flow, progress entry addition (append-only, so prefix up to last checkpoint is stable)
- Target: all agents in a flow execution share the same prompt cache entry for the prefix portion

---

## ADR-009a: Continue-vs-Spawn Decision for Fix Loops

### Context (Expansion of ADR-009)

Claude Code's Coordinator Mode reuses workers when context overlaps (same files, error correction) but spawns fresh for unrelated work. Canon always spawns fresh agents per state, losing valuable context in fix loops (tester finds bugs → fixer attempts fix → tester re-runs → fixer tries again). Each fresh fixer spawn must re-discover the codebase context the previous fixer already had.

**Claude Code reference:** `src/coordinator/coordinatorMode.ts` (continue-vs-spawn decision heuristics in system prompt), `src/tools/AgentTool/AgentTool.tsx` (SendMessage to continue existing agent vs. fresh Agent spawn), `src/tasks/LocalAgentTask/LocalAgentTask.tsx` (pendingMessages queue for continued agents).

### Decision (Addition to ADR-009)

`drive_flow` tracks agent session identifiers per state. For fix-loop iterations, `SpawnRequest` includes a `continue_from` field instead of a fresh prompt.

```typescript
interface SpawnRequest {
  // ... existing fields
  continue_from?: {
    agent_id: string;           // previous agent's session ID
    context_summary: string;    // what happened since last run
  };
}
```

**Decision heuristic:**
- **Continue** if: same agent type AND same files in scope AND previous iteration was a fix/retry attempt AND previous agent hasn't been evicted from memory
- **Spawn fresh** if: different agent type OR different files OR first iteration OR context is stale/evicted

**Caller behavior:**
- If `continue_from` is present: use `SendMessage` (or equivalent) to continue the existing agent with the `context_summary` as the new user message
- If absent: spawn a new agent with the full prompt (current behavior)

**Context summary format:** `drive_flow` assembles the summary from the latest state result — test failures, review violations, or user feedback that triggered the retry. The fixer gets "here's what failed since your last attempt" rather than rebuilding the full context.

**Eviction:** Continued agents are evicted after a configurable idle timeout (default: 10 minutes). If evicted, `drive_flow` falls back to fresh spawn with full context.

---

## ADR-003a: Agent Performance Metrics

### Context (Expansion of ADR-003)

Claude Code tracks per-agent `{toolUseCount, tokenCount, lastActivity}` for every background agent. Combined with transcripts (ADR-015), this enables understanding agent efficiency and identifying optimization opportunities.

**Claude Code reference:** `src/tasks/LocalAgentTask/LocalAgentTask.tsx` (AgentProgress type with toolUseCount, tokenCount, lastActivity), `src/tools/AgentTool/runAgent.ts` (updateAsyncAgentProgress on each message yield), `src/services/api/claude.ts` (per-request token tracking in modelUsage).

### Decision (Addition to ADR-003)

Store per-state-execution performance metrics alongside diagnostic events.

**Metrics stored in `execution_states` (ADR-001):**

```typescript
interface AgentMetrics {
  tool_calls: number;              // total tool invocations
  orientation_calls: number;       // Grep + Glob + Read before first Edit/Write
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  turns: number;                   // API round-trips
  cache_read_tokens?: number;      // prompt cache hits
  cache_write_tokens?: number;     // prompt cache misses
}
```

**Key derived metric:** `orientation_ratio = orientation_calls / tool_calls` — the fraction of agent effort spent discovering context vs. doing work. This is the primary metric for measuring ADR-008 (Context Assembly) effectiveness. Target: reduce orientation_ratio from current ~40-60% to <20% after context injection.

**Diagnostic surface:**
- `diagnose` command includes agent efficiency report: average metrics per agent type, orientation ratio trends, fix-loop iteration counts
- Per-flow summary: total tokens, total tool calls, total duration, broken down by state
- Anomaly detection: flag states where orientation_ratio > 50% or duration > 2x median for that agent type

### Implementation (Addition to ADR-003)

- Add `AgentMetrics` columns to `execution_states` schema
- Record metrics from agent spawn result in `report_result`
- Add efficiency report section to `diagnose` command
- Define baseline metrics before ADR-008 lands; measure after for comparison
- Add anomaly detection thresholds (configurable per agent type)

---

## Adoption Order

| Order | ADR | Rationale |
|-------|-----|-----------|
| 1 | 001 SQLite Store | Foundation — everything reads/writes through this |
| 2 | 002 Adapters | Low risk, prerequisite for diagnostics |
| 3 | 004 Flow Revamp | Parallel with 002, high impact on authoring quality |
| 4 | 003+003a Diagnostics | Builds on adapter seam (002) + SQLite events (001); 003a metrics land with schema |
| 5 | 005 KG Consolidation | Extends 001 to the graph layer |
| 6 | 015 Transcripts | Low effort, needs only 001 (transcript_path column); unblocks 016 |
| 7 | 006+006a Prompt Pipeline | Needs stable flow schema (004) and SQLite reads (001); 006a cache prefix lands here |
| 8 | 014+014a Tool Scoping + Permission Bypass | Parallel with 006; 014a lands with 009 (needs SpawnRequest + worktree_path) |
| 9 | 008 Context Assembly | Needs pipeline stages (006) + KG (005) + SQLite (001) |
| 10 | 018 Workspace Structure | Parallel with 008; formalizes handoff paths for pipeline injection |
| 11 | 007 Background Jobs | Prerequisite for 016; KG freshness mitigates stale-context risk from 008 |
| 12 | 009+009a Server-Side Loop | Needs SQLite state (001), typed errors (002), validated flows (004); 009a continue-vs-spawn lands here |
| 13 | 017 Approval Gates | Parallel with 009; extends drive_flow with approval breakpoints |
| 14 | 010 Output Contracts | Parallel with 009; needs typed errors (002), validated flow schema (004) |
| 15 | 011 Flow Composition | Parallel with 009, 010; needs load-time validation (004) |
| 16 | 013 Flow Simulation | Parallel with 009, 010, 011; builds on validateFlow (004) |
| 17 | 016 Auto-Learn | After 007 (background jobs) + 015 (transcripts) + 014 (learner tool restrictions) |
| 18 | 012 Conditional States | After 009 (server driver evaluates conditions); needs validated flow schema (004) |

**First cohort (foundation):** ADRs 001, 002, 003, 004, 005 — can progress in parallel once 001 schema is defined. ADR 015 (transcripts) slots in early because it's low-effort and unblocks the learning pipeline.

**Second cohort (pipeline + structure):** ADRs 006, 008, 014, 018 — prompt pipeline, context assembly, tool scoping, and workspace structure. These are mutually reinforcing and can develop in parallel.

**Third cohort (execution + contracts):** ADRs 007, 009, 010, 011, 013, 017 — server-side loop, output contracts, flow composition, simulation, and approval gates. 009 is the centerpiece; others extend it.

**Fourth cohort (automation):** ADR 016 (auto-learn) and 012 (conditional states) — these depend on the full stack being stable. Auto-learn needs transcripts (015), background jobs (007), and tool restrictions (014). Conditional states need the server-side driver (009).

ADRs 014 (tool scoping) and 015 (transcripts) are deliberately early — they're low-effort, low-risk, and unlock higher-value ADRs downstream.

## Decision Summary

- SQLite as the single canonical store — no file projections for orchestration state
- Agent work-product files remain (DESIGN.md, SUMMARY.md, etc.)
- Shell/git behind adapter boundaries; typed error contract (`CanonToolError` discriminated union) at MCP tool boundary
- Structured local diagnostics via SQLite events, with per-agent performance metrics (orientation ratio, token usage, duration)
- Strict flow validation at load time, SQL-backed stuck detection, explicit wave policy, validated schema for agent-produced INDEX.md via structured write tool
- Single graph representation (SQLite KG) including summaries migration from JSON to DB-primary
- Explicit prompt assembly pipeline with structural escaping and shared prompt cache prefix across agents in the same flow
- Context assembly policy: pre-orient agents via file affinity, KG summaries, topology and conventions variables to reduce tool-call overhead; item-count budgeting, not token budgeting; agent instruction compression as a follow-on
- Background jobs via child processes for heavy analysis
- `drive_flow` server-side state machine: LLM orchestrator reduced to O(hitl_points) calls; wave execution becomes server-side orchestration; continue-vs-spawn decision for fix loops preserves agent context
- Structured write tools for all agent output boundaries (`write_test_report`, `write_review`, `write_implementation_summary`); regex parsing eliminated; artifact validation in `report_result`
- Flow composition: `extends` for flow inheritance, composite fragments, typed ports replacing implicit string-param coupling
- `skip_when` expression language + agent-requested flow events via `flow-events` channel with `allowed_insertions` whitelist
- Reachability analysis in `validateFlow`; `simulate_flow` tool for deterministic flow dry-runs
- Per-agent tool scoping profiles: structural enforcement of role boundaries (researchers can't edit, reviewers can't write), with per-state overrides; permission bypass for orchestrated agents in worktrees eliminates prompt wall while worktree containment + tool scoping maintain safety
- Agent transcript recording: full conversation JSONL per specialist agent for debugging, resume, and learning
- Auto-triggered learning: gated background consolidation (time + flow count thresholds) that proposes principle/convention updates from transcript analysis
- Plan approval gates: optional positive confirmation step after architect states, with revision cycles and tier-based defaults
- Formalized workspace communication structure: `handoffs/` directory with structured cross-agent files injected by prompt pipeline
