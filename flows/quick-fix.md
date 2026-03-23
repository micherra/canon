---
name: quick-fix
description: Implement, verify, and review — fast path for small changes
tier: small
entry: implement
progress: ${WORKSPACE}/progress.md

includes:
  - fragment: implement-verify
    with:
      after_all_passing: context-sync

  - fragment: context-sync
    with:
      next: review

  - fragment: review-fix-loop
    with:
      after_clean: ship
      after_warning: ship
      max_iterations: 2

  - fragment: ship-done
---

## Spawn Instructions

### implement
Direct mode — no plan file. Task: ${task}. Treat the task description as your plan. Save summary to ${WORKSPACE}/plans/${slug}/SUMMARY.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/implementation-log.md.

${progress}

### verify
Lightweight verification gate — run the project test suite only (do NOT write new tests). Check ${WORKSPACE}/plans/${slug}/SUMMARY.md for implementation context. Save report to ${WORKSPACE}/plans/${slug}/TEST-REPORT.md. Report all_passing or implementation_issue.
