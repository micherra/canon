---
fragment: verify-fix-loop
description: Verify tests pass, fix implementation bugs if needed, loop until all passing
entry: verify
params:
  after_all_passing: ~
  role: verify
  max_iterations: 2
  write_tests: false

states:
  verify:
    type: single
    agent: canon-tester
    role: ${role}
    template: test-report
    max_iterations: ${max_iterations}
    stuck_when: same_file_test
    inject_context:
      - from: user
        prompt: "Write tests for this change?"
        as: user_write_tests
        skip_when: ${write_tests}
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
      done: verify
      blocked: hitl
---

## Spawn Instructions

### verify
Run the full test suite to verify implementation correctness. Check ${WORKSPACE}/plans/${slug}/*-SUMMARY.md for what changed. If your role includes test-writing, also write integration tests and fill coverage gaps starting with Coverage Notes from summaries. (User requested tests: ${write_tests} / ${user_write_tests}). Save report to ${WORKSPACE}/plans/${slug}/TEST-REPORT.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/test-report.md. Report all_passing or implementation_issue.

${progress}

### fix-impl
Mode: test-fix. Test report: ${WORKSPACE}/plans/${slug}/TEST-REPORT.md. Determine source bugs vs test bugs for each failure. Fix the implementation (not the tests) to restore correct behavior. Save summary to ${WORKSPACE}/plans/${slug}/FIX-SUMMARY.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/implementation-log.md.

${progress}
