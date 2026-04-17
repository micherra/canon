---
task_id: "phase1-03"
wave: 1
depends_on:
  - "phase1-00"
files:
  - skills/canon/runbooks/epic.md
  - skills/canon/runbooks/migrate.md
principles:
  - simplicity-first
  - information-hiding
domains: []
---

## Task: Create epic and migrate runbooks (large-tier flows)

### Action

Create two runbooks for the most complex Canon flows.

#### 1. `skills/canon/runbooks/epic.md`

Read `flows/epic.md` for legacy state coverage. Epic is the most complex flow: parallel research, competitive design, multi-wave implementation with consultations, testing, security scanning, and review.

**States to cover** (from epic.md + fragments):
- `research` (canon-researcher, dispatch: subagent) — parallel research dimensions (codebase + risk)
- `design` (canon-architect, dispatch: subagent, hitl: approval) — competitive synthesis, produces plan index with wave assignments
- `implement` (canon-engineer, dispatch: team) — multi-wave. Adaptive: after wave N, architect may replan wave N+1 based on results. Notes should document consultation protocol (before/between/after wave advisory spawns).
- `test` (canon-tester, dispatch: subagent) — write integration tests, fill coverage gaps
- `fix-impl` (canon-engineer in fix mode, dispatch: subagent) — fix test failures
- `security` (canon-security, dispatch: subagent) — security assessment
- `fix-security` (canon-engineer in fix mode, dispatch: subagent) — fix security findings
- `context-sync` (canon-scribe, dispatch: subagent) — update documentation
- `review` (canon-reviewer, dispatch: subagent, hitl: checkpoint) — principle compliance
- `fix-violations` (canon-engineer in fix mode, dispatch: subagent) — fix violations
- `pre-launch-check` (no agent, hitl: on_failure) — quality gates
- `ship` (canon-shipper, dispatch: subagent) — PR description
- `learn` (canon-learner, dispatch: subagent, skip_when: "learn gate not passed")

**Multi-wave notes**: The `implement` step body should document: wave advancement (after wave N completes, lead reads artifacts and decides whether to continue or replan), consultation protocol (spawn advisory subagent between waves), worktree merge strategy.

#### 2. `skills/canon/runbooks/migrate.md`

Read `flows/migrate.md` for legacy state coverage. Migrate emphasizes rollback planning, parallel research dimensions (migration-scope + rollback-plan), and security scanning.

**States to cover** (from migrate.md + fragments):
- `research` (canon-researcher, dispatch: subagent) — parallel: migration-scope + rollback-plan dimensions
- `design` (canon-architect, dispatch: subagent, hitl: approval) — competitive synthesis with rollback emphasis
- `implement` (canon-engineer, dispatch: team) — wave implementation
- `verify` (canon-engineer in fix mode, dispatch: subagent) — verify migration + rollback
- `fix-impl` (canon-engineer in fix mode, dispatch: subagent) — fix failures
- `security` (canon-security, dispatch: subagent) — security assessment
- `fix-security` (canon-engineer in fix mode, dispatch: subagent) — fix security findings
- `context-sync` (canon-scribe, dispatch: subagent) — update documentation
- `review` (canon-reviewer, dispatch: subagent, hitl: checkpoint) — principle compliance
- `fix-violations` (canon-engineer in fix mode, dispatch: subagent) — fix violations
- `pre-launch-check` (no agent, hitl: on_failure) — quality gates
- `ship` (canon-shipper, dispatch: subagent) — PR description
- `learn` (canon-learner, dispatch: subagent, skip_when: "learn gate not passed")

**Rollback notes**: The body should emphasize that every implementation step must consider rollback. The research step produces a rollback plan alongside the migration scope.

### Canon principles to apply

- **simplicity-first**: Despite complexity, the runbook is still a linear step list. Claude handles adaptive behavior (replan between waves) via judgment, not YAML branching.
- **information-hiding**: Each step encapsulates what the lead needs.

### Tests to write

No code tests. Verify YAML frontmatter parses for both files.

### Verify

1. Both files exist and YAML parses
2. Epic covers all states from epic.md + fragments (13 states)
3. Migrate covers all states from migrate.md + fragments (13 states)
4. Both `implement` steps have `dispatch: team`
5. Epic documents consultation protocol
6. Migrate documents rollback emphasis
7. Step IDs match legacy state names

### Done when

- Both runbooks cover all states from their legacy flows
- Conform to `templates/runbook-template.md` format
