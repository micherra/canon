---
task_id: "phase1-02"
wave: 1
depends_on:
  - "phase1-00"
files:
  - skills/canon/runbooks/feature.md
principles:
  - simplicity-first
  - information-hiding
domains: []
---

## Task: Create feature runbook (absorbs refactor as variant)

### Action

Create `skills/canon/runbooks/feature.md` — the medium-tier runbook covering 4–10 file features. Also absorbs the refactor flow as a variant annotation.

1. Read `flows/feature.md` and `flows/refactor.md` for legacy state coverage.
2. Read `templates/runbook-template.md` for the runbook format.
3. Write `feature.md` following the template.

**States to cover** (from feature.md + fragments):
- `design` (canon-architect, dispatch: subagent, hitl: approval) — competitive design with approval gate
- `implement` (canon-engineer, dispatch: team) — wave implementation, parallel per task
- `verify` (canon-engineer in fix mode, dispatch: subagent) — run tests, fix failures
- `fix-impl` (canon-engineer in fix mode, dispatch: subagent) — fix test failures
- `context-sync` (canon-scribe, dispatch: subagent) — update documentation
- `review` (canon-reviewer, dispatch: subagent, hitl: checkpoint) — principle compliance review
- `fix-violations` (canon-engineer in fix mode, dispatch: subagent) — fix review violations
- `pre-launch-check` (no agent, dispatch: subagent, hitl: on_failure) — run quality gates
- `ship` (canon-shipper, dispatch: subagent) — synthesize PR description
- `learn` (canon-learner, dispatch: subagent, skip_when: "learn gate not passed") — pattern analysis

**Refactor variant**: Add a notes section at the top of the body:
> When used for behavior-preserving restructuring: (1) start with a scope-analysis research step before design (spawn canon-researcher with role: refactor-scope), (2) emphasize behavior preservation in all engineer spawn prompts, (3) run verification after every implementation step.

**Wave step**: The `implement` step uses `dispatch: team`. Notes should document: create agent team from plan index, teammates claim tasks via shared task list, `TaskCompleted` hooks enforce artifacts, merge worktrees after wave completes.

### Canon principles to apply

- **simplicity-first**: One runbook for feature + refactor. Variant is a notes annotation, not a separate file.
- **information-hiding**: Each step encapsulates what the lead needs.

### Tests to write

No code tests. Verify YAML frontmatter parses.

### Verify

1. `skills/canon/runbooks/feature.md` exists and YAML parses
2. All 10 states from the expanded feature flow are covered
3. Refactor variant notes present
4. `implement` step has `dispatch: team`
5. Step IDs match legacy state names

### Done when

- Feature runbook covers all states from feature.md + fragments
- Refactor variant documented
- Conforms to `templates/runbook-template.md` format
