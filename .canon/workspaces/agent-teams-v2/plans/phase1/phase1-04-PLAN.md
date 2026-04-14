---
task_id: "phase1-04"
wave: 1
depends_on:
  - "phase1-00"
files:
  - skills/canon/runbooks/feature.md
  - skills/canon/runbooks/refactor.md
principles:
  - agent-plans-are-prompts
  - agent-design-before-code
domains:
  - orchestration
---

## Task: Create feature and refactor runbooks

### Action

Create two medium-tier runbooks. Both include `dispatch: team` wave steps for parallel implementation. These are more complex than fast-path — they have design, implementation waves, testing, review, and ship phases.

#### 1. `feature.md`

Read `flows/feature.md` and its included fragments. The full state sequence is:
- `design` (single, canon-architect, approval_gate)
- `checkpoint` (user-checkpoint fragment — approval/revise)
- `implement` (wave, canon-implementor)
- `context-sync` (single, canon-scribe)
- `verify` / `fix-impl` (verify-fix-loop fragment — tester + fixer loop)
- `review` / `fix-violations` (review-fix-loop fragment)
- `pre-launch-check` (gate-only)
- `ship` (single, canon-shipper)
- `learn` (single, canon-learner, skip_when)

```yaml
name: "feature"
description: "Design, implement in parallel waves, test, review, and ship a feature"
tier: "medium"

steps:
  - id: "design"
    agent: "canon-architect"
    dispatch: "subagent"
    mcp_tools:
      - get_principles
      - get_file_context
      - graph_query
      - semantic_search
      - init_workspace
      - log_step
    artifacts:
      - "plans/${slug}/DESIGN.md"
      - "plans/${slug}/INDEX.md"
      - "plans/${slug}/${task_id}-PLAN.md"
      - "decisions/"
      - "context.md"
    hitl: "approval"
    skip_when: null
    notes: |
      Design the technical approach. Produce design document, task plans
      with wave assignments, plan index, and decision records. Initialize
      context.md. Present the plan to the user for approval before
      implementation. If user requests revisions, re-design (max 3 revisions).
      Write affected files to board metadata via update_board set_metadata.

  - id: "implement"
    agent: "canon-implementor"
    dispatch: "team"
    mcp_tools:
      - get_principles
      - get_file_context
      - log_step
    artifacts:
      - "plans/${slug}/${task_id}-SUMMARY.md"
    hitl: "none"
    skip_when: null
    notes: |
      Wave execution. Create an agent team from the plan index. Each
      teammate claims one task from the shared task list. Teammates
      self-coordinate via Mailbox. TaskCompleted hooks enforce artifact
      production. After each wave, merge worktrees. Run inter-wave gates
      if configured. Continue waves until plan index is complete.

  - id: "context-sync"
    agent: "canon-scribe"
    dispatch: "subagent"
    mcp_tools:
      - log_step
    artifacts:
      - "plans/${slug}/CONTEXT-SYNC.md"
    hitl: "none"
    skip_when: "no_contract_changes"
    notes: |
      Sync CLAUDE.md, context.md, and CONVENTIONS.md after implementation.
      Diff source: implementation commits since design. Skip if no contract
      or convention changes detected.

  - id: "verify"
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
      Write integration tests and fill coverage gaps. Start with Coverage
      Notes from implementation summaries. Read plan files for risk
      mitigations sections. If tests reveal source bugs, spawn canon-fixer
      (test-fix mode), then re-verify. Loop max 2 iterations.

  - id: "review"
    agent: "canon-reviewer"
    dispatch: "subagent"
    mcp_tools:
      - get_principles
      - get_file_context
      - review_code
      - log_step
    artifacts:
      - "plans/${slug}/REVIEW.md"
      - "reviews/"
    hitl: "checkpoint"
    skip_when: null
    notes: |
      Review changes via git diff. Cross-check against implementation
      summaries. Read DESIGN.md and INDEX.md for drift-from-plan detection.
      If blocking violations, spawn canon-fixer (violation-fix mode), then
      re-review. Loop max 3 iterations. Persist review via store_pr_review.

  - id: "pre-launch-check"
    agent: null
    dispatch: "subagent"
    mcp_tools:
      - log_step
    artifacts: []
    hitl: "on_failure"
    skip_when: null
    notes: |
      Gate-only step. Run all discovered quality-check commands. If all
      pass, proceed to ship. If any fail, present to user.

  - id: "ship"
    agent: "canon-shipper"
    dispatch: "subagent"
    mcp_tools:
      - log_step
      - update_board
    artifacts:
      - "plans/${slug}/PR-DESCRIPTION.md"
    hitl: "on_failure"
    skip_when: null
    notes: |
      Synthesize build artifacts into PR description. Read all summaries,
      design doc, test report, review verdict. Run git log for commit
      history. Call update_board complete_flow at the end.

  - id: "learn"
    agent: "canon-learner"
    dispatch: "subagent"
    mcp_tools:
      - log_step
      - get_drift_report
    artifacts: []
    hitl: "none"
    skip_when: "learn_gate_not_passed"
    notes: |
      Auto-trigger pattern analysis. Analyze transcripts and drift data.
      Skip if learn gate evaluation fails.
```

#### 2. `refactor.md`

Read `flows/refactor.md` and its included fragments. The full state sequence is:
- `analyze` (single, canon-researcher, role: refactor-scope)
- `checkpoint` (user-checkpoint — approval/revise)
- `implement` (wave, canon-implementor)
- `verify` / `fix-impl` (verify-fix-loop)
- `context-sync` (single, canon-scribe)
- `review` / `fix-violations` (review-fix-loop)
- `pre-launch-check` (gate-only)
- `ship` / `learn` / `done` (ship-done)

```yaml
name: "refactor"
description: "Behavior-preserving restructuring with continuous test verification"
tier: "medium"

steps:
  - id: "analyze"
    agent: "canon-researcher"
    dispatch: "subagent"
    mcp_tools:
      - get_file_context
      - graph_query
      - semantic_search
      - init_workspace
      - log_step
    artifacts:
      - "research/refactor-scope.md"
    hitl: "approval"
    skip_when: null
    notes: |
      Analyze refactoring scope. Identify all files affected, existing test
      coverage, and behavioral contracts to preserve. Map dependencies.
      Key outputs: file list, test coverage map, behavioral contracts,
      risk areas, recommended wave ordering (files with no dependents first).
      Present analysis to user for approval before implementation.

  - id: "implement"
    agent: "canon-implementor"
    dispatch: "team"
    mcp_tools:
      - get_principles
      - get_file_context
      - log_step
    artifacts:
      - "plans/${slug}/${task_id}-SUMMARY.md"
    hitl: "none"
    skip_when: null
    notes: |
      CRITICAL: preserve all existing behavior. Wave execution per plan
      index. Run existing tests after each change to verify nothing breaks.
      Each wave must leave the test suite green.

  - id: "verify"
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
      Run full test suite to verify refactoring preserved behavior. Compare
      test results against pre-refactor baseline. If failures, spawn
      canon-fixer to restore correct behavior (fix source, not tests).
      Loop max 2 iterations.

  - id: "context-sync"
    agent: "canon-scribe"
    dispatch: "subagent"
    mcp_tools:
      - log_step
    artifacts:
      - "plans/${slug}/CONTEXT-SYNC.md"
    hitl: "none"
    skip_when: "no_contract_changes"
    notes: |
      Sync docs after implementation. Diff source: implementation commits.
      Skip if no contract changes.

  - id: "review"
    agent: "canon-reviewer"
    dispatch: "subagent"
    mcp_tools:
      - get_principles
      - get_file_context
      - review_code
      - log_step
    artifacts:
      - "plans/${slug}/REVIEW.md"
      - "reviews/"
    hitl: "checkpoint"
    skip_when: null
    notes: |
      Review refactored code. Focus on behavior preservation and principle
      compliance. If blocking violations, spawn fixer, re-review. Max 2
      iterations. Persist review.

  - id: "pre-launch-check"
    agent: null
    dispatch: "subagent"
    mcp_tools:
      - log_step
    artifacts: []
    hitl: "on_failure"
    skip_when: null
    notes: |
      Gate-only step. Run discovered quality checks. Fail closed.

  - id: "ship"
    agent: "canon-shipper"
    dispatch: "subagent"
    mcp_tools:
      - log_step
      - update_board
    artifacts:
      - "plans/${slug}/PR-DESCRIPTION.md"
    hitl: "on_failure"
    skip_when: null
    notes: |
      Synthesize PR description from build artifacts.

  - id: "learn"
    agent: "canon-learner"
    dispatch: "subagent"
    mcp_tools:
      - log_step
      - get_drift_report
    artifacts: []
    hitl: "none"
    skip_when: "learn_gate_not_passed"
    notes: |
      Auto-trigger pattern analysis. Skip if learn gate fails.
```

### Canon principles to apply
- **agent-plans-are-prompts**: Wave steps must clearly describe the team dispatch pattern — shared task list, Mailbox coordination, TaskCompleted hooks.
- **agent-design-before-code**: Both runbooks have an explicit design/analysis step before implementation.

### Tests to write
- No code tests. YAML validation only.

### Verify
1. Both files exist at `skills/canon/runbooks/{feature,refactor}.md`
2. Both parse as valid YAML
3. `feature.md`: 8 steps covering design through learn
4. `refactor.md`: 8 steps covering analyze through learn
5. Both have `dispatch: team` on the implement step
6. HITL patterns: `approval` on design/analyze, `checkpoint` on review, `on_failure` elsewhere
7. `npm run build` passes
8. `npm test` passes

### Done when
- Both runbooks exist and parse as valid YAML
- Implementation steps use `dispatch: team` for wave execution
- All states from legacy flows are represented as steps
- Fix-loop semantics documented in verify and review step notes
- Build and tests pass unchanged
