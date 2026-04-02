---
fragment: test-fix-loop
description: Test, fix implementation bugs, sync docs, loop until all tests pass
entry: test
params:
  after_all_passing:
    type: state_id
  max_iterations:
    type: number
    default: 2

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
      done: context-sync-fix
      blocked: hitl

  context-sync-fix:
    type: single
    agent: canon-scribe
    template: context-sync-report
    skip_when: no_contract_changes
    transitions:
      updated: test
      no_updates: test
      blocked: hitl
---

## Spawn Instructions

### test
Write integration tests and fill coverage gaps. Start with Coverage Notes from ${WORKSPACE}/plans/${slug}/*-SUMMARY.md. Save report to ${WORKSPACE}/plans/${slug}/TEST-REPORT.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/test-report.md.

**Architect plans**: Read plan files in `${WORKSPACE}/plans/${slug}/` (DESIGN.md, INDEX.md, task plans) for `### Risk mitigations` sections — verify architect-specified risk coverage was implemented.

${progress}

### fix-impl
Mode: test-fix. Test report: ${WORKSPACE}/plans/${slug}/TEST-REPORT.md. Determine source bugs vs test bugs for each failure. Save summary to ${WORKSPACE}/plans/${slug}/FIX-SUMMARY.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/implementation-log.md.

${progress}

### context-sync-fix
Sync docs after fix-impl. Diff source: fix commits since last context-sync. Summary: ${WORKSPACE}/plans/${slug}/FIX-SUMMARY.md. Save report to ${WORKSPACE}/plans/${slug}/CONTEXT-SYNC-FIX.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/context-sync-report.md.
