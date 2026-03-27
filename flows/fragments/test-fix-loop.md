---
fragment: test-fix-loop
description: Test, fix implementation bugs, sync docs, loop until all tests pass
entry: test
params:
  after_all_passing: ~
  max_iterations: 2

states:
  test:
    type: single
    agent: canon-tester
    template: test-report
    max_iterations: ${max_iterations}
    stuck_when: same_file_test
    transitions:
      all_passing: ${after_all_passing}
      implementation_issue: fix-impl
      blocked: hitl

  fix-impl:
    type: single
    agent: canon-fixer
    role: test-fix
    template: implementation-log
    transitions:
      done: test
      blocked: hitl
---

## Spawn Instructions

### test
Write integration tests and fill coverage gaps. Start with Coverage Notes from ${WORKSPACE}/plans/${slug}/*-SUMMARY.md. Save report to ${WORKSPACE}/plans/${slug}/TEST-REPORT.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/test-report.md.

${progress}

### fix-impl
Mode: test-fix. Test report: ${WORKSPACE}/plans/${slug}/TEST-REPORT.md. Determine source bugs vs test bugs for each failure. Save summary to ${WORKSPACE}/plans/${slug}/FIX-SUMMARY.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/implementation-log.md.

${progress}
