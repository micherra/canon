---
task_id: "phase1-00"
wave: 1
depends_on: []
files:
  - skills/canon/runbooks/_template.md
principles:
  - agent-plans-are-prompts
  - agent-design-before-code
  - patterns-need-justification
domains: []
---

## Task: Define the canonical runbook format

### Action

Create `skills/canon/runbooks/_template.md` — a canonical runbook template using markdown with YAML frontmatter, consistent with Canon's existing convention (agents, principles, rules, templates all use this format).

Runbooks are **markdown files with YAML frontmatter**, not pure YAML. The frontmatter carries structured step metadata (machine-readable for the journal tool). The body carries prose guidance for each step (human-readable for the lead and reviewers).

1. Create the directory `skills/canon/runbooks/` if it does not exist.
2. Write `_template.md`:

```markdown
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
```

3. Add a `_README.md` in the same directory documenting:
   - Runbook format: markdown with YAML frontmatter (consistent with Canon conventions)
   - Frontmatter fields: `name`, `description`, `tier`, `steps[]` with `id`, `agent`, `dispatch`, `mcp_tools`, `artifacts`, `hitl`
   - Body sections: Overview, Steps (one H3 per step with prose guidance), Completion
   - How `steps[].id` maps to `log_step` calls in the orchestration journal
   - How `dispatch` maps to subagent vs agent team (§2.5 of migration plan)
   - How `hitl` values map to Claude's native HITL patterns
   - How `artifacts` maps to post-subagent verification checks
   - That body prose is guidance — Claude adapts via judgment, not rigid execution

### Canon principles to apply

- **agent-plans-are-prompts**: The template is self-documenting. An implementor reads only this file and produces a conformant runbook.
- **agent-design-before-code**: This template defines the contract for all 5 runbooks. Get it right before Wave 1 proceeds.
- **patterns-need-justification**: The markdown-with-YAML-frontmatter pattern is justified by consistency with Canon's existing conventions (agents, principles, rules, templates all use this format).

### Tests to write

No code tests. Manual verification: YAML frontmatter parses correctly.

### Verify

1. `skills/canon/runbooks/_template.md` exists
2. YAML frontmatter parses: `python3 -c "import yaml; yaml.safe_load(open('skills/canon/runbooks/_template.md').read().split('---')[1])"`
3. Body contains Overview, Steps, and Completion sections
4. `_README.md` documents the format convention
5. `npm run build` and `npm test` pass unchanged

### Done when

- `_template.md` exists with complete frontmatter schema and prose body example
- `_README.md` documents the format and field semantics
- A second implementor can read only these files and produce a conformant runbook
