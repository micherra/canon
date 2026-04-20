---
task_id: "v2_1a-00"
wave: 1
depends_on: []
decisions:
  - "dc-01"
files:
  - skills/canon/references/runbook-vocabulary.md
principles:
  - agent-design-before-code
  - agent-surface-assumptions
domains:
  - infrastructure
---

## Task: Create canonical step vocabulary

### Action

Write `skills/canon/references/runbook-vocabulary.md` as the canonical list of step IDs Canon knows. This is the data layer that `planner-brief.md` and `runbook-synthesis.md` (v2_1a-01, v2_1a-02) reference strictly.

**Structure:**

- Front-matter declaring this as a skill file, discoverable under the Canon skills registry
- Versioning policy (semver: minor = additive; major = removal after deprecation cycle)
- Table of the 15 canonical step IDs per v2.1 §5.1:

| Step ID | Default agent | Dispatch | Default HITL | Purpose |
|---------|---------------|----------|--------------|---------|
| `research` | canon-researcher | subagent | none | Investigation — any scope |
| `design` | canon-architect | subagent | approval | Plan index + design decisions |
| `spike` | canon-engineer | subagent | none | Time-boxed exploratory prototype |
| `implement` | canon-engineer | subagent or team | none | Build code with TDD/BDD |
| `migrate` | canon-engineer | subagent | none | Schema/data migration execution (pairs with rollback artifact) |
| `verify` | canon-engineer | subagent | on_failure | Run existing tests/gates post-change |
| `test` | canon-tester | subagent | none | Net-new integration tests; coverage-gap fills |
| `benchmark` | canon-tester | subagent | on_failure | Performance verification against baseline |
| `security` | canon-security | subagent | none | Security assessment |
| `review` | canon-reviewer | subagent | checkpoint | Principle compliance |
| `fix` | canon-engineer | subagent | on_failure | Fix mode (requires `cause: test-failure\|security\|review\|verify`) |
| `pre-launch-check` | null | n/a | on_failure | Gate-only — lead runs discovered checks via Bash |
| `ship` | canon-shipper | subagent | on_failure | PR description synthesis |
| `context-sync` | canon-scribe | subagent | none | Doc sync — **mandatory tail** |
| `learn` | canon-learner | subagent | none | Pattern analysis — **mandatory tail** |

Total: 15 entries (13 functional + 2 mandatory tail).

- Vocabulary evolution discipline section (minor = additive; major = deprecation cycle of at least one minor version before removal)
- Resume-behavior subsection for cross-vocab-version runbook resumes (per v2.1 §5.1): locked runbooks continue with synthesis-time vocab unless a referenced entry was removed; regeneration with workspace context + re-approval required

### Canon principles to apply

- **agent-design-before-code** — vocabulary is the design substrate; every downstream skill references it strictly
- **agent-surface-assumptions** — document the semver discipline explicitly so downstream tools know what changes are safe

### Risk mitigations

- Vocabulary drift (§13 risk, LOW/LOW): include an explicit version field in the file's frontmatter; require versioned-migration review for any change

### Tests to write

- `skills/canon/references/__tests__/runbook-vocabulary.test.ts`:
  - Parse the vocabulary file; assert exactly 15 entries
  - Assert mandatory tail IDs (`context-sync`, `learn`) present with `canon-scribe` / `canon-learner` defaults
  - Assert every step ID is unique and lowercase-kebab
  - Assert `fix` entry requires `cause` field note in its purpose cell

### Verify

1. `skills/canon/references/runbook-vocabulary.md` exists and parses as markdown
2. Vocabulary test passes: `npm test -- runbook-vocabulary`
3. Grep confirms no other file redefines the same step-ID list — this is the single source of truth
4. Skills registry (if manifest-driven) loads the file without errors

### Done when

- File exists at the specified path with all 15 entries matching the table above
- Versioning discipline section present
- Resume behavior section present
- All tests pass
- File is registered in the skills manifest so `agent-context-check` can load it on demand
