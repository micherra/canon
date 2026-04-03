---
name: refactor
description: Behavior-preserving restructuring with continuous test verification
tier: medium
entry: analyze
progress: ${WORKSPACE}/progress.md

includes:
  - fragment: user-checkpoint
    with:
      after_approved: implement
      on_revise: analyze

  - fragment: verify-fix-loop
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

states:
  analyze:
    type: single
    agent: canon-researcher
    role: refactor-scope
    template: research-finding
    transitions:
      done: checkpoint
      blocked: hitl

  implement:
    type: wave
    agent: canon-implementor
    gate: test-suite
    template: implementation-log
    transitions:
      done: verify
      blocked: hitl
---

## Spawn Instructions

### analyze
Analyze refactoring scope for: ${task}. Identify all files affected, existing test coverage, and behavioral contracts that must be preserved. Map dependencies between files being refactored. Save to ${WORKSPACE}/research/refactor-scope.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/research-finding.md.

Key outputs: file list, test coverage map, behavioral contracts, risk areas, recommended wave ordering (files with no dependents first).

### implement
Refactoring task from ${WORKSPACE}/plans/${slug}/${task_id}-PLAN.md. CRITICAL: preserve all existing behavior. Run existing tests after each change to verify nothing breaks. Save summary to ${WORKSPACE}/plans/${slug}/${task_id}-SUMMARY.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/implementation-log.md.

${wave_briefing}

${enrichment}

### verify
Run the full test suite to verify refactoring preserved behavior. Check ${WORKSPACE}/plans/${slug}/*-SUMMARY.md for what changed. Compare test results against pre-refactor baseline. Save report to ${WORKSPACE}/plans/${slug}/TEST-REPORT.md. Report all_passing or implementation_issue.

### fix-impl
Mode: test-fix. Test report: ${WORKSPACE}/plans/${slug}/TEST-REPORT.md. The refactoring broke existing behavior — fix the implementation (not the tests) to restore correct behavior. Save summary to ${WORKSPACE}/plans/${slug}/FIX-SUMMARY.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/implementation-log.md.

${progress}
