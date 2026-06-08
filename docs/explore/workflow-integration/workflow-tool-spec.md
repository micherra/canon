<!-- Persisted from .canon/history/fresh-architect-review-of-claude-code-workflow-tool — explore flow 2026-06-07; competition: 3 proposals, 3 judges, synthesis ratified at HITL -->
# Claude Code `Workflow` Tool — Authoritative Capability Spec

> Source: verbatim-faithful transcription of the Workflow tool definition from the
> Claude Code harness (Opus 4.8 session, 2026-06-07), prepared by the orchestrator
> as research input. Agents cannot see harness tool schemas directly — treat this
> file as the authoritative reference for what the Workflow tool can do.

## What it is

`Workflow` executes a self-contained **plain JavaScript orchestration script** that
spawns and coordinates subagents deterministically. Control flow (loops,
conditionals, fan-out) is encoded in code, not model-driven. Use for multi-step
orchestration where control flow should be deterministic.

Runtime properties:

- **Runs in the background** — the tool returns immediately with a task ID and a
  `runId`; a `<task-notification>` arrives on completion. `/workflows` shows live
  progress to the user.
- **Sandboxed JS** — standard built-ins (JSON, Math, Array, ...) available, but NO
  filesystem access, NO Node.js APIs. `Date.now()`, `Math.random()`, and argless
  `new Date()` **throw** (they would break deterministic resume). Pass timestamps
  in via `args`; vary prompts by index instead of randomness.
- **Plain JavaScript, NOT TypeScript** — type annotations, interfaces, generics
  fail to parse. Script body runs in an async context (use `await` directly).
- **Journaled** — every `agent()` call's result is recorded, enabling
  prefix-cached resume (see Resume).
- **Opt-in only** — the orchestrator may only invoke Workflow when the user has
  explicitly opted into multi-agent orchestration (keyword "ultracode", session
  ultracode toggle, user asks for a workflow/orchestration in their own words, a
  skill instructs it, or the user invokes a named/saved workflow).

## Invocation parameters

- `script` — inline script (max 512KB). Every invocation automatically persists
  its script to a file under the session directory and returns the path in the
  tool result.
- `scriptPath` — path to a script file on disk; takes precedence over `script` and
  `name`. To iterate on a workflow: edit the persisted file with Write/Edit and
  re-invoke with `{scriptPath}` instead of resending the script.
- `name` — name of a predefined workflow (built-in or from `.claude/workflows/`).
  Saved workflows are parameterized via `args`.
- `args` — arbitrary JSON value exposed to the script as the global `args`,
  verbatim. MUST be passed as real JSON values (arrays as arrays), not stringified.
- `resumeFromRunId` — run ID of a prior invocation to resume from (same-session
  only; stop the prior run first via TaskStop).

## Script structure

Every script must begin with a `meta` export that is a PURE LITERAL (no variables,
function calls, spreads, or template interpolation):

```js
export const meta = {
  name: 'find-flaky-tests',                       // required
  description: 'Find flaky tests and propose fixes', // required, shown in permission dialog
  whenToUse: '...',                                // optional, shown in workflow list
  phases: [                                        // optional, one entry per phase() call
    { title: 'Scan', detail: 'grep test logs for retries' },
    { title: 'Fix', detail: 'one agent per flaky test', model: 'haiku' }, // model = display note for phase override
  ],
}
// script body — async context
```

Phase titles in `meta.phases` are matched EXACTLY against `phase()` calls; a
`phase()` call with no matching meta entry gets its own progress group. The
script's `return` value becomes the tool result the orchestrator reads.

## Primitives (script-body globals)

### `agent(prompt, opts?) → Promise<any>`

Spawn a subagent.

- Without `schema`: returns the agent's final text as a string. Subagents are told
  their final text IS the return value (raw data, not a human-facing message).
- `opts.schema` (JSON Schema object): the subagent is forced to call a
  StructuredOutput tool; `agent()` returns the validated object — no parsing.
  Validation happens at the tool-call layer so the model retries on mismatch.
- `opts.label` — display label override.
- `opts.phase` — explicitly assign this agent to a progress group. Use inside
  `pipeline()`/`parallel()` stages to avoid races on the global `phase()` state.
- `opts.model` — 'sonnet' | 'opus' | 'haiku' override. Default: omit — the agent
  inherits the main-loop session model. Only set when highly confident a
  different tier fits.
- `opts.isolation: 'worktree'` — fresh git worktree per agent. EXPENSIVE
  (~200–500ms setup + disk each); use ONLY when agents mutate files in parallel
  and would otherwise conflict. Worktree auto-removed if unchanged.
  (NOTE for Canon: the Agent tool's worktree isolation auto-merges to the calling
  branch on completion — it bypasses Canon's controlled merge lifecycle. Canon
  CLAUDE.md prohibits `isolation: "worktree"` for code-writing agents; Canon owns
  the worktree.)
- `opts.agentType` — use a custom subagent type (e.g. 'Explore', 'canon:reviewer',
  'canon:engineer') instead of the default workflow subagent. Resolved from the
  SAME registry as the Agent tool. Composes with `schema` (the custom agent's
  system prompt gets a StructuredOutput instruction appended).
- Returns `null` (never throws to the script) if the user skips the agent mid-run
  or the subagent dies on a terminal API error after retries. Idiom:
  `.filter(Boolean)`.

### `pipeline(items, stage1, stage2, ...) → Promise<any[]>`

Run each item through all stages independently with NO barrier between stages —
item A can be in stage 3 while item B is still in stage 1. This is the DEFAULT for
multi-stage work. Wall-clock = slowest single-item chain, not sum-of-slowest-per-
stage. Every stage callback receives `(prevResult, originalItem, index)`. A stage
that throws drops that item to `null` and skips its remaining stages.

### `parallel(thunks: Array<() => Promise<any>>) → Promise<any[]>`

Run tasks concurrently. This is a BARRIER: awaits all thunks before returning. A
thunk that throws (or whose agent errors) resolves to `null` in the result array —
the call itself never rejects (`.filter(Boolean)` before use).

Barrier-choice discipline (verbatim guidance): a barrier is correct ONLY when
stage N needs cross-item context from ALL of stage N−1 — dedup/merge across the
full result set, early-exit on aggregate count, prompts referencing "the other
findings". NOT justified by "flatten/map/filter first" (do it inside a pipeline
stage), "conceptually separate stages", or cleanliness. Smell test:
`await parallel(...)` → pure transform → `await parallel(...)` means the middle
transform didn't need the barrier. When in doubt: pipeline.

### `workflow(nameOrRef, args?) → Promise<any>`

Run another workflow inline as a sub-step and return its return value. Pass a name
(saved-workflow registry) or `{scriptPath}`. The child SHARES this run's
concurrency cap, agent counter, abort signal, and token budget — its agents appear
under a "▸ name" group; its tokens count toward `budget.spent()`. **Nesting is one
level only** — `workflow()` inside a child throws. Throws on unknown name /
unreadable scriptPath / child syntax error.

### `budget`

`{total: number|null, spent(): number, remaining(): number}` — the turn's token
target from a user "+500k"-style directive. `spent()` counts output tokens this
turn across the main loop AND all workflows (shared pool). The target is a HARD
ceiling: once `spent()` reaches `total`, further `agent()` calls THROW. With no
target, `remaining()` is `Infinity` — guard loops with `budget.total &&`.
Patterns: dynamic loop `while (budget.total && budget.remaining() > 50_000)`;
static scaling `const FLEET = budget.total ? Math.floor(budget.total/100_000) : 5`.

### `phase(title)` / `log(message)`

`phase()` starts a new progress group for subsequent `agent()` calls. `log()`
emits a narrator line above the progress tree. **No-silent-caps rule**: if a
workflow bounds coverage (top-N, no-retry, sampling), `log()` what was dropped.

### `args`

The Workflow call's `args` value, verbatim (undefined if not provided).

## Limits & execution semantics

| Constraint | Value |
|---|---|
| Concurrent `agent()` calls per workflow | min(16, cpu cores − 2); excess queue and run as slots free |
| Lifetime agent cap per workflow | 1,000 (runaway backstop) |
| Items per single `pipeline()`/`parallel()` call | 4,096 (explicit error beyond — never silent truncation) |
| `workflow()` nesting | 1 level |
| Script size | 512KB |

Workflow agents can reach ALL session-connected MCP tools via ToolSearch — schemas
load on demand per agent. Caveat: interactively-authenticated MCP servers may be
absent in headless/cron runs.

## Resume

Tool result includes a `runId`. To resume after a pause, kill, or script edit:
relaunch with `{scriptPath, resumeFromRunId}`. The **longest unchanged prefix** of
`agent()` calls — matched on exact (prompt, opts) — returns cached results
instantly; the first edited/new call and everything after runs live. Same script +
same args → 100% cache hit. This is WHY nondeterminism is banned in scripts:
`Date.now()` in a prompt would change on replay and invalidate the cache from that
point. Fallback when no journal is available: read `agent-<id>.jsonl` files in the
transcript directory and hand-author a continuation script.

## Canonical patterns (from the tool spec)

1. **Pipeline-default multi-stage** (review→verify with no wasted wall-clock):
```js
const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, {label: `review:${d.key}`, phase: 'Review', schema: FINDINGS_SCHEMA}),
  review => parallel(review.findings.map(f => () =>
    agent(`Adversarially verify: ${f.title}`, {label: `verify:${f.file}`, phase: 'Verify', schema: VERDICT_SCHEMA})
      .then(v => ({...f, verdict: v}))
  ))
)
const confirmed = results.flat().filter(Boolean).filter(f => f.verdict?.isReal)
```
2. **Justified barrier** — dedup across ALL findings before expensive verification.
3. **Loop-until-count** — accumulate to a target N.
4. **Loop-until-budget** — scale depth to the user's token directive.
5. **Loop-until-dry** — for unknown-size discovery, keep spawning finder rounds
   until K consecutive rounds return nothing new. Convergence subtlety: dedup vs
   ALL SEEN findings, not vs confirmed — else judge-rejected findings reappear
   every round and it never converges.
6. **Adversarial verify** — N independent skeptics per finding, each prompted to
   REFUTE ("default to refuted=true if uncertain"); kill if ≥majority refute.
7. **Perspective-diverse verify** — distinct lenses (correctness/security/repro)
   instead of N identical refuters when a finding can fail multiple ways.
8. **Judge panel** — N independent attempts from different angles, parallel
   judges score, synthesize from winner + graft runner-up ideas.
9. **Multi-modal sweep** — parallel agents each searching a different way
   (by-container, by-content, by-entity, by-time), blind to each other.
10. **Completeness critic** — final agent asking "what's missing?"; output seeds
    the next round.

Scale to the ask: quick check → few finders, single-vote verify; "thoroughly
audit" → larger pool, 3–5-vote adversarial pass, synthesis stage. Compose novel
harnesses when the task calls for it (tournament brackets, self-repair loops,
staged escalation).

## Orchestrator-level usage idioms (from the tool spec)

- **Hybrid scouting**: scout inline first (list files, scope the diff) to discover
  the work-list, then call Workflow to pipeline over it.
- **Phase-per-workflow**: for multi-phase work (understand → design → implement →
  review), run several workflows in sequence — read each result before deciding
  the next phase; the orchestrator stays in the loop between fan-outs.
- Common single-phase workflow shapes: Understand (parallel readers → structured
  map), Design (judge panel of N approaches → scored synthesis), Review
  (dimensions → find → adversarially verify), Research (multi-modal sweep →
  deep-read → synthesize), Migrate (discover sites → transform each with worktree
  isolation → verify).

## Related harness facts relevant to integration design

- The `Agent` tool (subagent spawn) shares the same agent-type registry as
  Workflow's `agentType`. Agent supports `name` + SendMessage continuation,
  `run_in_background`, `team_name`, and `isolation: 'worktree'` (auto-merge
  semantics — see Canon prohibition above).
- Agent teams (TeamCreate/TaskCreate/SendMessage) are a separate, experimental
  primitive gated by CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS (currently enabled in
  this environment). Canon's DAG execution protocol currently uses them.
- ScheduleWakeup / CronCreate exist for self-pacing loops and scheduled runs
  (relevant to background-maintenance ideas, not core build orchestration).
- There is NO mid-run HITL primitive inside a Workflow: the user can skip agents
  from /workflows, and the orchestrator can TaskStop the run, but a script cannot
  pause to ask the user a question. HITL must live at workflow boundaries
  (sequential invocations) — consistent with Canon's decided segment-at-gates
  design.
