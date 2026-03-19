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

**`wave`** — Iterates over waves from an INDEX.md. Each wave spawns parallel agents, with a gate check between waves.
```yaml
implement:
  type: wave
  agent: canon-implementor
  gate: test-suite
  transitions:
    done: test
    blocked: hitl
```

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

Custom conditions can be added — the orchestrator matches them against the agent's reported status string.

### Stuck Detection

`stuck_when` strategies:
| Strategy | Meaning |
|----------|---------|
| `same_violations` | Same principle IDs + file paths as previous iteration |
| `same_file_test` | Same file + test pair failing as previous iteration |
| `same_status` | Agent returned identical status as previous iteration |
| `no_progress` | No new commits or artifacts since previous iteration |

When stuck is detected, the state transitions to `hitl` regardless of the normal transition map.

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
| `section` | Optional — specific section/artifact from that state's output |
| `as` | Variable name available in the spawn instruction via `${variable}` |
| `prompt` | For `from: user` — question to ask |

### Progress File

When `progress` is set at the top level, the orchestrator:
1. Reads the file at the start of each state-machine cycle
2. Includes its contents as context for each agent spawn
3. After each cycle, appends a summary of what happened (what worked, what failed, what was learned)

Progress persists on disk across fresh-context iterations — each agent starts clean but learns from what previous iterations discovered.

## Markdown Body: Spawn Instructions

The markdown body contains `### state-id` sections. Each section is the prompt template for that state's agent.

Variables available in spawn instructions:
| Variable | Source |
|----------|--------|
| `${task}` | The user's task description |
| `${WORKSPACE}` | Workspace path |
| `${slug}` | Task slug |
| `${role}` | Agent's role (for parallel states) |
| `${task_id}` | Task ID (for wave states) |
| `${CLAUDE_PLUGIN_ROOT}` | Plugin root path |
| `${item}` | Current item (for parallel-per states) |
| `${progress}` | Contents of the progress file |
| Any `as:` variable from `inject_context` |

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
| `started` | ISO-8601 | When the flow began |
| `last_updated` | ISO-8601 | Last board write |
| `states` | map | Per-state status and metadata |
| `states.{id}.status` | enum | `pending`, `in_progress`, `done`, `skipped`, `blocked` |
| `states.{id}.entered_at` | ISO-8601 | When the state was first entered |
| `states.{id}.completed_at` | ISO-8601 | When the state completed (if done) |
| `states.{id}.entries` | int | How many times this state has been entered (tracks loops) |
| `states.{id}.result` | string | The condition that triggered the outgoing transition |
| `states.{id}.artifacts` | list | Paths to artifacts produced (relative to `${WORKSPACE}`) |
| `states.{id}.wave` | int | Current wave (for `wave` type states) |
| `states.{id}.wave_total` | int | Total waves (for `wave` type states) |
| `states.{id}.wave_results` | map | Per-wave results (for `wave` type states) |
| `iterations` | map | Per-state loop tracking for states with `max_iterations` |
| `iterations.{id}.count` | int | How many times this state has been entered |
| `iterations.{id}.max` | int | Max iterations from the flow template |
| `iterations.{id}.history` | list | Previous results — used for stuck detection |
| `blocked` | object or null | If non-null: `{ "state": "...", "reason": "...", "since": "ISO-8601" }` |
| `concerns` | list | Accumulated DONE_WITH_CONCERNS messages |
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
   - Set `states.{id}.status` to `done` (or `blocked`)
   - Set `states.{id}.result` to the matched transition condition
   - Record `artifacts`, `completed_at`
   - Update `iterations.{id}` if applicable
   - Set `current_state` to the target state from the transition
   - Check stuck detection against `iterations.{id}.history`
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
