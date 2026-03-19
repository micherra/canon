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

## Flow Execution

Execute the flow as a state machine. Start at the `entry` state (or the first state defined).

### State execution

For each state, based on its `type`:

**`single`**: Spawn the agent with the spawn instruction from the markdown body. Substitute variables (`${task}`, `${WORKSPACE}`, `${slug}`, `${role}`, etc.). Wait for completion. Read the agent's status. Match status to a transition condition. Move to the target state.

**`parallel`**: Spawn one agent per role (or per entry in `agents`). Wait for all to complete. If all succeed, follow the `done` transition.

**`wave`**: Read INDEX.md. For each wave, spawn one agent per task in that wave (parallel within wave). Between waves, run the `gate` check (e.g., test suite). If gate fails, transition to `blocked`. If all waves complete, transition to `done`.

**`parallel-per`**: Read the `iterate_on` data from the previous state's output. Spawn one agent per item. Wait for all. If all succeed, follow `done`.

**`terminal`**: Flow is complete. Proceed to logging and summary.

### Transition evaluation

After each state completes, evaluate transitions in order:
1. Check the agent's reported status against transition conditions
2. First matching condition determines the target state
3. If no condition matches, treat as an error and surface to user

### HITL handling

When a transition targets `hitl`:
- Present the agent's output/concerns to the user
- Wait for user input
- Re-enter the current state with user input as injected context, OR advance to the next state if user says to proceed

### Stuck detection

If a state has `stuck_when` and `max_iterations`:
- Track entries to this state and the condition data (violations, file+test pairs, etc.)
- If the stuck condition is met, override the normal transition and go to `hitl`
- Include iteration count and what's stuck in the HITL message

### Skip flags

When `--skip-*` flags are active, skip states whose agent matches:
- `--skip-research`: skip states with `canon-researcher`
- `--skip-tests`: skip states with `canon-tester`
- `--skip-security`: skip states with `canon-security`

Skipped states follow their `done` transition immediately.

### Progress file

If the flow has a `progress` field:
1. Read the progress file at the start of each state (if it exists)
2. Include its contents in the agent's spawn instruction as `${progress}`
3. After each state completes, append a one-line summary of what happened

### Plan-only mode

If `--plan-only`: after the design state completes, present the design and plan index to the user and stop. Do not enter the implement state.

## Post-Flow

After the state machine reaches `terminal`:

### Log

Log the review results for drift tracking using the `report` MCP tool (type=review). Extract from `${WORKSPACE}/plans/{slug}/REVIEW.md`:
- `files`: The list of files that were reviewed
- `violations`: Each violation's `principle_id` and `severity`
- `honored`: IDs of principles that were honored
- `score`: The pass/total counts for rules, opinions, and conventions
- `verdict`: The verdict from the review header

### Summary

Present a final summary to the user:
- Flow used and tier classification
- What was built
- States visited and iterations (if any loops occurred)
- Which Canon principles were applied
- Any concerns or issues flagged
- Security findings (if any)
- Review verdict and results
- Links to all artifacts in `${WORKSPACE}/plans/{slug}/`
- Link to the workspace: `${WORKSPACE}/`

At the end of the summary, include: "Tip: Run `/canon:learn` periodically to discover codebase patterns and refine principles based on review data. Run `/canon:clean` when this branch is merged to archive workspace artifacts."
