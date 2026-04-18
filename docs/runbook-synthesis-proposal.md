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

Phase 1 of the agent-teams migration specified 5 hardcoded runbooks (fast-path, feature, epic, migrate, test-gap) plus 4 flows handled via CLAUDE.md inline dispatch. In the course of landing `phase1-00` (the runbook format template), we realized the hardcoded model is itself a vestige of the state-machine mental model the v2 migration is explicitly shedding.

§2.1 of the migration plan argues: *"Everything `drive_flow` coordinates — sequencing, conditionals, HITL gates, parallel dispatch, convergence, skip conditions, effects — is native Claude capability."* If that's true for the scheduler, it's true for runbook composition too. Static runbooks are "give Claude a rigid playbook to follow"; the v2 architecture points toward "Claude composes a plan-specific runbook from a canonical vocabulary."

But a deeper reframe emerged during the review thread: **synthesis isn't primarily about plan-matches-work. It's what makes Canon's whole stack learnable.** Static runbooks don't learn — whoever wrote them wrote them once. Synthesized runbooks, captured as lifecycle records, feed a learning system that improves:

- Principles (rules, opinions, conventions) from observed enforcement
- Plan quality (synthesis skill, brief skill) from observed outcomes
- Design patterns from architect decisions that stick
- Template health from which sections agents actually use
- Skill effectiveness from which primers correlate with better outcomes
- Agent memory from what's been observed vs. what's remembered
- Vocabulary itself from step usage patterns

Canon's real differentiation — per v2 §1, *"principles and artifacts as the engine's product"* — is only durable if the whole stack improves from every interaction. That requires a learning substrate, and synthesis is load-bearing for it.

The shift:

| | Hardcoded (v2) | Synthesized + learned (v2.1) |
|---|----------------|------------------------------|
| Standing artifacts | 5 runbook files, 4 inline-dispatch patterns in CLAUDE.md | 1 vocabulary + 2 skills (brief + synthesis) + lifecycle persistence |
| Flow-matches-work | Flow labels approximate; `skip_when` handles variants | Runbook tailored per-request via planner-user iteration |
| Intent classification | 9-row table in CLAUDE.md | Every build request → `canon-planner` → iterate-until-approved |
| Authoring burden | 5 files × N future changes = 5N edits | 1 vocabulary update per step addition; learner proposes skill refinements |
| **Does Canon improve over time?** | Only via manual principle edits | **Yes — observation → pattern → proposal → refinement across the whole stack** |

Critically, we keep all the determinism we care about — artifact production, commit trailers, claim release, mandatory tail steps (`context-sync` + `learn`), completion verification — and add a learning substrate that sharpens every Canon artifact from observed execution.

## 2. Decisions log

Explicit decisions made in the PR #115 review thread, in order:

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Brainstorm vocabulary broadly before capping | Avoid premature abstraction; see what Canon actually does |
| 2 | `cause`-style parameterization is first-class, broader than just `fix` | Generalizes to `skills:` field on any step |
| 3 | `canon-planner` does runbook synthesis via a dedicated skill, not baked into the agent body | Portable knowledge; synthesis can be loaded by other agents (learner, validators) |
| 4 | Amend `docs/agent-teams-migration-plan-v2.md` as v2.1, not a separate ADR | Keep the plan authoritative; avoid ADR-vs-plan split-brain |
| 5 | Mark `phase1-01..04` plans abandoned; delete any runbook files they would have produced | None exist yet — only the template + README on this PR |
| 6 | Two-skill split: `planner-brief.md` (strategic) + `runbook-synthesis.md` (mechanical) | Different mental modes; cleaner to reason about and evolve |
| 7 | Strict validation of `skills:` names against `skills/canon/references/` at synthesis time | Typo safety; catches skill drift early |
| 8 | Confidence score is a **surfaced signal during iteration**, not a gating mechanism | Planner proposes, user approves; confidence informs the user, doesn't decide for them |
| 9 | `mode` field deferred, handled in synthesis rules until evidence warrants promotion | Only 2–3 real variants today; promote when inline rules proliferate |
| 10 | **Iterate-until-approved planner loop** replaces autonomous-execution thresholds | User is always the gate; eliminates confidence-threshold gating, recipes-as-separate-concept, escape hatches |
| 11 | **Learning system is the headline**, synthesis is one mechanism in service of it | Canon's quality-up guarantee comes from the learning loop; synthesis makes plan quality learnable where static runbooks can't |
| 12 | **Agent memory is a first-class refinement target** | Same corpus supports memory audit, grooming, and seeding — not just principle refinement |

## 3. Canon's learning system

Canon's quality-up story depends on a single mechanism applied across every dimension of what it produces:

**Observation → Pattern → Proposal → Refinement**

- **Observation** — a single data point from a flow. "In flow X, review found principle P violation on file Y; fix took N iterations; the fix summary cited root cause Z."
- **Pattern** — recurring observations across multiple flows. "10 recent flows showed principle P violations on auth-related files; 8 shared the same underlying cause."
- **Proposal** — a concrete refinement suggestion grounded in the pattern. Structured patch to an artifact (principle file, skill, template, memory entry, agent prompt, vocabulary entry).
- **Refinement** — an accepted proposal applied to the relevant Canon artifact.

Every interaction contributes observations to a growing corpus. The learner periodically mines that corpus for patterns and emits proposals. Human review accepts or rejects; accepted proposals land as refinements. Over weeks and months, Canon's principles sharpen, its synthesis skill learns common request shapes, its templates lose dead sections, its agents' memories stay groomed, and its domain skills reflect what actually works.

This is the **unified learning loop**. There isn't one for principles and one for plans — there's one mechanism with many refinement targets.

### 3.1 Why synthesis is load-bearing for this

Static runbooks break the plan-quality arm of this loop. A hand-written `fast-path.md` never learns — whoever wrote it wrote it once. Whatever observations accumulate about how fast-path runs play out have no feedback path into the file.

Synthesized runbooks close that loop. Each run is a data point: planner proposed X, user iterated to Y, execution produced outcome Z. The learner sees the pattern ("planner consistently misses `security` step for auth-touching requests"), proposes a synthesis-skill refinement ("when affected files match auth paths, include `security` by default"), and the next synthesis does better.

Static runbooks serve principle refinement fine — the corpus still captures review findings, fixes, and deviations. But they obstruct plan refinement entirely. Synthesis is what makes Canon learn at the plan layer, not just the principle layer.

### 3.2 Why the learner is the engine

The `canon-learner` agent is the orchestrator of this mechanism. Today it mostly produces principle and convention suggestions. Under v2.1, its role expands: it analyzes the full corpus, detects patterns, and emits proposals targeting *any* Canon artifact.

One agent, many query types, many output targets. Same learner, richer analyses.

### 3.3 Why lifecycle persistence is the substrate

Observations only compound if they're captured durably. Workspace files are ephemeral — cleaned up after flows complete. Without persistence, each run's signal is lost. With persistence (see §11), each run contributes to a permanent corpus the learner can mine.

Lifecycle persistence isn't an implementation detail — it's the thing that makes the whole learning system possible.

## 4. Refinement targets matrix

The full surface of Canon artifacts the learning system can refine:

| Target | Location | What gets refined |
|--------|----------|-------------------|
| **Principles** | `principles/*.md` | Scope narrowing, severity promotion/demotion, wording clarifications, new principles from recurring patterns |
| **Conventions** | `.canon/CONVENTIONS.md` | Established patterns observed across N flows; graduation to principles when warranted |
| **Runbook synthesis skill** | `skills/canon/references/runbook-synthesis.md` | Default step selection, skill-selection patterns, contract pairings, request-shape recognition |
| **Planning brief skill** | `skills/canon/references/planner-brief.md` | Strategic analysis patterns, open-question framing, value-assessment accuracy |
| **Domain skills** | `skills/canon/references/*.md` | Primer content accuracy, co-loading patterns, gaps where a new primer is warranted |
| **Templates** | `templates/*.md` | Section utility (drop dead sections), placeholder clarity, structured-tag additions |
| **Agent definitions** | `agents/*.md` | Prompt refinements, `skills:` frontmatter, preloaded rules |
| **Agent rules** | `rules/*.md` | Clarify wording that led to misapplication; add new rules from observed needs |
| **Vocabulary** | `skills/canon/references/runbook-vocabulary.md` | Step ID additions when compound sequences recur; usage-driven defaults |
| **Agent memory** | `.claude/memory/{agent}/*` | Stale entry correction, redundant consolidation, citation-based pruning, seed bundles for new agents |
| **Knowledge graph priors** | `knowledge-graph.db` | Observed file relationships, domain inferences, confidence-weighted edges |

Today's learner produces proposals mostly in the first two rows. Under v2.1, it can target any row.

Each target has its own evidence threshold (see §12), cadence (weekly / monthly / quarterly), and review process. Principle changes warrant more scrutiny than template tweaks. The learner emits at the appropriate threshold per target.

### 4.1 Shared vs. target-specific analyses

Some analyses produce proposals for a single target; others correlate across targets.

- **Single-target:** "Principle P's fix-iteration cost is 3× the baseline → refine P." Target: principles.
- **Cross-target:** "Agents that load `authentication-security` skill during `fix` steps with `cause: security` have 40% fewer iterations. Two proposals emit: (a) update `runbook-synthesis.md` to auto-include that skill for security fixes, (b) update `authentication-security` domain skill to highlight the most-cited patterns."

Cross-target analyses are the highest-value signal — they show connected improvements across Canon's stack.

## 5. Observation mechanism — hybrid structured tags + prose

The learning system needs observations captured at flow time, stored durably (§11), and queryable cross-run. Two viable approaches existed: everything upfront-structured, or everything post-hoc extracted. Neither is ideal.

**Decision: hybrid.** Specialist agents produce their normal prose artifacts unchanged. They add lightweight **structured tags** in frontmatter for the highest-value signals. The learner reads both — tags are high-confidence signals consumed directly; prose is fallback for richer analysis when needed.

### 5.1 Why hybrid

- **Upfront-only structured:** rigid; heavy authoring burden; schema changes cascade to every agent. Over-engineers the observation layer before we know what's useful.
- **Post-hoc-only extraction:** extraction quality varies; LLM token cost per flow; latency. Spends tokens extracting what agents could have emitted directly.
- **Hybrid:** low authoring burden (small frontmatter additions); high-value signals are structured and direct; prose stays natural for deeper analysis. Schemas evolve gradually as useful fields become clear.

### 5.2 First-pass structured tags per artifact

Low-burden additions to existing templates. Agents already produce this information in prose; promoting the most-useful bits to structured fields is cheap.

| Artifact | Structured frontmatter fields |
|----------|------------------------------|
| Planning brief | `confidence` scalar + `confidence_signals[]`, `request_shape_tag`, `alternatives_considered` count |
| Synthesized runbook | (§9 covers step schema; `vocabulary_version` on frontmatter) |
| Research finding | `dimensions_explored[]`, `risks_surfaced[]`, `confidence_per_dimension{}` |
| Design decision | `decision_id`, `options_considered` count, `chosen_option_tag`, `rationale_tags[]` |
| Task plan | `task_id`, `dependencies[]`, `file_count`, `principle_ids[]` |
| Implementation summary | `compliance_declared_for: [principle_id]`, `justified_deviations: [{principle_id, reason_short}]`, `memory_cited: [item_id]` |
| Test report | `tests_added` count, `coverage_delta`, `tests_paired_with_principle_ids[]` |
| Review finding | `principle_id` per finding, `severity`, `file_path` |
| Fix summary | `cause`, `root_cause_tag`, `upstream_step_id` |
| HITL event | `event_type`, `posture`, `outcome`, `step_id_affected` (often null) |

### 5.3 Tag discipline — rules the indexer follows

- **Tags are optional.** Missing fields don't fail ingestion. Indexer tolerates absence; learner treats missing as "no signal from this field" rather than error.
- **Tags are additive.** Agents can include fields not in the first-pass schema; indexer stores them as a generic `extra_tags` JSON blob. Useful fields get promoted to first-class columns in a later schema revision.
- **Prose stays authoritative.** When a tag and prose disagree, prose wins for factual questions; tag wins for aggregate analysis. (The learner flags tag-prose disagreement as a data-quality signal.)
- **Secret / PII scrubbing.** Tag values pass through a basic secret-pattern match before persistence. Free-text short-summary fields are bounded (e.g., 280 chars).

### 5.4 What about richer analysis the tags don't capture?

Prose extraction remains available for the learner when it wants richer context than tags provide. E.g., if the learner detects a pattern in design-decision outcomes but wants to understand *why* architects chose certain options, it reads the `rationale_tags[]` tag first, falls back to scanning the prose body of the decision artifact if the tags aren't sufficient.

This is a small number of LLM calls per week (at learner cadence), not per flow. Avoids the token cost of per-flow extraction while preserving the ability to dig deeper when analysis requires it.

### 5.5 Memory citation — a specific observation worth calling out

One structured tag deserves highlighting because it enables memory grooming (§7): `memory_cited: [item_id]` on agent outputs.

When an agent loads its project memory and actually uses an entry, it declares the citation. This gives the learner a direct signal about which memory entries earn their place. Entries cited across many flows are valuable; entries never cited are candidates for pruning.

Implementation is a prompt addition in the agent definition: *"when your output uses information from your project memory, list the cited memory entry IDs in your structured output's `memory_cited` field."* Small change; enables whole memory-audit dimension of the learning system.

### 5.6 Commit trailers as a second observation channel

Beyond structured tags in artifacts, commit trailers are the second observation channel — specifically for code-line-level provenance that survives workspace tear-down and lives in git forever.

**Canon-Deviation trailer family** (new):

```
Canon-Deviation: <principle-id>
Canon-Deviation-Rationale: <short reason>
Canon-Deviation-Decision: <decision-id, optional>
```

When an engineer writes code that intentionally deviates from a principle, they record both:
1. A `justified_deviations[]` entry in their implementation summary (§5.2 structured tag)
2. A `Canon-Deviation*` trailer on the specific commit where the deviating code lands

The trailer is the durable second layer. It survives workspace tear-down, is readable via standard `git log` / `git blame`, and gives future readers direct line ↔ rationale linkage without needing Canon-specific tooling.

**Why both the summary tag and the trailer:**

| Channel | Lifetime | Granularity | Consumer |
|---------|----------|-------------|----------|
| `justified_deviations[]` tag in summary | Retained per §11 retention tiers | Per-flow (all deviations in this flow) | Learner pattern detection |
| `Canon-Deviation*` trailer in commit | Forever in git history | Per-commit (specific code lines) | Blame / review / audit |

The lifecycle indexer scans `git log --grep=Canon-Workflow:${slug}` during `snapshot_workspace` to extract trailer data into the corpus (see §11.3 `lifecycle_deviations` table). The reviewer agent cross-references trailers when assessing principle compliance — commits with authorizing trailers treat the deviation as intentional; commits without treat it as a defect.

**Validation via PostCommit hook:** when an implementation summary declares a `justified_deviations` entry, every commit in the step's range must carry a matching `Canon-Deviation` trailer. Hook exits 2 if missing, with a message instructing the engineer to amend or add the trailer.

### 5.7 Schema policy — closed for v2.1

Per §15 resolved-question #7: **the structured-tag schema is closed for v2.1**. The fields enumerated in §5.2 are the complete list. Agents that emit fields outside this list have those fields **dropped** by the indexer; nothing is silently captured in a generic `extra_tags` JSON blob.

**Rationale:**

- We don't yet have signal on which extra fields agents would invent. Designing a promotion path before any data exists is premature optimization.
- SQLite JSON queryability is decent but real query performance comes from indexed columns; an open `extra_tags` blob accumulates unstructured data that never gets the column treatment unless explicitly promoted.
- A closed schema forces every additional signal through a deliberate schema-change review, which is a healthy forcing function.

**How to evolve the schema** (when a new field is wanted):

1. Propose a schema change as a versioned migration against `drift-schema.ts`
2. Update the relevant template + agent prompt
3. Migrate existing data if applicable
4. Same review cadence as Canon principle changes

**Future possibility (v2.2+, not in v2.1):** the learner could analyze patterns in agent prose outputs, detect recurring fields agents *would* like to emit, and propose schema additions automatically. This is a natural extension of the learning system but explicitly out of scope for v2.1; it would require the learner to have demonstrated trustworthy proposals on principle/synthesis-skill targets first.

## 6. Learner analyses gallery

> **⚠️ ALL NUMBERS IN THIS SECTION ARE FABRICATED — ILLUSTRATIVE ONLY.** They describe *hypothetical* query results to demonstrate the data-to-value path; **they are not measurements from actual Canon usage**. Per architect change #4 (§16), one real end-to-end trace against today's Canon data (drift-db, learning.jsonl, git log) is required before ratification. Actual numbers will replace these illustrations at that point, or the analysis will be removed if the trace shows it can't produce acceptable proposals from available data.

Concrete *illustrative* examples of query → pattern → proposal flows the learner would run against the lifecycle corpus. Each one shows the data-to-value path and what infrastructure it depends on.

### 6.1 Principle refinement from review findings

**Query:** "Across the last 50 flows, which principles had review findings, and what was the fix-iteration cost per principle?"

**Hypothetical result (fabricated):**

| Principle | Findings | Avg fix iterations |
|-----------|----------|-------------------|
| `thin-handlers` | 12 | 1.1 |
| `error-bubbling` | 8 | 1.2 |
| `result-types` | 15 | **3.1** |

**Pattern (if this were the data):** `result-types` takes 3× the fix iterations. Either the principle is ambiguous or hard to apply.

**Follow-up query:** "For `result-types` fixes, what did fix summaries say?"

**Hypothetical follow-up result (fabricated):** 10 of 15 mentioned "unclear how to apply to callback-style APIs."

**Proposal (conditional on real data showing this shape):** structured patch to `principles/result-types.md` narrowing scope or adding a callback-case example.

**Depends on:** `principle_id` on review findings; fix summary `cause` and `root_cause_tag`.

**Architect change #4 target:** this is the analysis to hand-run against real data before ratification. If real data shows this pattern, it's the first learner win; if not, we've learned the analysis design needs revision.

### 6.2 Plan refinement from deviations

**Query:** "Across recent runbooks, which had 3+ deviations?"

**Hypothetical result (fabricated):** 8 runbooks with deviations; of those, 6 had a `security` step *added* by the lead that the planner hadn't synthesized. Follow-up: all 6 touched `src/auth/**` or `src/api/**/session*`.

**Proposal (conditional):** update `runbook-synthesis.md` — *"when affected files match auth paths, include `security` step by default."*

**Depends on:** `lifecycle_runbook_deviations` table; file-path tagging on requests.

### 6.3 Skill effectiveness from `domain_skills_loaded` × outcome

**Query:** "For `fix` steps with `cause: security`, which skill combinations correlate with fewer iterations?"

**Hypothetical result (fabricated):**

| Skills combination | Avg fix iterations |
|-------------------|---------------------|
| `[]` | 3.8 |
| `[authentication-security]` | 2.3 |
| `[authentication-security, backend-api]` | 1.4 |
| `[authentication-security, error-handling]` | **1.1** |

**Proposal (conditional on real data showing this shape):** update `runbook-synthesis.md` — *"for `fix` with `cause: security`, include both `authentication-security` AND `error-handling` in `skills:` by default."*

**Depends on:** journal's `domain_skills_loaded` + `cause` + fix outcome tracking. Note: this is a 3-way join and the most aspirational analysis in the gallery — architect flagged it as hardest to deliver.

### 6.4 Decomposition quality from task-plan tags

**Query:** "Correlate task `file_count` with downstream fix-iteration count per task."

**Hypothetical result (fabricated):** 1–2 files → 0.3 avg fix iterations; 3–5 files → 1.2 avg; 6+ files → 3.1 avg (20% with test failures).

**Proposal (conditional):** update `templates/task-plan.md` with explicit guidance ("aim for 2–4 files per task"); add new rule `agent-task-right-sizing.md`.

**Depends on:** `file_count` on task-plan frontmatter; linking tasks to downstream fix events.

### 6.5 Design quality from decision tags

**Query:** "For design decisions where `options_considered = 1`, what's the reversal rate in later flows?"

**Hypothetical result (fabricated):** 40% reversal rate vs. 8% when `options_considered ≥ 3`.

**Proposal (conditional):** update `canon-architect.md` or create `agent-explore-alternatives` rule.

**Depends on:** `options_considered` on design-decision frontmatter; decision-reversal detection across flows.

### 6.6 Template health from section-completeness

**Query:** "Across recent implementation logs, which template sections are routinely empty?"

**Hypothetical result (fabricated):** "External Evidence" present in 8% of logs; "Verified Facts" in 15%; "Assumptions" in 62%.

**Proposal (conditional):** revise `templates/implementation-log.md` — drop sections that aren't earning their place.

**Depends on:** per-section completeness tracking (could be derived post-hoc by the indexer scanning artifacts).

### 6.7 HITL pattern analysis

**Query:** "At which steps do users most often intervene during iteration?"

**Hypothetical result (fabricated):** `design` interventions far outnumber `research` interventions per flow.

**Proposal (conditional):** amend `runbook-synthesis.md` — for design steps, include planner's confidence-signals inline in the brief; surface open questions explicitly.

**Depends on:** `lifecycle_hitl_events` table; step-level linkage.

### 6.8 What a learner run might produce (hypothetical)

Weekly, the learner would run these analyses in parallel and output a single digest. Hypothetical shape (fabricated; digest format will be designed once v2.2 scope is reached):

```
# Canon Learning Digest — Week of [date]

## High-confidence proposals (≥ 0.9)
- Refine principle `result-types` (§6.1) — structured patch attached
- Add task-right-sizing rule (§6.4) — draft rule attached

## Medium-confidence proposals (0.7–0.9)
- Auth-path synthesis default (§6.2) — patch to runbook-synthesis.md
- Security fix skill combo (§6.3) — patch to runbook-synthesis.md

## Observations accumulating (below threshold)
- Design options-count correlation (§6.5) — not enough observations yet
- Template section dead zones (§6.6) — pattern visible; below threshold
```

Digest format, review cadence, and acceptance workflow are all **hypothetical**; final shape will be designed if and when v2.2 reaches the point of producing cross-target analyses. V2.1b's single-analysis deliverable (principle refinement from §6.1) does not require the digest format — a single proposal in `.canon/proposed-learnings/` is sufficient.

## 7. Agent memory audit / groom / seed — DEFERRED to v2.2+

**Status:** Cut from v2.1 per architect review (change #2 in §16). Automated writes to agent memory files (`.claude/memory/{agent}/*`) based on corpus statistics are high-risk: the failure modes are real (groom away rarely-cited-but-critical knowledge; consolidate memory items incorrectly and lose a nuance; seed a new agent with stale patterns that calcify into its new baseline). That risk is not worth taking on before v2.1b has demonstrated the base learner produces trustworthy proposals on lower-risk targets (principles, conventions, synthesis skill).

**Phasing:**

- **v2.2** — memory audit (staleness detection, corpus cross-check, overconfidence detection) + memory grooming (citation-driven pruning, consolidation, budget management). Contingent on v2.1b demonstrating ≥ 3 accepted principle-refinement proposals. The `memory_cited` structured tag (§5.5) is the load-bearing signal; it moves to v2.2 scope alongside the memory analyses.
- **v2.3+** — memory seeding for new agents and fresh repos. The seed-bundle format is its own artifact design; defer further until v2.2's audit/groom produces enough accumulated memory data to seed from.

**Upstream references that change:**

- §5.5 (memory citation tag) — the `memory_cited` field moves to v2.2 scope alongside audit/groom. Not captured in v2.1b.
- §4 refinement matrix — "Agent memory" row becomes v2.2 scope.
- §13 rollout — memory citation prompt guidance (currently in Tier 2) moves to v2.2 work.
- §17.3 v2.2 scope — already lists this correctly.

**Design content preserved:** The original §7 design (audit analyses, grooming analyses, seed-bundle concept, infrastructure table) is moved to **Appendix B** for reference when v2.2 is drafted.

## 8. Vocabulary

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

### 8.1 Explicitly dropped candidates

| Dropped | Why |
|---------|-----|
| `scan` | Scope of `research` |
| `map` | Covered by `codebase_graph` MCP tool + SessionStart KG-check hook; not a per-flow step |
| `triage` | Scope of `research` (ranked-list output) |
| `profile` | Speculative — no Canon perf flow today; add via versioned-change process if one emerges |
| `risk-assessment` | Scope of `research` with `skills: [risk-analysis]` |
| `refactor` | Handled via synthesis rule — `implement` with mandatory-following `verify`; promote to `mode: refactor` if evidence warrants |
| `smoke` | Scope of `verify` |
| `audit` | Scope of `review` |
| `rollback-prep` | Paired artifact of `migrate`; handled in synthesis rule, not a separate step |
| `monitor` | No Canon ops/deploy flow today; add later if one emerges |
| `release` | Subsumed into `ship` unless release automation becomes distinct |

### 8.2 Vocabulary evolution discipline

The vocabulary is versioned and evolves under semver-style discipline:

- **Minor versions are additive only.** New step IDs, new default values, new optional fields. Existing runbooks remain valid.
- **Major versions may remove or rename entries**, but only after a deprecation cycle.
- **Deprecation cycle:** at least one minor version where the entry is marked deprecated (still functional, but emits a deprecation notice). Removal happens in the next major version. Runbooks synthesized during the deprecation window get a warning at synthesis time.

**Resume implications** (relevant to §11.3 `lifecycle_synthesized_runbooks.vocabulary_version` and §15 resolved-question #3):

- Resume against a *minor-version-newer* vocab → locked runbook continues to work fine; no user prompt needed
- Resume against a *major-version-newer* vocab where the locked runbook references a removed entry → regeneration required (user approval gated, planner re-synthesizes with full workspace context per §17.1 entry gate semantics)
- Resume against a vocab that deprecated (but did not remove) a referenced entry → continues with notice; user may opt to abandon and regenerate

This discipline keeps regeneration rare. Most vocab evolution is additive and never triggers a resume regen path at all.

## 9. Step schema — first-class fields

Every step in a synthesized runbook carries structural fields (from `templates/runbook-template.md`), plus three domain-oriented axes:

### 9.1 `skills:` — what domain expertise to load

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

**Validation:** strict. The planner validates every `skills:` name against the file list in `skills/canon/references/` at synthesis time. Unresolvable names are a synthesis error.

**Why declarative, not inline prose:** planner decides skill selection at synthesis; journal's `domain_skills_loaded` field captures the list verbatim; multiple skills per step compose cleanly; no step-specific `domain` / `scope` field proliferation.

### 9.2 `cause:` — analytic lineage + skill hint (fix-specific)

Used on `fix` (and potentially future re-work steps). Carries two signals:

1. **Analytic:** which upstream step triggered this fix (for outcome correlation)
2. **Skill hint:** a default primer the planner auto-adds to `skills:` (e.g., `cause: review` → `review-feedback-handling`)

```yaml
- id: fix
  agent: canon-engineer
  cause: security                 # analytic + hints at authentication-security skill
  skills:
    - authentication-security     # explicit additional primer
  artifacts: ["plans/${slug}/FIX-SUMMARY.md"]
  hitl: on_failure
```

### 9.3 `mode:` — deferred

Rejected for v2.1 as a general mechanism. Real variants today (`implement` behavior-preserving refactor, `migrate` schema/data) are handled via rules in `runbook-synthesis.md`:

- "When the task is behavior-preserving, synthesize `implement` with skill `refactor-methodology` and mandatory-following `verify` with 'no behavior changes' criterion."
- "Schema/data migrations synthesize `migrate` (not `implement`), paired with rollback artifact."

Promote `mode:` to a first-class field in a future vocabulary revision if synthesis rules proliferate beyond 3–4 variants.

## 10. Synthesis contract

Rules the planner (via `runbook-synthesis.md` skill) MUST follow when emitting a runbook. These invariants replace the structural guarantees static runbooks used to provide.

### 10.1 Planner MUST

1. **Include mandatory tail.** Every build runbook ends with `context-sync` followed by `learn`. Not optional, not reorderable.
2. **Use canonical step IDs only.** Any step ID not in `runbook-vocabulary.md` is a synthesis error.
3. **Preserve default agent / dispatch / HITL** unless overriding with explicit justification in the brief body.
4. **Validate `skills:` names strictly** against `skills/canon/references/` at synthesis time.
5. **Use `${slug}` / `${task_id}` / `${timestamp}` placeholders** per the runbook format spec.
6. **Include a one-paragraph Overview** explaining why this step sequence was chosen.
7. **Emit body H3 prose per step** with intent, skip-when elaboration, and coordination notes (per `skills/canon/runbooks/README.md`).
8. **Apply contract pairings** from synthesis rules:
   - Behavior-preserving `implement` → mandatory-following `verify` with "no behavior changes" criterion
   - `migrate` → paired rollback artifact
   - `security` findings → at least one `fix` step with `cause: security` before `ship`
   - `review` verdict not clean → `fix` with `cause: review` loop until clean

### 10.2 Planner MAY

- **Reorder steps** (`security` before `review` for auth-sensitive changes)
- **Skip optional steps** (`design` for scoped fixes; `test` for doc-only changes)
- **Repeat steps** (two `review` passes for risky migrations; multiple `fix` cycles)
- **Expand a single step into multiple waves** (`implement` split into wave 1 = core + wave 2 = extensions)

### 10.3 Planner MUST NOT

- **Invent new step IDs.** Adding a vocabulary entry is a deliberate versioned change, not a per-run decision.
- **Remove baseline HITL** from step defaults. The runbook's declared `hitl:` posture stays regardless of any signal.
- **Skip mandatory tail** regardless of flow size or user preference.

### 10.4 Iteration, not one-shot

The contract applies across the full planner-user iteration loop. The planner proposes a runbook; the user reviews; either approves or requests changes. If the user's requested change would violate a MUST (e.g., "skip context-sync"), the planner pushes back. If the change is within MAY, the planner adapts and re-emits. Iteration continues until the user approves.

This means "the planner's output" is really "the finally-approved runbook", which may differ from the initial proposal. Both are captured in the lifecycle corpus — initial and approved versions — so the learner can analyze iteration patterns.

## 11. Lifecycle persistence — the substrate for the learning system

Everything in §3–§7 depends on one piece of infrastructure: a durable, queryable record of what happened in each flow that survives workspace cleanup. Workspaces under `.canon/workspaces/<id>/` are ephemeral by design — they're scratch, not record. Without repo-level persistence, observations are lost and the learning loop can't close.

This section locks in the storage decision and sketches schemas. It is the load-bearing layer under the rest of the proposal.

### 11.1 Storage decision

**Extend `.canon/drift-db.sqlite` with new `lifecycle_*` tables. Per-run snapshot at flow completion.**

Rationale:

- Drift analytics and lifecycle persistence have the same underlying concern: time-series record of execution. Calling it "drift" vs. "lifecycle" is naming; the data model is continuous.
- Existing infrastructure already handles schema migrations, query layer, and retention policy hooks. Don't duplicate it.
- New tables use a `lifecycle_` prefix to partition from existing drift tables and keep the mission boundary explicit.
- JOINs with the existing `FlowRunEntry` table are natural — same `workspace_id` key.

Rejected alternatives:

- *New dedicated DB (`.canon/lifecycle.db`)* — two DBs, duplicate infrastructure, cross-DB JOINs need app-level work.
- *Pure JSONL append-log* — simple but every query is a scan; no joins; structured queries need an import step. Reserve JSONL for raw event capture if direct DB writes become a bottleneck.

Fallback if drift-db feels overloaded: Kappa pattern — raw events append to JSONL (`runbook-history.jsonl`, `hitl-events.jsonl`), materialized into drift-db tables on demand via a `refresh_lifecycle_index` MCP tool. Don't build now; keep as escape hatch.

### 11.2 Persistence boundary — per-run snapshot

Workspace files are the source of truth *while a flow is running*. At flow completion, `snapshot_workspace({ workspace_id })` reads the workspace and materializes a structured lifecycle record.

- `completion-verify.sh` hook is the natural trigger — verify, snapshot, then the workspace can be safely cleaned up
- Janitor processes also call `snapshot_workspace` before deleting abandoned workspaces, preserving partial state

**In-progress flows are queried from the workspace, not the DB.** Real-time dashboards / mid-run interventions are out of scope for v1. If they emerge as a need, upgrade to write-through later — the snapshot table schema is the same either way.

### 11.3 New tables

All under the `lifecycle_` prefix in `drift-db.sqlite`.

#### `lifecycle_synthesized_runbooks`

One row per synthesis event (initial proposal OR approved final — both persisted to support iteration analysis).

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | |
| `workspace_id` | TEXT | Links to existing `FlowRunEntry.workspace_id` |
| `slug` | TEXT | Workspace slug |
| `synthesizer_agent` | TEXT | Usually `canon-planner` |
| `vocabulary_version` | TEXT | Version of `runbook-vocabulary.md` this was synthesized against |
| `synthesis_skill_version` | TEXT | Version of `runbook-synthesis.md` used |
| `stage` | TEXT | `proposed` / `approved` / `regenerated` — `regenerated` rows are emitted when a resume across vocab major versions triggers re-synthesis (per §8.2 + §15 resolved #3); they reference the original via `original_runbook_id` |
| `original_runbook_id` | INTEGER FK nullable | Set on `regenerated` rows; points to the originally-approved runbook this re-synthesis succeeds |
| `iteration_index` | INTEGER | 0 = first proposal; N = Nth iteration during user review |
| `confidence` | REAL | 0.0–1.0 |
| `confidence_signals` | JSON | `[{signal, value}]` |
| `step_ids` | JSON | Ordered list of canonical step IDs |
| `brief_summary` | TEXT | Bounded summary; no verbatim user input |
| `synthesized_at` | TIMESTAMP | |

#### `lifecycle_step_executions`

One row per executed or skipped step (of the approved runbook).

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | |
| `runbook_id` | INTEGER FK | `lifecycle_synthesized_runbooks.id` (approved stage) |
| `step_id` | TEXT | Canonical vocabulary ID |
| `step_index` | INTEGER | Ordinal position |
| `agent_type` | TEXT | Nullable for gate-only steps |
| `dispatch` | TEXT | `subagent` / `team` / null |
| `skills_loaded` | JSON | Array of skill names actually loaded |
| `cause` | TEXT | Nullable — for fix steps |
| `mcp_tools_called` | JSON | Pre-spawn composition tools |
| `artifacts_expected` | JSON | From runbook |
| `artifacts_produced` | JSON | On disk post-step |
| `status` | TEXT | `started` / `completed` / `skipped` / `failed` |
| `skip_reason` | TEXT | Nullable |
| `outcome` | JSON | `{review_verdict, fix_iterations, test_pass_rate, memory_cited, ...}` |
| `started_at`, `completed_at` | TIMESTAMP | |

#### `lifecycle_hitl_events`

One row per user intervention.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | |
| `runbook_id` | INTEGER FK | |
| `step_execution_id` | INTEGER FK nullable | Null when outside a specific step |
| `event_type` | TEXT | `approval` / `clarification` / `redirect` / `reject` / `abort` / `iterate` / `modify` / `escalate` / `consult` (per §15 resolved #8) |
| `phase` | TEXT | `synthesis` / `execution` / `post_execution` (per §15 resolved #8) — distinguishes when in the flow lifecycle the event occurred |
| `posture` | TEXT | Step's declared `hitl` or `unscheduled` / `plan-approval` |
| `input_summary` | TEXT | Bounded, no verbatim |
| `outcome` | TEXT | `proceeded` / `rerouted` / `aborted` |
| `occurred_at` | TIMESTAMP | |

#### `lifecycle_runbook_deviations`

One row per observed deviation between approved runbook and actual execution.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | |
| `runbook_id` | INTEGER FK | |
| `deviation_type` | TEXT | `step_added` / `step_skipped` / `step_reordered` / `step_repeated` / `step_modified` |
| `step_id_affected` | TEXT | Canonical step ID |
| `reason_summary` | TEXT | Bounded |
| `detected_at` | TIMESTAMP | |

Computed during snapshot by diffing approved `step_ids` vs. actual `step_executions` sequence.

#### `lifecycle_workspace_snapshots`

Aggregate row per completed/abandoned workspace. Joins to existing `FlowRunEntry`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | |
| `workspace_id` | TEXT | FK-by-convention to `FlowRunEntry` |
| `slug` | TEXT | |
| `approved_runbook_id` | INTEGER FK | |
| `outcome` | TEXT | `complete` / `aborted` / `abandoned` |
| `total_iterations_to_approve` | INTEGER | How many planner-user rounds |
| `total_steps_executed` | INTEGER | |
| `total_steps_skipped` | INTEGER | |
| `total_hitl_events` | INTEGER | |
| `total_deviations` | INTEGER | |
| `flow_duration_ms` | INTEGER | |
| `commit_range_first` | TEXT | First SHA with Canon-Workflow trailer matching slug |
| `commit_range_last` | TEXT | Last such SHA — joins to git history |
| `snapshotted_at` | TIMESTAMP | |

The `commit_range_*` fields bridge lifecycle data to git — the code-change axis. `query_workspace_history` can JOIN lifecycle rows with `git log --grep="Canon-Workflow: ${slug}"` for full provenance.

#### `lifecycle_deviations`

One row per `Canon-Deviation` commit trailer observed in the lifecycle corpus. Populated by the indexer during `snapshot_workspace` by scanning commits in the workspace's `commit_range`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | |
| `workspace_id` | TEXT | Links to `lifecycle_workspace_snapshots.workspace_id` |
| `commit_sha` | TEXT | Indexed — direct lookup from `git blame` output |
| `principle_id` | TEXT | Parsed from `Canon-Deviation:` trailer value |
| `rationale_short` | TEXT | Parsed from `Canon-Deviation-Rationale:` trailer (bounded) |
| `decision_id` | TEXT | Nullable — from `Canon-Deviation-Decision:` trailer if present |
| `author_agent` | TEXT | From `Canon-Agent` trailer on the same commit |
| `step_id` | TEXT | From `Canon-State` trailer on the same commit |
| `files_affected` | JSON | Paths changed in the commit (from `git show --name-only`) |
| `observed_at` | TIMESTAMP | Commit timestamp |

This table becomes a first-class signal for the learner (see §6 gallery). Queries it enables:

- *"Which principles are most often deviated from, and with what rationales?"* → candidates for scope refinement or convention carve-out
- *"Are deviations clustered in specific subsystems?"* → candidate for a subsystem-scoped convention
- *"For principle P, which rationales recur?"* → if the same rationale appears N+ times, it should probably be promoted from per-commit annotation into the principle's own text (e.g., "this principle does not apply in context X")
- *"Agent X has authored N deviations for principle P — is X interpreting P differently than others?"* → calibration signal for agent prompts or the principle's wording

Retention: `lifecycle_deviations` rows are small (under 1KB each even with metadata); retain permanently unless explicit archive policy dictates otherwise. The full commit history in git is the source of truth; this table is a queryable index.

### 11.4 New MCP tools

#### `snapshot_workspace({ workspace_id }) → { snapshot_id, runbook_id, deviations_detected }`

Reads the workspace (runbook.md, brief.md, journal entries, artifact paths, git log with trailers) and materializes them into the lifecycle tables. Triggered by:

- `completion-verify.sh` hook after successful flow completion (primary)
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
iterations_to_approve_range: [min, max]
similar_to: text_query   # semantic match against brief_summary
memory_cited: item_id
```

Projection selects which tables to join and which columns to return — default is a compact summary (slug, outcome, confidence, total_steps, deviations, iterations_to_approve).

### 11.5 Retention policy

**Tiered default:**

- **Most recent 100 snapshots:** full detail across all `lifecycle_*` tables
- **100 to 1 year old:** aggregate — keep `lifecycle_workspace_snapshots` + `lifecycle_synthesized_runbooks` (approved stage only), drop per-row detail for executions / hitl / deviations (folded into snapshot aggregates)
- **> 1 year:** drop entirely, or export to cold storage via `.canon/archive/`

Janitor process runs retention (SessionStart hook or cron-equivalent). Settings in `.canon/retention.toml` (new) or extended Canon config.

Tunable per project — teams may favor historical depth (N=1000) or space (aggregate more aggressively).

### 11.6 Privacy and sharing

Lifecycle data includes condensed records of user requests and interventions. Safe defaults:

- **No verbatim user input in DB.** `brief_summary`, `input_summary`, `reason_summary` all auto-generated, bounded (e.g., 280 chars). Full brief lives in workspace markdown (reachable until cleanup), referenced by path not content.
- **Secret-detection pass** — summary generation runs a basic pattern match (API keys, tokens) before persisting; matches elided.
- **Local-only by default.** `.canon/drift-db.sqlite` is gitignored; lifecycle tables inherit.
- **Team sharing is out of scope for v2.1.** If/when Canon grows team features, a separate "shared" DB (committed to a dedicated repo, or a hosted service) handles cross-machine sync.

### 11.7 What this unlocks (concretely)

Once lifecycle snapshots land, these queries become first-class — and they're how the learner analyses in §6 and §7 actually run:

- *"All `fix` executions with `cause: security` where confidence was 0.6–0.8 — what were the outcomes?"*
- *"Synthesized runbooks where the lead deviated by skipping `review` — subsequent regression rate?"*
- *"For auth-touching requests, which `skills:` combinations correlate with fewer fix iterations?"*
- *"Runbooks synthesized against vocabulary v1.2 vs. v1.3 — outcome deltas?"*
- *"Workspaces where HITL events exceeded N — common root causes?"*
- *"Total iterations-to-approve trending over time?"* — a direct planner-quality metric
- *"Which memory items were cited across ≥ N flows in the last 30 days?"* — memory grooming signal
- *"Design decisions with `options_considered = 1` — reversal rate?"* — architect-quality metric

None are answerable from workspace files alone (cleaned up) or git alone (coordination data missing). The snapshot DB is the join point.

### 11.8 Phase impact

| Phase | Lifecycle persistence work |
|-------|---------------------------|
| Phase 1 | No change — still additive. Journal's `domain_skills_loaded` field is the schema foundation. |
| **Phase 1.5** | Schema migration adding `lifecycle_*` tables. `snapshot_workspace` + `query_workspace_history` MCP tools. `completion-verify.sh` hook extended to call snapshot. Retention policy stub. |
| Phase 2 | Learner analyses (§6, §7) run against the snapshot corpus. Calibration exercises become observational. |
| Phase 3 | No direct impact — lifecycle persistence is additive. |

**Phase 1.5 justification:** synthesis ships workable without persistence, but without persistence, the learning system (§3) can't close. Phase 1.5 is the bridge that makes v2.1's learning-system headline real. Phase 1 stays additive-only per the v2 plan's constraint; Phase 1.5 adds the substrate; Phase 2 validates the learning loops.

### 11.9 Open questions specific to persistence

1. **Schema versioning in SQLite** — drift-db's migration story for the new tables. Canon already has some migration infrastructure; reuse vs. extend.
2. **`brief_summary` generation** — planner emits it (cheap, authoritative) vs. post-hoc summarizer in `snapshot_workspace` (more flexible). Lean: planner emits.
3. **Deviation severity** — a skipped optional step vs. a skipped mandatory tail are different weights. Categorize in schema via severity field, or derive at query time?
4. **Query cost** — `query_workspace_history` over years of data could become slow. Indexing strategy? Probably not a concern at single-dev repo scale; worth revisiting at team scale.
5. **Cross-repo learning** — teams wanting Canon to learn from multiple repos' lifecycles need cross-repo memory. Out of scope for v2.1 but worth flagging the boundary.

## 12. Confidence scoring

Reframed for v2.1: confidence is a **surfaced signal during iteration**, not a gating mechanism. Under the iterate-until-approved planner loop, the user is always the approval gate; confidence informs the user during iteration, doesn't decide for them.

### 12.1 Schema

In the synthesized runbook frontmatter:

```yaml
confidence: 0.0-1.0
confidence_signals:
  - {signal: "novelty",           value: 0.7}
  - {signal: "scope_clarity",     value: 0.9}
  - {signal: "domain_coverage",   value: 0.8}
  - {signal: "dependency_drift",  value: 0.6}
  - {signal: "question_count",    value: 0.85}
```

### 12.2 Signals

| Signal | Meaning | How computed |
|--------|---------|--------------|
| `novelty` | Has Canon built something like this before? | Planner's `memory: project` + `query_workspace_history({ similar_to: brief_summary })` |
| `scope_clarity` | Does the request have concrete acceptance criteria? | Planner analysis of brief; fewer open questions ⇒ higher |
| `domain_coverage` | Are relevant domain primers available? | Ratio of affected file-layers with ≥1 matching primer in `skills/canon/references/` |
| `dependency_drift` | How much has changed in target files since related work? | `get_drift_report` + recent commit density |
| `question_count` | Open questions remaining in the brief? | Inverse of count, clamped |

Overall `confidence` combines signals with equal weighting initially. As lifecycle data accumulates, the learner proposes weight refinements based on observed correlation between each signal and flow outcome.

### 12.3 How confidence is used — surfaced, not gated

During iteration, the planner presents the runbook with confidence + signals visible to the user:

> *"Proposed runbook confidence: 0.62. Scope clarity is low (open questions: how should X behave in edge case Y; what's the rollback boundary); novelty is low (no similar past runs); other signals are strong. Want me to dig into the open questions, or proceed with this plan?"*

The user can:
- **Proceed** — the runbook is approved as-is
- **Iterate** — ask the planner to refine (address open questions, explore alternatives, adjust a specific step)
- **Override** — supply their own content for one or more steps
- **Abandon** — stop here; request is too ambiguous to execute

No autonomous threshold, no gate. Confidence is display information.

### 12.4 What confidence is for (even without gating)

Three durable roles:

1. **User decision support.** Helps the user decide whether to iterate, dig deeper, or proceed.
2. **Learner calibration.** Over time, correlate confidence with actual outcomes. A miscalibrated planner (uniformly 0.95, or uniformly 0.5) is detectable in the corpus. Proposals refine the signal weights.
3. **Process analytics.** Aggregate confidence trends — are they rising? Is the planner getting more sure as Canon accumulates experience in a repo?

None of these require gating behavior; all benefit from persisted scores in `lifecycle_synthesized_runbooks`.

### 12.5 HITL invariant — confidence never removes baseline

An invariant worth stating explicitly:

> Confidence affects the **ceiling** of iteration depth (low confidence → more iteration warranted), never the **floor** of HITL posture specified in the runbook.

If a step declares `hitl: approval`, that stays regardless of confidence. The runbook's HITL postures are contracts, not suggestions. Confidence might *add* a user checkpoint; it never removes one.

## 13. Phase rollout — Tier 1 / 2 / 3 ordering

The build order for v2.1 inverts from what the earlier proposal draft suggested. The true priority is **dependency**, not implementation cost. Most tagging and observation work is roughly equivalent cost; what matters is which pieces unblock which downstream capabilities.

### 13.1 Tier 1 — foundational; blocks the learning loops

Without these, observations have no keys to anchor on. Nothing else works until Tier 1 is in place.

1. **`principle_id` threading in review findings** — foundation for principle refinement analyses
2. **Deviation capture in `log_step`** — foundation for plan refinement analyses
3. **Lifecycle persistence schema** (`lifecycle_*` tables, `snapshot_workspace` MCP tool) — the substrate itself

### 13.2 Tier 2 — observation enrichment; lands in parallel or concurrently

All lightweight structured tag additions. Same cost profile across the board; no reason to serialize them.

| Artifact | Tags |
|----------|------|
| Fix summary | `cause`, `root_cause_tag`, `upstream_step_id` |
| Task plan | `task_id`, `dependencies[]`, `file_count`, `principle_ids[]` |
| Design decision | `decision_id`, `options_considered`, `chosen_option_tag`, `rationale_tags[]` |
| Research finding | `dimensions_explored[]`, `risks_surfaced[]` |
| Implementation summary | `compliance_declared_for[]`, `justified_deviations[]`, `memory_cited[]` |
| Test report | `tests_added`, `coverage_delta` |
| HITL events | captured via journal hooks + `log_step` outcome field |

Plus:
- **Synthesis skill versioning** — each synthesis records which skill version produced it
- **Memory citation prompt guidance** — added to six memory-bearing agent definitions
- **`Canon-Deviation*` commit trailer family** — `commit-trailers.ts` extension; PostCommit hook validates trailer-vs-summary parity; indexer populates `lifecycle_deviations` during snapshot (see §5.6, §11.3)

Cost: one coordinated schema migration + template edits + agent prompt updates. Cheaper as a single pass than sequencing.

### 13.3 Tier 3 — learner analyses; built on the corpus Tiers 1+2 produce

Once the corpus exists, the learner analyzes it.

- **Principle-refinement analyses** (§6.1) — single-target, fast to implement once data exists
- **Plan-refinement analyses** (§6.2) — single-target
- **Skill-effectiveness analyses** (§6.3) — cross-target (synthesis skill + domain skills)
- **Decomposition / design quality** (§6.4, §6.5)
- **Template health** (§6.6)
- **HITL pattern analysis** (§6.7)
- **Memory audit / groom** (§7.1–7.2)
- **Memory seeding** (§7.3) — heavier; may slip to v2.2
- **Cross-run dashboards / digests** — weekly learning-digest format

Cost per analysis: low-medium. Each is mostly a query + summarization template. The learner agent gains a new output dimension per analysis.

### 13.4 Revised phase plan

| Phase | Content |
|-------|---------|
| Phase 1 (already spec'd, additive-only) | Journal, hooks, agent def updates, skills registration. Unchanged from v2; now understood as foundation for Tier 1. |
| **Phase 1.5 (new in v2.1)** | Tier 1 + all of Tier 2. One coordinated schema migration + template + agent-prompt pass. Plus: `canon-planner` synthesis rewrite (brief + synthesis skills, iterate-until-approved loop), `runbook-vocabulary.md`, updated `runbook-synthesis.md`. |
| Phase 2 (validation) | Learner analyses (Tier 3) run against the corpus. Observational — no autonomous thresholds, just calibration and correlation. Produces first weekly digests. Humans grade proposals; refinements land. |
| Phase 3 (deletion) | Unchanged from v2. Removes legacy state-machine / prompt-pipeline / flow YAML runtime / coordination infrastructure after Phase 2 validation passes. |

Phase 1.5 is the critical addition. It's where the learning substrate and the synthesis architecture land together. Without it, Phase 2 validation has nothing to validate.

### 13.5 Revised Phase 1 task inventory

| Task | Status | Note |
|------|--------|------|
| phase1-00 (runbook format) | DONE on PR #115 | Output format for synthesis |
| phase1-01..04 (5 runbook files) | **ABANDONED** | Replaced by vocabulary-based synthesis |
| phase1-05..09 | Unchanged / lightly extended | See §14 |
| phase1-10 (validation) | **Refactored** | Validates vocabulary + synthesis behavior, not 5 static files |

Wave 1 shrinks from 5 tasks to 2 in Phase 1 (vocabulary + brief/synthesis skills). Phase 1.5 adds the lifecycle + observation work as a new batch.

## 14. Migration plan amendments — v2.1 delta against v2

Sections of `docs/agent-teams-migration-plan-v2.md` that need amendment for v2.1:

| Section | Change |
|---------|--------|
| §1 "What v1 got right" | Add: "Canon's learning loop is the durable quality-up mechanism; synthesis is what makes plan quality learnable alongside principles." |
| §2.2 "What stays" (Runbooks row) | Replace "Lightweight playbooks describing recommended step sequences" with "Canonical step vocabulary + synthesis skill. Runbooks synthesized per plan by `canon-planner` via iterate-until-approved loop." |
| §2.3 "Pre-build gate (canon-planner)" | Expand planner responsibilities: emits both `planning-brief.md` AND `runbook.md` per flow; iterates with user until approval. Two-skill split (`planner-brief.md` + `runbook-synthesis.md`); agent body shrinks to skill loading + output contract. |
| §2.4 "How Claude orchestrates a Canon flow" | Update example: planner proposes runbook, iterates with user, user approves; lead executes approved runbook with lifecycle capture. |
| §2.5 (duplicate #1 — Dispatch framework) | Unchanged — `dispatch: subagent | team` stays the same |
| §2.5 (duplicate #2 — Self-serve context) | Expand: agents also emit structured tags (§5) for learning-system observations |
| §2.6 "Why this is simpler" | Add bullet: "Canon's whole stack improves from every interaction — principles, synthesis skill, templates, agent memory, vocabulary — via the unified learning system." |
| §2.7 (Orchestration journal) | Expand: journal's `domain_skills_loaded`, outcome fields, and new HITL-event capture feed the lifecycle-persistence substrate (§11). |
| §2.8 Layer 1 | Amend: "CLAUDE.md + vocabulary + synthesis skill" (not runbooks plural). |
| §3 row 23 (variable interpolation: deprecate) | Unchanged — still deprecate |
| §3 row 27 (skip conditions: native) | Unchanged — still native, in `skip_when` field |
| §4 Phase 1 deliverables table | Replace fast-path / feature / epic / migrate / test-gap rows with vocabulary + brief + synthesis skill rows. Add Phase 1.5 task block (schema migration, snapshot tool, observation tags). |
| §4b P4 "Self-improving skills" | **Promote** from roadmap item to active Phase 2 validation work — the learning system makes P4 operational. |
| §4b P5 "Memory architecture" | **Partially promote** — memory audit + grooming become part of v2.1 (Phase 1.5 + 2). Seeding may slip to v2.2. |
| §5 Phase 2 validation | Add: learner analyses gallery runs produce first weekly digests; confidence signals correlate with outcomes; memory groomed per schedule; first proposals accepted into principle / skill / template refinements. |
| §6 Risks | Add: "Planner emits inconsistent runbooks across similar requests" (mitigated by iterate-until-approved + deviation tracking); "Vocabulary drift" (LOW — versioned change process); "Observation tag compliance" (LOW — hybrid schema tolerates missing fields). |
| §7 Out of scope | Add: "Cross-repo learning (memory sharing across Canon installs). Autonomous confidence-based gating. Real-time write-through to lifecycle DB (per-run snapshot only in v2.1)." |
| §4 Phase 1 deliverables (trailer addition) | Extend `commit-trailers.ts` with `Canon-Deviation`, `Canon-Deviation-Rationale`, `Canon-Deviation-Decision` trailer family. PostCommit hook validates trailer-vs-`justified_deviations` parity. Engineer agent prompt updated to emit trailer alongside summary tag. Reviewer agent prompt updated to check for authorizing trailer before flagging principle violations. |

**Revision naming:** `docs/agent-teams-migration-plan-v2.1.md` as a new file; v2 preserved for history. v2.1 frontmatter references v2 as its supersedent.

## 15. Open questions

General questions (persistence-specific ones are in §11.9):

1. **Planner output location** — `plans/${slug}/runbook.md` alongside brief, or distinct location? Lean: same directory as brief for cohesion.
2. **`cause` extensibility** — any step besides `fix` need `cause`? Defer until evidence.
3. **Vocabulary versioning** — if a runbook is synthesized against v1 and resumed later under v2, how does resume work? Options: lock to synthesis-time version (cleanest); regenerate on vocab change; warn-and-proceed. Lean: lock for determinism during a single build.
4. **Learner loop ownership** — Phase 2 establishes baseline; who owns continuous refinement afterward? Planner auto-tunes from learner output (P5 territory) or humans curate proposals weekly? Probably the latter initially (supervised); automation is a later promotion.
5. **CLAUDE.md intent classification minimum** — with all build requests routing to planner, what's the minimal residual intent set? Greetings, questions, chat — defer to a separate design pass.
6. **Seed-bundle format** — if memory seeding lands in v2.1 (not v2.2), what's the artifact format? A new `templates/memory-seed.md`? Merges with existing memory-file format? Defer.
7. **Observation-schema evolution** — when a new structured tag is worth promoting to first-class column vs. staying in `extra_tags` JSON? Criterion: observed across N flows in ≥M agents' outputs → promote.
8. **HITL event categorization** — our event types (`approval`, `clarification`, `redirect`, `reject`, `abort`, `iterate`) cover the current model. Are we missing any? Particularly for the iteration loop.
9. **Tier 2 timing** — land all observation tags simultaneously or roll per-artifact? Lean: simultaneous (one coordinated pass) unless a specific tag needs design work first.

## 16. Status and next steps

**Status: DRAFT — REVISE before ratification.** A critical architectural review conducted in the PR #115 thread (summary in Appendix A) returned a *revise* recommendation with 10 concrete changes required before this can become v2.1. The proposal's headline (unified learning loop) and tactical decision (synthesis over static runbooks) are defensible; the surrounding infrastructure is over-scoped relative to what can be proven in one pass.

### Outstanding changes required before ratification

Tracked as the work list for converging toward v2.1. Each is a concrete modification to this document or a concrete pre-ratification validation step.

1. **Split this proposal into v2.1a / v2.1b / v2.2** — see §17 for the carve-out. The current single-ratification framing bundles three independent architectural commitments and violates v2's additive-small-steps discipline.
2. **Cut §7 (memory audit / groom / seed) entirely from v2.1.** Highest-risk section; automated writes to agent memory without a demonstrated base learner. Defer to v2.2+ once the principle/synthesis loop is demonstrated.
3. **Drop the `Canon-Deviation*` commit trailer family (§5.6)** and its PostCommit parity hook. Keep `justified_deviations[]` in the implementation summary tag. Revisit once `git blame`-level provenance is demonstrated to matter.
4. **Require one real end-to-end trace before ratification.** Hand-run the §6.1 principle-refinement analysis against Canon's *existing* data (`.canon/drift-db.sqlite`, `.canon/learning.jsonl`, git log) and produce one actually-acceptable refinement proposal. The minimum infrastructure needed for that single working trace becomes the real v2.1b scope — not §11 in full.
5. **Specify the user-approval affordance** (§10.4 and §14 row on §2.3). What does "approve" look like at the MCP/runtime level? Is there a fast-path for trivial requests that skips the full iteration loop? Quantify the planner-synchronous UX cost.
6. **Replace §4's 10-target refinement matrix** with a 3-target matrix: principles, conventions, synthesis skill. Mark the rest as "candidates for v2.2+ once the 3-target loop is demonstrated."
7. **Add hard precondition to Phase 1.5 (and v2.1a/b):** v2 Phase 1 exit criteria met — `canon-planner` and `canon-engineer` agent definitions exist, register, and have been validated in ≥ 3 successful runs under the feature flag. No v2.1 work before that.
8. **Commit to a storage decision with migration math.** Either (a) reference `drift-schema.ts` with concrete migration DDL for the proposed tables; (b) adopt JSONL-first and defer materialization; or (c) explicitly scope to v2.1b minimum (one table) and defer §11 in full. Current §11.1 rejects the JSONL alternative in one dismissive sentence — that needs a real rebuttal or reconsideration.
9. **Promote §15 open questions #3 (vocabulary versioning across resume), #7 (observation-schema evolution), #8 (HITL event categorization) to blocking decisions.** Resolve in-document before ratification; do not defer.
10. **Remove or unambiguously mark the illustrative numbers in §6 as fabricated.** Current phrasing ("40% reversal rate vs. 8%", "3× fix iterations") invites reading as evidence of expected outcomes. Either replace with real measurements from the trace required in #4, or explicitly label as "illustrative scenario, not measurement."

### Gates before ratification

- **Gate A (existence):** v2 Phase 1 exit criteria met (canon-planner + canon-engineer defs validated). Without this, v2.1 has no planner agent to hang synthesis off.
- **Gate B (evidence):** item #4 above — one real refinement proposal produced by running a §6-style analysis against today's data. Without this, §3's learning-loop claim is unvalidated.
- **Gate C (scope discipline):** items #2, #3, #6 executed; split per §17 committed. Without this, the proposal stays at v2.1-as-one-thing scope.

All three gates must be clear before converting this draft into `docs/agent-teams-migration-plan-v2.1.md`.

### Next concrete step

Work through the 10 changes iteratively in the PR #115 thread. Each change is a scoped amendment to this document; commit per change. After all 10 are addressed, re-run the architect review. Only then promote to v2.1.

**Do NOT:**

- Start v2.1a, v2.1b, or v2.2 work based on this draft. Changes 1–10 must land and the gates must pass first.
- Amend Phase 1 plan files in `.canon/workspaces/agent-teams-v2/plans/phase1/` yet. They're the pre-v2.1 spec; editing preemptively conflates this draft with the ratified plan.
- Mark `phase1-01..04` abandoned (as §13.5 currently proposes). Those design plans represent the natural first corpus for validating the synthesis skill against ground-truth reference runbooks.

**Who reviews (next round):** Canon maintainers per the review process that produced v2, plus a follow-up architect pass after changes 1–10 land.

---

## 17. Proposed carve-out: v2.1a / v2.1b / v2.2

Responding to architect change #1 (§16). The current proposal bundles three independent architectural commitments into a single ratification ask; v2's methodology is *additive small steps with hard handoffs*, and this single-ratification framing violates that discipline. The split below carves v2.1 into three sequentially-gated sub-proposals, each scoped to what it can prove on its own.

### 17.1 v2.1a — Vocabulary + synthesis, no substrate

**Scope:**

- §8 Vocabulary — 15 canonical step IDs (or 10 per architect change #6 if cuts are applied)
- §9 Step schema — `skills:`, `cause:` first-class fields
- §10 Synthesis contract — MUST / MAY / MUST NOT rules; iterate-until-approved loop
- `skills/canon/references/runbook-vocabulary.md` — new vocabulary file
- `skills/canon/references/planner-brief.md` + `skills/canon/references/runbook-synthesis.md` — two skills the planner loads
- `canon-planner` agent body updated: loads both skills, emits `planning-brief.md` + `runbook.md`, runs the iterate-until-approved loop
- `templates/runbook-template.md` — already landed on PR #115; becomes the output format for synthesis

**Explicitly out of scope for v2.1a:**

- No lifecycle persistence (no new tables, no MCP tools)
- No learner role expansion
- No commit trailer family
- No structured observation tags on artifacts
- No memory audit/groom/seed
- No embeddings or semantic search

**Entry gate:** v2 Phase 1 exit criteria met (architect change #7). `canon-planner` and `canon-engineer` agent definitions must exist and be validated in ≥ 3 successful runs under the feature flag before v2.1a starts.

**Exit criteria:**

- `canon-planner` synthesizes runbooks that conform to the format spec and pass iterate-until-approved
- At least 5 distinct request types processed end-to-end (bug fix, small feature, refactor, migration, test-gap)
- User-approval affordance defined at the runtime level (architect change #5)
- Runbooks execute per the contract; same artifact quality as pre-synthesis static flows
- Zero new enforcement hooks introduced (additive-only discipline honored)

**What this ratifies on its own:** the synthesis-over-static-files architectural decision. If v2.1a ships and runs well, that's a clean win even if v2.1b and v2.2 never follow. The proposal's central coordination claim is tested independently of the learning-loop claim.

### 17.2 v2.1b — Minimum viable lifecycle persistence

**Scope:**

- One new table: `lifecycle_workspace_snapshots` (aggregate row per completed workspace, per §11.3's schema for that row)
- One new MCP tool: `snapshot_workspace({ workspace_id })` — called by `completion-verify.sh` at flow completion
- Structured tags on *three* artifact types only — the minimum needed to run one working learner analysis (per architect change #4):
  - Review findings: add `principle_id` to each finding (the single highest-value signal per architect review)
  - Fix summary: add `cause`, `root_cause_tag`
  - Implementation summary: add `justified_deviations[]`
- Extend existing `canon-learner` with one new analysis dimension: principle-refinement from per-flow review data (§6.1). No template, no design-decision, no memory analyses.

**Explicitly out of scope for v2.1b:**

- No embeddings / semantic search (`similar_to` filter deferred)
- No commit trailer family
- No design-decision, research-finding, or test-report tags
- No memory audit/groom/seed; no `memory_cited` tag
- No cross-target analyses
- No weekly digest format
- No retention-tier policy (keep everything until we have data showing we need to prune)
- No additional learner output dimensions beyond principle refinement

**Entry gate:** v2.1a has shipped and produced ≥ 20 synthesized runbooks in real use. Without that corpus, v2.1b's principle-refinement analysis has no data to run against.

**Exit criteria:**

- One concrete principle-refinement proposal produced by the learner against real lifecycle data
- Proposal accepted by a human reviewer and applied as an actual edit to a principle file
- End-to-end loop closed: observation → pattern → proposal → accepted refinement in the repository
- Schema migration against `drift-schema.ts` executes cleanly and is reversible
- `snapshot_workspace` handles the failure cases listed in architect question #4 (what happens if snapshot fails, workspace already torn down, etc.)

**What this ratifies on its own:** the learning-loop claim. A single real observation → pattern → proposal → refinement cycle, end-to-end, against one artifact class (principles). Everything else in §§4–7 is "expand the surface once this loop demonstrably closes."

### 17.3 v2.2 — Surface expansion

**Scope (all contingent on v2.1b success):**

- Additional structured tags (design decision, task plan, research finding, test report, HITL events — per §5.2 full matrix)
- Additional lifecycle tables (`lifecycle_synthesized_runbooks` with stage/iteration tracking, `lifecycle_step_executions`, `lifecycle_hitl_events`, `lifecycle_runbook_deviations`)
- Embeddings + `similar_to` semantic search (§11.4 filter)
- Memory citation tag + audit/groom analyses (§7 partial — grooming and audit only; seeding stays v2.3+)
- Cross-target correlation analyses (§6 full gallery)
- Weekly learning digest format (§6.8)
- Commit trailer family — only if `git blame`-level provenance proves necessary in practice
- Tiered retention policy — only once storage data warrants it

**Explicitly out of scope for v2.2:**

- Memory seeding for new agents (§7.3) — v2.3 at earliest; high-risk automated-writeback to agent state
- Agent-prompt refinement targets in §4 matrix — requires separate design pass on "learner writes to agents/*.md"
- Knowledge graph priors in §4 matrix — requires separate design pass on "learner writes to knowledge-graph.db"
- Vocabulary meta-refinement (learner proposes new step IDs) — requires demonstrated stability first

**Entry gate:** v2.1b has shipped ≥ 3 principle-refinement proposals, of which ≥ 1 has been accepted and applied. Without that track record, scope expansion is premature.

**Exit criteria:** per-expansion — each new refinement target added under v2.2 must demonstrate a completed observation → refinement cycle before the next target is enabled.

### 17.4 What this split changes about §§3–15

§§3, 5, 8, 9, 10 align cleanly with v2.1a + v2.1b — they describe infrastructure and architecture independent of scope phase.

§§4, 6, 7 are heavily expanded beyond what v2.1a/b deliver; they become *aspirational scope for v2.2*. Those sections need an explicit "scope marker" per subsection indicating which phase it lands in (v2.1a / v2.1b / v2.2 / later). Architect change #6 covers the reduction of §4; §7 is cut entirely (architect change #2); §6's gallery is marked as v2.2 analyses with only §6.1 landing in v2.1b.

§11 is sharply cut in v2.1b (one table, one tool) and expanded back in v2.2. §11.5 retention policy defers to v2.2 (architect note). §11.8 phase impact rewrites per the split.

§12 confidence scoring stays as observational data captured in v2.1a (emitted but not persisted) and persisted in v2.1b (stored with the snapshot). Calibration analyses are v2.2.

§13 phase rollout rewrites entirely per this split. The current Tier 1/2/3 framing collapses into v2.1a/b/2.2 framing, which is cleaner.

§14 migration plan amendments narrows to the minimal set needed for v2.1a + v2.1b. Many of the currently-listed amendments (§4b P4/P5 promotion, §6 Risks additions for cross-target concerns, §7 out-of-scope additions) become v2.2 amendments.

A full rewrite of §§3–15 under this split is substantial but mechanical once the carve-out is ratified. Doing that rewrite is architect change #1 in full.

### 17.5 Why the split is the right response to the architect review

The architect's core critique was "you're asking for one ratification of three independent architectural commitments with a lot of speculative surface." This split:

- **Isolates the risks.** v2.1a proves synthesis works without being hostage to persistence design decisions. v2.1b proves the learning loop closes without being hostage to memory/embeddings/trailers. v2.2 expands only after each prior step earned the right.
- **Re-instates v2's methodology.** Each sub-proposal is independently additive and has a clean exit. v2's discipline holds.
- **Produces evidence at each gate.** v2.1a produces real synthesized runbooks; v2.1b produces one real refinement proposal; v2.2 expands based on what the corpus actually shows.
- **Makes rollback tractable.** If v2.1b's loop doesn't close, v2.1a's synthesis-over-static decision still stands — we don't have to revert the whole v2.1 bundle.

The cost is longer elapsed time before the full v2.1 vision ships. The benefit is that each piece earns ratification on its own merits and the architecture can self-correct between phases.

---

## Appendix B: Deferred — agent memory audit / groom / seed (v2.2+ design)

Preserved from §7 when it was cut from v2.1 scope per architect change #2. Reference material for when v2.2 is drafted.

### Agent memory context

Per the migration plan, six agents get `memory: project` — planner, engineer, researcher, architect, scribe, learner. Memory accumulates across sessions, and without grooming it **degrades**:

- **Stale** — agent remembers pattern X; codebase refactored to Y months ago
- **Wrong** — agent generalized from 2 observations that don't hold at corpus scale
- **Redundant** — same observation written multiple times in slightly different phrasings
- **Stranded** — memory references file paths that no longer exist
- **Overconfident** — agent wrote "always use A"; subsequent flows used B cleanly

All of this is detectable from the corpus once `memory_cited` tagging (originally §5.5, now v2.2 scope) is in place.

### Memory audit analyses (v2.2 proposed scope)

**Staleness check:** "For each memory item citing a file path, does the path still exist?"
→ Proposal: prune deleted paths; rewrite renamed paths.

**Cross-check against corpus:** "Memory claims `auth uses JWT with 15-min TTL`. What does recent corpus say?"
→ [illustrative] 12 flows in last 60 days used 60-min TTL.
→ Proposal: update memory — "Auth uses JWT with 60-min TTL (corrected: was 15-min until March 2026)."

**Overconfidence detection:** "Memory says `always use Result<T,E> everywhere`. Corpus pattern?"
→ [illustrative] 35 of 40 flows used Result; 5 used exceptions (in low-level parsers, per documented convention).
→ Proposal: refine memory — "Prefer Result<T,E> except in low-level parsers (see `exceptions-at-boundaries`)."

### Memory grooming analyses (v2.2 proposed scope)

**Citation tracking:** "Across recent agent outputs, which memory items were cited vs. ignored?"
→ Requires `memory_cited: [item_id]` structured tag on specialist outputs.
→ [illustrative] Item M27 cited 0 times across 50 flows; items M1–M20 cited 40+ times each.
→ Proposal: prune M27.

**Consolidation:** "Which memory items make overlapping claims?"
→ [illustrative] Items M8, M14, M22 describe the same auth hook-ordering gotcha in different phrasings.
→ Proposal: consolidate to single authoritative entry.

**Budget management:** "Agent's memory exceeds N tokens; rank by recent-citation-weighted utility and prune bottom quartile."
→ Automatic maintenance once citation data exists.

### Memory seeding (v2.3+ proposed scope)

The corpus is distilled expert context for the repo. When:

- A new agent role is introduced (future `canon-security-auditor`)
- Canon is installed in a new repo
- An agent's memory is intentionally reset
- An existing agent's role expands

…seed memory from the corpus instead of starting cold.

**Seed-candidate analysis:** for a fresh `canon-engineer` memory in this repo, pull from the existing corpus:

- Codebase invariants (patterns with >90% consistency across 6+ months)
- Design decisions with zero reversal rate
- Subsystem-specific gotchas (recurring root causes that took 3+ iterations initially but converged)
- Principle-application examples (fixes where `cause = review` and principle correctly applied)

**Output:** a seed bundle — structured memory entries ranked by signal strength — that becomes the new agent's starting memory.

### Infrastructure additions required (for whenever v2.2 runs)

| Addition | Effort | Where |
|----------|--------|-------|
| `memory_cited` structured tag on specialist outputs | Small | Template update + lifecycle schema |
| Learner file-read access to `.claude/memory/{agent}/*` | Small | Learner tool allowlist |
| Memory-patch output format (add/update/remove item) | Small | Learner proposal template |
| Seed-bundle format | Medium | New artifact template |
| Memory citation prompt guidance in agent bodies | Small | Agent definitions |

### Key risks to address before v2.2 ratifies this work

- **Groom-away-critical-knowledge:** memory item cited rarely but covering a critical edge case might be pruned incorrectly by citation-weighted policy. Mitigation: require human review of every prune proposal before apply.
- **Incorrect consolidation:** M8/M14/M22 "describe the same thing" is a similarity judgment that can lose nuance. Mitigation: surface consolidation proposals with the original items side-by-side; require explicit accept.
- **Seed-stale-calcifies:** a new agent seeded from a corpus containing outdated patterns inherits them as baseline. Mitigation: freshness-weight seed candidates heavily; cap seed bundle age.
- **Automated writeback to agent state:** the learner writing to `.claude/memory/{agent}/*` is a new write scope beyond today's `.canon/proposed-learnings/` scope. Requires separate trust / audit design.

---

## Appendix A: Conversation provenance

This proposal emerged from the PR #115 review thread on branch `claude/runbook-template-format-dM3LJ`. Key conversation beats, chronologically:

1. **PR opened** for `phase1-00` (runbook format template) — static-runbook model assumed
2. **Review pass 1** surfaced drift between DESIGN.md schema and phase1-01 / phase1-10 plans; amended
3. **User observation** — *"runbooks as guidance for Claude-native orchestration — does this open the door for dynamic, plan-specific runbooks?"*
4. **Proposal for Option A** (vocabulary + synthesis) surfaced; iterated on
5. **Scope expansion** — lifecycle persistence surfaced as necessary substrate because workspaces are cleaned up
6. **User reframe** — *"maybe the planner should just iterate on the runbook until user approval"* — collapsed confidence gating, recipes-as-separate-concept, escape hatches
7. **User push** — *"have we lost sight of Canon's purpose?"* — honest audit; realized most of the proposal was coordination-layer architecture rather than Canon-value-aligned
8. **User refinement** — *"Canon is an agentic team that builds grounded in best practices; ensure the work drives quality up"* — quality-up as the lodestar
9. **User push further** — *"how does the system as a whole learn with each interaction?"* — reframed as unified learning system across every Canon artifact
10. **User push again** — *"can we use this for agent memory audit and seed?"* — memory as a first-class refinement target
11. **User critical check** — *"is this infra or Canon's purpose?"* — honest conclusion: learning loop is the actual Canon-purpose win; synthesis is load-bearing for the plan-quality arm of that loop
12. **This rewrite** — restructures the proposal around the learning-system headline; lifecycle persistence promoted to cornerstone; synthesis reframed as load-bearing mechanism, not coordination aesthetic

The conversation is the source; this document is the durable artifact.

