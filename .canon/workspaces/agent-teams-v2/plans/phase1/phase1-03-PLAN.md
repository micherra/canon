---
task_id: "phase1-03"
wave: 1
depends_on: []
decisions:
  - "runbook-yaml-structure"
files:
  - skills/canon/runbooks/test-gap.yaml
  - skills/canon/runbooks/adopt.yaml
principles:
  - simplicity-first
  - information-hiding
domains: []
---

## Task: Create test-gap and adopt runbooks

### Action

Create two runbooks for flows that have fix loops but no ship step.

#### 1. `skills/canon/runbooks/test-gap.yaml`

```yaml
name: test-gap
description: "Analyze test coverage gaps, write tests, verify they pass"
tier: testing

steps:
  - id: scan
    agent: canon-researcher
    dispatch: subagent
    mcp_tools:
      - get_file_context
      - graph_query
      - semantic_search
    artifacts:
      - "${WORKSPACE}/research/coverage-scan.md"
    hitl: none
    skip_when: "No meaningful coverage gaps found (researcher reports no_gaps)"
    notes: >
      Spawn canon-researcher in coverage-scan role. The researcher discovers
      source files and their test files, identifies untested modules, untested
      branches, missing edge cases, and missing integration tests. Prioritizes
      gaps by risk. If no gaps found, flow completes immediately.

  - id: write-tests
    agent: canon-tester
    dispatch: subagent
    mcp_tools:
      - get_principles
      - get_file_context
    artifacts:
      - "${WORKSPACE}/plans/${slug}/TEST-REPORT.md"
    hitl: none
    notes: >
      Spawn canon-tester with the coverage report. The tester writes tests
      to fill prioritized gaps -- integration tests, edge cases, regression
      tests. Runs all tests to verify they pass. If tests reveal source bugs,
      reports implementation_issue.

  - id: fix-impl
    agent: canon-fixer
    dispatch: subagent
    mcp_tools:
      - get_file_context
    artifacts:
      - "${WORKSPACE}/plans/${slug}/FIX-SUMMARY.md"
    hitl: none
    skip_when: "All tests pass (tester reports all_passing, not implementation_issue)"
    notes: >
      Spawn canon-fixer in test-fix mode if the tester found source bugs.
      The fixer reads the test report and fixes source code to make tests pass.
      After fixing, loop back to write-tests to verify.

  - id: review
    agent: canon-reviewer
    dispatch: subagent
    mcp_tools:
      - get_principles
      - get_file_context
      - get_drift_report
    artifacts:
      - "${WORKSPACE}/plans/${slug}/REVIEW.md"
    hitl: on_failure
    notes: >
      Spawn canon-reviewer to review the new tests and any source fixes.
      If BLOCKING, spawn canon-fixer to address violations, then re-review.
      Loop up to 2 times. If CLEAN or WARNING, flow completes.

  - id: fix-violations
    agent: canon-fixer
    dispatch: subagent
    mcp_tools:
      - get_file_context
    artifacts:
      - "${WORKSPACE}/plans/${slug}/FIX-SUMMARY.md"
    hitl: none
    skip_when: "Review verdict is CLEAN or WARNING"
    notes: >
      Spawn canon-fixer in violation-fix mode for each BLOCKING violation.
      After fixing, loop back to review. Max 2 iterations.
```

#### 2. `skills/canon/runbooks/adopt.yaml`

```yaml
name: adopt
description: "Scan codebase for principle violations, optionally auto-fix"
tier: adoption

steps:
  - id: scan
    agent: canon-researcher
    dispatch: subagent
    mcp_tools:
      - get_principles
      - get_file_context
      - semantic_search
    artifacts:
      - "${WORKSPACE}/plans/${slug}/ADOPTION-REPORT.md"
    hitl: none
    notes: >
      Spawn canon-researcher in adoption-scan role. The researcher discovers
      source files, loads principles filtered by severity, matches against
      file scopes, and produces a tiered remediation report. If no rule-severity
      violations found, flow completes immediately.

  - id: fix
    agent: canon-fixer
    dispatch: subagent
    mcp_tools:
      - get_file_context
    artifacts: []
    hitl: none
    skip_when: "No violations found or user did not request fixes"
    notes: >
      For each violation group, spawn a canon-fixer subagent in violation-fix
      mode. For multiple independent groups, spawn in parallel. Each fixer
      preserves behavior and verifies with tests. Max 2 iterations per group.

  - id: rescan
    agent: canon-researcher
    dispatch: subagent
    mcp_tools:
      - get_principles
      - get_file_context
    artifacts:
      - "${WORKSPACE}/plans/${slug}/ADOPTION-REPORT.md"
    hitl: none
    skip_when: "No fixes were applied"
    notes: >
      Re-scan the codebase after fixes to verify violations are resolved
      and no new ones were introduced. Produces an updated adoption report.
```

**Verify flow coverage**:
- `test-gap.md`: states scan, write-tests, fix-impl, review (from fragment), fix-violations (from fragment), done. Runbook covers all non-terminal states.
- `adopt.md`: states scan, fix (parallel-per), rescan, done. Runbook covers all non-terminal states.

### Canon principles to apply

- **simplicity-first**: Fix loops are described as sequential steps with skip conditions, not as YAML loop constructs.
- **information-hiding**: Skip conditions are plain-language descriptions. Claude evaluates them via judgment.

### Tests to write

No tests -- YAML playbook files.

### Verify

1. Both files exist at `skills/canon/runbooks/{test-gap,adopt}.yaml`
2. Valid YAML
3. Step IDs match legacy flow states
4. `npm run build` and `npm test` still pass

### Done when

- Two runbook files exist and are valid YAML
- All states from their legacy flows are represented
