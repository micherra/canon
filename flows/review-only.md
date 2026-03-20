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
Review all code changes. Use git diff to see changes. Save review to ${WORKSPACE}/plans/${slug}/REVIEW.md using the review-checklist template at ${CLAUDE_PLUGIN_ROOT}/templates/review-checklist.md. Also save a copy to ${WORKSPACE}/reviews/. Append a log entry to ${WORKSPACE}/log.jsonl.
