---
name: review-only
description: Review current changes against Canon principles

states:
  review:
    type: single
    agent: canon-reviewer
    template: review-checklist
    transitions:
      clean: done
      warning: done
      blocking: hitl
      blocked: hitl

  done:
    type: terminal
---

## Spawn Instructions

### review
Review all code changes via git diff. Save to ${WORKSPACE}/plans/${slug}/REVIEW.md and ${WORKSPACE}/reviews/. Template: ${CLAUDE_PLUGIN_ROOT}/templates/review-checklist.md.
