---
task_id: "phase1-06"
wave: 1
depends_on: []
decisions:
  - "runbook-yaml-structure"
files:
  - skills/canon/runbooks/migrate.yaml
principles:
  - simplicity-first
  - information-hiding
domains: []
---

## Task: Create migrate runbook (medium-tier with rollback emphasis)

### Action

Create `skills/canon/runbooks/migrate.yaml` -- the migration flow runbook. Similar structure to feature but with parallel research (migration-scope + rollback-plan) and security scanning.

```yaml
name: migrate
description: "Staged migration with rollback planning and verification at each stage"
tier: medium

steps:
  - id: research
    agent: canon-researcher
    dispatch: subagent
    mcp_tools:
      - get_principles
      - get_file_context
      - graph_query
      - semantic_search
    artifacts:
      - "${WORKSPACE}/research/migration-scope.md"
      - "${WORKSPACE}/research/rollback-plan.md"
    hitl: none
    notes: >
      Spawn parallel canon-researcher subagents: one for migration-scope
      (affected files, configs, schemas, dependencies, current vs target state,
      data transformations), one for rollback-plan (rollback strategy, destructive
      data migrations, safe rollback points). Each produces a research finding.

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
      Spawn canon-architect with both research findings (especially rollback
      findings). Key constraint: each wave must leave the system in a working
      state. For data migrations, design forward-compatible steps. Include
      rollback instructions per stage. For competitive synthesis: spawn 2
      architect subagents with lenses (safety-first, minimal-disruption).
      Present plan to user for approval.

  - id: implement
    agent: canon-implementor
    dispatch: team
    mcp_tools:
      - get_file_context
    artifacts:
      - "${WORKSPACE}/plans/${slug}/*-SUMMARY.md"
    hitl: none
    notes: >
      Create agent team per wave. Each migration stage must leave the system
      working. Gate on test-suite passing between waves. Create worktrees,
      merge after completion. Verify system works after each stage.

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
      Verify migration correctness: full test suite plus migration-specific
      checks (data integrity, schema compatibility, backward compatibility).

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
      Fix migration issues. Pay special attention to data integrity and
      backward compatibility. Loop back to verify. Max 3 iterations.

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
      Scan migration for security issues: credential handling, connection
      strings, data exposure during migration, permission changes.

  - id: fix-security
    agent: canon-fixer
    dispatch: subagent
    mcp_tools:
      - get_file_context
    artifacts: []
    hitl: none
    skip_when: "No critical security findings"
    notes: >
      Fix critical security vulnerabilities in migration code.

  - id: context-sync
    agent: canon-scribe
    dispatch: subagent
    mcp_tools: []
    artifacts:
      - "${WORKSPACE}/context.md"
    hitl: none
    notes: >
      Spawn canon-scribe to update documentation for migration changes.

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
      Review migration for principle compliance. Max 2 review/fix iterations.

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

**Verify flow coverage**: Compare against `flows/migrate.md`. Legacy states: research (parallel: migration-scope, rollback-plan), design (compete: safety-first, minimal-disruption), implement (wave), verify (from fragment), fix-impl (from fragment), security (from fragment), fix-security (from fragment), context-sync (from fragment), review (from fragment), fix-violations (from fragment), pre-launch-check (from fragment), ship (from fragment), learn (from fragment), done. Runbook covers all non-terminal states.

### Canon principles to apply

- **simplicity-first**: Flat step list. Rollback emphasis is in notes, not structure.
- **information-hiding**: Migration-specific details (forward-compatible steps, data integrity) in notes.

### Tests to write

No tests -- YAML playbook file.

### Verify

1. File exists at `skills/canon/runbooks/migrate.yaml`
2. Valid YAML
3. All legacy states covered
4. `npm run build` and `npm test` still pass

### Done when

- Migrate runbook exists and is valid YAML
- All states from the legacy migrate flow are represented
- Rollback emphasis and migration-specific verification are documented
