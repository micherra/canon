# Canon Architecture Decision Records

**Status**: Active | **Last revised**: 2026-03-31

**Coupling constraint**: Canon couples only to Claude Code's documented public APIs. Every capability Canon depends on from Claude Code must be traceable to a URL at `code.claude.com/docs`. No source-path-derived assumptions about internal behavior.

**Stable API surface**: Agent definition frontmatter (`tools`, `disallowedTools`, `permissionMode`, `isolation`, `background`, `model`, `maxTurns`, `skills`, `mcpServers`, `hooks`, `memory`, `effort`, `initialPrompt`) · Hook lifecycle events · Agent SDK headless mode (`claude -p --bare --agents`) · Agent teams (experimental) · MCP protocol.
Sources: [sub-agents](https://code.claude.com/docs/en/sub-agents) · [plugins](https://code.claude.com/docs/en/plugins) · [plugins-reference](https://code.claude.com/docs/en/plugins-reference) · [agent-teams](https://code.claude.com/docs/en/agent-teams) · [headless](https://code.claude.com/docs/en/headless)

**Plugin agent restriction**: Plugin-shipped agents do NOT support `hooks`, `mcpServers`, or `permissionMode` frontmatter. These must be configured at user/project settings level.

---

## Shared Types

The following types are defined once here and referenced by ADRs that use them. Duplicating these definitions across ADRs is a violation of this document.

### SpawnRequest

`drive_flow` (ADR-009) returns `SpawnRequest[]` for single-agent and fallback-mode wave states. All fields map to documented Claude Code agent definition frontmatter.

```typescript
interface SpawnRequest {
  action: "spawn";
  agent_type: string;            // subagent definition name (e.g., "canon-implementor")
  prompt: string;                // Canon-assembled spawn prompt (ADR-006)
  isolation?: "worktree" | "branch" | "none";  // maps to agent definition isolation field
  model?: string;                // model override (maps to agent definition model field)
  tools?: string[];              // allowlist (maps to agent definition tools field)
  disallowed_tools?: string[];   // denylist (maps to agent definition disallowedTools field)
  permission_mode?: "default" | "acceptEdits" | "dontAsk" | "bypassPermissions";  // permissionMode
  max_turns?: number;            // maps to agent definition maxTurns field
  background?: boolean;          // maps to agent definition background field (arch-03)
  role?: string;                 // for parallel/wave states
  task_id?: string;              // for wave tasks
}
```

### TeamRequest

`drive_flow` returns `TeamRequest` for wave states when agent teams are available (ADR-009). Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`.

```typescript
interface TeamRequest {
  action: "create_team";
  team_name: string;
  lead_prompt: string;           // Canon-assembled prompt for the team lead
  tasks: Array<{
    task_id: string;
    description: string;
    depends_on?: string[];
    teammate_agent_type: string; // subagent definition to use as teammate role
    teammate_prompt: string;     // Canon-assembled prompt for this task (ADR-006)
  }>;
  plan_approval_required: boolean;
  gate?: string;                 // gate command to run after all tasks complete
}
```

### HitlBreakpoint

```typescript
interface HitlBreakpoint {
  action: "hitl";
  reason: string;
  context: string;
  options?: string[];
}
```

### CanonToolError

All Canon MCP tool functions return `ToolResult<T>`. Only truly unexpected conditions (bugs, I/O failures) throw. The top-level MCP handler wraps throws as `{ ok: false, error_code: "UNEXPECTED" }`.

```typescript
type ToolResult<T> = { ok: true } & T | CanonToolError;

interface CanonToolError {
  ok: false;
  error_code: CanonErrorCode;
  message: string;
  recoverable: boolean;
  context?: Record<string, unknown>;
}

type CanonErrorCode =
  | "WORKSPACE_NOT_FOUND"
  | "FLOW_NOT_FOUND"
  | "FLOW_PARSE_ERROR"
  | "KG_NOT_INDEXED"
  | "CONVERGENCE_EXCEEDED"
  | "INVALID_INPUT"
  | "PREFLIGHT_FAILED"
  | "UNEXPECTED";
```

---

## Group 1: Foundation

### ADR-001: SQLite as Canonical Local Store

#### Context

Workflow state is distributed across board.json, session.json, progress.md, message files, reviews.jsonl, log.jsonl, and flow-runs.jsonl. Each has its own read/write logic, locking strategy, rotation rules, and failure modes. Resume requires reconciling multiple files. The knowledge graph already uses SQLite (better-sqlite3).

#### Decision

Adopt SQLite as the single canonical store for all runtime state. No file projections — the prompt pipeline reads SQLite and injects formatted context directly. Agent work-product files (DESIGN.md, SUMMARY.md, REVIEW.md, etc.) remain as files since they are the substance of the work, not orchestration metadata.

**Moves to SQLite:**

| Current | SQLite table | Notes |
|---------|-------------|-------|
| board.json + session.json | `executions`, `execution_states`, `iterations` | Transactional writes replace file locking |
| progress.md | `progress_entries` | Pipeline formats on the fly via `${progress}` |
| messages/{channel}/*.md | `messages` | Pipeline injects directly, agents never read files |
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
- `atomicWriteFile` for orchestration state (still used for agent artifacts)

**Complete schema DDL** (column source annotated):

```sql
-- Core execution tracking
CREATE TABLE executions (
  id          TEXT PRIMARY KEY,    -- ADR-009: workspace + flow + session
  workspace   TEXT NOT NULL,
  flow_name   TEXT NOT NULL,
  status      TEXT NOT NULL,       -- pending | running | done | failed
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  metadata    TEXT                 -- JSON, arbitrary session metadata
);

CREATE TABLE execution_states (
  id              TEXT PRIMARY KEY,
  execution_id    TEXT NOT NULL REFERENCES executions(id),
  state_id        TEXT NOT NULL,   -- ADR-004: matches flow state definition ID
  agent_type      TEXT NOT NULL,
  iteration       INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL,   -- pending | running | done | failed | skipped
  result_status   TEXT,            -- agent-reported status keyword
  transcript_path TEXT,            -- ADR-015: path to agent observation log
  started_at      TEXT,
  finished_at     TEXT,
  -- ADR-003a performance metrics
  tool_calls          INTEGER,
  orientation_calls   INTEGER,     -- Grep+Glob+Read before first Edit/Write
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  cache_read_tokens   INTEGER,
  cache_write_tokens  INTEGER,
  duration_ms         INTEGER,
  turns               INTEGER
);

CREATE TABLE iterations (
  id           TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id),
  state_id     TEXT NOT NULL,
  iteration    INTEGER NOT NULL,
  result       TEXT,               -- JSON, agent result payload
  created_at   TEXT NOT NULL
);

CREATE TABLE progress_entries (
  id           TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id),
  state_id     TEXT,
  message      TEXT NOT NULL,      -- ADR-006: injected as ${progress}
  created_at   TEXT NOT NULL
);

-- Messaging (replaces message files)
CREATE TABLE messages (
  id           TEXT PRIMARY KEY,
  execution_id TEXT REFERENCES executions(id),
  channel      TEXT NOT NULL,
  seq          INTEGER NOT NULL,   -- ordering within channel
  from_agent   TEXT,
  content      TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

-- Review output (replaces reviews.jsonl)
CREATE TABLE reviews (
  id           TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id),
  state_id     TEXT NOT NULL,
  verdict      TEXT NOT NULL,      -- ADR-010: approved | approved_with_concerns | changes_required | blocked
  scores       TEXT,               -- JSON: { rules, opinions, conventions }
  created_at   TEXT NOT NULL
);

CREATE TABLE violations (
  id           TEXT PRIMARY KEY,
  review_id    TEXT NOT NULL REFERENCES reviews(id),
  principle_id TEXT NOT NULL,
  severity     TEXT NOT NULL,
  file         TEXT,
  message      TEXT NOT NULL
);

-- Flow analytics (replaces flow-runs.jsonl)
CREATE TABLE flow_runs (
  id           TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id),
  flow_name    TEXT NOT NULL,
  tier         TEXT,
  status       TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  total_tokens INTEGER,
  total_turns  INTEGER
);

-- Structured events (replaces log.jsonl)
CREATE TABLE events (
  id             TEXT PRIMARY KEY,
  execution_id   TEXT REFERENCES executions(id),  -- ADR-003: correlation ID
  state_id       TEXT,
  event_type     TEXT NOT NULL,
  payload        TEXT,            -- JSON
  created_at     TEXT NOT NULL
);

-- Learn gate (ADR-016)
CREATE TABLE learn_runs (
  id           TEXT PRIMARY KEY,
  completed_at TEXT NOT NULL,
  flows_since  INTEGER NOT NULL,
  proposals    INTEGER NOT NULL
);
```

**Human inspection:** Users who want to see execution state use `canon-inspector` or the `diagnose` tool (ADR-003) that queries SQLite and produces formatted output. No stale projection files.

#### Consequences

Positive: single transactional store, atomic resume, proper indexing, schema versioning via migrations, cross-entity queries, massive code deletion.

Negative: SQLite becomes a hard dependency; agent artifacts and execution state live in different storage systems; debugging requires a query tool rather than `cat board.json`.

#### Implementation

- Design schema per DDL above; implement migrations system
- Implement `execution-store.ts` with transaction-wrapped mutations
- Migrate `update_board`, `report_result`, `enter_and_prepare_state` to use store
- Rewrite prompt pipeline to read `${progress}` from SQL
- Rewrite message injection to read from SQL
- Migrate drift store from JSONL to SQLite tables
- Delete: file locking, JSONL rotation, board backup, sequence counters, message lock dirs

---

### ADR-002: Shell and Git as Privileged Adapters

#### Context

Subprocess calls (git, test runners, gate commands) are scattered across orchestration code with inconsistent timeout, error handling, and retry behavior. This blocks clean diagnostic instrumentation.

#### Decision

Centralize all subprocess execution behind adapter modules with standardized timeout, error mapping, output capture, and retry behavior. Extend the typed error contract (`CanonToolError`, defined in Shared Types above) to the MCP tool boundary.

**Subprocess adapters:**
- `git-adapter.ts`: worktree, merge, diff, status, ref validation
- `process-adapter.ts`: gate commands, test runners, arbitrary shell

Only truly unexpected conditions throw. Expected errors return `CanonToolError` with `recoverable` set appropriately. The orchestrator branches on `result.ok` instead of text-pattern matching.

#### Consequences

Positive: single risk boundary for subprocesses, consistent typed errors at all tool boundaries, clean test mocking, natural instrumentation point for ADR-003.

Negative: refactoring scattered calls; every tool return type changes (migration cost).

#### Implementation

- Introduce `git-adapter.ts` and `process-adapter.ts`
- Decompose `gate-runner.ts`: resolution (domain) vs execution (adapter)
- Route all orchestration subprocess calls through adapters
- Standardize: default timeouts, output truncation limits, error shapes, retry policy
- Replace `errors: string[]` in `LoadFlowResult` with discriminated union
- Replace plain throws with typed error returns throughout
- Add top-level MCP handler catch-all that wraps unexpected throws
- Update orchestrator agent instructions to use `result.ok` branching

---

### ADR-003: Diagnostics

#### Context

Canon needs strong local diagnostics — why a flow is stuck, what happened, how to recover. Tests are strong but runtime diagnostics are weaker than orchestration complexity warrants.

#### Decision

Structured local diagnostics via correlation IDs, execution events, and diagnostic queries. Events stored in SQLite (ADR-001). Adapters (ADR-002) provide the instrumentation seam.

**Per-state execution performance metrics** are stored alongside events in `execution_states` (schema in ADR-001):

| Metric | Column | Purpose |
|--------|--------|---------|
| Total tool calls | `tool_calls` | Agent effort |
| Orientation calls | `orientation_calls` | Grep+Glob+Read before first Edit/Write |
| Token usage | `input_tokens`, `output_tokens` | Cost tracking |
| Cache hits | `cache_read_tokens`, `cache_write_tokens` | Prompt cache efficiency (ADR-006) |
| Duration | `duration_ms` | Wall-clock performance |
| Turns | `turns` | API round-trips |

**Key derived metric:** `orientation_ratio = orientation_calls / tool_calls` — the fraction of agent effort spent discovering context vs. doing work. This is the primary metric for ADR-008 (Context Assembly) effectiveness. Target: reduce from ~40-60% to <20% after context injection.

**Diagnostic surface:**
- `diagnose` command: queries events + execution state + performance metrics, produces actionable report
- Stuck detection: evaluation results become queryable events ("compared X to Y, not stuck because Z")
- Anomaly detection: flag states where `orientation_ratio > 50%` or `duration > 2x median` for that agent type
- `canon-inspector`: queries SQLite for formatted execution state

#### Consequences

Positive: debuggability, user trust, recovery workflows, ADR-008 effectiveness measurement.

Negative: event modeling discipline, diagnostic surface area.

#### Implementation

- Add `correlation_id` (execution ID) to every event
- Standardize event shapes in `events` table
- Instrument adapter calls with timing and outcome events
- Stuck detection evaluation results become queryable events
- Implement `diagnose` command with execution state + performance report
- Add anomaly detection thresholds (configurable per agent type)
- Evolve `canon-inspector` to query SQLite events

---

### ADR-005: Knowledge Graph Consolidation

#### Context

Two parallel graph representations: file-level (graph-data.json, in-memory queries) and entity-level (knowledge-graph.db, SQLite). A view-materializer bridges them. The `summaries.json` write path is JSON-primary but the read path is DB-primary — they diverge permanently for projects without a full KG index.

#### Decision

SQLite KG is the sole graph representation. Eliminate graph-data.json, summaries.json, and the legacy in-memory query path. All consumers (codebase_graph, graph_query, get_file_context, store_summaries, UI) read from and write to SQLite via KgQuery.

**Summaries migration:**
- Flip `store_summaries` write primary: SQLite first (in transaction), JSON as optional export
- Remove the file-must-exist guard in `writeSummariesToDb` — upsert a stub file row for summaries without a full KG index
- One-time migration: on first `storeSummaries` call, read `summaries.json`, upsert missing entries into DB, rename to `summaries.json.migrated`
- Remove `loadSummariesFile` fallback from `get-file-context.ts`

#### Consequences

Positive: one query API, transactional updates, no consistency drift, entity-level precision everywhere, summaries always in sync with the graph.

Negative: migration for any consumers reading graph-data.json or summaries.json directly; view-materializer deletion.

#### Dependencies

ADR-001 (SQLite as single store).

#### Implementation

- Migrate `query.ts` (in-memory graph) consumers to KgQuery
- Migrate UI components to read via MCP tools backed by KgQuery
- Delete view-materializer.ts, graph-data.json generation, reverse-deps.json
- Add missing query methods to KgQuery (degree analysis, layer violations)
- Execute summaries migration per decision above

---

### ADR-007: Background Jobs for Heavy Analysis

#### Context

Heavy operations (codebase graph generation, impact analysis) run inline with interactive orchestration and degrade responsiveness.

#### Decision

Local background job model using child processes (not worker threads — shared memory complexity is not justified). Persist job status and cached outputs in SQLite (ADR-001).

#### Consequences

Positive: responsiveness, retry/caching, control-plane isolation.

Negative: local runtime complexity, job lifecycle rules, cache invalidation.

#### Dependencies

ADR-001 (job status and cache in SQLite).

#### Implementation

- Add job abstraction: submit, poll, result, cancel
- Split `codebase_graph` into submit/poll/materialize
- Cache by repo + config fingerprint in SQLite
- Job status visible via `diagnose` (ADR-003)
- Synchronous fallback for CI environments
- Background jobs get their own principle cache instance

---

## Group 2: Flow System

### ADR-004: Flow Validation and Execution Model

#### Context

The flow system has five sources of brittleness: fragment params are string interpolation (typos produce literal `${typo}` silently), transitions are unchecked strings, spawn instructions match by markdown heading (orphaned headings are silent), stuck detection depends on caller-provided history shapes (missing fields fail silently), and wave execution semantics are implicit. The architect produces INDEX.md with a markdown table parsed by regex in `wave-variables.ts` — if the architect writes backtick-wrapped IDs, the wave runner silently proceeds with zero tasks.

#### Decision


Keep the YAML+MD format. Add strict load-time validation, move execution state management to SQLite, and validate agent-produced artifacts that drive execution.

**Load-time validation (strict):**
- Every transition target resolves to a real state ID or `hitl`
- Every non-terminal state has a matching spawn instruction heading
- Fragment params are typed (`state_id`, `string`, `number`, `boolean`); `state_id` params validated against resolved state map
- Variable references checked against declared availability per state type
- Reachability analysis: warn on unreachable states (ADR-013)
- Unresolved `${...}` references after substitution are errors, not silent pass-through

**Stuck detection moves to SQL:**
Execution store records raw state results. Stuck detection becomes a query comparing the last two iterations. Eliminates the "caller forgot a field" failure mode entirely.

**Wave policy becomes explicit** and gains a `coordination` field for agent team support (arch-02):

```yaml
implement:
  type: wave
  agent: canon-implementor
  wave_policy:
    coordination: team          # team | subagent (default: team when agent teams available)
    isolation: worktree         # worktree | branch | none (subagent fallback only)
    merge_strategy: sequential  # sequential | rebase | squash (subagent fallback only)
    gate: test-suite
    on_conflict: hitl           # hitl | replan | retry-single
  consultations:
    before: [plan-review]
    between: [pattern-check]
    after: [impl-handoff]
```

When `coordination: team`, teammates manage their own file isolation and Canon's `merge_strategy` / worktree creation are not used. When `coordination: subagent` (fallback), Canon manages worktree creation and sequential merge.

**Discriminated state schemas:**
- Per-type Zod schemas: `SingleStateSchema`, `WaveStateSchema`, `ParallelStateSchema`, `ParallelPerStateSchema`, `TerminalStateSchema`
- `z.discriminatedUnion("type", [...])` for `StateDefinitionSchema`
- Fragment schema derived via helper that relaxes numeric fields for param placeholders
- Additional fields on `StateDefinitionSchema`: `approval_gate` (boolean, default false), `max_revisions` (integer, default 3), `rejection_target` (string, default "hitl"), `tool_overrides` (object), `domain` (string), `required_artifacts` (string[]), `skip_when` (expression), `allowed_insertions` (string[]), `non_blocking` (boolean)

**INDEX.md structural write path:**

`write_plan_index` MCP tool accepts a typed structure and produces normalized markdown:

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

The architect calls this tool instead of writing raw markdown. The regex always sees clean input because the tool controls the output format.

#### Consequences

Positive: flow authoring errors caught at load time, stuck detection cannot silently fail, wave behavior is explicit and configurable, agent-authored flows validated strictly.

Negative: existing flows must pass stricter validation (migration), fragment param syntax changes (auto-migratable), wave_policy is new surface area.

#### Dependencies

ADR-001 (execution store for stuck detection), ADR-002 (typed errors at validation boundary).

#### Implementation

- Add validation pass to `load_flow`: transitions, spawn instructions, params, reachability
- Implement typed fragment params
- Implement discriminated union state schemas
- Move stuck detection from caller-constructed history to SQL query
- Add `wave_policy` to `WaveStateSchema` with `coordination` field
- Harden `parseTaskIdsForWave` regex; add `validate_plan_index` check (zero tasks = block, not proceed)
- Implement `write_plan_index` MCP tool
- Update architect spawn instructions to call `write_plan_index`
- Run all existing flows through strict validation as acceptance test

---

### ADR-011: Flow Composition Model

#### Context

Fragments are string interpolation only. There is no top-down extension model. Adding a quality gate to all medium+ flows requires editing every flow file individually. The `test-fix-loop` and `verify-fix-loop` fragments are structurally identical but share no common skeleton. Transition wiring across fragment boundaries uses string params that create implicit coupling.

#### Decision

Three additions to the composition model:

**1. Flow extension:** A flow declares `extends: <flow-name>` to inherit all states and spawn instructions from a parent flow. Child states merge with parent's (child wins on conflict). Enables a `standard-medium` base flow that `feature`, `refactor`, and `migrate` extend.

**2. Composite fragments:** Fragments can include other fragments via the same `includes:` mechanism. A `try-fix-retry` meta-fragment can be shared between `test-fix-loop` and `verify-fix-loop`.

**3. Typed fragment ports:** Fragments declare explicit exit points via a `ports:` block instead of string params for transition targets.

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
  retry:
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

Unwired required ports are a load-time error (ADR-004 validation).

#### Consequences

Positive: single-point-of-change for pipeline patterns, fragment duplication eliminated, fragment boundaries become explicit contracts.

Negative: inheritance resolution adds complexity to flow-parser (cycle detection), port syntax is new surface area.

#### Dependencies

ADR-004 (load-time validation for unwired required ports and circular inheritance chains).

#### Implementation

- Add `extends` field to flow schema; implement inheritance resolution with depth-first merge
- Add cycle detection for circular inheritance chains
- Add `includes` support to fragment schema; implement recursive resolution with cycle detection
- Add `ports` block to fragment schema
- Add port wiring syntax to `includes`
- Create `standard-medium` base flow; migrate `feature`, `refactor`, `migrate` to extend it
- Migrate `test-fix-loop` and `verify-fix-loop` to share `try-fix-retry`

---

### ADR-012: Conditional State Inclusion

#### Context

Flows are static YAML. The `skip_when` mechanism has exactly 5 hardcoded enum values. Agents cannot signal that a flow needs modification mid-execution. There is no way to express "skip research if task touches fewer than N files" or "insert security-scan if the change touches `auth/`".

#### Decision

Two mechanisms:

**1. Extensible `skip_when` with predicate expressions:** Replace the closed enum with an expression evaluator. `skip_when` accepts either the legacy enum values (backward compat) or a predicate expression over board metadata. Predicates are evaluated at state-entry time by the server (not the LLM).

Supported predicates:
- `files_changed < N`
- `layers_touched includes "<layer>"`
- `gate_passed("<gate-name>")`
- `has_artifact("<artifact-name>")`
- `metadata.<key> == <value>`

Multiple predicates can be combined: `files_changed < 5 AND NOT layers_touched includes "auth"`.

**2. Agent-requested flow events via `flow-events` channel:** Extend the wave event mechanism so agents can request flow modifications by posting to a `flow-events` channel via `post_message`. The server (ADR-009) evaluates these between states.

```typescript
{ type: "request_state", target: "research", reason: "Found 3 unknown subsystems" }
{ type: "skip_ahead", target: "ship", reason: "No violations found" }
{ type: "escalate", context: "...", suggested_options: ["add security scan", "proceed"] }
```

`request_state` is subject to an `allowed_insertions` whitelist declared in the flow. `skip_ahead` requires a reason and is only evaluated if the target state is reachable. `escalate` triggers a HITL breakpoint.

#### Consequences

Positive: flows adapt to runtime conditions without requiring user presence, `skip_when` becomes a proper expression language, agents can signal complexity escalation through a controlled mechanism.

Negative: expression evaluator adds parsing and security surface (predicates must not be injectable), agent-requested events need careful whitelist enforcement.

#### Dependencies

ADR-004 (flow schema validation for `allowed_insertions` whitelist and `skip_when` expression syntax), ADR-009 (server-side driver evaluates conditions mechanically between states).

#### Implementation

- Implement predicate expression parser for `skip_when`; support legacy enum values for backward compat
- Define predicate functions: `files_changed`, `layers_touched`, `gate_passed`, `has_artifact`, `metadata`
- Add `allowed_insertions: string[]` field to flow schema
- Add `flow-events` channel processing in `drive_flow` state loop (ADR-009)
- Implement `request_state`, `skip_ahead`, `escalate` event processing; enforce whitelist

---

### ADR-013: Flow Simulation and Reachability Analysis

#### Context

`validateFlow` checks structural validity but cannot simulate execution. Dead-end paths — where certain failure conditions lead to states with no path to a terminal — are discovered only at runtime. `buildStateGraph` exists in `flow-parser.ts` but is unused in validation.

#### Decision

Two capabilities:

**1. Reachability analysis at load time:** For every state, verify that every possible transition condition eventually leads to a terminal state or `hitl`. Report dead-end states, unreachable states, and stuck loops. Integrated into `validateFlow` as warnings (not errors). Surfaces during `load_flow` in the `warnings` array.

**2. Flow simulation (`simulate_flow` tool):** Walks the state machine with mocked agent results. The caller provides a scenario: a sequence of `(state_id, status_keyword)` pairs.

```typescript
interface SimulateFlowInput {
  flow: string;
  scenario: Array<{ state_id: string; status: string }>;
  max_steps?: number;  // default 50
}

interface SimulateFlowOutput {
  ok: boolean;
  path: Array<{
    state_id: string;
    status_input: string;
    next_state: string;
    transition_matched: string;
  }>;
  terminal_state?: string;
  stuck_at?: string;
  dead_end_at?: string;
  iterations_consumed: Record<string, number>;
  warnings: string[];
}
```

No agents are spawned, no workspace is created. The simulator operates purely on the resolved flow definition.

#### Consequences

Positive: catches dead-end flow designs before runtime, flow authors can verify complex logic quickly, enables automated flow regression testing.

Negative: reachability analysis is conservative (ADR-012 predicates are not evaluated by the analyzer), simulation does not capture wave-level complexity.

#### Dependencies

ADR-004 (`buildStateGraph` becomes the analysis backbone; `GateResult` and transition schemas provide edge types).

#### Implementation

- Implement reachability analysis: BFS/DFS from every state through all transition edges
- Integrate into `validateFlow`; add results to `warnings` array in `LoadFlowResult`
- Implement `simulate_flow` tool
- Add `canon flow validate` CLI command; exits non-zero on warnings

---

## Group 3: Pipeline and Context

### ADR-006: Agent Prompt Assembly Pipeline

#### Context

`get-spawn-prompt.ts` is ~500 lines with 9 implicit composition layers. The ordering is hardcoded. The trust boundary (`escapeDollarBrace`) is a single function that must be called correctly at every agent-text injection site. The current pipeline has essentially no budget model — everything concatenates unbounded. There is no shared prompt prefix across agents in the same flow.

Under the plugin architecture (arch-01), the pipeline injects **Canon-specific context** (principles, KG summaries, file affinity data, progress, wave briefings, conventions). It does NOT inject tool scoping instructions or permission configurations — those go in agent definition frontmatter, not prompt text. This separation is mandatory: tool scoping via prompt text is unreliable; tool scoping via frontmatter `tools`/`disallowedTools` is structurally enforced by Claude Code.

#### Decision

Explicit named pipeline stages with defined execution order. Agent-sourced text enters pre-escaped by the stage that reads it (structural guarantee, not caller discipline). Each stage is independently testable.

**Pipeline stages (ordered):**

1. **resolve-context** — read injected context from prior states (SQLite); file affinity resolution for task-referenced files (ADR-008)
2. **resolve-progress** — format execution history from SQLite as `${progress}`
3. **resolve-messages** — read relevant messages from SQLite, format for injection
4. **substitute-variables** — flow-level and wave-level variable replacement
5. **inject-templates** — append template instructions
6. **inject-wave-briefing** — assemble briefing from prior wave data (SQLite); KG summary injection (ADR-008)
7. **fanout** — expand single prompt into N prompts (parallel roles, wave items, compete lenses, diff clusters)
8. **inject-coordination** — append messaging and guidance instructions
9. **validate** — check for unresolved `${...}` references (error, not silent)

Stages 1-3 read from SQLite and escape all agent-sourced text at the read boundary. Stage 9 catches any variable that fell through.

**Shared prompt prefix (cache optimization):**

Split assembled prompts into a shared prefix and an agent-specific suffix. The shared prefix is computed once per workspace and frozen for all agent spawns in that flow execution. Canon's `init_workspace` computes and caches it as `workspace.prompt_prefix`. `drive_flow` returns cached prefix bytes alongside each `SpawnRequest`. Caller passes the frozen prefix to agent spawn, ensuring byte-identical API requests for the prefix portion, maximizing prompt cache hits across all agents in a flow.

Shared prefix contents (stable across agents): project context, conventions, principles, topology.
Agent-specific suffix: role instructions, task details, handoff content, state-specific context.

**Principle injection by relevance:**

Principles are tagged by domain (testing, security, API design, etc.). The pipeline injects only principles relevant to the current task's domain classification. This significantly shrinks spawn prompts for agents where only a subset of principles applies.

#### Consequences

Positive: adding a stage is additive, trust boundary is structural, per-stage unit testing, prompt construction is auditable, prompt cache hit rate improves across all agents in a flow.

Negative: pipeline abstraction adds indirection, must migrate ~500 lines of implicit logic.

#### Dependencies

ADR-001 (pipeline reads from SQLite), ADR-004 (stable flow schema), ADR-005 (KG summaries).

#### Implementation

- Define `PromptStage` interface: `(context: PromptContext) => PromptContext`
- Implement each stage as a pure function
- Wire stages in `get-spawn-prompt.ts` as a pipeline
- Move escape responsibility to read-boundary stages (1-3)
- Add stage 9 validation (unresolved references = error)
- Compute shared prefix at `init_workspace`; cache in workspace record
- Add domain tagging to principle schema; implement relevance filtering in stage 5
- Delete monolithic composition logic

---

### ADR-008: Context Assembly Policy

#### Context

Canon is a Claude Code plugin. The real cost of agent disorientation is not tokens — it is **tool-call round-trips**. Each Grep/Glob/Read call burns a turn in the agent's conversation. Currently ~25-35% of each agent's instruction weight is orientation protocol — steps like "read your plan", "load principles", "check context.md" — that exist because agents arrive cold. The prompt assembly pipeline (ADR-006) has explicit injection stages but no policy for what project context to inject and no budget model.

#### Decision

Define a context assembly policy that the prompt pipeline (ADR-006) executes at spawn time. The goal is **tool-call reduction**, not token minimization — spend tokens upfront on pre-computed context to avoid sequential discovery tool calls.

**Context injection mechanisms:**

1. **File affinity resolution** — when a task plan references specific files, pipeline stage 1 resolves `get_file_context` for each and injects summaries, imports, exports, blast radius. Eliminates 3-5 Read/Glob/Grep calls per file.
2. **KG summary injection** — pipeline stage 6 queries SQLite KG (ADR-005) for file-level summaries of files in task scope. Compact format replaces verbose research prose. Eliminates the "read callers, read callees, understand blast radius" discovery cluster.
3. **Project topology variable** — `${project_structure}` computed at workspace init from KG layer/degree data: layer breakdown, hub files (high in-degree), recent changes since base branch. Low injection cost, eliminates "where does this kind of file live?" orientation.
4. **Conventions pre-indexing** — lightweight scan at workspace init captures test framework, import style, error handling patterns into a `${conventions}` variable. Eliminates the "read CLAUDE.md + grep for patterns" cluster.
5. **`graph_query` as agent default** — agent definition files explicitly instruct agents to prefer `graph_query` MCP tool over Grep for dependency/caller/callee questions. Zero system changes, convention update only.

**Injection budgeting (item-count, not token-count):**

The 200k context window is not the constraint — **attention efficiency** is. Pre-injecting 2,000 tokens of structured context to avoid 8-10 tool calls is always worthwhile. Budget by item count:
- File affinity: max N files (ordered by blast radius), where N is configurable per flow tier (e.g., 5 for hotfix, 15 for feature, 30 for epic)
- KG summaries: one line per file in scope, capped at the same N
- `${project_structure}` and `${conventions}`: fixed-size snapshots, always injected

No tokenizer needed. Item-count caps naturally bound injection size.

**Background preparation (arch-03):**

While a foreground agent runs, Canon can spawn lightweight background preparation agents using Claude Code's `background: true` agent definition field. This is a context assembly optimization, not a state machine change.

| Foreground state | Background prep | Benefit |
|-----------------|-----------------|---------|
| Implement (coding) | Refresh KG index; compute which principles apply to changed files | Reviewer arrives with fresh context |
| Test (running) | Pre-read diff + principles | Reviewer arrives pre-oriented |
| Any state | Scribe keeps docs in sync (fire-and-forget) | Context-sync never blocks |

Background prep constraints:
- No data dependency on current state's output — always safe regardless of outcome
- No wasted work — prep is useful regardless of how the foreground state resolves
- No state machine change — prep agents are spawned alongside the foreground SpawnRequest
- Fire-and-forget for scribe; KG refresh results are cached and consumed by next state's pipeline

Background prep is NOT: speculative pipelining (starting the next state early), parallel state execution, or out-of-order completions. The state machine remains strictly sequential. The few states where real data dependencies prevent safe overlap (researcher → architect, implementor → reviewer) are correctly handled by the sequential model.

The scribe case specifically can use `non_blocking: true` on the context-sync state, allowing the orchestrator to transition immediately without waiting for the scribe to complete.

**Agent output forwarding:**

Each agent's results are piped directly into the next agent's spawn prompt via ADR-006 stage 1 (resolve-context). The researcher's findings go into the architect's prompt. The architect's plan goes into the implementor's prompt. The implementor's summary goes into the tester's prompt. This is not just "workspace files exist" — the pipeline actively reads, compresses, and injects prior agent output so the next agent does not need to re-read the same source code independently. Combined with file affinity, this eliminates the redundant discovery pattern where every agent in the pipeline Grep/Reads the same files.

**Cached workspace context (project snapshot):**

At workspace init, Canon builds a compressed "project snapshot" — key file summaries, directory structure, conventions, recent changes — and caches it as `workspace.context_snapshot`. This is injected into every agent's prompt via `${project_snapshot}`. Agents no longer need to glob/grep/read to orient themselves about the project shape. The snapshot is recomputed only when the KG is refreshed (ADR-007) or a background prep agent updates it.

**Agent instruction compression:**

Once context injection is reliable, agent `.md` files can be revised to remove orientation protocol (~25-35% of current instruction weight). This is a follow-on task — do not compress instructions until the pipeline reliably delivers the context they compensate for.

#### Consequences

Positive: agents arrive pre-oriented, tool calls per agent drop significantly (target: 50%+ reduction in orientation Grep/Glob/Read calls), better attention efficiency.

Negative: stale context risk if KG/summaries are outdated (mitigated by ADR-007 background refresh and background prep), affected-files extraction adds architect responsibility.

#### Dependencies

ADR-001 (SQLite foundation), ADR-005 (KG as single graph source), ADR-006 (prompt assembly pipeline stages), ADR-007 (KG freshness via background jobs).

#### Implementation

- Add `inject_context` source type `file_context` to pipeline stage 1
- Add KG summary query to stage 6 wave briefing assembly
- Implement `${project_structure}` variable computation at workspace init
- Implement `${conventions}` variable via lightweight pattern scan at workspace init
- Add item-count caps per flow tier to flow schema (not token budgets)
- Update researcher and implementor agent `.md` files to prefer `graph_query`
- Add `non_blocking: true` field support for scribe state
- Implement background prep agent spawning alongside main SpawnRequest in `drive_flow`
- Implement agent output forwarding in pipeline stage 1: read prior state's structured output + summary, compress, inject into next agent's prompt
- Implement `workspace.context_snapshot` computation at init time; inject via `${project_snapshot}` variable
- Acceptance metric: measure orientation tool calls before/after; target 50%+ reduction

---

## Group 4: Execution

### ADR-009: Server-Side State Machine and Single-Agent Fast Path

#### Context

The orchestrator's inner loop — enter state, check can_enter, spawn agents, report result, read next_state, repeat — is fully mechanical. The LLM adds zero judgment to this loop, yet every state costs an LLM round-trip. Only three steps require LLM judgment: intent classification at start, HITL decision points, and fan-out fixer categorization. Current flows have 6-14 states; a typical feature flow burns 8-12 LLM calls where 1-2 would suffice.

Additionally, ~70% of Canon tasks are small: touching ≤3 files with clear instructions. These tasks do not benefit from the full research → design → implement → test → review pipeline. Every state in the pipeline has overhead costs; for small tasks, the overhead exceeds the value.

#### Decision

**Server-side state machine (`drive_flow`):**

Implement a `drive_flow` MCP tool that executes the state machine loop mechanically. The server enters states, resolves spawn prompts, and returns agent spawn instructions to the caller. The LLM orchestrator is invoked only for: (1) initial intent classification and flow selection, (2) HITL breakpoints requiring user decisions, (3) fan-out fixer categorization.

`drive_flow` operates on a turn-by-turn protocol:
- **Caller sends:** `{ workspace, flow, result? }` (result absent on first call)
- **Server returns:** one of four response shapes (see Shared Types section for type definitions):
  - `SpawnRequest[]` — caller spawns one or more agents, sends results back
  - `TeamRequest` — caller creates an agent team for a wave state (when agent teams available)
  - `HitlBreakpoint` — caller presents to user, sends decision back
  - `{ action: "done", terminal_state: string, summary: string }` — flow complete

Wave execution (worktree creation in fallback mode, sequential merge, gate running) becomes server-side orchestration rather than LLM-interpreted prose. The wave loop runs entirely within the server on each `drive_flow` call.

**Agent team vs. subagent selection for wave states (arch-02):**

For wave states, `drive_flow` checks whether agent teams are available (detects `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` environment flag):
- **Team mode** (available): returns `TeamRequest`. The orchestrator creates a team; the lead assigns tasks to teammates using Canon's subagent definitions as teammate roles. Canon observes progress via `TaskCompleted` hooks and evaluates the gate when all tasks report complete.
- **Fallback mode** (unavailable): returns `SpawnRequest[]`. The orchestrator spawns individual subagents, collects results, and reports back to `drive_flow`. Canon manages worktree creation and sequential merge.

In both modes, Canon assembles each agent/teammate's spawn prompt (ADR-006), injects context (ADR-008), enforces principle compliance, and evaluates gates. The difference is only how parallel agents are coordinated.

**Single-agent fast path:**

If the task request indicates a small scope (≤3 files changed, clear unambiguous instructions), `drive_flow` returns a single `SpawnRequest` for a generalist agent that performs code + test + self-review in one pass. No research state, no architect state, no separate tester or reviewer. The agent is spawned with the implementor definition but with explicit instructions to also write tests and self-review against principles.

Fast path triggers when ALL of the following are true:
- `files_changed <= 3` (from KG diff analysis at init_workspace)
- `instructions_clarity == "high"` (assessed by drive_flow using a simple heuristic: no open questions, no ambiguous scope)
- `task_type` is not `"design"`, `"architecture"`, `"migration"`, or `"epic"`

Fast path saves approximately 70% of tokens for tasks that qualify. It is the biggest single token optimization in Canon.

**Approval gates:**

Canon leverages two complementary mechanisms for plan approval:

1. **`planModeRequired: true`** (Claude Code native) — on agent definitions. The agent starts in plan mode and must receive explicit user approval before switching to implementation mode. This is Claude Code's built-in approval gate, documented at code.claude.com/docs/en/sub-agents. Canon uses this on the architect definition so that designs require user approval before any implementation begins — the approval happens at the Claude Code level, not as a custom Canon state.

2. **`approval_gate: true`** (Canon flow-level) — on state definitions. Pauses `drive_flow` after the agent completes and returns an approval breakpoint. This handles Canon-specific approval needs beyond what `planModeRequired` covers (e.g., approving wave boundaries in epics).

```typescript
interface ApprovalBreakpoint {
  action: "approve";
  state_id: string;
  agent_type: string;
  artifacts: string[];
  summary: string;
  options: ["approve", "revise", "reject"];
}
```

User responses: **approve** (normal transition), **revise** (re-enter state with feedback appended; iteration counter increments), **reject** (transition to `rejection_target`, default `"hitl"`). `max_revisions` (default 3) limits revision cycles.

```yaml
design:
  type: single
  agent: canon-architect   # architect definition has planModeRequired: true
  approval_gate: true      # Canon also gates the flow transition
  transitions:
    done: implement
    blocked: hitl
```

**Tier-based defaults:** `hotfix` flows: no approval gates; `feature` flows: architect has `planModeRequired: true` + `approval_gate: true` on design state; `epic` flows: approval gates on design and each wave boundary.

**Continue-vs-spawn for fix loops:**

For fix-loop iterations, `SpawnRequest` includes a `continue_from` field to reuse the previous agent's context instead of spawning fresh:

```typescript
interface SpawnRequest {
  // ...existing fields...
  continue_from?: {
    agent_id: string;        // previous agent's session ID
    context_summary: string; // what happened since last run
  };
}
```

Decision heuristic — **continue** if: same agent type AND same files in scope AND previous iteration was a fix/retry attempt AND previous agent has not been evicted. **Spawn fresh** otherwise. Eviction after 10 minutes idle.

**Fan-out fixer categorization:**

Extracted into a dedicated `categorize_failures` tool that accepts a test report (`TestReportInput` from ADR-010) and returns grouped `FailureCategory[]`. The orchestrator LLM calls this once and returns the result to `drive_flow` as part of the HITL response for fix states.

#### Consequences

Positive: massive cost reduction (most flows have 0-1 HITL points), faster execution (no LLM latency per state transition), deterministic loop behavior, ~70% token savings on small tasks via fast path.

Negative: agent spawning still requires the caller (Claude Code cannot be invoked from server-side), HITL interaction model needs careful UX design, wave-level complexity moves into server code.

#### Dependencies

ADR-001 (SQLite state — server loop reads/writes atomically), ADR-002 (typed errors — clean branching on recoverable vs. fatal), ADR-004 (validated flows — safe mechanical execution requires verified transitions).

#### Implementation

- Implement `drive_flow` tool with state entry, convergence check, prompt resolution, result acceptance, transition evaluation
- Implement fast path detection: files_changed + instructions_clarity heuristic
- Implement team-vs-subagent mode selection: detect `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`
- Define `TeamRequest` and `SpawnRequest` return types in Shared Types section (above)
- Move wave execution protocol (fallback mode: worktree lifecycle, merge sequencing, gate running) to server-side handlers keyed on `wave_policy` (ADR-004)
- Implement `categorize_failures` tool
- Implement `ApprovalBreakpoint` response type and revision loop
- Implement continue-vs-spawn tracking: store agent session IDs in `execution_states`
- Migrate orchestrator agent `.md` to: intent classification rules, HITL decision logic, `drive_flow` usage, `categorize_failures` invocation
- Add `drive_flow` e2e test with simulated agent results for a 3-state flow

---

### ADR-014: Agent Subagent Definitions and Tool Scoping

#### Context

Canon specialist agents all inherit the same tool set. A researcher agent can call Edit and modify source code. A reviewer can call Write and create files. There is no enforcement boundary — agent role restrictions exist only in prose instructions.

Claude Code's documented stable API solves this: agent definitions (`.claude/agents/*.md` or `--agents` JSON) support `tools` (allowlist) and `disallowedTools` (denylist) frontmatter fields. The model never sees tools it shouldn't use. These definitions are also reusable as teammate roles when agent teams are active (arch-02).

**Previous approach (V1 ADR-014):** Custom runtime enforcement via Canon's own filtering. This was building what Claude Code already provides.

#### Decision

Canon defines subagent definitions — one per specialist role — with `tools`/`disallowedTools` and `permissionMode` frontmatter. `drive_flow` (ADR-009) references these definitions by name in each `SpawnRequest.agent_type`. Claude Code handles tool filtering and permission enforcement via documented frontmatter. No custom runtime enforcement.

Subagent definitions are reused as teammate roles when agent teams are active. Canon's subagent definitions serve double duty: as standalone subagent types and as teammate role templates.

**Two enforcement mechanisms:**

1. **Plan mode** (`permissionMode: plan`) — for read-only agents. The agent can read, search, and think, but cannot edit, write, or execute destructive operations. Claude Code enforces this at runtime. This is strictly better than tool deny lists for read-only roles because the agent still *sees* all tools (useful for understanding what's possible) but cannot invoke write operations.

2. **Tool deny lists** (`disallowedTools`) — for agents that need partial write access. The scribe can edit specific docs but not run Bash. The architect can call structured write tools but not edit source files directly.

**Per-role scoping profiles:**

| Agent | Mode | `disallowedTools` | Rationale |
|-------|------|------------------|-----------|
| researcher | `plan` | — | Read-only; plan mode enforces structurally |
| architect | `plan` | — | Read-only; produces plans via structured write tools only (MCP tools work in plan mode) |
| reviewer | `plan` | — | Read-only; observes and reports via structured write tools |
| learner | `plan` | — | Read-only; reads patterns, proposes to staging area |
| implementor | `default` | — | Full access needed |
| tester | `default` | — | Writes tests + runs them |
| fixer | `default` | — | Needs full access to fix issues |
| scribe | `default` | Bash, Write (except CLAUDE.md/context.md/CONVENTIONS.md) | Scribe updates docs only |

Note: MCP tools (Canon's structured write tools like `write_plan_index`, `write_review`, `write_research_synthesis`) are callable in plan mode because they are MCP server tools, not file-system tools. This means the architect can call `write_plan_index` to produce a plan without needing Edit/Write permission. The plan mode boundary prevents agents from directly modifying source code while still allowing them to produce structured output through Canon's MCP tools.

**Permission configuration:**

Plugin agents cannot set `permissionMode` frontmatter (documented restriction). For interactive use, users configure permission modes at the project level via `.claude/settings.json`. For CI/headless flows, Canon uses the Agent SDK (`claude -p --bare --agents JSON`) and can specify `permissionMode` in the `--agents` JSON definition for full control. Canon documents the recommended project-level configuration:
- Read-only agents (researcher, architect, reviewer, learner): `permissionMode: plan`
- Write agents in worktrees (implementor, tester, fixer): `permissionMode: bypassPermissions` or `acceptEdits`
- Scribe: `permissionMode: default` with targeted `disallowedTools`

**Domain-conditional tool profiles:**

Flow state definitions accept a `domain` tag that adjusts the tool profile at resolution time. When `domain: frontend`, tester and reviewer profiles gain Playwright MCP tools.

```yaml
test-frontend:
  type: single
  agent: canon-tester
  domain: frontend   # grants playwright_navigate, playwright_screenshot, playwright_click to tester + reviewer
```

Supported `domain` values: `"frontend" | "backend" | "infra" | "docs"`.

**Per-state overrides:**

```yaml
security-research:
  type: single
  agent: canon-researcher
  tool_overrides:
    allow: [Bash]   # researcher needs Bash for this state
```

#### Consequences

Positive: role enforcement is structural (Claude Code enforces it), not prose, eliminates accidental cross-boundary actions, subagent definitions serve double duty for subagents and agent team teammates.

Negative: plugin agents cannot set `permissionMode` directly (users must configure at project level), Playwright MCP must be available for `domain: frontend` flows.

#### Dependencies

ADR-009 (SpawnRequest carries `agent_type`, `tools`, `disallowed_tools`, `permission_mode`).

#### Implementation

- Create `.claude/agents/` definitions for each specialist role: read-only agents (researcher, architect, reviewer, learner) use `permissionMode: plan`; write agents use `disallowedTools` where needed
- Set `planModeRequired: true` on architect definition for native approval gating
- Add `domain` field to `StateDefinitionSchema`; implement domain-conditional tool profile resolution in `drive_flow`
- Document recommended project-level permission configuration in Canon setup guide
- Add `tool_overrides` field to `StateDefinitionSchema`
- Document recommended project-level permission configuration for Canon users
- Update `SpawnRequest.permission_mode` documentation to reference `claude -p --agents` for CI/headless use

---

## Group 5: Output and Quality

### ADR-010: Structured Agent Output Contracts

#### Context

ADR-004 solves INDEX.md parsing fragility with `write_plan_index`. Every other agent-to-agent boundary has the same problem: the reviewer produces REVIEW.md parsed by 5 regex patterns, the tester produces a `### Issues Found` markdown table parsed by the orchestrator, the implementor produces `### Coverage Notes` consumed by the tester. If any agent formats differently, downstream consumers silently get nothing. `resolveAndRead` in `effects.ts` returns null on missing artifacts and logs an error but does not block the flow.

#### Decision

Generalize the `write_plan_index` pattern: structured write MCP tools for all agent output boundaries. Each tool accepts a typed structure and produces normalized markdown. Downstream consumers parse tool-produced output (guaranteed format) rather than free-form agent prose.

For CI/headless flows, Canon additionally supports `--output-format json --json-schema` from the Agent SDK (source: https://code.claude.com/docs/en/headless) as an alternative to structured write tools for agents that run programmatically. The structured write tools remain the primary path for interactive flows.

**Structured write tools:**

| Tool | Writer | Readers |
|------|--------|---------|
| `write_plan_index` (ADR-004) | Architect | Wave runner |
| `write_research_synthesis` | Researcher | Architect |
| `write_design_brief` | Architect | Implementor |
| `write_test_report` | Tester | Fixer (failure grouping), Reviewer (coverage check) |
| `write_review` | Reviewer | Fixer (blocking violations), Shipper (go/no-go) |
| `write_implementation_summary` | Implementor | Tester (coverage notes), Reviewer (risk areas) |

**Typed structures:**

```typescript
interface TestReportInput {
  workspace: string; slug: string;
  passed: number; failed: number; skipped: number;
  issues: Array<{
    test_name: string; file: string; error: string; category?: string;
  }>;
  coverage_gaps: string[];
  risk_areas: string[];
}

interface ReviewInput {
  workspace: string; slug: string;
  verdict: "approved" | "approved_with_concerns" | "changes_required" | "blocked";
  violations: Array<{ principle_id: string; severity: string; file?: string; message: string }>;
  honored: string[];
  scores: { rules: number; opinions: number; conventions: number };
  blocking_issues: string[];
  concerns: string[];
}

interface ImplementationSummaryInput {
  workspace: string; slug: string;
  files_changed: string[];
  tests_written: string[];
  coverage_notes: string;
  risk_areas: string[];
  compliance: Array<{ principle_id: string; status: string; note: string }>;
}
```

**Server-side artifact validation in `report_result`:** Check that required artifacts for the state's agent type exist and are parseable. Missing or malformed required artifacts block the transition. Declare required artifacts per state type in the flow schema via a `required_artifacts` field.

**Workspace directory structure (formalizes handoff paths):**

```
workspace/
├── plans/{slug}/
│   ├── DESIGN.md             # architect design
│   ├── INDEX.md              # task breakdown (write_plan_index)
│   └── {task_id}-PLAN.md     # per-task implementation plan
├── research/
│   └── {dimension}.md        # one file per research dimension
├── artifacts/
│   └── {task_id}-SUMMARY.md  # implementation summaries (write_implementation_summary)
├── reports/
│   ├── TEST-REPORT.md        # structured test report (write_test_report)
│   └── REVIEW.md             # structured review (write_review)
├── handoffs/
│   ├── research-synthesis.md # write_research_synthesis → architect
│   ├── design-brief.md       # write_design_brief → implementor
│   ├── impl-handoff.md       # write_implementation_summary → tester
│   └── test-findings.md      # write_test_report → fixer
└── decisions/{decision}.md
```

Pipeline stage 1 (resolve-context, ADR-006) reads the relevant handoff file for the current state's agent type and injects it into the spawn prompt. Agents do not need to `Read` files to discover prior work — it is pre-injected.

#### Consequences

Positive: eliminates all regex parsing of agent output, agent output format is a code contract not LLM compliance, mandatory artifact validation catches missing outputs before silent downstream failures.

Negative: agents must use tools instead of free-form writing, migration cost for all existing agent `.md` instructions.

#### Dependencies

ADR-002 (typed error contract — validation failures return `INVALID_INPUT`), ADR-004 (`write_plan_index` establishes the pattern; `required_artifacts` field added to state schema), ADR-006 (pipeline injects handoff content at resolve-context stage).

#### Implementation

- Implement `write_test_report`, `write_review`, `write_implementation_summary`, `write_research_synthesis`, `write_design_brief` tools
- Add artifact validation to `report_result`
- Replace `parseReviewArtifact` regex parsing in `effects.ts` with structured read
- Add `required_artifacts` field to `StateDefinitionSchema`
- Add handoff path resolution to prompt pipeline stage 1
- Update tester, reviewer, implementor, researcher, architect agent `.md` files to call structured write tools

---

### ADR-015: Agent Observation

#### Context

Canon records orchestrator-level events in SQLite (ADR-001), but the full reasoning trace of specialist agents is lost. When an implementor makes a surprising design choice or a reviewer misses a violation, there is no way to understand why. The canon-learner (ADR-016) needs agent data to analyze patterns and identify what's working.

Claude Code stores agent transcripts at `~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl` (documented path). Claude Code's hook events (`SubagentStart`, `SubagentStop`) provide lifecycle signals. Canon's MCP boundary provides direct observation of what was sent (spawn prompt) and received (result).

**Previous approach (V1 ADR-015):** Custom JSONL transcript recording infrastructure. This was rebuilding what Claude Code already provides.

#### Decision

Canon observes agents through three documented channels, recorded in the execution store (ADR-001):

1. **Spawn prompt observation** — Canon assembles and sends spawn prompts. Canon records what it sent in `execution_states`. This is canonical: it always reflects exactly what the agent received.

2. **Result observation** — Canon receives `report_result` calls from agents. Canon records the result, timing, and any structured artifacts (ADR-010) in `execution_states`.

3. **Hook-based lifecycle observation** — Canon registers `SubagentStart` and `SubagentStop` hooks to capture agent lifecycle timing. For agent team flows, `TaskCreated` and `TaskCompleted` hooks provide per-task observation. Hook registration happens at the project level (plugin agents cannot register hooks directly; users configure them via `.claude/settings.json`).

For deeper post-mortem analysis, Canon reads transcript files from the documented path (`~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl`). The `get_transcript` MCP tool reads a specific agent's transcript by looking up the agent ID from `execution_states` and reading the documented path.

**What Canon records in `execution_states.transcript_path`:** The documented path to the Claude Code transcript file for this agent run. Canon does not write its own JSONL — it records where Claude Code wrote it.

#### Consequences

Positive: no custom recording infrastructure, full transcript access via documented path, lifecycle observation via documented hooks, spawn prompt recording is 100% reliable (Canon writes it).

Negative: transcript access requires reading files that Claude Code writes (Canon cannot control their format or lifecycle), hook registration requires user-level configuration (plugin restriction).

#### Dependencies

ADR-001 (`transcript_path` stored in `execution_states` table), ADR-003 (diagnostics surface transcript excerpts).

#### Implementation

- Add `transcript_path` column to `execution_states` (already in ADR-001 DDL)
- Implement `get_transcript` MCP tool: looks up `transcript_path`, reads documented Claude Code path
- Update `diagnose` command to include transcript excerpts for failed/stuck states
- Document how users configure `SubagentStart`/`SubagentStop` hooks at project level

---

### ADR-016: Auto-Triggered Learning

#### Context

`canon-learner` is manually invoked via `/canon:learn`. Learning only happens when the user remembers to ask — which is rarely, since the value of learning is long-term and invisible.

#### Decision

Auto-trigger `canon-learner` after flow completion when gating conditions are met. The learner runs as a background job (ADR-007) with restricted tool profile (ADR-014, learner definition). Output goes to a staging area for user review — the learner never modifies principles directly.

The learner can use Claude Code's documented `memory` feature (`memory: project` in agent definition frontmatter) for persistent cross-session context accumulation.

**Gating logic (cheapest checks first):**

```typescript
interface LearnGateConfig {
  enabled: boolean;               // default: true
  min_flows_since_last: number;   // default: 5
  min_hours_since_last: number;   // default: 48
  lock_stale_after_hours: number; // default: 1
}
```

Gate evaluation order:
1. Feature check: auto-learn enabled in `.canon/config`
2. Time gate: hours since last learn > `min_hours_since_last`
3. Scan throttle: if time gate passes but flow gate doesn't, wait 10 minutes before re-checking
4. Flow gate: completed flows since last learn > `min_flows_since_last` (query `flow_runs` table, ADR-001)
5. Lock gate: acquire `.canon/learn.lock` (PID + mtime; stale after 1 hour; rollback mtime on failure)

**Trigger:** After `report_result` on a terminal state, `drive_flow` checks the gate. If passed, includes `{ learn_gate_passed: true }` in the response. The orchestrator spawns the learner as a background agent.

**Learner input:** Spawn prompts + results recorded in `execution_states`, flow execution events from `events` table, drift reports from recent reviews, current principles and conventions.

**Learner output:** Proposed updates written to `.canon/proposed-learnings/{timestamp}/`. Each proposal: observation + proposed change + evidence + confidence level. Types: `principle_update`, `convention_update`, `flow_optimization`.

**Flow state effectiveness analysis:**

The learner analyzes whether each flow state is earning its complexity cost, using ADR-003 metrics as evidence:

| Signal | Metric | Trigger |
|--------|--------|---------|
| Research adds nothing new | Low orientation_ratio post-research | Propose merging or skipping research state |
| Review finds no blockers | blocking_issues count = 0 consistently | Propose relaxing review gate for this tier |
| Fix loops resolve in one cycle | iterations_consumed = 1 in every fix loop | Propose reducing max_iterations |
| Verification always skipped | skip_when predicate true in >80% of executions | Propose removing state from default flow |

The learner does NOT automatically modify flow YAML — it only proposes. Adoption is explicit.

**Inter-cohort complexity audits:**

After each implementation cohort ships, run a complexity audit — learner consuming ADR-003 metrics — to evaluate whether later-cohort ADRs are still justified. Every component encodes assumptions about model limitations; those assumptions become stale as capabilities improve. The audit produces `flow_optimization` proposals for components where evidence suggests complexity is no longer justified.

#### Consequences

Positive: principles and conventions improve automatically over time, learning is consistent, proposals require human approval (no autonomous principle changes), lock prevents concurrent learners.

Negative: background job overhead, learner quality depends on observation quality (ADR-015), proposed learnings may accumulate without review.

#### Dependencies

ADR-001 (`flow_runs` table for gate counting, `events` table for execution data), ADR-007 (background job infrastructure), ADR-014 (learner restricted to read-only tool profile), ADR-015 (spawn prompts + results as primary learning input).

#### Implementation

- Define `LearnGateConfig` in `.canon/config` schema
- Implement gate evaluation functions: time_gate, flow_gate, lock_gate, scan_throttle
- Implement lock file management (acquire, rollback, stale reclaim)
- Add `learn_gate_passed` field to `drive_flow` terminal response
- Create `.canon/proposed-learnings/` directory structure
- Add `/canon:review-learnings` command
- Update `canon-learner` agent to accept execution_states data and produce structured proposals
- Add flow-state effectiveness analysis with per-state signal computation

---

## Adoption Order

| Order | ADR | Rationale |
|-------|-----|-----------|
| 1 | 001 SQLite Store | Foundation — everything reads/writes through this; defines complete schema |
| 2 | 002 Adapters | Low risk, prerequisite for diagnostics instrumentation |
| 3 | 004 Flow Validation | High impact on authoring quality; can parallel with 002 once 001 schema is defined |
| 4 | 003 Diagnostics | Builds on adapter seam (002) + SQLite events (001) |
| 5 | 005 KG Consolidation | Extends 001 to the graph layer |
| 6 | 006 Prompt Pipeline | Needs stable flow schema (004) and SQLite reads (001) |
| 7 | 014 Subagent Definitions | Parallel with 006; creates agent definition files Claude Code will use |
| 8 | 008 Context Assembly | Needs pipeline stages (006) + KG (005) + SQLite (001) |
| 9 | 007 Background Jobs | Prerequisite for 016; KG freshness mitigates stale-context risk from 008 |
| 10 | 009 Server-Side Loop | Needs SQLite state (001), typed errors (002), validated flows (004); centerpiece |
| 11 | 010 Output Contracts | Parallel with 009; needs typed errors (002), validated flow schema (004) |
| 12 | 011 Flow Composition | Parallel with 009, 010; needs load-time validation (004) |
| 13 | 013 Flow Simulation | Parallel with 009, 010, 011; builds on validateFlow (004) |
| 14 | 015 Observation | Parallel with 009; low effort, unblocks 016 |
| 15 | 016 Auto-Learn | After 007 (background jobs) + 015 (observation) + 014 (learner tool restrictions) |
| 16 | 012 Conditional States | After 009 (server driver evaluates conditions) |

**First cohort (foundation):** ADRs 001, 002, 003, 004, 005 — can progress in parallel once 001 schema is defined.

**Second cohort (pipeline):** ADRs 006, 007, 008, 014 — prompt pipeline, context assembly, background jobs, subagent definitions. Mutually reinforcing; develop in parallel.

**Third cohort (execution + contracts):** ADRs 009, 010, 011, 013 — server-side loop, output contracts, flow composition, simulation. ADR-009 is the centerpiece; others extend it.

**Fourth cohort (automation):** ADRs 015, 016, 012 — observation, auto-learn, conditional states. Depend on the full stack being stable.

**ADR disposition summary:**

| ADR | Disposition | Notes |
|-----|-------------|-------|
| 001 SQLite | KEEP | Core Canon — orchestration state |
| 002 Adapters | KEEP | Core Canon — code quality + error contract |
| 003 Diagnostics | KEEP | Core Canon — debuggability and metrics |
| 004 Flow Validation | REWRITTEN | Gains `coordination` field for agent teams (arch-02) |
| 005 KG | KEEP | Core Canon — structural codebase understanding |
| 006 Prompt Pipeline | REWRITTEN | Separates Canon context injection from agent runtime config |
| 007 Background Jobs | KEEP | Core Canon — heavy analysis |
| 008 Context Assembly | KEEP + EXTENDED | Gains background prep mechanism (arch-03) |
| 009 drive_flow | REWRITTEN | Gains TeamRequest variant (arch-02) + single-agent fast path |
| 010 Structured Output | REWRITTEN | Gains Agent SDK structured output as headless alternative |
| 011 Flow Composition | KEEP | Core Canon — flow system |
| 012 Conditional States | KEEP | Core Canon — flow system |
| 013 Flow Simulation | KEEP | Core Canon — flow system |
| 014 Tool Scoping | REWRITTEN as subagent definitions | Read-only agents use `permissionMode: plan`; write-restricted agents use `disallowedTools`; architect uses `planModeRequired: true` for native approval gating |
| 014a Permission Bypass | DROPPED | CC's `permissionMode` frontmatter handles this; no custom implementation |
| 015 Transcripts | REWRITTEN as observation | Uses SubagentStop hooks + documented transcript paths |
| 016 Auto-Learn | KEEP | Core Canon — cross-flow learning |

---

## Decision Summary

- **Canon stays a plugin** (arch-01) — documented stable API surface is rich enough; standalone would require rebuilding all of Claude Code's agent execution infrastructure
- **Couple only to documented APIs** — every Claude Code capability Canon depends on must be traceable to code.claude.com/docs
- **Agent teams for wave execution with fallback** (arch-02) — `drive_flow` returns `TeamRequest` when agent teams are available; `SpawnRequest[]` when not; both modes share Canon's context assembly, principle compliance, and flow gating
- **Agent teams are experimental** — require `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`; fallback path ensures Canon works if removed or changed
- **Single-agent fast path** — ≤3 files + clear instructions = skip the pipeline; one agent does code + test + self-review; handles ~70% of tasks
- **Background prep, not speculative pipelining** (arch-03) — `background: true` agents for KG refresh and reviewer pre-orientation; scribe is non-blocking; no state machine change; real data dependencies make speculative pipelining a bad tradeoff
- **Token optimization** — shared prompt prefix across all agents in a flow (cache hits), principle injection by relevance, agent output forwarding (pipe results into next agent's prompt), cached project snapshot, file affinity pre-injection, item-count budgets
- **SQLite as the single canonical store** — no file projections for orchestration state; agent work-product files remain
- **Shell/git behind adapter boundaries** — typed error contract (`CanonToolError`) at MCP tool boundary
- **Structured local diagnostics** — SQLite events with correlation IDs, per-agent performance metrics (orientation ratio, token usage, duration)
- **Strict flow validation at load time** — SQL-backed stuck detection, explicit wave policy, validated schema for agent-produced INDEX.md via `write_plan_index`
- **Single graph representation** — SQLite KG including summaries migration from JSON to DB-primary
- **Explicit prompt assembly pipeline** — structural escaping, shared cache prefix, principle relevance filtering
- **Context assembly policy** — pre-orient agents via file affinity, KG summaries, topology and conventions variables; item-count budgeting, not token budgeting
- **Background jobs via child processes** — for heavy analysis; synchronous fallback for CI
- **`drive_flow` server-side state machine** — LLM orchestrator reduced to O(hitl_points) calls; continue-vs-spawn for fix loops preserves agent context
- **Structured write tools** for all agent output boundaries — regex parsing eliminated; artifact validation in `report_result`
- **Subagent definitions** using CC frontmatter `tools`/`disallowedTools` — structural role enforcement; definitions reused as agent team teammate roles
- **Flow composition** — `extends` for inheritance, composite fragments, typed ports replacing implicit string-param coupling
- **`skip_when` expression language** + agent-requested flow events via `flow-events` channel with `allowed_insertions` whitelist
- **Reachability analysis** in `validateFlow`; `simulate_flow` tool for deterministic flow dry-runs
- **Agent observation** via spawn prompt recording, result recording, and `SubagentStop` hooks — no custom JSONL recording infrastructure
- **Auto-triggered learning** — gated background consolidation (time + flow count thresholds); proposes principle/convention updates; requires human approval; analyzes flow-state effectiveness
