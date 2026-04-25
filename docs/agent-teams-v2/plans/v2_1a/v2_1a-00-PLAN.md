---
task_id: "v2_1a-00"
wave: 1
depends_on: ["v2_1a-pre"]
decisions:
  - "dc-01"
files:
  - references/runbook-vocabulary.md
principles:
  - agent-design-before-code
  - agent-surface-assumptions
domains:
  - infrastructure
---

## Task: Create canonical step vocabulary

### Action

Write `references/runbook-vocabulary.md` as the canonical list of step IDs Canon knows. This is the data layer that `planner-brief.md` and `runbook-synthesis.md` (v2_1a-01, v2_1a-02) reference strictly.

**Structure:**

- Markdown title and version declaration (Canon reference convention — no YAML frontmatter needed; other `references/*.md` files use plain markdown headers)
- Versioning policy (semver: minor = additive; major = removal after deprecation cycle)
- Table of the 15 canonical step IDs per v2.1 §5.1:

| Step ID | Default agent | Dispatch | Default HITL | Purpose |
|---------|---------------|----------|--------------|---------|
| `research` | researcher | subagent | none | Investigation — any scope |
| `design` | architect | subagent | approval | Plan index + design decisions |
| `spike` | engineer | subagent | none | Time-boxed exploratory prototype |
| `implement` | engineer | subagent or team | none | Build code with TDD/BDD |
| `migrate` | engineer | subagent | none | Schema/data migration execution (pairs with rollback artifact) |
| `verify` | engineer | subagent | on_failure | Run existing tests/gates post-change |
| `test` | tester | subagent | none | Net-new integration tests; coverage-gap fills |
| `benchmark` | tester | subagent | on_failure | Performance verification against baseline |
| `security` | security | subagent | none | Security assessment |
| `review` | reviewer | subagent | checkpoint | Principle compliance |
| `fix` | engineer | subagent | on_failure | Fix mode (requires `cause: test-failure\|security\|review\|verify`) |
| `pre-launch-check` | null | n/a | on_failure | Gate-only — lead runs discovered checks via Bash |
| `ship` | shipper | subagent | on_failure | PR description synthesis |
| `context-sync` | scribe | subagent | none | Doc sync — **mandatory tail** |
| `learn` | learner | subagent | none | Pattern analysis — **mandatory tail** |

Total: 15 entries (13 functional + 2 mandatory tail).

- Vocabulary evolution discipline section (minor = additive; major = deprecation cycle of at least one minor version before removal)
- Resume-behavior subsection for cross-vocab-version runbook resumes (per v2.1 §5.1): locked runbooks continue with synthesis-time vocab unless a referenced entry was removed; regeneration with workspace context + re-approval required

### Canon principles to apply

- **agent-design-before-code** — vocabulary is the design substrate; every downstream skill references it strictly
- **agent-surface-assumptions** — document the semver discipline explicitly so downstream tools know what changes are safe

### Risk mitigations

- Vocabulary drift (§13 risk, LOW/LOW): include an explicit version declaration in the file header; require versioned-migration review for any change

### Tests to write

Canon has no existing test infrastructure for `references/` markdown files. Options:

- **Preferred:** add minimal validation via the integration test in v2_1a-02 / v2_1a-08 (which parses the vocabulary as part of synthesis validation — a failing vocabulary fails synthesis downstream).
- **If a reference-lint harness is desirable:** file a follow-up task to add a lint script that parses every `references/*.md` file for required structure. Out of scope for this task.

Validation for v2_1a-00:

- Manual read: exactly 15 step entries; mandatory tail present; step IDs unique + lowercase-kebab; `fix` entry notes `cause` requirement
- Downstream integration (v2_1a-02): synthesis skill validates step ID references against this file at synthesis time — runs on every synthesized runbook

### Verify

1. `references/runbook-vocabulary.md` exists and parses as markdown
2. Grep confirms no other file redefines the same step-ID list — this is the single source of truth
3. `npm run build` and `npm test` pass (no regressions — this is a data file, not code)

### Done when

- File exists at the specified path with all 15 entries matching the table above
- Versioning discipline section present
- Resume behavior section present
- `npm run build` and `npm test` pass
- File is discoverable under `references/` so `resolve_agent_skills` can preload it when agents declare it in their `references:` frontmatter (v2_1a-03 wires the planner to reference it)
