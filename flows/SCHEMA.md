# Flow Template Schema

Flow templates define agent pipelines as state machines. Each phase is a state, transitions connect them, and loops emerge naturally from cycles in the graph. The orchestrator walks the graph — it doesn't need to understand "loops" as a special concept.

## File Format

YAML frontmatter for structure, markdown body for spawn instructions.

```
---
name: flow-name
description: What this flow does
# ... states, transitions, settings
---

## Spawn Instructions

### state-id
Prompt text for the agent in this state...
```

## Frontmatter Fields

### Top-Level

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Unique flow identifier |
| `description` | string | yes | Human-readable description |
| `tier` | string | no | Default tier this flow maps to (`small`, `medium`, `large`) |
| `entry` | string | no | Starting state (defaults to first state defined) |
| `progress` | string | no | Path to append-only learnings file for cross-iteration context |
| `hitl_default` | string | no | Default HITL behavior: `pause` (default) or `report` |
| `review_threshold` | string | no | Minimum review verdict that triggers fix-violations: `blocking` (default) or `warning`. When set to `warning`, both BLOCKING and WARNING verdicts route to fix-violations instead of only BLOCKING. |

### States

Each key under `states:` is a state ID. State IDs must be lowercase, alphanumeric, with hyphens.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | enum | yes | `single`, `parallel`, `wave`, `parallel-per`, `terminal` |
| `agent` | string | yes* | Agent name (e.g., `canon-researcher`). *Not required for `terminal`. |
| `agents` | list | no | For `parallel` type — list of agent names |
| `roles` | list | no | For `parallel` type — role labels passed to each agent |
| `role` | string | no | For `single` type — role label passed to the agent |
| `template` | string or list | no | Template name(s) the agent must use |
| `transitions` | map | yes* | Map of `condition: target-state`. *Not required for `terminal`. |
| `max_iterations` | int | no | Max times this state can be entered before escalating to HITL |
| `stuck_when` | string | no | Stuck detection strategy (see below) |
| `gate` | string | no | For `wave` type — verification to run between waves |
| `iterate_on` | string | no | For `parallel-per` type — what to fan out on |
| `inject_context` | list | no | Context to inject from prior states or user (see below) |
| `skip_when` | string | no | Pre-check condition — if met, skip the state with `no_items` result (see below) |
| `large_diff_threshold` | int | no | For `single` review states: if the diff exceeds this many lines, the orchestrator fans out parallel reviewers by file cluster instead of running a single reviewer (see Large Diff Review) |

### State Types

**`single`** — One agent, runs once per entry.
```yaml
design:
  type: single
  agent: canon-architect
  transitions:
    done: implement
```

**`parallel`** — Multiple agents run simultaneously. All must complete before transitioning.
```yaml
research:
  type: parallel
  agents: [canon-researcher]
  roles: [codebase, architecture, risk]
  transitions:
    done: design
```
When `agents` has one entry and `roles` has multiple, the agent is spawned once per role.

**Wave resume**: When resuming a `wave` state where `wave_results.{N}.status` is `"in_progress"`, the orchestrator checks which tasks in that wave have completed by looking for their summary artifacts in `plans/{slug}/`. A summary is considered complete if the file exists AND contains a `### Status` heading with a recognized status keyword. If the file exists but lacks this section, treat the task as incomplete and re-spawn it. Tasks with valid summaries are skipped. Only tasks without valid summaries are re-spawned. This prevents re-running completed work within an interrupted wave.

**`wave`** — Iterates over waves from an INDEX.md. Each wave spawns parallel agents in isolated worktrees, with a gate check between waves.
```yaml
implement:
  type: wave
  agent: canon-implementor
  gate: test-suite
  transitions:
    done: test
    blocked: hitl
```

**Wave isolation via worktrees**: Each implementor in a wave runs in its own git worktree to prevent parallel tasks from overwriting each other's file changes. The orchestrator:
1. Creates a temporary worktree per task: `git worktree add .canon/worktrees/{task_id} -b canon-wave/{task_id} HEAD`
2. Spawns each agent with its worktree as the working directory (using `isolation: "worktree"` on the Agent tool)
3. Each implementor commits atomically within its worktree branch
4. After all tasks in the wave complete, the orchestrator merges each worktree branch back into the main working branch sequentially: `git merge --no-ff canon-wave/{task_id} -m "merge: {task_id}"`
5. If a merge produces conflicts, the orchestrator records the conflicting task IDs and transitions to `hitl` with message: "Merge conflict between wave tasks {task_a} and {task_b}. Resolve manually or re-plan wave assignment."
6. After successful merges (or HITL resolution), the orchestrator cleans up: `git worktree remove .canon/worktrees/{task_id}` and `git branch -d canon-wave/{task_id}`
7. The gate check runs after all merges complete

This prevents the silent data loss that occurs when parallel implementors modify overlapping files on the same branch.

**`parallel-per`** — Spawns one agent per item in a dynamic list (e.g., one refactorer per violation group).
```yaml
fix-violations:
  type: parallel-per
  agent: canon-refactorer
  iterate_on: violation_groups
  transitions:
    done: review
```

**`terminal`** — End state. No agent, no transitions. The flow is complete.
```yaml
done:
  type: terminal
```

### iterate_on Data Contract

For `parallel-per` states, `iterate_on` names a data source the orchestrator extracts from the previous state's artifact. The orchestrator reads the artifact and parses it into a list of items. Each item is available in spawn instructions as `${item}` (for strings) or `${item.field}` (for structured items).

**Built-in iterate_on sources:**

| Source | Parsed From | Item Shape |
|--------|-------------|------------|
| `violation_groups` | REVIEW.md `#### Violations` table | `{ principle_id, severity, file_path, detail }` |
| `security_findings` | SECURITY.md `### Findings` section | `{ severity, file_path, detail, category }` |

The orchestrator parses the violations table from the reviewer's REVIEW.md. Each unique `{principle_id, file_path}` pair becomes one item. If the table has multiple violations for the same principle in the same file, they are grouped into one item.

Custom `iterate_on` values can reference any artifact from the prior state. The orchestrator reads the artifact as a markdown table or JSON array and fans out.

**Empty iteration list**: If the iteration list is empty after parsing and filtering (no items, or all items excluded by `cannot_fix`), the state transitions immediately to `done` with result `no_items`. No agents are spawned.

**Result aggregation for `parallel-per`**: When multiple agents run in parallel-per, their individual results are aggregated:
- If **all items** return `done` (including aliases like `fixed`, `partial_fix`): the state transitions to `done`.
- If **some items** return `done` and **some** return `cannot_fix`: the state transitions to `done`. The `cannot_fix` items are recorded in `iterations.{id}.cannot_fix` and excluded from future iterations. The flow continues with the successful fixes.
- If **all items** return `cannot_fix`: the state transitions to `cannot_fix` (typically `hitl`). All items are recorded in `cannot_fix`.
- If **any item** returns `blocked` or fails: the successful items are kept, and the orchestrator transitions to `hitl` with details about the blocked items. On retry, only the failed items are re-spawned.

### Gate Contract

The `gate` field on `wave` states names a verification step run between waves. Gates are shell commands or test suite invocations.

**Built-in gates:**

| Gate | Command | Pass Condition |
|------|---------|----------------|
| `test-suite` | Run the project's test command (auto-detected from `package.json scripts.test`, `Makefile test`, `pytest`, etc.) | Exit code 0 |

If the gate fails, the wave state's result is `blocked` and the orchestrator follows the `blocked` transition. The gate failure output (stderr/stdout) is included in `board.json` under `states.{id}.wave_results.{N}.gate_output`.

Custom gates can be defined as shell commands in the flow frontmatter:
```yaml
gates:
  test-suite: npm test
  lint-check: npm run lint
```

**Pre-gate merge check**: Before running the gate command between waves, the orchestrator runs `git status` to check for uncommitted changes or merge conflicts. If conflicts are detected, the gate is skipped and the wave transitions to `blocked` with reason: "Merge conflict detected between wave tasks. Resolve conflicts before proceeding." This surfaces the real issue instead of showing a confusing test failure from conflicted files.

### Agent Timeouts

Each state type has a default timeout. If an agent does not return within the timeout, the orchestrator treats it as a failure (same as a crash — transitions to `blocked`/`hitl`).

| Agent Role | Default Timeout | Rationale |
|-----------|----------------|-----------|
| `canon-researcher` | 5 minutes | Scoped to one dimension; should complete quickly |
| `canon-architect` | 15 minutes | Produces design + plans; needs time for graph analysis |
| `canon-implementor` | 20 minutes | Writes code + tests; largest working scope |
| `canon-tester` | 10 minutes | Writes integration tests; runs test suite |
| `canon-reviewer` | 10 minutes | Reads diff + principles; no code writing |
| `canon-refactorer` | 10 minutes | Fixes one violation group |
| `canon-security` | 10 minutes | Scans files + runs dependency audit |
| `canon-scribe` | 5 minutes | Classification + surgical edits |

Flows can override the default timeout per state:
```yaml
implement:
  type: wave
  agent: canon-implementor
  timeout: 30m  # Override default 20m for large tasks
```

The orchestrator logs timeouts in `board.json states.{id}.error: "Agent timed out after {N}m"`.

### Agent Failure Handling

When a spawned agent fails (crashes, times out, or returns an error rather than a status):

1. **Single/wave agents**: The orchestrator sets `states.{id}.status` to `blocked`, records the error in `states.{id}.error`, and transitions to `hitl`. The user decides whether to retry or skip.
2. **Parallel agents**: If some agents succeed and others fail, the orchestrator keeps successful results and records failures. If all required agents failed, transition to `hitl`. If optional agents failed, proceed with successful results. All roles are **required** by default. A role is **optional** only if explicitly marked with `optional: true` in the flow's `roles` definition (e.g., `roles: [{ name: risk, optional: true }]`).
3. **Retry**: The orchestrator does not auto-retry agent failures. Retries happen only when the user explicitly requests re-entry from HITL.

### Transitions

Transitions are `condition: target-state` pairs. The orchestrator evaluates conditions based on the agent's output.

**Reserved conditions:**
| Condition | Meaning |
|-----------|---------|
| `done` | Agent completed successfully |
| `hitl` | Pause and present to user. User input re-enters the current state or advances. |
| `blocked` | Agent reported BLOCKED — surface to user |
| `clean` | Review verdict CLEAN |
| `warning` | Review verdict WARNING |
| `blocking` | Review verdict BLOCKING |
| `all_passing` | All tests pass |
| `implementation_issue` | Tester found implementation bug |
| `has_questions` | Agent has open questions for user |
| `critical` | Critical finding requiring user attention |
| `cannot_fix` | Refactorer cannot resolve the issue |
| `needs_context` | Agent missing required template or context — always transitions to `hitl` |

**Status aliases**: Some agent-reported keywords map to existing transition conditions:
| Agent Status | Transition Alias | Notes |
|---|---|---|
| `fixed` | `done` | Refactorer — violation resolved |
| `partial_fix` | `done` | Refactorer — partial fix, remaining items iterate |
| `findings` | `done` | Security — non-critical findings in artifact |
| `done_with_concerns` | `done` | Concern text stored in `board.json concerns[]` |

**Case normalization**: Agents report status keywords in UPPERCASE (e.g., `DONE`). The orchestrator lowercases them before matching to transition conditions (e.g., `done`). Flow templates always define transitions in lowercase.

Custom conditions can be added — the orchestrator matches them against the agent's reported status string (after lowercasing).

**`review_threshold` override**: When `review_threshold: warning` is set at the flow level, the orchestrator overrides the review state's `warning: done` transition to `warning: fix-violations` (or whatever the `blocking` transition targets). This allows projects to opt into automated remediation of strong-opinion violations without modifying the flow template's state definitions. Default: `blocking` (only rule-severity violations trigger fixes).

**Default transition**: If the agent's output contains no recognized status keyword, or if the status keyword has no matching transition in the state's `transitions` map, the orchestrator treats the result as `blocked` and transitions to `hitl`. The raw agent output is recorded in `states.{id}.error` for user review. This prevents the flow from stalling silently when an agent returns an unexpected status.

### Stuck Detection

`stuck_when` strategies:
| Strategy | Meaning |
|----------|---------|
| `same_violations` | Same principle IDs + file paths as previous iteration |
| `same_file_test` | Same file + test pair failing as previous iteration |
| `same_status` | Agent returned identical status as previous iteration |
| `no_progress` | No new commits or artifacts since previous iteration |

When stuck is detected, the state transitions to `hitl` regardless of the normal transition map. The HITL message includes: the stuck strategy that triggered, the current iteration count, and the history entries showing repeated patterns.

#### History Entry Schemas

Each `stuck_when` strategy stores history entries in `iterations.{id}.history` with a defined shape:

| Strategy | History Entry Shape | Stuck When |
|----------|-------------------|------------|
| `same_violations` | `{ principle_ids: [...], file_paths: [...] }` | Current entry's sets are identical to previous entry (set equality — same elements regardless of order) |
| `same_file_test` | `{ pairs: [{ file, test }] }` | Current entry's pairs are a subset of previous entry's pairs |
| `same_status` | `{ status: "..." }` | Current status string is identical to previous |
| `no_progress` | `{ commit_sha: "...", artifact_count: N }` | Same commit SHA and same artifact count as previous |

The orchestrator records one history entry per state entry. Stuck detection compares only the two most recent entries (current vs previous).

### Large Diff Review

When a `single` review state has `large_diff_threshold` set and the diff (`git diff --stat ${base_commit}..HEAD | tail -1`) exceeds that threshold in lines changed, the orchestrator automatically fans out the review:

1. **Group files by directory cluster**: Use the top-level directory of each changed file as the cluster key (e.g., `src/services/`, `src/types/`, `src/handlers/`). Files in the same directory cluster are reviewed together.
2. **Spawn parallel reviewers**: One reviewer per cluster, each receiving only the diff for its file set (`git diff ${base_commit}..HEAD -- {file1} {file2} ...`).
3. **Aggregate verdicts**: Collect all cluster reviews. The final verdict is the most severe across all clusters (BLOCKING > WARNING > CLEAN). Merge all violation tables into a single REVIEW.md.
4. **Proceed normally**: The aggregated review is stored as the state's artifact, and transitions are based on the merged verdict.

If the diff is under the threshold, the state runs normally as a single reviewer.

### Conditional Skip (`skip_when`)

States can define a `skip_when` condition that the orchestrator evaluates before spawning the agent. If the condition is true, the state is skipped with the `done` transition (using the first `done`-like transition: `updated` → `no_updates` → `done`).

**Built-in skip_when conditions:**

| Condition | Check | When to Skip |
|-----------|-------|-------------|
| `no_contract_changes` | Run `git diff --name-only ${before}..HEAD` and check if any changed files match contract patterns: `**/index.ts`, `**/api/**`, `**/routes/**`, `**/types/**`, `**/schema*`, `**/public/**`, `package.json`, `**/migrations/**`. | Skip if all changes are internal (test files, private modules, config). |

If `skip_when` is set and the condition is met, the orchestrator:
1. Logs: `"Skipping {state-id}: {skip_when} condition met"`
2. Sets `states.{id}.status` to `done`, `result` to the first available done-like transition
3. Proceeds to the target state without spawning an agent

This avoids unnecessary agent spawns for states that frequently produce no-op results (e.g., scribe after internal-only changes).

### Context Injection

States can pull context from prior states or from the user mid-flow:

```yaml
design:
  type: single
  agent: canon-architect
  inject_context:
    - from: research
      section: risk
      as: risk_findings
    - from: user
      prompt: "Any architectural constraints?"
      as: user_constraints
```

| Field | Description |
|-------|-------------|
| `from` | Source: a state ID or `user` |
| `section` | Optional — heading name from the state's primary artifact (e.g., `risk` reads `### Risk` from the artifact). If omitted, includes the full artifact. |
| `as` | Variable name available in the spawn instruction via `${variable}` |
| `prompt` | For `from: user` — question to ask |

**Resolution rules:**
- `from: <state-id>`: The orchestrator reads the artifact(s) listed in `board.json` under `states.{id}.artifacts`. If `section` is specified, extracts the content under that heading. The result is included in the spawn instruction as `${as}`.
- `from: user`: The orchestrator pauses and asks the user the `prompt` question. The user's response is available as `${as}`.

**Artifact validation**: When resolving `from: <state-id>`, the orchestrator checks that each artifact path in `states.{id}.artifacts` exists on disk:
- **Some missing**: Log a warning for each missing file and inject only the available artifacts.
- **All missing** and the injected variable is referenced in the spawn instruction: transition to `hitl` with message: "Required context from '{state-id}' is missing — artifacts may have been deleted."
- **Section not found**: If `section:` is specified but the heading does not exist in the artifact, inject the full artifact content with a warning note prepended: "Warning: Section '{section}' not found — injecting full artifact."

### Progress File

When `progress` is set at the top level, the orchestrator:
1. Reads the file at the start of each state (if it exists)
2. Includes its contents in the agent's spawn instruction as `${progress}`
3. After each state completes, the orchestrator appends a one-line summary: `- [{state-id}] {result}: {one-sentence summary from agent output}`

The orchestrator owns the progress file — agents never write to it directly. Progress persists on disk across fresh-context iterations — each agent starts clean but learns from what previous iterations discovered.

## Markdown Body: Spawn Instructions

The markdown body contains `### state-id` sections. Each section is the prompt template for that state's agent.

Variables available in spawn instructions:
| Variable | Source | Available In |
|----------|--------|-------------|
| `${task}` | User's task description from `session.json` | All states |
| `${WORKSPACE}` | Workspace path: `.canon/workspaces/{sanitized-branch}` | All states |
| `${slug}` | Task slug from `session.json` (task description → lowercase, hyphens, truncated) | All states |
| `${CLAUDE_PLUGIN_ROOT}` | Canon plugin install path | All states |
| `${progress}` | Contents of the progress file (if `progress` is set in flow) | All states |
| `${base_commit}` | Git commit SHA at flow initialization (from `board.json`) — use for diff ranges | All states |
| `${role}` | Role label from `roles` list. `roles` (plural) in state definitions lists available roles for parallel spawning. If a state has no `roles` field, the agent is spawned once with no `${role}` variable. | `parallel` states |
| `${task_id}` | Task ID from INDEX.md current wave | `wave` states |
| `${wave_briefing}` | Inter-wave learning briefing extracted from previous wave's summaries (new shared code, patterns established, gotchas). Empty for wave 1. | `wave` states (waves 2+) |
| `${item}` | Current item (string) or `${item.field}` (structured) | `parallel-per` states |
| `${<as>}` | Injected context variable from `inject_context` | States with `inject_context` |

## Tier Mapping

The orchestrator maps tiers to flows via `tier` field or a separate config:

| Tier | Default Flow |
|------|-------------|
| `small` | `quick-fix` |
| `medium` | `feature` |
| `large` | `deep-build` |

Override with `--flow <name>` to use any flow regardless of tier.

## Board: Execution State Tracker

The orchestrator persists its execution state to `${WORKSPACE}/board.json`. This is the single source of truth for where the flow is, what's done, what's in progress, and what's blocked. The orchestrator never tracks state in its context window — it reads and writes the board.

### Why

- **Resumability**: If the orchestrator's context compresses or the session restarts, it reads `board.json` and picks up where it left off.
- **Visibility**: The user can inspect `board.json` at any time to see the flow's status.
- **Clean context**: The orchestrator holds no state in memory. It reads the board, makes one transition, writes the board. Stateless between transitions.

### Schema

```json
{
  "flow": "deep-build",
  "task": "Add order creation endpoint",
  "entry": "research",
  "current_state": "implement",
  "base_commit": "abc123def",
  "started": "ISO-8601",
  "last_updated": "ISO-8601",
  "states": {
    "research": {
      "status": "done",
      "entered_at": "ISO-8601",
      "completed_at": "ISO-8601",
      "entries": 1,
      "result": "done",
      "artifacts": ["research/codebase.md", "research/architecture.md", "research/risk.md"]
    },
    "design": {
      "status": "done",
      "entered_at": "ISO-8601",
      "completed_at": "ISO-8601",
      "entries": 1,
      "result": "done",
      "artifacts": ["plans/add-order/DESIGN.md", "plans/add-order/INDEX.md"]
    },
    "implement": {
      "status": "in_progress",
      "entered_at": "ISO-8601",
      "entries": 1,
      "wave": 2,
      "wave_total": 3,
      "wave_results": {
        "1": { "tasks": ["order-01", "order-02"], "status": "done", "gate": "passed" },
        "2": { "tasks": ["order-03"], "status": "in_progress" }
      }
    },
    "test":           { "status": "pending" },
    "fix-impl":       { "status": "pending" },
    "security":       { "status": "pending" },
    "review":         { "status": "pending" },
    "fix-violations": { "status": "pending" },
    "done":           { "status": "pending" }
  },
  "iterations": {
    "test":           { "count": 0, "max": 2, "history": [] },
    "fix-violations": { "count": 0, "max": 3, "history": [] }
  },
  "blocked": null,
  "concerns": [],
  "skipped": []
}
```

### Field Reference

| Field | Type | Description |
|-------|------|-------------|
| `flow` | string | Name of the flow template being executed |
| `task` | string | User's task description |
| `entry` | string | Starting state of the flow |
| `current_state` | string | State the orchestrator is currently in or about to enter |
| `base_commit` | string | Git commit SHA at flow initialization. Used for diff ranges (`git diff ${base_commit}..HEAD`) and rollback. Recorded by the orchestrator during workspace init. |
| `started` | ISO-8601 | When the flow began |
| `last_updated` | ISO-8601 | Last board write |
| `states` | map | Per-state status and metadata |
| `states.{id}.status` | enum | `pending`, `in_progress`, `done`, `skipped`, `blocked` |
| `states.{id}.entered_at` | ISO-8601 | When the state was first entered |
| `states.{id}.completed_at` | ISO-8601 | When the state completed (if done) |
| `states.{id}.entries` | int | How many times this state has been entered (tracks loops) |
| `states.{id}.result` | string | The condition that triggered the outgoing transition |
| `states.{id}.artifacts` | list | Paths to artifacts produced (latest entry), stored relative to `${WORKSPACE}`. The orchestrator resolves them by prepending the workspace path. Agents should report paths relative to workspace in their output. |
| `states.{id}.artifact_history` | list | For looping states: `[{ entry: 1, artifacts: [...] }, ...]`. Preserves artifacts from all iterations, not just the latest. The current `artifacts` field is always the latest snapshot; `artifact_history` provides the full audit trail. |
| `states.{id}.wave` | int | Current wave (for `wave` type states) |
| `states.{id}.wave_total` | int | Total waves (for `wave` type states) |
| `states.{id}.wave_results` | map | Per-wave results (for `wave` type states) |
| `states.{id}.wave_results.{N}.gate_output` | string | Gate failure output (stderr/stdout) if gate failed |
| `states.{id}.error` | string | Error message if agent crashed or timed out |
| `states.{id}.metrics` | object | `{ duration_ms, spawns, model }` — performance metrics for the state (see Cost Observability) |
| `iterations` | map | Per-state loop tracking for states with `max_iterations` |
| `iterations.{id}.count` | int | How many times this state has been entered |
| `iterations.{id}.max` | int | Max iterations from the flow template |
| `iterations.{id}.history` | list | Previous results — entries shaped by `stuck_when` strategy (see History Entry Schemas) |
| `iterations.{id}.cannot_fix` | list | `{principle_id, file_path}` pairs excluded from future `parallel-per` fan-out |
| `blocked` | object or null | If non-null: `{ "state": "...", "reason": "...", "since": "ISO-8601" }` |
| `concerns` | list | Accumulated DONE_WITH_CONCERNS messages. Each entry: `{ state_id: string, agent: string, message: string, timestamp: ISO-8601 }`. Concerns are presented to the user in the final build summary. |
| `skipped` | list | State IDs skipped due to `--skip-*` flags |

### Orchestrator Board Protocol

The orchestrator follows this protocol at every state transition:

1. **Read** `board.json`
2. **Determine** the current state and what to do
3. **Update** `current_state` and `states.{id}.status` to `in_progress`
4. **Write** `board.json`
5. **Execute** the state (spawn agent(s))
6. **Read** the agent's result
7. **Update** the board:
   - If agent succeeded: set `states.{id}.status` to `done`, set `result` to matched transition condition, record `artifacts` and `completed_at`
   - If agent failed: set `states.{id}.status` to `blocked`, record `error`, transition to `hitl`
   - Update `iterations.{id}` if applicable (increment count, append history entry matching `stuck_when` schema)
   - Set `current_state` to the target state from the transition
   - Check stuck detection: compare latest two `iterations.{id}.history` entries
8. **Write** `board.json`
9. **Proceed** to next state (go to step 1)

On startup, if `board.json` already exists and `current_state` is not `done`:
- **Resume**: Read the board. If `current_state` has status `in_progress`, the previous execution was interrupted. Re-enter that state.
- **Skip completed**: States with status `done` are not re-entered.

### Board Initialization

When starting a new flow, initialize `board.json` with:
- All states from the flow template set to `pending`
- `current_state` set to `entry` (or first state)
- `iterations` populated from states that have `max_iterations`
- `blocked`, `concerns`, `skipped` empty

## Example

See `flows/deep-build.md` for a complete example.
