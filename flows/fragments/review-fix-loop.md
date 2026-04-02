---
fragment: review-fix-loop
description: Review code against principles, fix violations, loop until clean
entry: review
params:
  after_clean:
    type: state_id
  after_warning:
    type: state_id
  max_iterations:
    type: number
    default: 3

states:
  review:
    type: single
    agent: canon-reviewer
    template: review-checklist
    inject_context:
      - from: design
        as: design_doc
        section: "## Design Document"
    effects:
      - type: persist_review
        artifact: REVIEW.md
    transitions:
      clean: ${after_clean}
      warning: ${after_warning}
      blocking: fix-violations
      blocked: hitl

  fix-violations:
    type: parallel-per
    agent: canon-fixer
    role: violation-fix
    iterate_on: violation_groups
    max_iterations: ${max_iterations}
    stuck_when: same_violations
    transitions:
      done: review
      cannot_fix: hitl
      blocked: hitl
---

## Spawn Instructions

### review
Review changes via `git diff ${base_commit}..HEAD` (scoped to file list if provided). After Stages 1-2, cross-check against ${WORKSPACE}/plans/${slug}/*-SUMMARY.md. Save to ${WORKSPACE}/plans/${slug}/REVIEW.md and ${WORKSPACE}/reviews/. Template: ${CLAUDE_PLUGIN_ROOT}/templates/review-checklist.md.

${design_doc}

${review_scope}

${progress}

### fix-violations
Mode: violation-fix. Violation: ${item.principle_id} (${item.severity}) in ${item.file_path}. Detail: ${item.detail}.

${progress}
