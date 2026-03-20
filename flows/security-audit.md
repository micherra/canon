---
name: security-audit
description: Security scan followed by principle compliance review

states:
  security:
    type: single
    agent: canon-security
    template: security-assessment
    transitions:
      done: review
      critical: hitl
      blocked: hitl

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
Review all code for Canon principle compliance via git diff. Save to ${WORKSPACE}/plans/${slug}/REVIEW.md and ${WORKSPACE}/reviews/. Template: ${CLAUDE_PLUGIN_ROOT}/templates/review-checklist.md.
