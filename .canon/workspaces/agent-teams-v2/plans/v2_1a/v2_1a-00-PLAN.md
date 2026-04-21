---
task_id: "v2_1a-00"
wave: 1
depends_on: ["v2_1a-pre"]
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

Canon has no existing test infrastructure for skills/ markdown files. Options:

- **Preferred:** add minimal validation via the skills-manifest loader (if one exists) or via the integration test in v2_1a-02 / v2_1a-08 (which parses the vocabulary as part of synthesis validation — a failing vocabulary fails synthesis downstream).
- **If a skill-lint harness is desirable:** file a follow-up task to add `scripts/lint-skills.ts` that parses every `skills/canon/references/*.md` skill file for required frontmatter. Out of scope for this task.

Validation for v2_1a-00:

- Manual read: exactly 15 step entries; mandatory tail present; step IDs unique + lowercase-kebab; `fix` entry notes `cause` requirement
- Downstream integration (v2_1a-02): synthesis skill validates `skills:` references against this file at synthesis time — runs on every synthesized runbook

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
