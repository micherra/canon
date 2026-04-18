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

## 6. Learner analyses gallery

Concrete examples of query → pattern → proposal flows the learner runs against the lifecycle corpus. These are illustrative, not exhaustive — each one shows the data-to-value path and what infrastructure it depends on.

### 6.1 Principle refinement from review findings

**Query:** "Across the last 50 flows, which principles had review findings, and what was the fix-iteration cost per principle?"

**Result (illustrative):**

| Principle | Findings | Avg fix iterations |
|-----------|----------|-------------------|
| `thin-handlers` | 12 | 1.1 |
| `error-bubbling` | 8 | 1.2 |
| `result-types` | 15 | **3.1** |

**Pattern:** `result-types` takes 3× the fix iterations. Either the principle is ambiguous or hard to apply.

**Follow-up query:** "For `result-types` fixes, what did fix summaries say?"

**Result:** 10 of 15 mentioned "unclear how to apply to callback-style APIs."

**Proposal:** structured patch to `principles/result-types.md` narrowing scope or adding a callback-case example.

**Depends on:** `principle_id` on review findings; fix summary `cause` and `root_cause_tag`.

### 6.2 Plan refinement from deviations

**Query:** "Across recent runbooks, which had 3+ deviations?"

**Result:** 8 runbooks with deviations; of those, 6 had a `security` step *added* by the lead that the planner hadn't synthesized.

**Follow-up:** "What did those 6 requests have in common?" → all touched `src/auth/**` or `src/api/**/session*`.

**Proposal:** update `runbook-synthesis.md` — *"when affected files match auth paths, include `security` step by default."*

**Depends on:** `lifecycle_runbook_deviations` table; file-path tagging on requests.

### 6.3 Skill effectiveness from `domain_skills_loaded` × outcome

**Query:** "For `fix` steps with `cause: security`, which skill combinations correlate with fewer iterations?"

**Result:**

| Skills combination | Avg fix iterations |
|-------------------|---------------------|
| `[]` | 3.8 |
| `[authentication-security]` | 2.3 |
| `[authentication-security, backend-api]` | 1.4 |
| `[authentication-security, error-handling]` | **1.1** |

**Pattern:** auth-security alone isn't enough — co-loading `error-handling` correlates with much cleaner fixes.

**Proposal:** update `runbook-synthesis.md` — *"for `fix` with `cause: security`, include both `authentication-security` AND `error-handling` in `skills:` by default."*

**Depends on:** journal's `domain_skills_loaded` + `cause` + fix outcome tracking.

### 6.4 Decomposition quality from task-plan tags

**Query:** "Correlate task `file_count` with downstream fix-iteration count per task."

**Result:**

- 1–2 files: 0.3 avg fix iterations
- 3–5 files: 1.2 avg
- 6+ files: 3.1 avg (20% had test failures)

**Pattern:** tasks spanning 6+ files are systematically harder; architect is under-decomposing.

**Proposal:** update `templates/task-plan.md` with explicit guidance ("aim for 2–4 files per task"); add new rule `agent-task-right-sizing.md`.

**Depends on:** `file_count` on task-plan frontmatter; linking tasks to downstream fix events.

### 6.5 Design quality from decision tags

**Query:** "For design decisions where `options_considered = 1`, what's the reversal rate in later flows?"

**Result:** 40% reversal rate vs. 8% when `options_considered ≥ 3`.

**Pattern:** single-option designs correlate with rework; architects converge too fast.

**Proposal:** update `canon-architect.md` or create `agent-explore-alternatives` rule.

**Depends on:** `options_considered` on design-decision frontmatter; decision-reversal detection across flows.

### 6.6 Template health from section-completeness

**Query:** "Across recent implementation logs, which template sections are routinely empty?"

**Result:** "External Evidence" present in 8% of logs; "Verified Facts" in 15%; "Assumptions" in 62%.

**Pattern:** first two sections aren't earning their place.

**Proposal:** revise `templates/implementation-log.md` — drop External Evidence and Verified Facts, or tighten their conditional guidance.

**Depends on:** per-section completeness tracking (could be derived post-hoc by the indexer scanning artifacts).

### 6.7 HITL pattern analysis

**Query:** "At which steps do users most often intervene during iteration?"

**Result:** `design` (12 interventions across 20 flows) vs. `research` (3 across 20).

**Pattern:** planner's proposed designs need more user iteration than its research steps.

**Proposal:** amend `runbook-synthesis.md` — for design steps, include planner's confidence-signals inline in the brief; surface open questions explicitly.

**Depends on:** `lifecycle_hitl_events` table; step-level linkage.

### 6.8 What a learner run actually produces

Weekly, the learner runs these analyses (and more) in parallel. Output is a single digest:

```
# Canon Learning Digest — Week of 2026-04-21

## High-confidence proposals (≥ 0.9)
- Refine principle `result-types` (§6.1) — structured patch attached
- Add task-right-sizing rule (§6.4) — draft rule attached
- Update engineer memory M14 (auth TTL correction, §7) — patch attached

## Medium-confidence proposals (0.7–0.9)
- Auth-path synthesis default (§6.2) — patch to runbook-synthesis.md
- Security fix skill combo (§6.3) — patch to runbook-synthesis.md
- Consolidate architect memory items M8/M14/M22 (§7) — patch attached

## Observations accumulating (below threshold)
- Design options-count correlation (§6.5) — 12 observations; needs ~20 to cross
- Template section dead zones (§6.6) — pattern visible; waiting for 0.7 threshold

## Seed bundle available
- `canon-security-auditor` seed memory ready if you want to onboard
```

Human reviews ~30 minutes per week, accepts/rejects proposals, refinements land. Each week's digest is a measurable increment of Canon's quality-up trajectory.

## 7. Agent memory audit / groom / seed

Agent project memory is another refinement target. Per the migration plan, six agents get `memory: project` — planner, engineer, researcher, architect, scribe, learner. Memory accumulates across sessions, and without grooming it **degrades**:

- **Stale** — agent remembers pattern X; codebase refactored to Y months ago
- **Wrong** — agent generalized from 2 observations that don't hold at corpus scale
- **Redundant** — same observation written multiple times in slightly different phrasings
- **Stranded** — memory references file paths that no longer exist
- **Overconfident** — agent wrote "always use A"; subsequent flows used B cleanly

All of this is detectable from the corpus once `memory_cited` tagging (§5.5) is in place.

### 7.1 Memory audit — analyses

**Staleness check:** "For each memory item citing a file path, does the path still exist?"
→ Proposal: prune deleted paths; rewrite renamed paths.

**Cross-check against corpus:** "Memory claims `auth uses JWT with 15-min TTL`. What does recent corpus say?"
→ 12 flows in last 60 days used 60-min TTL.
→ Proposal: update memory — "Auth uses JWT with 60-min TTL (corrected: was 15-min until March 2026)."

**Overconfidence detection:** "Memory says `always use Result<T,E> everywhere`. Corpus pattern?"
→ 35 of 40 flows used Result; 5 used exceptions (in low-level parsers, per documented convention).
→ Proposal: refine memory — "Prefer Result<T,E> except in low-level parsers (see `exceptions-at-boundaries`)."

### 7.2 Memory grooming — keeping what's useful

**Citation tracking:** "Across recent agent outputs, which memory items were cited vs. ignored?"
→ Requires `memory_cited: [item_id]` structured tag on specialist outputs (§5.5).
→ Item M27 cited 0 times across 50 flows; items M1–M20 cited 40+ times each.
→ Proposal: prune M27.

**Consolidation:** "Which memory items make overlapping claims?"
→ Items M8, M14, M22 describe the same auth hook-ordering gotcha in different phrasings.
→ Proposal: consolidate to single authoritative entry.

**Budget management:** "Agent's memory exceeds N tokens; rank by recent-citation-weighted utility and prune bottom quartile."
→ Automatic maintenance once citation data exists.

### 7.3 Memory seeding — warm-starting new agents or repos

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

### 7.4 What this adds infrastructure-wise

Small extensions over §5 / §11:

| Addition | Effort | Where |
|----------|--------|-------|
| `memory_cited` structured tag on specialist outputs | Small | Template update + lifecycle schema |
| Learner file-read access to `.claude/memory/{agent}/*` | Small | Learner tool allowlist |
| Memory-patch output format (add/update/remove item) | Small | Learner proposal template |
| Seed-bundle format | Medium | New artifact template |
| Memory citation prompt guidance in agent bodies | Small | Agent definitions |

Audit + grooming land in v2.1 alongside principle refinement — same learner, additional output dimension. Seeding is heavier (seed-bundle format, cross-agent transfer logic) and can slip to v2.2 unless there's a forcing function.

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
| `stage` | TEXT | `proposed` / `approved` — distinguishes initial from user-iterated-final |
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
| `event_type` | TEXT | `approval` / `clarification` / `redirect` / `reject` / `abort` / `iterate` |
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

<!-- BATCH 13 MARKER: sections 14 onward to be populated in subsequent commits -->
