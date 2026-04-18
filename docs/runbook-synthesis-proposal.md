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

## 4. Vocabulary

The canonical set of step IDs Canon knows. Adding a new ID is a versioned change (like adding a principle — deliberate, reviewed). The vocabulary is stored at `skills/canon/references/runbook-vocabulary.md` and loaded as a skill by any agent that needs to understand runbook structure.

| Step ID | Default agent | Dispatch | Default HITL | Purpose |
|---------|---------------|----------|--------------|---------|
| `research` | canon-researcher | subagent | none | Investigation — any scope (codebase, risks, coverage gaps, migration scope, drift). Absorbs legacy `scan`. |
| `design` | canon-architect | subagent | approval | Plan index + design decisions |
| `spike` | canon-engineer | subagent | none | Time-boxed exploratory prototype; produces findings, not shipped code |
| `implement` | canon-engineer | subagent or team | none | Build code with TDD/BDD. `team` when wave-parallel. Absorbs legacy `write-tests` via TDD. |
| `migrate` | canon-engineer | subagent | none | Schema/data migration execution (pairs with rollback artifact) |
| `verify` | canon-engineer | subagent | on_failure | Run existing tests / gates post-change |
| `test` | canon-tester | subagent | none | Net-new integration tests; coverage-gap fills |
| `benchmark` | canon-tester | subagent | on_failure | Performance verification against baseline |
| `security` | canon-security | subagent | none | Security assessment |
| `review` | canon-reviewer | subagent | checkpoint | Principle compliance (absorbs legacy `audit` via scope) |
| `fix` | canon-engineer | subagent | on_failure | Fix mode. Required: `cause: test-failure \| security \| review \| verify` |
| `pre-launch-check` | null | n/a | on_failure | Gate-only — lead runs discovered checks via Bash |
| `ship` | canon-shipper | subagent | on_failure | PR description synthesis (absorbs legacy `release` unless distinct release flow emerges) |
| `context-sync` | canon-scribe | subagent | none | Doc sync — **mandatory tail** |
| `learn` | canon-learner | subagent | none | Pattern analysis — **mandatory tail** |

Total: **15 entries** (13 functional + 2 mandatory tail).

### Explicitly dropped candidates

| Dropped | Why |
|---------|-----|
| `scan` | Scope of `research` |
| `map` | Covered by `codebase_graph` MCP tool + SessionStart KG-check hook; not a per-flow step |
| `triage` | Scope of `research` (ranked-list output) |
| `profile` | Speculative — no Canon perf flow today; add via versioned-change process if one emerges |
| `risk-assessment` | Scope of `research` with `skills: [risk-analysis]` |
| `refactor` | Handled via synthesis rule — `implement` with a mandatory-following `verify`; promote to `mode: refactor` if evidence warrants |
| `smoke` | Scope of `verify` |
| `audit` | Scope of `review` |
| `rollback-prep` | Paired artifact of `migrate`; handled in synthesis rule, not a separate step |
| `monitor` | No Canon ops/deploy flow today; add later if one emerges |
| `release` | Subsumed into `ship` unless release automation becomes distinct |

## 5. Step schema — first-class fields

Every step in a synthesized runbook carries the same structural fields (from `templates/runbook-template.md`), **plus** three domain-oriented axes introduced by this proposal:

### 5.1 `skills:` — what domain expertise to load

General-purpose: any step can declare domain primers to load from `skills/canon/references/`. Agents read named skills on their first turn via `agent-context-check`.

```yaml
- id: implement
  agent: canon-engineer
  dispatch: team
  skills:
    - backend-api
    - authentication-security
  mcp_tools: [get_principles, get_file_context]
  artifacts: ["plans/${slug}/${task_id}-SUMMARY.md"]
  hitl: none
```

**Validation:** strict. The planner validates every name in `skills:` against the file list in `skills/canon/references/` at synthesis time. Unresolvable names are a synthesis error, not a warning.

**Why declarative, not inline prose:** (a) planner decides skill selection once at synthesis, not per-spawn; (b) journal's existing `domain_skills_loaded` field captures the list verbatim for learner analysis; (c) multiple skills per step compose cleanly (auth + backend-api); (d) no step-specific `domain` / `scope` / `cause` field proliferation.

### 5.2 `cause:` — analytic lineage + default skill hint (fix-specific)

Used only on `fix` (and potentially future re-work steps). Carries two signals in one field:

1. **Analytic:** which upstream step triggered this fix (for outcome correlation — test-failure fixes have different shape than security fixes)
2. **Skill hint:** a default primer to auto-add to `skills:` (e.g., `cause: review` → `review-feedback-handling`)

```yaml
- id: fix
  agent: canon-engineer
  cause: security               # analytic + hints at authentication-security skill
  skills:
    - authentication-security   # explicit additional primer
  mcp_tools: [get_principles, get_file_context]
  artifacts: ["plans/${slug}/FIX-SUMMARY.md"]
  hitl: on_failure
```

### 5.3 `mode:` — deferred for now

Rejected for v2.1 as a general mechanism. The two real variants today (`implement.mode: refactor`, `implement.mode: migrate`) are handled via rules in `runbook-synthesis.md`:

- "When the task is behavior-preserving, synthesize `implement` with skill `refactor-methodology` and a mandatory-following `verify` step whose body prose specifies 'no behavior changes' as the pass criterion."
- "When the task is a schema/data migration, synthesize `migrate` (not `implement`) paired with a rollback-prep artifact."

If synthesis rules proliferate beyond 3–4 variants, promote `mode` to a first-class field in a vocabulary revision. For now, inline the rules.

### 5.4 Full frontmatter example (security-triggered fix with domain primers)

```yaml
- id: fix
  agent: canon-engineer
  dispatch: subagent
  cause: security
  skills:
    - authentication-security
    - backend-api
  mcp_tools:
    - get_principles
    - get_file_context
  artifacts:
    - "plans/${slug}/FIX-SUMMARY.md"
  hitl: on_failure
  skip_when: null
```

Body H3 prose for this step covers intent ("address security findings"), composition hints beyond `mcp_tools` (which template to reference for FIX-SUMMARY), and HITL posture. Body does NOT restate the frontmatter fields — per the authoring rule in `skills/canon/runbooks/README.md`.

## 6. Synthesis contract

Rules the planner (via `runbook-synthesis.md` skill) MUST follow when emitting a runbook. These are the invariants that replace the structural guarantees static runbooks used to provide.

### 6.1 Planner MUST

1. **Include mandatory tail.** Every build runbook ends with `context-sync` followed by `learn`. Not optional, not reorderable.
2. **Use canonical step IDs only.** Any step ID not in `runbook-vocabulary.md` is a synthesis error.
3. **Preserve default agent / dispatch / HITL** unless overriding with explicit justification in the planning brief.
4. **Validate `skills:` names strictly** against `skills/canon/references/` at synthesis time.
5. **Use `${slug}` / `${task_id}` / `${timestamp}` placeholders** per the runbook format spec. No bare `{slug}` / `{task_id}` / `{timestamp}`.
6. **Include a one-paragraph Overview** in the runbook body explaining why this step sequence was chosen (the "why" the vocabulary+frontmatter can't capture).
7. **Emit body H3 prose per step** with intent, skip-when elaboration, and wave/HITL coordination notes — per the authoring rule in `skills/canon/runbooks/README.md` ("prose covers why/skip/coordination, never restates frontmatter").
8. **Apply contract pairings** from synthesis rules:
   - Behavior-preserving `implement` (refactor) → mandatory-following `verify` with "no behavior changes" criterion in body prose
   - `migrate` → paired rollback artifact in the step's `artifacts:` list
   - `security` findings → at least one `fix` step with `cause: security` before `ship`
   - `review` verdict not clean → `fix` with `cause: review` loop until clean

### 6.2 Planner MAY

- **Reorder steps** (e.g., `security` before `review` for auth-sensitive changes).
- **Skip optional steps** (`design` for scoped fixes with obvious approach; `test` for doc-only changes).
- **Repeat steps** (two `review` passes for risky migrations; multiple `fix` cycles).
- **Expand a single step into multiple waves** (`implement` split into wave 1 = core + wave 2 = extensions).

### 6.3 Planner MUST NOT

- **Invent new step IDs.** Adding a vocabulary entry is a deliberate versioned change, not a per-run decision.
- **Remove baseline HITL** from step defaults based on confidence score. Confidence may only add HITL on top, never remove (see §7.3).
- **Skip mandatory tail** regardless of flow size or confidence.

## 7. Confidence scoring

The planner emits a scalar confidence value with each synthesized runbook, along with per-signal contributions. Confidence is a calibration signal and a HITL amplifier — never a HITL-removal mechanism.

### 7.1 Schema

```yaml
# In synthesized runbook frontmatter
confidence: 0.0-1.0
confidence_signals:
  - {signal: "novelty",           value: 0.7}
  - {signal: "scope_clarity",     value: 0.9}
  - {signal: "domain_coverage",   value: 0.8}
  - {signal: "dependency_drift",  value: 0.6}
  - {signal: "question_count",    value: 0.85}
```

### 7.2 Signals

| Signal | Meaning | How computed |
|--------|---------|--------------|
| `novelty` | Has Canon built something like this before? | Planner's `memory: project` semantic search on past plans |
| `scope_clarity` | Does the request have concrete acceptance criteria? | Planner's analysis of the brief; fewer open questions ⇒ higher |
| `domain_coverage` | Are relevant domain primers available for the affected layers? | Ratio of affected file-layers with ≥1 matching primer in `skills/canon/references/` |
| `dependency_drift` | How much has changed in the target files since the last related work? | `get_drift_report` + recent commit density in target files |
| `question_count` | How many open questions remain in the brief after analysis? | Inversely proportional to the count; clamped |

Overall `confidence` is a weighted combination (weights tuned during Phase 2 calibration — Phase 1 ships with equal weighting as a placeholder).

### 7.3 Confidence as HITL amplifier

Critical principle: confidence affects the **ceiling** of autonomy, not the **floor**. The baseline HITL in a synthesized runbook (`architect approval`, `review checkpoint`, etc.) stays regardless of score.

- **Low confidence** → *add* HITL (extra checkpoints, harder approval gates, additional user presentation)
- **High confidence** → *baseline* HITL (the runbook's specified posture)
- **Never:** high confidence → *less* HITL than the runbook specifies

This prevents a calibration failure from silently removing guardrails.

### 7.4 Gating behavior — deferred to Phase 2 calibration

**Phase 1** ships confidence as **observable only** — planner emits the score and signals; journal captures them; nothing gates on the value. This lets us collect a calibration sample without trusting an untrusted signal.

**Phase 2a (calibration sub-phase)** — *all* synthesized runbooks pause for human review regardless of confidence. Collect N paired (confidence, human-quality) samples. Build calibration curve.

**Phase 2b (threshold validation)** — from the calibration curve, pick the confidence level above which human-graded quality was ≥95%. Test that threshold: runs above proceed autonomously; runs below pause for review. Observe.

**Phase 3 rollout** — production threshold derived from Phase 2b data. Final gating behavior likely lands somewhere like:

- `confidence < T_low` → planner presents brief with open questions; lead surfaces to user before executing
- `T_low ≤ confidence < T_high` → proceeds, but adds one `hitl: checkpoint` at a risky step; baseline HITL preserved
- `confidence ≥ T_high` → proceeds per synthesized runbook as-is

…but `T_low` and `T_high` are determined by Phase 2b data, not guessed at Phase 1.

## 8. Phase rollout

### 8.1 Phase 1 task inventory (revised)

| Task | Status | Change vs. v2 |
|------|--------|---------------|
| phase1-00 (runbook format) | DONE on PR #115 | Unchanged — format spec for synthesis output |
| phase1-01 (fast-path runbook) | **ABANDONED** | Replaced by vocabulary-based synthesis |
| phase1-02 (feature runbook) | **ABANDONED** | ditto |
| phase1-03 (epic + migrate runbooks) | **ABANDONED** | ditto |
| phase1-04 (test-gap runbook) | **ABANDONED** | ditto |
| **NEW: phase1-01-v2.1 (step vocabulary)** | Wave 1 | `skills/canon/references/runbook-vocabulary.md` — 15 canonical step IDs |
| **NEW: phase1-02-v2.1 (synthesis + brief skills)** | Wave 1 | `skills/canon/references/runbook-synthesis.md` and `skills/canon/references/planner-brief.md` |
| phase1-05 (skills registration) | Unchanged | The new skills register alongside existing ones |
| phase1-06 (orchestration journal) | Unchanged | Already captures `domain_skills_loaded` per §4b P4 |
| phase1-07 (hooks) | Unchanged | Artifact enforcement unchanged at step level |
| phase1-08 (agent defs) | **Scope expands** | `canon-planner` body shrinks: loads brief + synthesis skills, emits both artifacts |
| phase1-09 (CLAUDE.md) | **Simpler** | No intent classification table; all build requests → planner |
| phase1-10 (validation) | **Refactored** | See §8.2 below |

Wave 1 shrinks from 5 tasks to 2. Wave 3 complexity drops in phase1-09. Total Phase 1 deliverable count decreases net-of-additions.

### 8.2 phase1-10 validation changes

**Removed checks:**
- "Runbook coverage against 5 legacy flows" (no longer applicable)
- "5 runbook format conformance" (no longer applicable)

**Added checks:**
- **Vocabulary conformance** — sample N synthesized runbooks from a Phase 2a calibration batch; every step ID in the vocabulary file
- **Mandatory tail present** — every synthesized build runbook ends with `context-sync` + `learn`
- **Planner output shape** — every `canon-planner` spawn produces both `planning-brief.md` AND `runbook.md` artifacts
- **Confidence schema** — planner emits valid `confidence` scalar (0.0–1.0) + `confidence_signals` list (Phase 1: schema only; data quality deferred to Phase 2)
- **Journal captures `domain_skills_loaded`** — schema-level check in Phase 1
- **`skills:` strict validation** — synthesized runbook references only skill files that exist

### 8.3 Phase 2 additions

Phase 2 gains two new validation tracks:

- **Skill effectiveness baseline** (§4b P4 of migration plan) — run N varied requests; tag outcomes; establish baseline correlations between `domain_skills_loaded` and outcome metrics (review verdict, fix iterations, test pass rate). The learner refines from this baseline.
- **Confidence calibration validation** — Phase 2a (all runs pause) collects paired (confidence, human-quality) samples. Phase 2b picks threshold from calibration curve and tests it.

## 9. Impact on `docs/agent-teams-migration-plan-v2.md`

The following sections need amendment for v2.1:

| Section | Change |
|---------|--------|
| §2.2 "What stays" (Runbooks row) | Replace "Lightweight playbooks describing recommended step sequences" with "Canonical step vocabulary + synthesis skill. Runbooks are synthesized per plan by `canon-planner`." |
| §2.3 "Pre-build gate (canon-planner)" | Expand planner responsibilities to include runbook synthesis. Note the two-skill split (brief + synthesis). |
| §2.4 "How Claude orchestrates a Canon flow" | Update example to show planner emitting both brief + runbook; step 3 becomes "reads `plans/${slug}/runbook.md`" instead of "reads the `feature` runbook". |
| §2.6 "Why this is simpler" | Add a bullet: "Seven: no hardcoded flow taxonomy. Every build request routes through `canon-planner`; the runbook is synthesized, not selected from a library." |
| §2.8 Layer 1 | Amend: "CLAUDE.md + runbook-synthesis.md skill" (not runbooks plural). |
| §3 row 23 ("Variable interpolation: deprecate") | Unchanged — still deprecate, now more emphatically since runbooks are per-plan. |
| §4 Phase 1 deliverables table | Replace rows for `fast-path.md` / `feature.md` / `epic.md` / `migrate.md` / `test-gap.md` with rows for `runbook-vocabulary.md` / `runbook-synthesis.md` / `planner-brief.md`. |
| §4b P4 "Self-improving skills" | Promote from roadmap item to Phase 2 validation requirement — skill effectiveness baseline is now part of proving synthesis works. |
| §6 Risks | Add: "Planner emits inconsistent runbooks across similar requests" (MEDIUM), "Planner drops mandatory tail" (MEDIUM — mitigated by completion hook), "Vocabulary drift" (LOW — versioned change process). |

Revision naming: `docs/agent-teams-migration-plan-v2.1.md` as a new file, with v2 preserved for history. v2.1 frontmatter references v2 as its supersedent.

## 10. Open questions

1. **Planner output location** — `plans/${slug}/runbook.md` sits alongside other planning artifacts. Or should synthesized runbooks have a distinct location (`runbooks/${slug}.md`)? Leaning: keep under `plans/${slug}/` for cohesion with the brief.
2. **`cause` extensibility** — does any step besides `fix` need `cause`? Candidates: a future `audit` step (cause = compliance-drift vs. periodic-check) if audit gets promoted from review-scope to its own step. Defer until evidence.
3. **Runbook versioning** — if a runbook is synthesized and then resumed in a later session with a newer vocabulary, how does resume work? Options: (a) lock runbook to vocabulary version at synthesis; (b) regenerate if vocabulary has changed; (c) warn and proceed. Lean: (a) for determinism during a build.
4. **Learner loop ownership** — Phase 2 establishes the skill-effectiveness baseline, but who owns the continuous refinement after? Planner auto-tunes skill selection from learner output, or humans review learner output and update the synthesis skill manually? Probably the latter for now (supervised learning); automatic tuning is a §4b P5 roadmap item.
5. **CLAUDE.md intent classification** — with all build requests routing to planner, the intent table simplifies dramatically, but we still need to handle non-build intents (greetings, questions, chat). Define the minimal residual intent set.
6. **Phase 2a sample size** — how many paired (confidence, human-quality) samples are needed for calibration? Depends on confidence variance. Suggest starting with N=30 and extending if the curve is noisy.

## 11. Status and next steps

This document is a **draft proposal**. It is not yet ratified.

**Next concrete step:** once the PR #115 conversation concludes, promote this draft into `docs/agent-teams-migration-plan-v2.1.md` as the canonical revision, with the sections in §9 edited directly against v2.

**Do NOT:**
- Start the new Wave 1 tasks (vocabulary + synthesis/brief skills) based on this draft. Ratify v2.1 first.
- Amend Phase 1 plan files in `.canon/workspaces/agent-teams-v2/plans/phase1/` yet. They're the pre-v2.1 spec; editing them preemptively conflates this draft with the ratified plan.

**Who reviews:** Canon maintainers per the same review process that produced v2.

---

## Appendix A: Conversation provenance

This proposal emerged from the PR #115 review thread on branch `claude/runbook-template-format-dM3LJ`. Key conversation beats, chronologically:

1. PR opened for `phase1-00` (runbook format template) — static-runbook model assumed
2. Review pass surfaced drift between DESIGN.md schema and phase1-01 / phase1-10 plans; amended
3. User observation: "runbooks as guidance for Claude-native orchestration — does this open the door for dynamic, plan-specific runbooks?"
4. Proposal for Option A (vocabulary + synthesis) surfaced; iterated on
5. Decisions crystallized across several rounds (see §2)
6. This document captures the outcome so context isn't lost to compaction

The conversation is the source; this document is the durable artifact.
