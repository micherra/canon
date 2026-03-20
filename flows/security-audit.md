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
Scan the codebase for security vulnerabilities. Focus on OWASP top 10, secrets in code, injection vectors, and authentication/authorization issues. Save assessment to ${WORKSPACE}/plans/${slug}/SECURITY.md using the security-assessment template at ${CLAUDE_PLUGIN_ROOT}/templates/security-assessment.md. Append a log entry to ${WORKSPACE}/log.jsonl.

### review
Review all code for Canon principle compliance. Use git diff to see recent changes. Save review to ${WORKSPACE}/plans/${slug}/REVIEW.md using the review-checklist template at ${CLAUDE_PLUGIN_ROOT}/templates/review-checklist.md. Also save a copy to ${WORKSPACE}/reviews/. Append a log entry to ${WORKSPACE}/log.jsonl.
