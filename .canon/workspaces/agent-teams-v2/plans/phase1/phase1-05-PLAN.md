---
task_id: "phase1-05"
wave: 1
depends_on: []
decisions:
  - "runbook-yaml-structure"
files:
  - skills/canon/runbooks/epic.yaml
principles:
  - simplicity-first
  - information-hiding
domains: []
---

## Task: Create epic runbook (large-tier with multi-wave, consultations, adaptive replan)

### Action

Create `skills/canon/runbooks/epic.yaml` -- the most complex runbook. The epic flow includes parallel research, competitive design synthesis, multi-wave implementation with consultations, testing, security scanning, and review.

```yaml
name: epic
description: "Adaptive epic pipeline -- research, design, multi-wave implementation, test, security, review"
tier: large

steps:
  - id: research
    agent: canon-researcher
    dispatch: subagent
    mcp_tools:
      - get_principles
      - get_file_context
      - graph_query
      - semantic_search
      - codebase_graph
    artifacts:
      - "${WORKSPACE}/research/codebase.md"
      - "${WORKSPACE}/research/risk.md"
    hitl: none
    notes: >
      Spawn parallel canon-researcher subagents: one for codebase research,
      one for risk research. Each produces a research finding document.
      Both researchers have full Canon MCP access to query the knowledge graph,
      search semantically, and load file context.

  - id: design
    agent: canon-architect
    dispatch: subagent
    mcp_tools:
      - get_principles
      - get_file_context
      - graph_query
      - semantic_search
      - codebase_graph
      - update_board
    artifacts:
      - "${WORKSPACE}/plans/${slug}/DESIGN.md"
      - "${WORKSPACE}/plans/${slug}/INDEX.md"
      - "${WORKSPACE}/plans/${slug}/*-PLAN.md"
      - "${WORKSPACE}/decisions/"
      - "${WORKSPACE}/context.md"
    hitl: approval
    notes: >
      Spawn canon-architect with research findings (especially risk.md).
      For competitive synthesis: spawn 3 architect subagents with different
      lenses (performance, simplicity, extensibility), then synthesize their
      outputs into a unified design. The design MUST include a North Star
      section with machine-readable done criteria in frontmatter.
      Present the plan to the user for approval. Max 3 revision rounds.
      After approval, the architect calls update_board to set affected_files
      metadata (triggers file claim registration).

  - id: implement
    agent: canon-implementor
    dispatch: team
    mcp_tools:
      - get_file_context
    artifacts:
      - "${WORKSPACE}/plans/${slug}/*-SUMMARY.md"
    hitl: none
    notes: >
      Multi-wave implementation. For each wave in the plan index:
      1. Create agent team with one canon-implementor teammate per task
      2. Create git worktrees for each teammate
      3. Teammates coordinate via shared task list and Mailbox
      4. Gate on test-suite passing between waves
      5. After wave completes, merge worktrees
      6. Run between-wave consultations: pattern-check, early-scan,
         targeted-research (spawn subagents for each)
      7. Evaluate done criteria from DESIGN.md -- if all met, skip remaining
         waves and proceed to pre-launch-check (epic_complete transition)
      8. If not complete, architect may replan remaining waves based on
         what was learned (adaptive replanning)
      After final wave, run after-consultations: impl-handoff (spawn subagent).
      Max 10 waves total. If stuck (no gate progress), present to user.

  - id: context-sync
    agent: canon-scribe
    dispatch: subagent
    mcp_tools: []
    artifacts:
      - "${WORKSPACE}/context.md"
    hitl: none
    notes: >
      Spawn canon-scribe to update documentation for implementation changes.

  - id: test
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
      Focus on cross-task integration testing.

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
      Fix source code bugs revealed by tests. Loop back to test. Max 3
      iterations of the test/fix loop.

  - id: security
    agent: canon-security
    dispatch: subagent
    mcp_tools:
      - get_principles
      - get_file_context
    artifacts:
      - "${WORKSPACE}/plans/${slug}/SECURITY.md"
    hitl: on_failure
    notes: >
      Spawn canon-security to scan implemented code for vulnerabilities.
      If critical findings, present to user. If non-critical, proceed to
      fix-security or review.

  - id: fix-security
    agent: canon-fixer
    dispatch: subagent
    mcp_tools:
      - get_file_context
    artifacts: []
    hitl: none
    skip_when: "No security findings or all findings are informational"
    notes: >
      Fix security vulnerabilities. Preserve behavior, verify with tests.
      After fixing, re-scan if critical findings remain.

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
      Four-stage review. Large diff threshold: 500 lines (higher than default
      due to epic scope). Call store_pr_review after review completes. If
      BLOCKING, proceed to fix-violations then re-review. Max 3 iterations.

  - id: fix-violations
    agent: canon-fixer
    dispatch: subagent
    mcp_tools:
      - get_file_context
    artifacts: []
    hitl: none
    skip_when: "Review verdict is CLEAN or WARNING"
    notes: >
      Fix BLOCKING violations. Loop back to review.

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

**Verify flow coverage**: Compare against `flows/epic.md`. Legacy states: research (parallel), design (compete), implement (wave+consultations+gate+stuck), context-sync, test (from fragment), fix-impl (from fragment), security (from fragment), fix-security (from fragment), review (from fragment), fix-violations (from fragment), pre-launch-check (from fragment), ship (from fragment), learn (from fragment), done (terminal). Plus consultation fragments: plan-review, pattern-check, early-scan, impl-handoff, targeted-research. The runbook covers all non-terminal states and incorporates consultation handling into the implement step notes.

### Canon principles to apply

- **simplicity-first**: Despite the epic flow's complexity, the runbook is still a flat step list. Multi-wave behavior and consultations are described in step notes, not as YAML nesting.
- **information-hiding**: Wave management details (worktree creation, merge strategies, consultation scheduling) are encapsulated in the implement step's notes.

### Tests to write

No tests -- YAML playbook file.

### Verify

1. File exists at `skills/canon/runbooks/epic.yaml`
2. Valid YAML
3. All legacy states covered including fragment and consultation states
4. `npm run build` and `npm test` still pass

### Done when

- Epic runbook exists and is valid YAML
- All states from the legacy epic flow are represented
- Multi-wave, consultation, adaptive replan, and competitive synthesis are documented in step notes
- Done criteria evaluation (epic_complete transition) is documented
