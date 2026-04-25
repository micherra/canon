---
task_id: "v2_1b-06"
wave: 4
depends_on: ["v2_1b-01", "v2_1b-03", "v2_1b-04", "v2_1b-05"]
decisions:
  - "dc-07"
files:
  - agents/learner.md
  - references/learner-principle-refinement.md
principles:
  - agent-design-before-code
  - agent-evidence-over-intuition
domains:
  - infrastructure
---

## Task: Extend `learner` with principle-refinement analysis dimension

### Action

Extend the `learner` agent so it can read lifecycle snapshots (v2_1b-01) + drift-store violations + v2.1b-era structured tags (v2_1b-03/04/05) and emit structured patch proposals to principle files. This is the ONE new learner analysis dimension v2.1b adds; other dimensions defer to v2.2.

**Approach:**

1. **New skill file** `references/learner-principle-refinement.md` documenting the analysis pattern:
   - **Input sources:** `lifecycle_workspace_snapshots` (v2_1b-00); `drift_store.violations` (existing); fix-summary files with `cause` / `root_cause_tag` / `upstream_step_id` (v2_1b-03); implementation-summary files with `justified_deviations[]` (v2_1b-04); review-finding `principle_id` consistency (v2_1b-05)
   - **Pattern-detection queries** (illustrative, not exhaustive):
     - **Elevated fix cost:** principles whose violations consistently take > N fix iterations → narrow the principle or improve its examples
     - **Repeat justified deviations:** principles repeatedly cited in `justified_deviations[]` → the principle's scope may be too broad; propose narrowing or exception list
     - **Clustering by root cause:** review findings for a principle that share `root_cause_tag` → propose adding the pattern to the principle's "common mistakes" section
     - **Unclassified findings:** observation-without-principle rate climbing → may indicate a missing principle (escalate to `writer` intent)
   - **Proposal output format:** structured patch to `principles/{category}/{name}.md` (unified-diff-friendly). Each proposal lives in `.canon/proposed-learnings/{timestamp}/principle-{name}-{proposal-id}.md` with the patch + a rationale citing evidence (row counts, specific flow IDs, principle IDs).
   - **Confidence bar:** the learner emits a proposal only when the supporting evidence meets a threshold (e.g., ≥ 3 distinct flows, ≥ 2 distinct affected files). Below threshold → observation noted, no proposal. This prevents proposal spam.

2. **learner agent body amendment:**
   - New section: "Principle-refinement analysis (v2.1b)"
   - References the `learner-principle-refinement` skill
   - Adds the skill to `skills:` frontmatter
   - Preserves existing behavior (mining pattern analysis, proposal emission, `.canon/learning.jsonl` read for dismissed items) — this task is ADDITIVE, not a replacement
   - `memory: project` stays

3. **Preserves supervised curation (v2.1 §3.4):** learner writes proposals to `.canon/proposed-learnings/{timestamp}/` for weekly human review. No automation applies proposals.

### Canon principles to apply

- **agent-design-before-code** — the skill file documents the analysis pattern before implementation; learner body reads the skill
- **agent-evidence-over-intuition** — proposals cite concrete evidence (row counts, flow IDs, principle IDs); no vibe-check proposals

### Risk mitigations

- Learner expands write scope too aggressively (§13 MEDIUM/LOW): scope is LOCKED to principle files in v2.1b; the skill file explicitly forbids proposals targeting agent defs, rules, vocabulary, or memory (those defer to v2.2+)
- Orchestration journal SPoF / MEDIUM-3: learner's analysis surfaces missing journal fields as data-quality findings, giving us visibility into population gaps
- Observation tag compliance §13 LOW/LOW: learner skips analyses where required tags are absent rather than inferring

### Tests to write

No existing test infrastructure for skills/*.md or agents/*.md. Validation is by:

- Manual read: skill file documents input sources, pattern-detection queries, confidence bar, proposal format; learner body references the new skill; `skills:` frontmatter includes `learner-principle-refinement`; existing mining behavior text preserved
- Integration (runs in v2_1b-07 loop-closure-evidence): against a seeded dataset of ≥ 5 flows with populated v2.1b tags, running learner produces ≥ 1 structured principle-refinement proposal in `.canon/proposed-learnings/{timestamp}/`. Below-confidence-bar cases produce observations, not proposals.

### Verify

1. Skill file exists and is registered
2. learner body + frontmatter updated
3. Unit tests pass
4. Integration test with seeded data produces at least one credible proposal

### Done when

- Skill + learner amendments merged
- Tests pass
- Integration test passes
- Scope lock documented: v2.1b learner writes proposals targeting `principles/*.md` ONLY; other targets defer to v2.2
