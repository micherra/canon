---
task_id: "phase1-06"
wave: 1
depends_on:
  - "phase1-00"
files:
  - skills/canon/runbooks/migrate.yaml
principles:
  - agent-plans-are-prompts
  - agent-design-before-code
domains:
  - orchestration
---

## Task: Create migrate runbook

### Action

Create `skills/canon/runbooks/migrate.yaml` — migration flow with rollback emphasis and security scanning.

Read `flows/migrate.md` and its included fragments. The full state sequence is:

1. `research` (parallel, canon-researcher, roles: [migration-scope, rollback-plan])
2. `design` (single, canon-architect, compete: 2 lenses [safety-first, minimal-disruption])
3. `checkpoint` (user-checkpoint — approval/revise)
4. `implement` (wave, canon-implementor)
5. `verify` / `fix-impl` (verify-fix-loop, role: migration-verify)
6. `security` / `fix-security` (security-scan)
7. `context-sync` (single, canon-scribe)
8. `review` / `fix-violations` (review-fix-loop, max 2 iterations)
9. `pre-launch-check` (gate-only)
10. `ship` / `learn` / `done` (ship-done)

```yaml
name: "migrate"
description: "Staged migration with rollback planning and verification at each stage"
tier: "medium"

steps:
  - id: "research"
    agent: "canon-researcher"
    dispatch: "subagent"
    mcp_tools:
      - get_file_context
      - graph_query
      - semantic_search
      - init_workspace
      - log_step
    artifacts:
      - "research/migration-scope.md"
      - "research/rollback-plan.md"
    hitl: "on_failure"
    skip_when: null
    notes: |
      Parallel research — spawn two subagents:
      1. migration-scope role: identify all files, configs, schemas,
         dependencies affected. Map current state and target state. Check
         for data that needs transformation.
      2. rollback-plan role: determine rollback strategy — can changes be
         reverted cleanly? Are there destructive data migrations? What is
         the safe rollback point?

  - id: "design"
    agent: "canon-architect"
    dispatch: "subagent"
    mcp_tools:
      - get_principles
      - get_file_context
      - graph_query
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
      Design staged migration plan. Competitive design with 2 lenses:
      safety-first and minimal-disruption. Inject rollback research
      findings into the architect's context.

      Key constraint: each wave must leave the system in a working state.
      If the migration involves data, design forward-compatible steps
      (old code works with new schema where possible). Include rollback
      instructions per stage.

      Present the plan to the user for approval. Max 3 revisions.

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
      Execute migration stages as waves. Each stage must leave the system
      in a working state. Verify after each stage — run tests, check for
      regressions. If a stage fails, the rollback plan from research
      defines the recovery path.

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
      Verify migration correctness. Run full test suite plus migration-
      specific checks: data integrity, schema compatibility, backward
      compatibility where required. If failures, spawn canon-fixer, then
      re-verify. Loop max 2 iterations.

  - id: "security"
    agent: "canon-security"
    dispatch: "subagent"
    mcp_tools:
      - get_principles
      - get_file_context
      - log_step
    artifacts:
      - "plans/${slug}/SECURITY.md"
    hitl: "on_failure"
    skip_when: null
    notes: |
      Scan migration for security issues — especially credential handling,
      connection strings, data exposure during migration, and permission
      changes. If critical findings, spawn fixer per finding, then re-scan.
      Unresolvable criticals go to user.

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
      Sync docs after migration implementation and verification.

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
      Review migration changes. Pay special attention to: data integrity,
      backward compatibility, rollback safety, and migration completeness.
      If blocking violations, spawn fixer, re-review. Max 2 iterations.
      Persist review.

  - id: "pre-launch-check"
    agent: null
    dispatch: "subagent"
    mcp_tools:
      - log_step
    artifacts: []
    hitl: "on_failure"
    skip_when: null
    notes: |
      Gate-only step. Run all discovered quality checks. Fail closed.

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
      Synthesize PR description. Include migration stages summary,
      rollback instructions, verification results, and security assessment.
      Call update_board complete_flow.

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
- **agent-plans-are-prompts**: The research step notes must distinguish the two parallel roles clearly. The implement step must emphasize the stage-by-stage working-state constraint.
- **agent-design-before-code**: The design step must include rollback instructions per stage as a first-class design requirement, not an afterthought.

### Risk mitigations
- **Rollback safety**: The design step notes must explicitly require rollback instructions per migration stage. This is the key differentiator of the migrate flow vs feature flow.
- **Security during migration**: The security step notes must call out migration-specific threats (credential exposure, data leakage during schema changes).

### Tests to write
- No code tests. YAML validation only.

### Verify
1. File exists at `skills/canon/runbooks/migrate.yaml`
2. Parses as valid YAML
3. 10 steps covering all states from `flows/migrate.md` and its fragments
4. Research step describes two parallel roles (migration-scope, rollback-plan)
5. Design step mentions rollback instructions per stage
6. Security step mentions migration-specific threats
7. Implement step emphasizes working-state-per-wave constraint
8. `npm run build` passes
9. `npm test` passes

### Done when
- `migrate.yaml` exists and parses as valid YAML
- All states from legacy flow represented as steps with correct agents
- Rollback emphasis is explicit in research, design, and implement step notes
- Security step covers migration-specific threats
- Build and tests pass unchanged
