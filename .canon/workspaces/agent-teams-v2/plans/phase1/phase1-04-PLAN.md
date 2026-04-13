---
task_id: "phase1-04"
wave: 1
depends_on: []
decisions:
  - "runbook-yaml-structure"
files:
  - skills/canon/runbooks/feature.yaml
  - skills/canon/runbooks/refactor.yaml
principles:
  - simplicity-first
  - information-hiding
domains: []
---

## Task: Create feature and refactor runbooks (medium-tier with wave steps)

### Action

Create two medium-tier runbooks that include wave (parallel) implementation steps. These are the first runbooks that use `dispatch: team` for implementation.

#### 1. `skills/canon/runbooks/feature.yaml`

```yaml
name: feature
description: "Design, implement, test, and review a feature (4-10 files)"
tier: medium

steps:
  - id: design
    agent: canon-architect
    dispatch: subagent
    mcp_tools:
      - get_principles
      - get_file_context
      - graph_query
      - semantic_search
    artifacts:
      - "${WORKSPACE}/plans/${slug}/DESIGN.md"
      - "${WORKSPACE}/plans/${slug}/INDEX.md"
      - "${WORKSPACE}/plans/${slug}/*-PLAN.md"
      - "${WORKSPACE}/decisions/"
      - "${WORKSPACE}/context.md"
    hitl: approval
    notes: >
      Spawn canon-architect with the task description, matched principles
      (full body), and file context. The architect produces a design document,
      task plans, and plan index. Present the plan to the user for approval.
      If the user requests revisions, re-spawn the architect with feedback.
      Max 3 revision rounds. The architect may use competitive synthesis
      (auto mode) -- spawn multiple architect subagents with different lenses
      and synthesize their outputs.

  - id: implement
    agent: canon-implementor
    dispatch: team
    mcp_tools:
      - get_file_context
    artifacts:
      - "${WORKSPACE}/plans/${slug}/*-SUMMARY.md"
    hitl: none
    notes: >
      Create an agent team with one canon-implementor teammate per task in the
      plan index. Each teammate receives its task plan file. Use the shared task
      list for coordination -- tasks with wave dependencies are auto-unblocked.
      Create git worktrees for each teammate (git worktree add). After all tasks
      complete, merge worktrees back. Run post-state effects (check_postconditions)
      after merge.

  - id: context-sync
    agent: canon-scribe
    dispatch: subagent
    mcp_tools: []
    artifacts:
      - "${WORKSPACE}/context.md"
    hitl: none
    notes: >
      Spawn canon-scribe to update CLAUDE.md, context.md, and CONVENTIONS.md
      based on the implementation changes. The scribe reads git diffs and
      implementor summaries to identify contract-level changes.

  - id: verify
    agent: canon-tester
    dispatch: subagent
    mcp_tools:
      - get_principles
      - get_file_context
    artifacts:
      - "${WORKSPACE}/plans/${slug}/TEST-REPORT.md"
    hitl: none
    notes: >
      Spawn canon-tester to write integration tests and fill coverage gaps.
      The tester reads implementor summaries for coverage notes. Runs all tests.

  - id: fix-impl
    agent: canon-fixer
    dispatch: subagent
    mcp_tools:
      - get_file_context
    artifacts:
      - "${WORKSPACE}/plans/${slug}/FIX-SUMMARY.md"
    hitl: none
    skip_when: "All tests pass (tester reports all_passing)"
    notes: >
      If tests fail, spawn canon-fixer in test-fix mode. Fix source code to
      make tests pass, then loop back to verify. Max 3 iterations of the
      verify/fix loop.

  - id: review
    agent: canon-reviewer
    dispatch: subagent
    mcp_tools:
      - get_principles
      - get_file_context
      - get_drift_report
    artifacts:
      - "${WORKSPACE}/plans/${slug}/REVIEW.md"
      - "${WORKSPACE}/reviews/"
    hitl: on_failure
    notes: >
      Spawn canon-reviewer for four-stage review (principle compliance, code
      quality, compliance cross-check, drift-from-plan). Call store_pr_review
      after review completes (persist_review effect). If BLOCKING, proceed to
      fix-violations then re-review. Max 3 iterations.

  - id: fix-violations
    agent: canon-fixer
    dispatch: subagent
    mcp_tools:
      - get_file_context
    artifacts: []
    hitl: none
    skip_when: "Review verdict is CLEAN or WARNING"
    notes: >
      For each BLOCKING violation, spawn canon-fixer in violation-fix mode.
      Multiple independent violations can be fixed in parallel. After fixing,
      loop back to review.

  - id: pre-launch-check
    agent: null
    dispatch: subagent
    mcp_tools: []
    artifacts: []
    hitl: on_failure
    notes: >
      Run all discovered quality gates via Bash. If all pass, proceed to ship.
      If any fail, present to user.

  - id: ship
    agent: canon-shipper
    dispatch: subagent
    mcp_tools: []
    artifacts:
      - "${WORKSPACE}/plans/${slug}/PR-DESCRIPTION.md"
    hitl: none
    notes: >
      Spawn canon-shipper to synthesize build artifacts into PR description.

  - id: learn
    agent: canon-learner
    dispatch: subagent
    mcp_tools: []
    artifacts: []
    hitl: none
    skip_when: "Learn gate not passed"
    notes: >
      Evaluate learn gate. If passed, spawn canon-learner.
```

#### 2. `skills/canon/runbooks/refactor.yaml`

```yaml
name: refactor
description: "Behavior-preserving restructuring with continuous test verification"
tier: medium

steps:
  - id: analyze
    agent: canon-researcher
    dispatch: subagent
    mcp_tools:
      - get_principles
      - get_file_context
      - graph_query
      - semantic_search
    artifacts:
      - "${WORKSPACE}/research/refactor-scope.md"
    hitl: none
    notes: >
      Spawn canon-researcher in refactor-scope role. Identifies all affected
      files, existing test coverage, behavioral contracts to preserve, and
      dependency map. Recommends wave ordering (files with no dependents first).
      Present the analysis to user for approval before proceeding.

  - id: checkpoint
    agent: null
    dispatch: subagent
    mcp_tools: []
    artifacts: []
    hitl: approval
    notes: >
      Present the refactoring scope analysis to the user. User approves to
      proceed or requests revision (loops back to analyze). This is the
      architect-equivalent approval gate for refactoring flows.

  - id: implement
    agent: canon-implementor
    dispatch: team
    mcp_tools:
      - get_file_context
    artifacts:
      - "${WORKSPACE}/plans/${slug}/*-SUMMARY.md"
    hitl: none
    notes: >
      Create agent team with implementor teammates. CRITICAL: each change must
      preserve existing behavior. Run existing tests after each change. Gate on
      test-suite passing between waves. Create worktrees, merge after completion.

  - id: verify
    agent: canon-tester
    dispatch: subagent
    mcp_tools:
      - get_principles
      - get_file_context
    artifacts:
      - "${WORKSPACE}/plans/${slug}/TEST-REPORT.md"
    hitl: none
    notes: >
      Run full test suite to verify refactoring preserved behavior. Compare
      test results against pre-refactor baseline.

  - id: fix-impl
    agent: canon-fixer
    dispatch: subagent
    mcp_tools:
      - get_file_context
    artifacts:
      - "${WORKSPACE}/plans/${slug}/FIX-SUMMARY.md"
    hitl: none
    skip_when: "All tests pass"
    notes: >
      If refactoring broke behavior, fix the implementation (not the tests).
      Loop back to verify. Max 3 iterations.

  - id: context-sync
    agent: canon-scribe
    dispatch: subagent
    mcp_tools: []
    artifacts:
      - "${WORKSPACE}/context.md"
    hitl: none
    notes: >
      Spawn canon-scribe to update documentation for structural changes.

  - id: review
    agent: canon-reviewer
    dispatch: subagent
    mcp_tools:
      - get_principles
      - get_file_context
      - get_drift_report
    artifacts:
      - "${WORKSPACE}/plans/${slug}/REVIEW.md"
      - "${WORKSPACE}/reviews/"
    hitl: on_failure
    notes: >
      Review refactoring for principle compliance. Max 2 review/fix iterations.

  - id: fix-violations
    agent: canon-fixer
    dispatch: subagent
    mcp_tools:
      - get_file_context
    artifacts: []
    hitl: none
    skip_when: "Review verdict is CLEAN or WARNING"
    notes: >
      Fix BLOCKING violations. Loop back to review. Max 2 iterations.

  - id: pre-launch-check
    agent: null
    dispatch: subagent
    mcp_tools: []
    artifacts: []
    hitl: on_failure
    notes: >
      Run all discovered quality gates.

  - id: ship
    agent: canon-shipper
    dispatch: subagent
    mcp_tools: []
    artifacts:
      - "${WORKSPACE}/plans/${slug}/PR-DESCRIPTION.md"
    hitl: none
    notes: >
      Synthesize build artifacts into PR description.

  - id: learn
    agent: canon-learner
    dispatch: subagent
    mcp_tools: []
    artifacts: []
    hitl: none
    skip_when: "Learn gate not passed"
    notes: >
      Evaluate learn gate. If passed, spawn canon-learner.
```

**Verify flow coverage**:
- `feature.md`: states design, implement (wave), context-sync, verify, fix-impl (from fragment), review (from fragment), fix-violations (from fragment), pre-launch-check (from fragment), ship (from fragment), learn (from fragment), checkpoint (from fragment), done. Runbook covers all non-terminal states.
- `refactor.md`: states analyze, implement (wave), verify (from fragment), fix-impl (from fragment), context-sync (from fragment), review (from fragment), fix-violations (from fragment), pre-launch-check (from fragment), ship (from fragment), learn (from fragment), checkpoint (from fragment), done. Runbook covers all non-terminal states.

### Canon principles to apply

- **simplicity-first**: Wave steps are described as "create agent team with teammates" rather than introducing wave YAML semantics.
- **information-hiding**: The lead does not need to know about wave policies, merge strategies, or worktree lifecycle internals -- the runbook says "create worktrees, merge after completion."

### Tests to write

No tests -- YAML playbook files.

### Verify

1. Both files exist at `skills/canon/runbooks/{feature,refactor}.yaml`
2. Valid YAML
3. Step IDs match legacy flow states
4. `npm run build` and `npm test` still pass

### Done when

- Two runbook files exist and are valid YAML
- All states from their legacy flows are represented including fragment states
- Wave/team dispatch is clearly annotated for implementation steps
