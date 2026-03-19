---
description: Full principle-driven development workflow — selects and runs a flow template
argument-hint: <task description> [--flow <name>] [--skip-research] [--skip-tests] [--skip-security] [--plan-only] [--review-only] [--wave N] [--tier small|medium|large]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent]
model: opus
---

Canon build orchestrator. Classifies the task, selects a flow template, and executes it as a state machine. **The orchestrator is a flow runner — all pipeline logic lives in flow templates.**

You are a **thin orchestrator**. You spawn agents, pass context between them, and walk the state machine. You never do heavy work yourself. Stay under 30-40% context usage.

## Orchestrator Rules

- Read paths and metadata only. Never load file contents into your own context.
- Each agent spawn passes specific file paths to read, not raw content.
- Read summaries from agents, not full outputs.
- If any agent reports BLOCKED, surface it to the user and wait for input.
- If any agent reports DONE_WITH_CONCERNS, flag it in the final report.

## Parse Flags

From ${ARGUMENTS}, extract:
- **Task description**: Everything that's not a flag
- `--flow <name>`: Use a specific flow template (overrides tier selection)
- `--skip-research`: Skip states with research agents
- `--skip-tests`: Skip states with tester agents
- `--skip-security`: Skip states with security agents
- `--plan-only`: Stop after the design state completes
- `--review-only`: Use the `review-only` flow
- `--wave N`: Resume wave execution from wave N
- `--tier small|medium|large`: Override automatic tier classification

## Setup

Initialize the branch workspace and create the artifact directory:
```bash
# Sanitize branch name for folder use
BRANCH=$(git branch --show-current)
SANITIZED_BRANCH=$(echo "${BRANCH}" | tr '[:upper:]' '[:lower:]' | sed 's|/|--|g' | sed 's/ /-/g' | sed 's/[^a-z0-9-]//g' | head -c 80)
WORKSPACE=".canon/workspaces/${SANITIZED_BRANCH}"

# Create workspace structure
mkdir -p "${WORKSPACE}/research" "${WORKSPACE}/decisions" "${WORKSPACE}/plans" "${WORKSPACE}/reviews" "${WORKSPACE}/notes"

# Create task slug for plan artifacts
TASK_SLUG=$(echo "${task_description}" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | sed 's/[^a-z0-9-]//g' | head -c 50)
mkdir -p "${WORKSPACE}/plans/${TASK_SLUG}/research"
```

Initialize `session.json` if it doesn't exist:
```json
{
  "branch": "{BRANCH}",
  "sanitized": "{SANITIZED_BRANCH}",
  "created": "{ISO-8601 timestamp}",
  "task": "{task_description}",
  "tier": "{tier}",
  "flow": "{flow_name}",
  "status": "active"
}
```

## Flow Selection

### Step 1: Classify the task tier

If `--tier` was passed, use that. If `--flow` was passed, skip classification. Otherwise, classify:

| Signal | Small | Medium | Large |
|--------|-------|--------|-------|
| Files likely touched | 1-3 | 4-10 | 10+ |
| Architectural decisions | None — approach is obvious | 1-2 choices | Multiple approaches, tradeoffs |
| New modules/services | No | Maybe 1 | Yes, new boundaries |
| External APIs/integrations | No | Existing ones | New ones to research |
| Keywords in description | "fix", "add field", "rename", "update" | "add feature", "implement", "refactor" | "build system", "redesign", "migrate", "new service" |

### Step 2: Select the flow

| Source | Flow |
|--------|------|
| `--flow <name>` | Load `${CLAUDE_PLUGIN_ROOT}/flows/<name>.md` |
| `--review-only` | Load `${CLAUDE_PLUGIN_ROOT}/flows/review-only.md` |
| Tier: small | Load `${CLAUDE_PLUGIN_ROOT}/flows/quick-fix.md` |
| Tier: medium | Load `${CLAUDE_PLUGIN_ROOT}/flows/feature.md` |
| Tier: large | Load `${CLAUDE_PLUGIN_ROOT}/flows/deep-build.md` |

Announce: "Classified as **{tier}** — running flow **{flow_name}**. Override with `--flow <name>` or `--tier <tier>`."

### Step 3: Load the flow template

Read the selected flow file. Parse:
1. **YAML frontmatter** — states, transitions, settings
2. **Markdown body** — spawn instructions per state (under `### state-id` headings)

### Step 4: Initialize or resume the board

Check if `${WORKSPACE}/board.json` exists:

**If it does NOT exist** (new flow): Initialize the board:
1. Create a state entry for each state in the flow, all set to `pending`
2. Set `current_state` to `entry` (or first state)
3. Populate `iterations` from states that have `max_iterations`
4. Write `board.json`

**If it DOES exist** (resuming): Read the board:
1. If `current_state` has status `in_progress`, the previous execution was interrupted — re-enter that state
2. Skip all states with status `done`
3. Announce: "Resuming flow **{flow_name}** from state **{current_state}**."

## Flow Execution

Execute the flow by walking the state machine. The board is the single source of truth — never track state in your context window.

### Transition loop

Repeat until `current_state` is `terminal`:

1. **Read** `board.json`
2. **Check skip flags**: If `current_state`'s agent matches a `--skip-*` flag, mark state as `skipped`, add to `skipped` list, follow the `done` transition, write board, continue
3. **Update board**: Set `states.{current}.status` = `in_progress`, set `entered_at`, increment `entries`. Write `board.json`.
4. **Execute the state** (see state execution below)
5. **Read** the agent's result (status string, artifacts produced)
6. **Evaluate transition**: Match result against the state's `transitions` map. First match wins.
7. **Check stuck detection**: If the state has `stuck_when` + `max_iterations`, compare result against `iterations.{id}.history`. If stuck, override transition to `hitl`.
8. **Update board**: Set `states.{current}.status` = `done`, record `result`, `completed_at`, `artifacts`. Update `iterations.{id}` if applicable. Set `current_state` to target state. Write `board.json`.
9. **Continue** to step 1

### State execution

For each state, based on its `type`:

**`single`**: Spawn the agent with the spawn instruction from the markdown body. Substitute variables (`${task}`, `${WORKSPACE}`, `${slug}`, `${role}`, etc.). Wait for completion. Read the agent's status.

**`parallel`**: Spawn one agent per role (or per entry in `agents`). Wait for all to complete. If all succeed, result is `done`.

**`wave`**: Read `${WORKSPACE}/plans/${slug}/INDEX.md` for the wave breakdown. If `--wave N` was passed, skip waves 1 through N-1 (they should already be `done` in `wave_results`). For each wave:
- Update `board.json` with current wave number (`states.{id}.wave`)
- Spawn one agent per task in that wave (parallel within wave), substituting `${task_id}` for each
- Wait for all to complete. Update `wave_results.{N}` in board with task list and status.
- Run the gate: resolve the gate name from the flow's `gates` map (or use built-in `test-suite`). If gate fails, record `gate_output` in `wave_results.{N}` and set result to `blocked`. If gate passes, proceed to next wave.
- After all waves complete and pass gates, result is `done`.

**`parallel-per`**: Resolve `iterate_on` — read the source artifact from the previous state's `artifacts` in `board.json` and parse items (see SCHEMA.md iterate_on data contract). Exclude items in `iterations.{id}.cannot_fix`. Spawn one agent per remaining item, substituting `${item}` / `${item.field}`. Wait for all. If all succeed, result is `done`. If any return `cannot_fix`, record in `iterations.{id}.cannot_fix` and check if any items remain.

**`terminal`**: Flow is complete. Proceed to post-flow.

### HITL handling

When a transition targets `hitl`:
1. Update board: set `blocked` to `{ "state": "{id}", "reason": "{agent output}", "since": "ISO-8601" }`
2. Write `board.json`
3. Present to the user:
   - The state that triggered HITL and why (agent blocked, stuck detection, max iterations, cannot_fix, agent failure)
   - The agent's output or error message
   - If stuck: the stuck strategy, iteration count, and what's repeating (from `iterations.{id}.history`)
   - If cannot_fix: the list of violations that can't be auto-fixed
   - Remaining options: retry the state, skip it, or provide guidance
4. Wait for user input
5. Clear `blocked` in board
6. Re-enter the current state with user input as injected context, OR advance to the next state if user says to proceed

### Skip flags

When `--skip-*` flags are active, skip states whose agent matches:
- `--skip-research`: skip states with `canon-researcher`
- `--skip-tests`: skip states with `canon-tester`
- `--skip-security`: skip states with `canon-security`

Mark skipped states in the board as `skipped` and add to the `skipped` list. Follow their `done` transition immediately.

### Progress file

If the flow has a `progress` field:
1. Read the progress file at the start of each state (if it exists)
2. Include its contents in the agent's spawn instruction as `${progress}`
3. After each state completes, append a one-line summary of what happened

### Plan-only mode

If `--plan-only`: after the first state with `agent: canon-architect` completes, present the design artifacts to the user and stop. Update the board: mark the architect state as `done`, set `current_state` to it, and do not proceed to the next transition.

## Post-Flow

After the state machine reaches `terminal`:

### Update board

Set the terminal state's status to `done`, `completed_at` = now. Write final `board.json`.

### Log

If the flow included a reviewer state (any state with `agent: canon-reviewer`), log results for drift tracking using the `report` MCP tool (type=review). Read the reviewer's artifact from `board.json` under `states.{reviewer-state}.artifacts` and extract:
- `files`: The list of files that were reviewed
- `violations`: Each violation's `principle_id` and `severity`
- `honored`: IDs of principles that were honored
- `score`: The pass/total counts for rules, opinions, and conventions
- `verdict`: The verdict from the review header

If no reviewer state exists in the flow, skip this step.

### Summary

Present a final summary to the user. Read `board.json` to generate it — do not reconstruct from memory:
- Flow used and tier classification
- What was built (from `task` in board)
- States visited and iterations (walk all `states` in board — report `entries` counts, `wave_results` for wave states)
- Any states that were skipped (from `skipped` list)
- Any concerns flagged (from `concerns` list)
- Review verdict and results (if a reviewer state produced artifacts)
- Security findings (if a security state produced artifacts)
- Links to all artifacts (collect `artifacts` from all `states.{id}`)
- Link to the workspace: `${WORKSPACE}/`
- Link to the board: `${WORKSPACE}/board.json`

At the end of the summary, include: "Tip: Run `/canon:learn` periodically to discover codebase patterns and refine principles based on review data. Run `/canon:clean` when this branch is merged to archive workspace artifacts."
