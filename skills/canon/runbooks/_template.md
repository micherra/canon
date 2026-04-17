---
name: template-example
description: One-line purpose of this flow
tier: medium  # small | medium | large

steps:
  - id: research          # Unique within runbook. Matches legacy state name.
    agent: canon-researcher
    dispatch: subagent     # subagent | team
    mcp_tools:             # MCP tools the lead calls BEFORE spawning
      - get_principles
      - get_file_context
    artifacts:             # Expected output paths (relative to workspace)
      - "research/synthesis.md"
    hitl: none             # none | approval | checkpoint | on_failure

  - id: implement
    agent: canon-engineer
    dispatch: team          # Agent team for parallel wave execution
    mcp_tools:
      - get_principles
      - get_file_context
    artifacts:
      - "plans/${slug}/${task_id}-SUMMARY.md"
    hitl: none
---

# {Flow Name} Runbook

## Overview

One paragraph describing when this flow is used, what it produces, and how long it typically takes.

## Steps

### research

Spawn `canon-researcher` as a subagent with matched principles and file context.

**What to compose before spawning:**
- Call `get_principles` with target file scope
- Call `get_file_context` for KG summaries

**Expected output:** `research/synthesis.md` in workspace.

**Skip when:** Never — research always runs for this flow.

### implement

Create an agent team from the plan index. Each teammate claims a task from the shared task list.

**What to compose before spawning:**
- Call `get_principles` with task file scope
- Call `get_file_context` for each task's target files

**Expected output:** One `{task_id}-SUMMARY.md` per task in `plans/{slug}/`.

**Wave notes:** Teammates coordinate via Mailbox. `TaskCompleted` hooks enforce artifact production. Merge worktrees after all tasks complete.

## Completion

After all steps complete, run the completion checklist:
1. `verify_completion({ workspace })` — journal verification
2. `update_board({ operation: "complete_flow" })` — flow analytics
3. Verify file claims released
4. Evaluate learn gate
