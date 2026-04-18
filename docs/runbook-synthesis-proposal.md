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

<!-- BATCH 3 MARKER: sections 6 onward to be populated in subsequent commits -->
