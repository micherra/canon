---
name: template-example
description: One-line purpose of this flow
tier: medium  # small | medium | large

steps:
  - id: research
    agent: canon-researcher
    dispatch: subagent     # subagent | team
    mcp_tools:             # MCP tools the lead calls BEFORE spawning
      - get_principles
      - get_file_context
    artifacts:             # Expected output paths (workspace-relative unless noted)
      - "research/synthesis.md"
    hitl: none             # none | approval | checkpoint | on_failure
    skip_when: null        # null | natural-language condition (evaluated by the lead)

  - id: implement
    agent: canon-engineer
    dispatch: team          # Agent team for parallel wave execution
    mcp_tools:
      - get_principles
      - get_file_context
    artifacts:
      - "plans/${slug}/${task_id}-SUMMARY.md"
    hitl: none
    skip_when: null

  - id: context-sync
    agent: canon-scribe
    dispatch: subagent
    mcp_tools: []           # Scribe works from git diff + filesystem
    artifacts:
      - "plans/${slug}/CONTEXT-SYNC.md"
    hitl: none
    skip_when: "all changes are internal/test-only/config"

  - id: learn
    agent: canon-learner
    dispatch: subagent
    mcp_tools: []           # Learner reads .canon/ data sources directly
    artifacts:
      - ".canon/proposed-learnings/${timestamp}/"
    hitl: none
    skip_when: "learn gate thresholds not met"
---

# {Flow Name} Runbook

## Overview

One paragraph describing when this flow is used, what it produces, and how long it typically takes. Cite the pre-build gate if this flow requires one.

## Steps

### research

Establishes the factual basis for downstream steps — target subsystem behavior, adjacent patterns, risks. The lead names relevant domain skills (e.g., `backend-api`, `authentication-security`) in the spawn prompt; the researcher loads them on its first turn via `agent-context-check`.

**Skip when:** never. Even for clearly-scoped work, the synthesis seeds the architect's design.

### implement

Wave execution across the tasks in the plan index. Each teammate claims one task from the shared task list.

**Wave coordination:** Teammates communicate via native Mailbox. `TaskCompleted` hooks enforce one `${task_id}-SUMMARY.md` per task. The lead merges worktrees after the wave completes and runs inter-wave gates if the flow declares them.

**Skip when:** never for build flows. A plan index with zero tasks is a planning error, not a skip condition.

### context-sync

Surgical post-implementation documentation update. The scribe reads the git diff and summaries, then edits CLAUDE.md / context.md / CONVENTIONS.md only where contracts changed.

**Skip when:** the scribe's own classification returns NO_UPDATES (all changes internal / test-only / config). The lead may pre-empt this step if the flow was entirely test-only, but is not required to — the scribe exits cheaply when there's nothing to sync.

### learn

Auto-trigger pattern analysis after flow completion. The learner reads transcripts and drift data, writes proposals to `.canon/proposed-learnings/${timestamp}/` when actionable signal exists.

**Skip when:** the learn gate thresholds (minimum reviews, builds, flow runs) are not met. The lead calls `.canon/learn.sh` if it exists; the script evaluates the gate.

## Completion

After all steps complete, run the completion checklist:
1. `verify_completion({ workspace })` — journal verification (blocks on missing steps or artifacts)
2. `update_board({ operation: "complete_flow" })` — flow analytics
3. Verify file claims released
4. Evaluate learn gate (may have been handled by the `learn` step already)
