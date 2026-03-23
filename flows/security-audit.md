---
name: security-audit
description: Security scan followed by principle compliance review

includes:
  - fragment: security-scan
    with:
      after_done: review
      on_critical: hitl

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

### security
Scan for security vulnerabilities. Save to ${WORKSPACE}/plans/${slug}/SECURITY.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/security-assessment.md.

### review
Review all code for Canon principle compliance via `git diff ${base_commit}..HEAD`. Save to ${WORKSPACE}/plans/${slug}/REVIEW.md and ${WORKSPACE}/reviews/. Template: ${CLAUDE_PLUGIN_ROOT}/templates/review-checklist.md.
