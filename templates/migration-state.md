---
template: migration-state
description: Structured handoff template for providing current migration state at session boundaries. Used by the lead when entering multi-wave migration coordination mode.
used-by: [orchestrator]
read-by: [wave-steward]
---

# Migration State: {migration-name}

<!-- Fill in each field below before handing off to the wave-steward skill. -->
<!-- The wave-steward will not proceed until all fields are complete or explicitly marked N/A. -->

## Most recent commit / tag / PR on main

<!-- The latest merged commit SHA, release tag, or PR number on the base branch. -->

{commit-sha-or-tag-or-pr}

## Last wave name + verdict

<!-- Name of the most recently executed wave and its verdict (PASS / CONDITIONAL / FAIL). -->

- **Wave**: {wave-name}
- **Verdict**: {PASS | CONDITIONAL | FAIL}
- **Artifact location**: {path or PR link where the wave report lives}

## Open PRs

<!-- PRs from prior waves still awaiting merge or review. List each with its PR number, title, and current status. -->

<!-- If none: write "None" -->

- {PR number} — {title} — {status: awaiting review | awaiting merge | changes requested}

## Open remediations

<!-- Follow-up tasks with task IDs and dependency edges (which tasks block which). -->
<!-- Format: task-id — description — blocks: [task-id, ...] | unblocked -->

<!-- If none: write "None" -->

- {task-id} — {description} — blocks: {task-id(s) or "nothing"}

## Known limitations

<!-- Documented limitations being carried forward from prior waves. -->
<!-- These are accepted constraints, not open bugs — note them so the next wave doesn't re-litigate them. -->

<!-- If none: write "None" -->

- {limitation description}

## Current blocks

<!-- What's blocked and on what gate. -->
<!-- Example: "v2.1b waves blocked pending ≥20 runbook accumulation" -->

<!-- If nothing is blocked: write "None" -->

{block description and gate condition}

## Authoritative INDEX path

<!-- File path to the migration's INDEX document where wave specs and dependencies live. -->
<!-- Example: ".canon/workspaces/agent-teams-v2/INDEX.md" -->

{path/to/INDEX.md}
