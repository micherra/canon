# Runbook Synthesis — Proposal for v2.1 Revision

**Status:** DRAFT — proposal document, not yet ratified
**Origin:** PR #115 review thread (2026-04-18)
**Supersedes:** §2.3, §4 (Phase 1 Wave 1 deliverables), §2.8 of `docs/agent-teams-migration-plan-v2.md` once accepted
**Related artifacts already landed on PR #115:**
- `templates/runbook-template.md` (runbook output format)
- `skills/canon/runbooks/README.md` (format documentation)

**Last updated:** 2026-04-18

---

## 1. Motivation

Phase 1 of the agent-teams migration specified 5 hardcoded runbooks (fast-path, feature, epic, migrate, test-gap) plus 4 flows handled via CLAUDE.md inline dispatch (review-only, security-audit, explore, adopt). In the course of landing `phase1-00` (the runbook format template), we realized the hardcoded model is itself a vestige of the state-machine mental model the v2 migration is explicitly shedding.

§2.1 of the migration plan argues: *"Everything `drive_flow` coordinates — sequencing, conditionals, HITL gates, parallel dispatch, convergence, skip conditions, effects — is native Claude capability."* If that's true for the scheduler, it's true for runbook composition too. Static runbooks are "give Claude a rigid playbook to follow"; the v2 architecture points toward "Claude composes a plan-specific runbook from a canonical vocabulary."

The shift:

| | Hardcoded (v2) | Synthesized (v2.1) |
|---|----------------|---------------------|
| Standing artifacts | 5 runbook files, 4 inline-dispatch patterns in CLAUDE.md | 1 vocabulary + 2 skills (brief + synthesis) |
| Flow-matches-work | Flow labels approximate; `skip_when` handles variants | Runbook tailored to the specific plan |
| Intent classification | 9-row table in CLAUDE.md mapping request → flow key | Every build request → `canon-planner` → synthesized runbook |
| Authoring burden | 5 files × N future changes = 5N edits | 1 vocabulary update per step addition |

Critically, we keep all the **determinism we actually care about** — artifact production, commit trailers, claim release, mandatory tail steps (`context-sync` + `learn`), completion verification — and drop only the **determinism we don't** (fixed step sequences, soft flow-tier heuristics).

## 2. Decisions log

Explicit decisions made in the PR #115 review thread, in order:

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Brainstorm vocabulary broadly before capping | Avoid premature abstraction; see what Canon actually does |
| 2 | `cause`-style parameterization is first-class, broader than just `fix` | Generalizes to `skills:` field on any step |
| 3 | `canon-planner` does runbook synthesis via a dedicated skill, not baked into the agent body | Portable knowledge; synthesis can be loaded by other agents (learner, validators) |
| 4 | Amend `docs/agent-teams-migration-plan-v2.md` as v2.1, not a separate ADR | Keep the plan authoritative; avoid ADR-vs-plan split-brain |
| 5 | Mark `phase1-01..04` plans abandoned; delete any runbook files they would have produced | None exist yet — only the template + README on this PR |
| 6 | Two-skill split: `planner-brief.md` (strategic) + `runbook-synthesis.md` (mechanical) rather than one combined skill | Different mental modes; cleaner to reason about and evolve |
| 7 | Strict validation of `skills:` names against `skills/canon/references/` at synthesis time | Typo safety; catches skill drift early |
| 8 | Confidence score is a HITL **amplifier**, not a HITL-removal mechanism | Baseline HITL in the runbook stays regardless of confidence; only adds on top |
| 9 | Phase 2 splits into 2a (calibration — all runs pause) + 2b (threshold validation) | Can't pick autonomy threshold without calibration data |
| 10 | `mode` field deferred, handled in synthesis rules until evidence warrants promotion | Only 2–3 real variants today; promote when inline rules proliferate |

## 3. Architecture summary

Five pieces work together:

1. **Runbook output format** (`templates/runbook-template.md`, already landed) — frontmatter metadata + body H3 prose per step.
2. **Step vocabulary** (`skills/canon/references/runbook-vocabulary.md`, new) — the canonical set of ~14 step IDs with default agent / dispatch / HITL per step.
3. **Synthesis skill** (`skills/canon/references/runbook-synthesis.md`, new) — rules the planner follows to compose a runbook: mandatory tail, stable IDs, artifact conventions, contract pairings (e.g., refactor → verify).
4. **Brief skill** (`skills/canon/references/planner-brief.md`, new) — strategic analysis extracted from the current `canon-planner` agent body.
5. **`canon-planner` agent** — shrinks to frontmatter + "load these skills; produce `planning-brief.md` and `runbook.md`; emit confidence score with signals."

Every build request routes to `canon-planner`. The lead then executes the synthesized runbook by calling `log_step`, spawning per step, verifying artifacts, handling HITL — same orchestration loop as the static-runbook model, with one change: the runbook file is `plans/${slug}/runbook.md` (synthesized per build) instead of `skills/canon/runbooks/<flow>.md` (standing).

_(Sections 4–9 to follow in subsequent batches: vocabulary, step schema fields, synthesis contract, confidence scoring, phase rollout, impact on existing plan, open questions.)_
