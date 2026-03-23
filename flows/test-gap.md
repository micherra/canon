---
name: test-gap
description: Analyze test coverage gaps, write tests, verify they pass
entry: scan
progress: ${WORKSPACE}/progress.md

includes:
  - fragment: review-fix-loop
    with:
      after_clean: done
      after_warning: done
      max_iterations: 2

states:
  scan:
    type: single
    agent: canon-researcher
    role: coverage-scan
    template: research-finding
    transitions:
      done: write-tests
      no_gaps: done
      blocked: hitl

  write-tests:
    type: single
    agent: canon-tester
    template: test-report
    max_iterations: 2
    stuck_when: same_file_test
    inject_context:
      - from: scan
        as: coverage_report
    transitions:
      all_passing: review
      implementation_issue: fix-impl
      blocked: hitl

  fix-impl:
    type: single
    agent: canon-fixer
    role: test-fix
    template: implementation-log
    transitions:
      done: write-tests
      blocked: hitl

  done:
    type: terminal
---

## Spawn Instructions

### scan
Analyze test coverage for: ${task}. Discover source files and their corresponding test files. Identify: untested modules, untested branches in tested modules, missing edge cases, missing integration tests. Prioritize gaps by risk (code complexity, change frequency, criticality). Save to ${WORKSPACE}/research/coverage-scan.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/research-finding.md.

If no meaningful gaps found, report no_gaps.

### write-tests
Write tests to fill coverage gaps identified in the coverage report. Prioritize by risk. Write integration tests for cross-module interactions, edge case tests for complex logic, and regression tests for areas with known bugs. Run all tests to verify they pass. Save report to ${WORKSPACE}/plans/${slug}/TEST-REPORT.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/test-report.md.

${progress}

### fix-impl
Mode: test-fix. New tests revealed bugs in the source code. Test report: ${WORKSPACE}/plans/${slug}/TEST-REPORT.md. Fix the source code (not the tests) so tests pass correctly. Save summary to ${WORKSPACE}/plans/${slug}/FIX-SUMMARY.md. Template: ${CLAUDE_PLUGIN_ROOT}/templates/implementation-log.md.

${progress}
