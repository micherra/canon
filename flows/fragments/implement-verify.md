---
fragment: implement-verify
description: Direct-mode implement then verify — fast path for small changes with no plan file
entry: implement
params:
  after_all_passing: ~

states:
  implement:
    type: single
    agent: canon-implementor
    template: implementation-log
    effects:
      - type: persist_decisions
    transitions:
      done: verify
      blocked: hitl

  verify:
    type: single
    agent: canon-tester
    role: verify
    template: test-report
    transitions:
      all_passing: ${after_all_passing}
      implementation_issue: fix-impl
      blocked: hitl

  fix-impl:
    type: single
    agent: canon-fixer
    role: test-fix
    template: implementation-log
    max_iterations: 1
    stuck_when: same_file_test
    transitions:
      done: verify
      blocked: hitl
---

## Spawn Instructions

### implement
Direct mode — no plan file. Task: ${task}. Treat the task description as your plan. Save summary to ${WORKSPACE}/plans/${slug}/SUMMARY.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/implementation-log.md.

${progress}

### verify
Lightweight verification gate — run the project test suite only (do NOT write new tests). Check ${WORKSPACE}/plans/${slug}/SUMMARY.md for implementation context. Save report to ${WORKSPACE}/plans/${slug}/TEST-REPORT.md. Report all_passing or implementation_issue.

### fix-impl
Mode: test-fix. Test report: ${WORKSPACE}/plans/${slug}/TEST-REPORT.md. Fix the implementation so tests pass. Save summary to ${WORKSPACE}/plans/${slug}/FIX-SUMMARY.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/implementation-log.md.

${progress}
