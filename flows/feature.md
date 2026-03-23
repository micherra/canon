---
name: feature
description: Design, implement, test, and review — skip research
tier: medium
entry: design
progress: ${WORKSPACE}/progress.md

includes:
  - fragment: user-checkpoint
    with:
      after_approved: implement
      on_revise: design

  - fragment: context-sync
    with:
      next: test

  - fragment: test-fix-loop
    with:
      after_all_passing: review

  - fragment: review-fix-loop
    with:
      after_clean: ship
      after_warning: ship

  - fragment: ship-done

states:
  design:
    type: single
    agent: canon-architect
    template: [design-decision, session-context]
    transitions:
      done: checkpoint
      has_questions: hitl

  implement:
    type: wave
    agent: canon-implementor
    template: implementation-log
    gate: test-suite
    transitions:
      done: context-sync
      blocked: hitl
---

## Spawn Instructions

### design
Design the technical approach for: ${task}. Save design to ${WORKSPACE}/plans/${slug}/DESIGN.md. Save task plans to ${WORKSPACE}/plans/${slug}/${task_id}-PLAN.md and index to INDEX.md. Record decisions to ${WORKSPACE}/decisions/. Templates: design-decision, session-context at ${CLAUDE_PLUGIN_ROOT}/templates/. Initialize ${WORKSPACE}/context.md.

### implement
Execute task plan at ${WORKSPACE}/plans/${slug}/${task_id}-PLAN.md. Save summary to ${WORKSPACE}/plans/${slug}/${task_id}-SUMMARY.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/implementation-log.md.

${wave_briefing}
