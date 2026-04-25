---
task_id: "v2_1a-01"
wave: 2
depends_on: ["v2_1a-00"]
decisions:
  - "dc-02"
files:
  - skills/canon/skills/plan/SKILL.md
  - templates/planning-brief.md
principles:
  - agent-surface-assumptions
  - agent-evidence-over-intuition
domains:
  - infrastructure
---

## Task: Create the `canon:plan` native skill + planning-brief template

### Action

Ship two artifacts that together define how the planner produces a strategic brief:

1. **Native Claude Code skill** — `skills/canon/skills/plan/SKILL.md` (plus any supporting files inside that directory) defining the strategic-analysis contract. Because it's a real SKILL.md-wrapped directory, Claude Code loads it natively when any subagent (v2.1a: planner; potentially others later) lists `canon:plan` in its `skills:` frontmatter.

2. **Output template** — `templates/planning-brief.md`. Partial skeleton already shipped in phase1-08; this task fleshes it out per the 7-section contract below. Referenced from the planner body per `agent-template-required`.

**PLAN amendment note** (2026-04-22, phase1-08.5 + follow-up): the original v2_1a-01 PLAN specified `references/planner-brief.md` as the single output. That conflated two concerns — the procedural skill (how to plan) and the output shape (the brief template). Separated per clarified intent: the skill is a native Claude Code skill under `skills/canon/skills/plan/`; the output shape is a template under `templates/`.

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

5. **Artifact contract** — where the brief is written (`${WORKSPACE}/plans/${slug}/planning-brief.md`), how it is referenced from the synthesized runbook, how iterations update it (new file per iteration? overwrite with append-log? per §6.6 use new `lifecycle_synthesized_runbooks` row per iteration, but for v2.1a without lifecycle DB, use numbered files: `planning-brief-iter-N.md`). The on-disk output follows `templates/planning-brief.md` (this task's second deliverable).

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

1. Native skill exists at `skills/canon/skills/plan/SKILL.md` (with the five contract elements captured in the SKILL.md body or structured sub-files)
2. Claude Code discovers the skill — any subagent listing `canon:plan` in its native `skills:` frontmatter receives the skill content at spawn
3. Template exists at `templates/planning-brief.md` with all seven sections from the brief-output contract
4. Skill tests pass: `npm test -- plan-skill` (or equivalent)
5. `v2_1a-03` planner rewrite lists `canon:plan` in native `skills:` (not in Canon's three-field `rules:`/`references:`/`primers:`)
6. Manually spawn planner against a test request; planner produces a brief matching `templates/planning-brief.md` and the skill's contract

### Done when

- Native skill exists as a proper `SKILL.md`-wrapped directory under `skills/canon/skills/plan/`
- Template exists at `templates/planning-brief.md` with all seven required sections
- All five contract elements (sections, depth rules, push-back, non-responsibilities, artifact contract) captured in the skill
- Tests pass
- No duplication with `canon:synthesize` (plan is strategic; synthesize is mechanical)
