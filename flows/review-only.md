---
name: review-only
description: Review current changes against Canon principles with optional layer-parallel fan-out

states:
  review:
    type: single
    agent: canon-reviewer
    template: review-checklist
    large_diff_threshold: 300
    cluster_by: layer
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
Review code changes via `git diff ${base_commit}..HEAD`. Scope: ${review_scope}. Save to ${WORKSPACE}/plans/${slug}/REVIEW.md and ${WORKSPACE}/reviews/. Template: ${CLAUDE_PLUGIN_ROOT}/templates/review-checklist.md.

${enrichment}
