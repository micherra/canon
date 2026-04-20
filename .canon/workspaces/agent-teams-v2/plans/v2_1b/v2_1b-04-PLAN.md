---
task_id: "v2_1b-04"
wave: 3
depends_on: []
decisions:
  - "dc-05"
files:
  - templates/implementation-log.md
  - agents/canon-engineer.md
principles:
  - agent-template-required
  - agent-surface-assumptions
domains:
  - infrastructure
---

## Task: Implementation-summary `justified_deviations[]` structured tag

### Action

Add `justified_deviations[]` as a structured frontmatter field on the implementation-log template. Amend `canon-engineer` to populate it when deviating from the task plan or runbook guidance with Canon-aligned justification.

**Template amendment** — extend `templates/implementation-log.md` frontmatter to include:

```yaml
justified_deviations:
  - principle_id: "{principle-id}"          # which Canon principle the deviation is justified against
    reason_short: "{≤ 140 chars explanation}"
    deviation_from: "{what the plan/runbook/convention expected}"
```

The field is **optional** — empty array (or omitted entirely) is the common case. It is populated only when the engineer deliberately deviates from plan guidance with a Canon-aligned justification.

**Semantics:**

- `principle_id` — the Canon principle the deviation honors (not the one it violates). Example: `agent-simplest-sufficient-design` justifies deviating from a plan that called for a class when a function suffices.
- `reason_short` — tight summary of why the deviation is justified (≤ 140 chars so it fits in tables and digests)
- `deviation_from` — what the plan / runbook / convention said to do, so the deviation is auditable

**canon-engineer amendment:**

- Agent body includes a Canon-Compliance section (if not already present) that notes any deviations made during the task
- When deviating, engineer adds a `justified_deviations[]` entry
- Engineer is the authoritative source for these entries — no one else can backfill them (they require the engineer's in-context reasoning about why deviation was warranted)
- **The engineer MUST NOT** use `justified_deviations[]` as a shortcut to skip plan steps or ignore reviewer feedback. It documents principled Canon-aligned choices, not disobedience.
- **The engineer MUST NOT** fabricate a principle_id. If no principle justifies the deviation, the engineer re-plans or escalates rather than deviating.

### Canon principles to apply

- **agent-template-required** — template is authoritative
- **agent-surface-assumptions** — deviations are surfaced explicitly rather than silently applied; auditable post-hoc

### Risk mitigations

- Observation tag compliance (§13 LOW/LOW): closed schema; indexer drops unknown fields
- Learner expands write scope too aggressively (§13 MEDIUM/LOW): `justified_deviations[]` feeds the learner's principle-refinement analysis — if a principle is repeatedly cited as justifying deviation from plans, the learner may propose narrowing the principle's scope. This is **exactly** the learning loop working as intended; the MEDIUM risk is about learner write scope, not about this data

### Tests to write

- `templates/__tests__/implementation-log.test.ts` (extend):
  - `justified_deviations` field present as an optional array in template
  - Each entry must have `principle_id`, `reason_short`, `deviation_from`
  - Template parse accepts empty / omitted field
- `agents/__tests__/canon-engineer.test.ts` (extend):
  - Engineer body references the `justified_deviations[]` rule
  - Body forbids fabrication (explicit text to that effect)
- Integration (runs in v2_1b-08):
  - Run a flow where the plan calls for X but the engineer sees a simpler Canon-principle-aligned path Y; engineer produces implementation-log with a populated `justified_deviations[]` entry; indexer stores it

### Verify

1. Template file carries the field per spec
2. canon-engineer body cites the rule
3. Tests pass
4. Integration test demonstrates a populated deviation entry

### Done when

- Template + engineer amendments merged
- Tests pass
- Integration test confirms population
- `justified_deviations[]` is the primary channel for tracking principle-aligned deviations; no other channel (review comment, chat message) is authoritative
