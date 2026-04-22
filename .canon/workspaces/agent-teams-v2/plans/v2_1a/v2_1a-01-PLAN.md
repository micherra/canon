---
task_id: "v2_1a-01"
wave: 2
depends_on: ["v2_1a-00"]
decisions:
  - "dc-02"
files:
  - references/planner-brief.md
principles:
  - agent-surface-assumptions
  - agent-evidence-over-intuition
domains:
  - infrastructure
---

## Task: Create planner-brief.md skill

### Action

Write `references/planner-brief.md` defining the strategic-analysis contract `planner` follows to produce `plans/${slug}/planning-brief.md` per build request.

**The skill must specify:**

1. **Required brief sections** (each with intent + example wording):
   - Problem statement — what outcome the user wants
   - Target users — who benefits; who does not
   - Acceptance criteria — explicit, verifiable statements of "done"
   - Alternatives considered — at minimum one alternative per non-trivial request, with honest tradeoffs
   - Recommended approach — the planner's recommendation with rationale
   - Open questions — items the planner could not resolve from the request alone; each tagged with a decision-owner (user / planner / architect)

2. **Depth calibration rules** (per v2.1 §6.2):
   - Trivial request (1-step runbook): one-sentence problem statement, one-line recommended approach, no alternatives section required, open questions only if genuinely open
   - Small feature (3–4 step runbook): short brief, at least one alternative, acceptance criteria explicit
   - Complex epic (multi-wave): full brief, multiple alternatives, North-Star-style done criteria

3. **Constructive push-back discipline** (per v2.1 §2.3 planner responsibilities):
   - Clarifies requirements
   - Challenges assumptions
   - Evaluates alternatives (configuration over new code; extension over rewrite)
   - Assesses value relative to effort (wave count, agents involved)

4. **Non-responsibilities** — what the brief does NOT cover:
   - Step-by-step execution plan (that's the synthesis skill's domain)
   - Code-level design decisions (that's the architect's domain during `design` step)

5. **Artifact contract** — where the brief is written (`${WORKSPACE}/plans/${slug}/planning-brief.md`), how it is referenced from the synthesized runbook, how iterations update it (new file per iteration? overwrite with append-log? per §6.6 use new `lifecycle_synthesized_runbooks` row per iteration, but for v2.1a without lifecycle DB, use numbered files: `planning-brief-iter-N.md`).

### Canon principles to apply

- **agent-surface-assumptions** — the brief is the primary channel for the planner to surface assumptions; skill must emphasize explicit listing, not inference
- **agent-evidence-over-intuition** — skill must require the planner to cite sources (KG references, principle IDs, memory hits) for non-obvious recommendations

### Risk mitigations

- Planner inconsistency (§13 risk, MEDIUM/MEDIUM): the skill is the authoritative contract, so the review MEDIUM-2 synthesis regression suite can compare planner output against skill-required sections mechanically

### Tests to write

No existing test infrastructure for skills/*.md. Validation is by:

- Manual read against the 5-contract-element checklist
- Downstream integration: planner (v2_1a-03) loads this skill; if the skill is malformed the planner spawn fails, which the v2_1a-08 validation will catch against all 5 request types
- Optional: file follow-up task to add skill-lint harness — out of scope here

### Verify

1. Skill file exists at `references/planner-brief.md`
2. Skill tests pass: `npm test -- planner-brief`
3. Skill is referenced by `planner` agent frontmatter (v2_1a-03 will add this)
4. Manually spawn planner against a test request; planner produces a brief matching the required sections

### Done when

- File exists and specifies all 5 contract elements (sections, depth rules, push-back, non-responsibilities, artifact contract)
- Tests pass
- File is registered in the skills manifest
- No duplication with `runbook-synthesis.md` (planner-brief is strategic; synthesis is mechanical)
