---
task_id: "phase1-04"
wave: 1
depends_on:
  - "phase1-00"
files:
  - skills/canon/runbooks/test-gap.md
principles:
  - simplicity-first
  - information-hiding
domains: []
---

## Task: Create test-gap runbook

### Action

Create `skills/canon/runbooks/test-gap.md` — a runbook for analyzing test coverage gaps, writing tests, and reviewing. This flow has no ship step.

1. Read `flows/test-gap.md` for legacy state coverage.
2. Read `templates/runbook-template.md` for the runbook format.
3. Write `test-gap.md` following the template.

**States to cover** (from test-gap.md + fragments):
- `scan` (canon-researcher, dispatch: subagent) — analyze test coverage, identify gaps
- `write-tests` (canon-tester, dispatch: subagent) — write tests to fill gaps
- `fix-impl` (canon-engineer in fix mode, dispatch: subagent) — fix source bugs revealed by new tests
- `context-sync` (canon-scribe, dispatch: subagent) — update documentation
- `review` (canon-reviewer, dispatch: subagent, hitl: checkpoint) — review new tests for principle compliance
- `fix-violations` (canon-engineer in fix mode, dispatch: subagent) — fix review violations

**No ship step**: test-gap flows don't produce a PR. They improve coverage in-place.

**No learn step**: test-gap is a focused utility flow. Learn gate evaluation is optional — add as skip_when: "learn gate not passed" if included.

### Canon principles to apply

- **simplicity-first**: Shortest build runbook (6 steps, no ship).
- **information-hiding**: Each step encapsulates what the lead needs.

### Tests to write

No code tests. Verify YAML frontmatter parses.

### Verify

1. `skills/canon/runbooks/test-gap.md` exists and YAML parses
2. All states from test-gap.md + review-fix-loop fragment covered
3. No ship step
4. Step IDs match legacy state names

### Done when

- Test-gap runbook covers all states from test-gap.md + fragments
- Conforms to `templates/runbook-template.md` format
