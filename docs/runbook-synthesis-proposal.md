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

## 12. Lifecycle persistence — what makes synthesis auditable and reliable

Synthesized runbooks only earn the "runbooks as data" argument if the data survives workspace cleanup. Workspaces under `.canon/workspaces/<id>/` are ephemeral by design — they're scratch, not record. Without repo-level persistence, we've just moved guidance from static files to ephemeral files and gained nothing for learning.

This section locks in the storage decision and sketches schemas for the key tables. It is the infrastructure layer that makes the rest of the proposal auditable (cross-run introspection of what was synthesized, executed, and outcome) and reliable (calibration data for confidence scoring, skill effectiveness correlations).

### 12.1 Storage decision

**Extend `.canon/drift-db.sqlite` with new lifecycle tables. Per-run snapshot at flow completion.**

Rationale:

- The underlying concern is the same as drift analytics: time-series record of execution. Calling it "drift" vs. "lifecycle" is naming; the data model is continuous. Both feed the learner.
- Existing infrastructure already handles schema migrations, query layer, and retention policy hooks. Not duplicating it.
- New tables use a `lifecycle_` prefix to partition from existing drift tables and keep the mission boundary explicit.
- JOINs with the existing `FlowRunEntry` table (repo-level flow aggregates) are natural — same `workspace_id` key.

Rejected alternatives:

- *New dedicated DB (`.canon/lifecycle.db`)* — two DBs to manage, duplicate infrastructure, cross-DB JOINs require application-level work. Not worth the separation.
- *Pure JSONL append-log* — simple but every query is a scan; no joins; structured queries need an import step. Reserve JSONL for raw event capture where a simple append is cheaper than a DB write (see §12.3).

Fallback if drift-db feels overloaded: Kappa-style — raw events append to JSONL (`runbook-history.jsonl`, `hitl-events.jsonl`), materialized into drift-db tables on demand via a `refresh_lifecycle_index` MCP tool. Simple write path, structured read layer built lazily. Don't build this now; keep it as an escape hatch if direct DB writes become a bottleneck.

### 12.2 Persistence boundary

**Per-run snapshot at flow completion** (not real-time write-through).

- Workspace files are the source of truth *while a flow is running*.
- At flow completion, a new MCP tool `snapshot_workspace({ workspace_id })` reads the workspace and materializes a structured lifecycle record.
- `completion-verify.sh` hook is the natural trigger — verify, snapshot, then the workspace can be safely cleaned up.
- Janitor processes also call `snapshot_workspace` before deleting an abandoned workspace — preserves partial state.

**In-progress flows are queried from the workspace, not the DB.** Real-time dashboards / mid-run interventions are out of scope for v1. If they emerge as a real need, upgrade to write-through later — the snapshot table schema is the same either way.

### 12.3 New tables (schemas)

All under the `lifecycle_` prefix in `drift-db.sqlite`.

#### `lifecycle_synthesized_runbooks`

One row per synthesis event.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | |
| `workspace_id` | TEXT | Links to existing `FlowRunEntry.workspace_id` |
| `slug` | TEXT | Workspace slug |
| `synthesizer_agent` | TEXT | Usually `canon-planner`; leaves room for alternatives |
| `vocabulary_version` | TEXT | Version of `runbook-vocabulary.md` this was synthesized against |
| `confidence` | REAL | 0.0–1.0 |
| `confidence_signals` | JSON | Array of `{signal, value}` |
| `step_ids` | JSON | Ordered list of canonical step IDs in this runbook |
| `brief_summary` | TEXT | Short auto-summary of the planning brief (bounded, no raw user input) |
| `brief_path` | TEXT | Workspace-relative path to `planning-brief.md` (may be unreachable after cleanup) |
| `runbook_path` | TEXT | Workspace-relative path to `runbook.md` (may be unreachable after cleanup) |
| `synthesized_at` | TIMESTAMP | |

#### `lifecycle_step_executions`

One row per executed or skipped step.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | |
| `runbook_id` | INTEGER FK | `lifecycle_synthesized_runbooks.id` |
| `step_id` | TEXT | Canonical vocabulary ID (e.g., `fix`, `implement`) |
| `step_index` | INTEGER | Ordinal position in the runbook |
| `agent_type` | TEXT | What was spawned (nullable for gate-only steps) |
| `dispatch` | TEXT | `subagent` / `team` / `null` for gate-only |
| `skills_loaded` | JSON | Array of skill names actually loaded |
| `cause` | TEXT | Nullable — present for `fix` steps (analytic lineage) |
| `mcp_tools_called` | JSON | Array of MCP tool names the lead invoked pre-spawn |
| `artifacts_expected` | JSON | Array of paths |
| `artifacts_produced` | JSON | Array of paths that actually exist post-step |
| `status` | TEXT | `started` / `completed` / `skipped` / `failed` |
| `skip_reason` | TEXT | Nullable — natural language when skipped |
| `outcome` | JSON | `{ review_verdict, fix_iterations, test_pass_rate, ... }` |
| `started_at` | TIMESTAMP | |
| `completed_at` | TIMESTAMP | |

#### `lifecycle_hitl_events`

One row per user intervention.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | |
| `runbook_id` | INTEGER FK | |
| `step_execution_id` | INTEGER FK nullable | Null if intervention was outside a specific step |
| `event_type` | TEXT | `approval` / `clarification` / `redirect` / `reject` / `abort` |
| `posture` | TEXT | Step's declared `hitl` value, or `unscheduled` |
| `input_summary` | TEXT | Short auto-summary of user input (bounded, no verbatim) |
| `outcome` | TEXT | `proceeded` / `rerouted` / `aborted` |
| `occurred_at` | TIMESTAMP | |

#### `lifecycle_runbook_deviations`

One row per observed deviation from the synthesized runbook.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | |
| `runbook_id` | INTEGER FK | |
| `deviation_type` | TEXT | `step_added` / `step_skipped` / `step_reordered` / `step_repeated` / `step_modified` |
| `step_id_affected` | TEXT | Canonical step ID |
| `reason_summary` | TEXT | Short auto-summary of why the lead deviated |
| `detected_at` | TIMESTAMP | |

Deviations are computed during snapshot by diffing the synthesized `step_ids` (in `lifecycle_synthesized_runbooks`) against the actual `step_executions` sequence.

#### `lifecycle_workspace_snapshots`

Aggregate row per completed/abandoned workspace. Joins to existing `FlowRunEntry`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | |
| `workspace_id` | TEXT | FK-by-convention to `FlowRunEntry` |
| `slug` | TEXT | |
| `runbook_id` | INTEGER FK | `lifecycle_synthesized_runbooks.id` |
| `outcome` | TEXT | `complete` / `aborted` / `abandoned` |
| `total_steps_executed` | INTEGER | |
| `total_steps_skipped` | INTEGER | |
| `total_hitl_events` | INTEGER | |
| `total_deviations` | INTEGER | |
| `flow_duration_ms` | INTEGER | |
| `commit_range_first` | TEXT | First SHA with Canon-Workflow trailer matching slug |
| `commit_range_last` | TEXT | Last such SHA — joins to git history |
| `snapshotted_at` | TIMESTAMP | |

The `commit_range_*` fields are the bridge to git — the code-change axis. A query tool can JOIN lifecycle data with `git log --grep="Canon-Workflow: ${slug}"` output for full provenance.

### 12.4 New MCP tools

#### `snapshot_workspace({ workspace_id }) → { snapshot_id, runbook_id, deviations_detected }`

Reads the workspace files (runbook.md, brief.md, journal entries, artifact paths, git log with trailers) and materializes them into the tables above. Called by:

- `completion-verify.sh` hook after successful flow completion (primary path)
- Janitor / cleanup processes before deleting an abandoned workspace
- Manual invocation via a future `/canon:snapshot` slash command

Idempotent — re-running against the same workspace updates the existing snapshot.

#### `query_workspace_history({ filters, projection }) → rows`

Structured query interface for the learner and human introspection.

Supported filters (initial):

```
confidence_range: [min, max]
has_step: step_id
fix_cause: cause_value
outcome: outcome_value
synthesized_after: timestamp
skill_loaded: skill_name
deviated: true | false
step_id_executed: step_id
```

Projection selects which tables to join and which columns to return — the default projection is a compact summary (slug, outcome, confidence, total_steps, deviations).

### 12.5 Retention policy

Repo-level DB that grows indefinitely needs bounds.

**Tiered retention (proposed default):**

- **Most recent 100 snapshots:** full detail (all rows across all `lifecycle_*` tables)
- **100 to 1 year old:** aggregate — keep `lifecycle_workspace_snapshots` + `lifecycle_synthesized_runbooks` rows, drop `lifecycle_step_executions` / `lifecycle_hitl_events` / `lifecycle_runbook_deviations` per-row detail (folded into aggregate counts already on the snapshot row)
- **> 1 year:** drop entirely, or export to cold storage via a separate `.canon/archive/` directory

Retention is run by a janitor process (SessionStart hook, or cron-equivalent). Settings live in a new `.canon/retention.toml` (or extend existing Canon config).

Tunable — a project may care more about historical depth (keep N=1000) or space (aggregate more aggressively).

### 12.6 Privacy and sharing

Lifecycle data includes condensed records of user requests and interventions. Design for safety by default:

- **No verbatim user input in DB.** `brief_summary`, `input_summary`, `reason_summary` are all auto-generated bounded summaries. The full brief lives in the workspace markdown (reachable until cleanup) and is referenced by path, not content.
- **Bounded summaries.** All `*_summary` fields capped (e.g., 280 chars). No unbounded text fields in lifecycle tables.
- **Secret-detection pass.** Summary generation runs text through a basic secret pattern match (API keys, tokens) before persisting; matches are elided.
- **Local-only by default.** `.canon/drift-db.sqlite` is already gitignored. Lifecycle tables inherit.
- **Team sharing is out of scope for v2.1.** If/when Canon grows team features, a separate "shared" DB (committed to a dedicated repo, or a hosted service) handles cross-machine sync. Not this scope.

### 12.7 Phase impact

| Phase | Lifecycle persistence work |
|-------|---------------------------|
| Phase 1 | No change — still additive. Journal's `domain_skills_loaded` field is the schema foundation. |
| **New: Phase 1.5** | Schema migration adding `lifecycle_*` tables. `snapshot_workspace` + `query_workspace_history` MCP tools. `completion-verify.sh` hook extended to call snapshot. Retention policy stub. |
| Phase 2 | Phase 2a calibration uses `query_workspace_history` to pull snapshot data for human review. Skill-effectiveness baseline queries the same tool. Confidence calibration curve is computed over the snapshot corpus. |
| Phase 3 | No direct impact — lifecycle persistence is additive to the synthesis architecture. |

**Phase 1.5 justification:** Synthesis ships workable without persistence (Phase 1), but without persistence, Phase 2 calibration has no storage substrate. Either Phase 1.5 lands before Phase 2a, or we fold it into Phase 1 and Phase 1 grows. My lean: split it — Phase 1 is additive-only per the v2 plan's constraint; Phase 1.5 is the bridge to Phase 2 validation.

### 12.8 What this unlocks (concretely)

Once lifecycle snapshots land, these queries become first-class:

- *"All `fix` executions with `cause: security` where confidence was 0.6–0.8 — what was the outcome?"* — calibrates confidence against a specific failure mode.
- *"Synthesized runbooks where the lead deviated by skipping `review` — subsequent regression rate?"* — validates `review` necessity or identifies over-cautious synthesis.
- *"For auth-touching requests, which `skills:` combinations correlate with fewer fix iterations?"* — learner's skill-effectiveness analysis.
- *"Runbooks synthesized against vocabulary v1.2 vs. v1.3 — outcome deltas?"* — A/B testing the vocabulary itself.
- *"Workspaces where HITL events exceeded N — common root causes?"* — surfaces where human judgment is irreplaceable vs. where planner calibration is off.

None are answerable from workspace files alone (cleaned up) or git alone (coordination data missing). The snapshot DB is the join point that makes synthesis auditable and reliable across time.

### 12.9 Open questions specific to persistence

1. **Schema versioning in SQLite** — drift-db migration story for the new tables. Does Canon already have a migration framework, or do we land the schema as a bundled seed?
2. **`brief_summary` generation** — who writes it? The planner emits one as part of its output? Or a post-hoc summarizer in `snapshot_workspace`? Lean: planner emits it (cheap, authoritative).
3. **Deviation detection sensitivity** — a skipped optional step is a legitimate deviation but not noteworthy; a skipped mandatory tail is a serious deviation. Do we categorize deviations by severity in the schema?
4. **Query cost** — `query_workspace_history` with arbitrary filters over years of data could become slow. Indexing strategy? At what scale does this matter in practice? (Probably never for a single-dev repo; maybe for team repos.)
5. **Cross-repo learning** — if a team wants Canon to learn from multiple repos' lifecycles (shared planner memory), how does that work? Out of scope for v2.1 but worth noting the boundary.

---

## 13. Updates to earlier sections implied by §12

The "ephemeral runbooks" loss in the critical assessment (recorded in the PR #115 conversation) is **struck**. With lifecycle persistence:

- Runbooks become data, not files — queryable across runs
- Temporal introspection is richer than static runbooks ever provided (step-level detail, HITL patterns, deviation tracking)
- Skill effectiveness analysis has a real corpus

The conditional was: *"runbooks become data instead of files — which under proper lifecycle persistence is a substantial gain."* §12 commits to the persistence layer, so the gain is unconditional in v2.1's final shape.

This does **not** resolve:

- **Planner risk concentration** — still a real architectural concern; mitigate via an escape-hatch mechanism (user specifies `runbook.md` directly, skips planner).
- **Self-improving loop is promissory** — §4b P4 still isn't built. Phase 1.5 + Phase 2 validation are the path to realizing it; nothing ships it for free.
- **Scope vs. velocity** — we're now committing to Phase 1.5 work on top of the original proposal. Honest accounting: this is substantial additional scope with genuine justification, not a bolt-on.

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
