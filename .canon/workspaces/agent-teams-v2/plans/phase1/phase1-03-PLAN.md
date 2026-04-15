---
task_id: "phase1-03"
wave: 1
depends_on:
  - "phase1-00"
files:
  - skills/canon/runbooks/test-gap.md
  - skills/canon/runbooks/adopt.md
principles:
  - agent-plans-are-prompts
domains:
  - orchestration
---

## Task: Create test-gap and adopt runbooks

### Action

Create two runbooks for fix-loop flows that do not have a ship step. These flows iterate between analysis/testing and fixing until converged.

#### 1. `test-gap.md`

Read `flows/test-gap.md`. States: `scan` (single, canon-researcher), `write-tests` (single, canon-tester), `fix-impl` (single, canon-engineer), review-fix-loop fragment (review, fix-violations), `done` (terminal).

```yaml
name: "test-gap"
description: "Analyze test coverage gaps, write tests, verify they pass"
tier: "small"

steps:
  - id: "scan"
    agent: "canon-researcher"
    dispatch: "subagent"
    mcp_tools:
      - get_file_context
      - graph_query
      - semantic_search
      - init_workspace
      - log_step
    artifacts:
      - "research/coverage-scan.md"
    hitl: "on_failure"
    skip_when: null
    notes: |
      Analyze test coverage for target files. Discover source files and
      corresponding test files. Identify: untested modules, untested
      branches, missing edge cases, missing integration tests. Prioritize
      gaps by risk (code complexity, change frequency, criticality).
      If no meaningful gaps found, report done with no_gaps — skip
      remaining steps.

  - id: "write-tests"
    agent: "canon-tester"
    dispatch: "subagent"
    mcp_tools:
      - get_principles
      - get_file_context
      - log_step
    artifacts:
      - "plans/${slug}/TEST-REPORT.md"
    hitl: "on_failure"
    skip_when: null
    notes: |
      Write tests to fill coverage gaps from the scan. Prioritize by risk.
      Write integration tests for cross-module interactions, edge case tests
      for complex logic, regression tests for known-bug areas. Run all tests.
      If tests reveal source code bugs (implementation_issue), proceed to
      fix-impl. If all passing, proceed to review.

  - id: "fix-impl"
    agent: "canon-engineer"
    dispatch: "subagent"
    mcp_tools:
      - get_principles
      - get_file_context
      - graph_query
      - log_step
    artifacts:
      - "plans/${slug}/FIX-SUMMARY.md"
    hitl: "on_failure"
    skip_when: null
    notes: |
      Mode: test-fix. New tests revealed source code bugs. Fix the source
      code (not the tests) so tests pass correctly. After fixing, loop back
      to write-tests to verify and check for remaining gaps.

  - id: "review"
    agent: "canon-reviewer"
    dispatch: "subagent"
    mcp_tools:
      - get_principles
      - review_code
      - log_step
    artifacts:
      - "plans/${slug}/REVIEW.md"
    hitl: "checkpoint"
    skip_when: null
    notes: |
      Review the test additions and any source fixes for Canon principle
      compliance. If blocking violations found, spawn canon-engineer to
      resolve, then re-review. Loop max 2 iterations.
```

#### 2. `adopt.md`

Read `flows/adopt.md`. States: `scan` (single, canon-researcher), `fix` (parallel-per, canon-engineer), `rescan` (single, canon-researcher), `done` (terminal).

```yaml
name: "adopt"
description: "Scan codebase for principle violations, optionally auto-fix"
tier: "small"

steps:
  - id: "scan"
    agent: "canon-researcher"
    dispatch: "subagent"
    mcp_tools:
      - get_principles
      - list_principles
      - get_file_context
      - init_workspace
      - log_step
    artifacts:
      - "plans/${slug}/ADOPTION-REPORT.md"
    hitl: "checkpoint"
    skip_when: null
    notes: |
      Scan the codebase for Canon principle applicability. Discover source
      files, load principles, match by scope and layer. Produce a tiered
      remediation report (Tier 1: rules, Tier 2: strong-opinions,
      Tier 3: conventions) with top violation directories and recommended
      actions. If no rule-severity violations found, report no_violations
      and skip remaining steps.

  - id: "fix"
    agent: "canon-engineer"
    dispatch: "subagent"
    mcp_tools:
      - get_principles
      - get_file_context
      - graph_query
      - log_step
    artifacts: []
    hitl: "on_failure"
    skip_when: "no_fix_requested"
    notes: |
      Mode: violation-fix. Fix each violation group from the adoption
      report. For parallel execution, spawn one subagent per violation
      group. Max 2 iterations per group. If a violation cannot be fixed
      automatically (requires architectural change), report cannot_fix.

  - id: "rescan"
    agent: "canon-researcher"
    dispatch: "subagent"
    mcp_tools:
      - get_principles
      - list_principles
      - log_step
    artifacts:
      - "plans/${slug}/ADOPTION-REPORT.md"
    hitl: "checkpoint"
    skip_when: null
    notes: |
      Re-scan the codebase after fixes. Same process as initial scan.
      Save updated report showing remaining violations. Compare with
      original report to measure improvement.
```

### Canon principles to apply
- **agent-plans-are-prompts**: Fix-loop runbooks must clearly describe the loop semantics in `notes` — which steps loop, what triggers the loop, and what convergence looks like.

### Tests to write
- No code tests. YAML validation only.

### Verify
1. Both files exist at `skills/canon/runbooks/{test-gap,adopt}.md`
2. Both parse as valid YAML
3. `test-gap.md`: 4 steps covering scan, write-tests, fix-impl, review (with fix-loop noted in review notes)
4. `adopt.md`: 3 steps covering scan, fix, rescan
5. Fix-loop semantics documented in notes fields
6. `npm run build` passes
7. `npm test` passes

### Done when
- Both runbooks exist and parse as valid YAML
- Each step maps to a legacy flow state with correct agent and dispatch type
- Loop semantics (write-tests ↔ fix-impl, review ↔ fix-violations) are described in step notes
- Skip conditions match legacy (`no_fix_requested`, `no_gaps`)
- Build and tests pass unchanged
