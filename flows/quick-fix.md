---
name: quick-fix
description: Implement, verify, and review — fast path for small changes
tier: small
progress: ${WORKSPACE}/progress.md

states:
  implement:
    type: single
    agent: canon-implementor
    template: implementation-log
    transitions:
      done: verify
      blocked: hitl

  verify:
    type: single
    agent: canon-tester
    role: verify
    template: test-report
    transitions:
      all_passing: context-sync
      implementation_issue: hitl
      blocked: hitl

  context-sync:
    type: single
    agent: canon-scribe
    template: context-sync-report
    transitions:
      updated: review
      no_updates: review
      blocked: hitl

  review:
    type: single
    agent: canon-reviewer
    template: review-checklist
    transitions:
      clean: done
      warning: done
      blocking: fix-violations
      blocked: hitl

  fix-violations:
    type: parallel-per
    agent: canon-refactorer
    iterate_on: violation_groups
    max_iterations: 2
    stuck_when: same_violations
    transitions:
      done: review
      cannot_fix: hitl

  done:
    type: terminal
---

## Spawn Instructions

### implement
Direct mode — no plan file. Task: ${task}. Treat the task description as your plan. Save summary to ${WORKSPACE}/plans/${slug}/SUMMARY.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/implementation-log.md.

${progress}

### verify
Lightweight verification gate — run the project test suite only (do NOT write new tests). Report all_passing or implementation_issue.

### context-sync
Sync docs after implementation. Diff source: implementation commit. Summary: ${WORKSPACE}/plans/${slug}/SUMMARY.md. Save report to ${WORKSPACE}/plans/${slug}/CONTEXT-SYNC.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/context-sync-report.md.

### review
Review all changes from this build via git diff. Save to ${WORKSPACE}/plans/${slug}/REVIEW.md and ${WORKSPACE}/reviews/. Template: ${CLAUDE_PLUGIN_ROOT}/templates/review-checklist.md.

${progress}

### fix-violations
Fix violation: ${item.principle_id} (${item.severity}) in ${item.file_path}. Detail: ${item.detail}.

${progress}
