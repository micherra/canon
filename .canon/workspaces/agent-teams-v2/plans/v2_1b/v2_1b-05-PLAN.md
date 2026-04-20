---
task_id: "v2_1b-05"
wave: 3
depends_on: []
decisions:
  - "dc-06"
files:
  - templates/review-checklist.md
  - agents/canon-reviewer.md
principles:
  - agent-template-required
  - agent-evidence-over-intuition
domains:
  - infrastructure
---

## Task: Review-finding `principle_id` consistency

### Action

Ensure every review finding carries a populated `principle_id`. The drift-db `violations` table has had the column indexed since v1, but population has been inconsistent. This task makes it **required** at the template + agent-prompt layer so v2.1b's learner analysis (v2_1b-06) has complete data.

**Template amendment** — extend `templates/review-checklist.md` so each finding's frontmatter / structured block requires:

```yaml
findings:
  - principle_id: "{principle-id}"        # required — MUST be a real principle ID from principles/
    severity: "HIGH | MEDIUM | LOW"
    file_path: "{path/to/file.ts}"
    line_range: "{N}-{M}"                 # optional
    description: "{human-readable finding}"
    suggested_fix: "{≤ 200 chars}"
```

**canon-reviewer amendment:**

- Reviewer's process section explicitly requires `principle_id` on every finding
- If the reviewer cannot map a finding to a principle, the finding MUST NOT be emitted. Either:
  1. Dig deeper until a principle applies (most findings map to *some* principle)
  2. File a note in the `## Observations` section (not `## Findings`) describing what was seen without a principle backing
  3. If the pattern recurs across reviews, the reviewer escalates to the `canon-writer` path (intent: `principle`) to propose a new principle
- Finding without `principle_id` → invalid review artifact → `verify_completion` rejects

**Why this matters for v2.1b:** the learner's principle-refinement analysis (v2_1b-06) JOINs lifecycle snapshots against `drift_store.violations` where `principle_id` is the key. Sparse `principle_id` means the learner sees fewer patterns — Gate B evidence becomes harder to produce.

**Discipline:** this is not a schema change (the column has existed since v1). It is a population-consistency change, enforced at:

1. Template (structural gate)
2. Agent prompt (behavioral gate)
3. Indexer (drops or rejects findings missing `principle_id` — confirm existing indexer behavior; if currently tolerant, make it strict for v2.1b)

### Canon principles to apply

- **agent-template-required** — template enforces field presence
- **agent-evidence-over-intuition** — every finding cites a principle, not a vibe

### Risk mitigations

- Observation tag compliance (§13 LOW/LOW): consistent population means the existing `principle_id` column has signal, not noise
- Learner scope creep (§13 MEDIUM/LOW): principle refinement is the ONE in-scope analysis for v2.1b; this task enables it

### Tests to write

- `templates/__tests__/review-checklist.test.ts`:
  - Template requires `principle_id` per finding
  - Finding without `principle_id` fails template parse
- `agents/__tests__/canon-reviewer.test.ts` (extend):
  - Reviewer body requires principle-ID-per-finding
  - Body documents the "no principle → observation, not finding" rule
- Indexer test (drift-store):
  - Existing review write with no `principle_id` → rejected or warned (confirm current behavior; make strict if currently tolerant)
- Integration (runs in v2_1b-08):
  - Run a review against a test flow; inspect all findings; assert `principle_id` non-null for every finding
  - Run a review where no principle clearly applies; reviewer emits an observation (not a finding) or escalates to `canon-writer`

### Verify

1. Template file carries the required field
2. Reviewer body cites the rule
3. Indexer rejects findings missing `principle_id` (or make it strict if tolerant)
4. Tests pass
5. Integration: review output confirms consistent population

### Done when

- Template + reviewer amendments merged
- Indexer strictness confirmed
- Tests pass
- Review findings in the v2.1b era have 100% `principle_id` population
- Retroactive backfill is OUT OF SCOPE — v2.1b analyzes v2.1b-era data forward; older findings retain their current (possibly sparse) state
