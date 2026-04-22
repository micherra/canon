---
task_id: "v2_1b-03"
wave: 3
depends_on: []
decisions:
  - "dc-04"
files:
  - templates/fix-summary.md
  - agents/engineer.md
principles:
  - agent-template-required
  - agent-evidence-over-intuition
domains:
  - infrastructure
---

## Task: Fix-summary structured tags (`cause`, `root_cause_tag`)

### Action

Add `cause` and `root_cause_tag` as required structured frontmatter fields on the fix-summary template. Amend `engineer` to populate them on every fix-mode run.

**Template amendment** — if `templates/fix-summary.md` does not yet exist, create it following the `implementation-log.md` template pattern. Required frontmatter:

```yaml
---
template: fix-summary
task_id: "{task-id}"
cause: "test-failure | security | review | verify"   # required; matches the triggering step's cause
root_cause_tag: "{short-phrase}"                      # required; e.g., "missing-null-check", "off-by-one", "wrong-import-path"
upstream_step_id: "{step-id-of-the-step-that-flagged}"
files_touched: []
principle_ids_addressed: []
---
```

**Field semantics:**

- **`cause`** — analytic lineage: which upstream step (in the runbook's step schema) triggered this fix. Enum: `test-failure | security | review | verify`. Required on every `fix` step per the synthesis contract (v2_1a-02). The synthesis skill's step-vocab entry for `fix` already requires it; this task enforces it at the summary-artifact layer too.
- **`root_cause_tag`** — a short phrase (≤ 40 chars, lowercase-kebab) categorizing the *root cause* of the issue being fixed. Open-coded initially; the learner can later mine common root_cause_tag values and propose a stable taxonomy. Examples: `missing-null-check`, `off-by-one`, `wrong-import-path`, `forgot-await`, `stale-snapshot`.
- **`upstream_step_id`** — the step ID (e.g., `review-wave1-a`) that flagged the issue. Enables the learner to correlate fixes with which upstream step caught them.

**engineer amendment:**

- Agent body's fix-mode section references the fix-summary template
- Engineer populates `cause` from its spawn-prompt metadata (synthesis carries this through)
- Engineer populates `root_cause_tag` based on its own analysis of the fix it made (1–3 words describing the actual cause, not the symptom)
- Engineer populates `upstream_step_id` from spawn-prompt metadata
- If engineer cannot determine `root_cause_tag` (unusual), it writes `root_cause_tag: "unclassified"` and logs a note — better to capture "we couldn't tag this" than to fabricate a tag

### Canon principles to apply

- **agent-template-required** — the template is authoritative; engineer MUST read it and follow its structure
- **agent-evidence-over-intuition** — `root_cause_tag` is what the engineer actually found, not a guess

### Risk mitigations

- Observation tag compliance (§13 LOW/LOW): closed schema per §4.6; the indexer drops unknown frontmatter fields, so only the three documented here will be captured
- Planner inconsistency (§13 MEDIUM/MEDIUM): by enforcing `cause` at the summary layer too (not just the synthesis layer), we catch cases where synthesis emitted it but the engineer didn't propagate it

### Tests to write

No existing test infrastructure for templates/*.md or agents/*.md. Validation is by:

- Manual read: template carries `cause` + `root_cause_tag` + `upstream_step_id` as required fields in frontmatter block; engineer body cites the fix-summary template
- Indexer-side check (existing drift-store code): if the indexer parses fix-summary frontmatter, it should reject or warn on missing required tags — confirm existing behavior or file a small follow-up task
- Integration (runs in v2_1b-08): run a flow with a deliberate review failure → fix step → fix-summary artifact exists with `cause: review` and a non-empty `root_cause_tag`

### Verify

1. `templates/fix-summary.md` exists with the required frontmatter shape
2. `engineer` body references the template
3. Template + engineer tests pass
4. A real fix-mode run produces a summary with both tags populated

### Done when

- Template + engineer amendments merged
- Tests pass
- Integration test confirms tag capture
- Indexer (storage side) can read the tags without additional schema work (drift-db columns for these tags are part of the review-finding / summary plumbing that already exists; if the indexer needs a new column, file a follow-up)
