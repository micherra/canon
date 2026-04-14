---
task_id: "phase1-05"
wave: 1
depends_on:
  - "phase1-00"
files:
  - skills/canon/runbooks/epic.md
principles:
  - agent-plans-are-prompts
  - agent-design-before-code
domains:
  - orchestration
---

## Task: Create epic runbook

### Action

Create `skills/canon/runbooks/epic.md` — the most complex runbook. Multi-wave with consultations, competitive design, adaptive replan, and full test/security/review pipeline.

Read `flows/epic.md` and all included fragments. The full state sequence is:

1. `research` (parallel, canon-researcher, roles: [codebase, risk])
2. `design` (single, canon-architect, compete: 3 lenses, approval_gate)
3. `checkpoint` (user-checkpoint — approval/revise)
4. `implement` (wave, canon-implementor, with consultations: before=[plan-review], between=[pattern-check, early-scan, targeted-research], after=[impl-handoff])
5. `context-sync` (single, canon-scribe)
6. `test` / `fix-impl` / `context-sync-fix` (test-fix-loop)
7. `security` / `fix-security` (security-scan)
8. `review` / `fix-violations` (review-fix-loop, large_diff_threshold: 500)
9. `pre-launch-check` (gate-only)
10. `ship` / `learn` / `done` (ship-done)

Additionally, the epic flow has a `debate` block enabling researcher/architect team debates.

```yaml
name: "epic"
description: "Adaptive epic — research, competitive design, multi-wave implementation with replan, test, security, review"
tier: "large"

steps:
  - id: "research"
    agent: "canon-researcher"
    dispatch: "subagent"
    mcp_tools:
      - get_principles
      - get_file_context
      - graph_query
      - semantic_search
      - init_workspace
      - log_step
    artifacts:
      - "research/codebase.md"
      - "research/risk.md"
    hitl: "on_failure"
    skip_when: null
    notes: |
      Parallel research — spawn two subagents:
      1. codebase role: architecture, data flow, key abstractions, entry points
      2. risk role: risks, edge cases, failure modes, migration concerns
      Both save to research/{role}.md. After completion, the lead
      assembles a research synthesis for the architect.

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
      Competitive design — spawn 3 subagents with different lenses:
      performance, simplicity, extensibility. Each produces an independent
      design. The lead (or a synthesis subagent) merges the best ideas
      into a single design. Inject risk research findings into the
      architect's context. Include the North Star template section in
      the design document with machine-readable done criteria.

      After design: call write_design_brief for structured handoff to
      implementors. Write affected files to board metadata via
      update_board set_metadata.

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
      Multi-wave execution with adaptive replan. Create an agent team per
      wave from the plan index. Teammates claim tasks via shared task list.

      BEFORE each wave: spawn a plan-review consultation (canon-architect)
      to review upcoming wave plans for conflicts and ambiguity. Inject
      clarifications into implementor prompts.

      BETWEEN waves (from wave 2 onward): spawn three consultations:
      1. pattern-check (canon-architect): review wave output for pattern
         drift, convention consistency, and done criteria progress
      2. early-scan (canon-security): quick security scan of wave changes
      3. targeted-research (canon-researcher): research open questions
         from pattern-check (skip if no open questions)

      If pattern-check reports "all done criteria met", skip remaining
      waves and proceed to context-sync.

      If pattern-check proposes events (add_task, skip_task, reprioritize),
      the lead adapts the plan accordingly.

      AFTER all waves: spawn impl-handoff consultation (canon-architect)
      to produce implementation overview for downstream agents.

      Inter-wave gate: test-suite. Max 10 iterations.

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
      Sync docs after all implementation waves complete.

  - id: "test"
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
      Notes from all implementation summaries. Read plan files for risk
      mitigations. If tests reveal source bugs:
      1. Spawn canon-fixer (test-fix mode)
      2. Optionally spawn context-sync-fix (canon-scribe) if contract changed
      3. Re-test
      Loop max 2 iterations.

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
      Full security scan of all implemented code. Read architect plans
      (DESIGN.md, INDEX.md) for planned security controls verification.
      Read implementation summaries for code context. If critical findings,
      spawn canon-fixer (violation-fix mode) per finding, then re-scan.
      Max 2 fix iterations. Unresolvable criticals go to user.

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
      Review all changes. For large diffs (500+ lines), cluster by layer
      and fan out as parallel subagents. Cross-check implementation
      summaries. Read DESIGN.md for drift-from-plan detection. If blocking
      violations, spawn fixer, re-review. Max 3 iterations. Persist review.

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
      Synthesize PR description from all build artifacts. Include design
      decisions, implementation waves summary, test coverage, security
      assessment, and review verdict. Call update_board complete_flow.

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
      Auto-trigger pattern analysis across all flow transcripts.
      Skip if learn gate evaluation fails.
```

### Canon principles to apply
- **agent-plans-are-prompts**: The implement step's `notes` must thoroughly describe the consultation protocol — what runs before, between, and after waves. This is the most complex orchestration in Canon and the notes are the lead's primary guide.
- **agent-design-before-code**: The competitive design pattern (3 lenses) must be documented in the design step notes.

### Risk mitigations
- **Consultation protocol complexity**: The implement step has 4 types of consultations (plan-review, pattern-check, early-scan, targeted-research). The notes must be explicit about timing (before/between/after) and conditions (min_waves: 2 for between consultations, skip_when for targeted-research).
- **Adaptive replan**: Pattern-check can propose events that modify the plan. The notes must describe how the lead handles these (apply/reject/adapt).

### Tests to write
- No code tests. YAML validation only.

### Verify
1. File exists at `skills/canon/runbooks/epic.md`
2. Parses as valid YAML
3. 10 steps covering all states from `flows/epic.md` and its fragments
4. Implement step has `dispatch: team` and consultation protocol in notes
5. Design step describes competitive design (3 lenses)
6. Research step describes parallel roles (codebase, risk)
7. Fix-loop semantics documented for test, security, and review steps
8. `npm run build` passes
9. `npm test` passes

### Done when
- `epic.md` exists and parses as valid YAML
- All 10 steps map to legacy flow states and fragments
- The consultation protocol (before/between/after waves) is fully described
- Competitive design pattern documented
- Adaptive replan mechanism (pattern-check → events → plan adaptation) documented
- Build and tests pass unchanged
