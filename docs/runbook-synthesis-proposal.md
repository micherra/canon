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

_(Sections 6–9 to follow: synthesis contract, confidence scoring, phase rollout, impact on existing plan, open questions.)_
