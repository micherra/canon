# Exploration Brief: The Compilation Gradient

**Mode:** EXPLORE (design/philosophy pressure-test — no code, no runbook)
**Author:** canon:architect
**Date:** 2026-07-05
**Seed:** "Program-as-Weights: A Programming Paradigm for Fuzzy Functions" (Zhang et al., arXiv:2607.02512) + the "compilation gradient" framing.

---

## VERDICT

**The thesis SURVIVES as a lens but PARTIALLY BREAKS as a literal architecture — and it breaks in the one place that turns out to be the most interesting finding.**

Three of the four sub-claims are **already Canon's stated architecture under other names** (I found the exact conventions and the entire evolution program that instantiate them). The load-bearing bet — "principles carry executors and advance down a fuzzy→deterministic gradient" — **is a category error as a total order**, but survives as a *binary* classification Canon already makes.

The genuinely net-new contribution is a **disanalogy the framing hides**: PAW compiles a fuzzy function into a *cheaper fuzzy executor* (a neural adapter that stays fuzzy-tolerant). Canon's "compiled" endpoint is a *deterministic shell gate* that **discards** fuzzy-tolerance and only accepts mechanically-verifiable predicates. These are different operations. The PAW-faithful analog for Canon is **not** the shell gate — it is a **cheap-model (Haiku) compiled checker**, and Canon has exactly one of those (the evaluator gate) and hasn't recognized it as a compilation tier. **That empty middle tier is the informative bet** (Section D).

**Recommendation:** Do NOT adopt "compilation level as a first-class scalar property" or the compiled-vs-derived ratio as a north-star metric — the first is a category error and the second has a lived perverse-incentive failure mode. **Do** adopt the narrower, testable reframe: a **three-tier execution gradient** (expensive-model prose reviewer → cheap-model compiled checker → deterministic gate), and run one probe-build that tests whether a high-frequency fuzzy principle can be compiled from tier-1 to tier-2. This is a real net-new lens on ~20% of the thesis; the other ~80% is a rename of the trace-driven-evolution program and the `prefer-deterministic-gate-over-prose-check` convention.

---

## ASSUMPTIONS

1. **PAW internals — confidence: medium.** WebFetch returned only the paper's abstract. I have the economic-inversion claim ("invoked once per function definition," "cheap and offline," "parameter-efficient adapters for a frozen, lightweight interpreter") but **not** the loss function and **not** the stated limitations. My PAW-vs-Canon disanalogy rests on the abstract's "neural adapter" phrasing; if the paper's compiled artifact is actually a deterministic rule table, the disanalogy weakens. **Correct this before committing.**
2. **The evaluator gate is templatable per-principle — confidence: medium.** I read its contract in CLAUDE.md (Haiku, structural signals + AC, fail-open, pre-review) but did not read the handler to confirm it can be pointed at a single principle with a frozen rubric. Section D's bet assumes it can be forked into a single-principle checker cheaply.
3. **`times_honored` means "reviewer evaluated this principle and it passed" — confidence: medium.** I saw the counter in `drift/analyzer.ts` (`times_honored + total_violations = total`) but did not confirm its emit site records evaluated-and-passed vs merely not-flagged.
4. **The resourcing-inversion claim is directional, not measured — confidence: medium.** I did not pull live token-cost data (Opus reviewer vs Haiku evaluator) from any build. "The frequent path is the expensive one" is structurally true (the 6-stage reviewer runs every build) but unquantified.
5. **"Frequently-violated fuzzy principle" is selectable from `get_drift_report` most_violated — confidence: high.** The tool exists and returns this; I did not run it in this read-only pass.

→ These shape everything below.

---

## A. Does the gradient hold as an architecture, or only as a metaphor?

**It holds as a *binary discriminator* Canon already owns; it breaks as a *total order*.**

### Where it holds
Canon already classifies every checkable predicate on exactly the axis the thesis proposes — and it already documents the classifier. The convention `principles/conventions/prefer-deterministic-gate-over-prose-check.md` **is** thesis sub-claim #2, verbatim in intent:

> "When a check currently relies on an LLM reading-and-judging... and its pass/fail decision can be expressed as a shell exit code — convert it to a deterministic gate wired into the verify pipeline."

Its `## Exceptions` section is the discriminator that tells you which principles *cannot* compile:

> "The predicate cannot be expressed as a shell exit code at all (requires model judgment or human decision)."

So the "irreducibly fuzzy vs mechanically-verifiable" split is **not a new axis to invent — it is already the load-bearing distinction in an existing convention.** `architectural-fitness-functions.md` is the same idea for architectural boundaries ("automate what you want to enforce; documentation alone erodes"). The learner→convention→hook pipeline the thesis describes is real and has fired at least 4 documented times (ADR-0013; PR #434), producing the same resolution each time.

### Where it breaks — the category error
"Compilation level" is **not a total order over principles.** Grounding in the actual taxonomy (67 portable principles: 6 rules / 36 strong-opinions / 25 conventions):

- `secrets-never-in-code`, `no-literal-repo-state-counts`, `verification-grep-minimum-scope` → **mechanically verifiable.** A shell gate can decide them. These sit at the deterministic endpoint and several already have gates.
- `deep-modules`, `leave-touched-files-better`, `patterns-need-justification`, `information-hiding`, `errors-are-values` → **irreducibly fuzzy.** "Is this module deep?" and "is this file better than you found it?" are taste/context judgments. No shell exit code decides them without becoming a proxy that fires wrong.
- `prefer-immutable-data`, `command-query-separation`, `functions-do-one-thing` → **partially compilable** (a linter can catch the egregious cases; the judgment call at the margin stays fuzzy).

Putting `prefer type over interface` (a lint rule) and `is this code good` (cross-cutting taste) on one scalar axis is a **category error**: they are not more-or-less-compiled versions of the same thing; they are *different kinds of predicate*. The honest structure is not a gradient (scalar) but a **partition into three classes**: `mechanical` | `distillable-to-cheap-judgment` | `irreducibly-expensive-judgment`. The thesis's "advance principles down the gradient" is only coherent for the first two classes, and for the second class the endpoint is *not* a shell gate.

**Finding A:** The gradient is real as a *3-way classification*, not a total order. Canon already makes the mechanical-vs-fuzzy cut in a shipped convention. The net-new part is recognizing a *middle* class (see D).

---

## B. Is the north-star ratio metric measurable today? Is it a good metric?

**Partially measurable (both halves exist, in different stores, unjoined); computing the ratio as framed needs new instrumentation; and the metric has a lived perverse-incentive failure mode that makes me recommend against it as a north-star.**

### What exists (grounded in the drift/archive schema)
- **Compiled/deterministic side:** `FlowRunEntry` records `avg_gate_pass_rate` and `avg_postcondition_pass_rate` per flow run (`drift/drift-db-queries.ts`, `drift-analytics-types.ts`). Gate executions are aggregated at finalize.
- **Fuzzy/re-derived side:** `drift/analyzer.ts` records per-principle `times_honored` and `total_violations` (sum = observations). Reviews persist `ReviewViolation[]` keyed by `principle_id`. `get_cross_run_analysis` exposes `recurring_violations` with `weighted_instance_count`.

### What's missing (the denominator)
The ratio as framed — "fraction of a build's decisions served by COMPILED artifacts vs RE-DERIVED by the big model" — requires a **per-build ledger tagging each judgment with which executor served it.** That does not exist:
- The reviewer records **violations found**, not **judgments made**. There is no "I evaluated principle X and it passed via prose reasoning" event with an executor tag. `times_honored` is the closest proxy but (assumption 3) its semantics are unconfirmed and it lives in the fuzzy store only.
- Gate pass-rate and principle honor-rate live in **separate stores and are never joined** into a single per-build denominator.
- There is **no `compilation_level` / `executor_class` attribute on any principle** — I checked the frontmatter schema and the taxonomy; principles carry `severity`, `scope`, `tags`, `portable`, not "which executor decides me."

So: **numerator-ish and denominator-ish signals both exist; the ratio does not, and can't be computed without (a) a per-principle executor-class attribute and (b) a per-build executor-tagged judgment event.** That is real new instrumentation, not a query.

### Why it's a dangerous north-star (the perverse incentive is not hypothetical)
Optimizing "minimize per-build fuzzy re-derivation" rewards **converting fuzzy judgment into brittle gates that fire wrong.** Canon has *lived* this failure mode repeatedly — it's in the project memory:
- `destructive-guard.sh` regex false-positived on branch names containing `clean…-f…`, **blocking a real PR push** (project_principle_enforcement_classifier_epic).
- `summary-diff-check.sh` has accreted a documented series of false-positive classes (heredoc, negated/descoped-seam tokens — watch_YYYYYYYYYYYY1).
- The push-guard heredoc false-positive hit a "3-fail-open enumeration treadmill" (project_pr447_r3_escalation).

Each of these is a fuzzy predicate that was over-compiled into a deterministic gate and then fired wrong. A ratio metric that rewards compilation-count would have **applauded every one of these at the moment it shipped** and only discovered the cost later, as separate false-positive incidents. The metric optimizes the thing PAW explicitly avoids: PAW's compiled artifact **stays fuzzy-tolerant** (neural adapter); Canon's shell-gate endpoint **is not fuzzy-tolerant**, so pushing more judgment through it is actively harmful past the mechanical-predicate boundary.

**Finding B:** The ratio is not a good north-star. If any metric is wanted here, it should be **per-tier and quality-gated** — e.g., "fraction of *mechanically-verifiable* checks served by a gate" (bounded, safe, already near-measurable) — never "fraction of *all* judgment compiled" (unbounded, rewards brittleness).

---

## C. Already-have vs genuinely-new (rigorous)

| Thesis sub-claim | Status | Evidence |
|---|---|---|
| #1 "Canon is already a compiler for engineering judgment" | **ALREADY COVERED** | `prefer-deterministic-gate-over-prose-check` + `architectural-fitness-functions` conventions; learner→convention→hook pipeline (ADR-0013, PR #434). This is a description of existing architecture, not a proposal. |
| #2 "compilation level as a first-class principle property, advanced down a gradient" | **PARTLY NEW / PARTLY CATEGORY ERROR** | The mechanical-vs-fuzzy *cut* already exists (Exceptions section of the gate convention). A scalar `compilation_level` attribute does not exist and **should not** (Finding A). A *binary* `compilable_predicate: y/n` classification would be net-new and coherent. |
| #3 "compiled-vs-derived ratio as north-star / evolution as a loss-minimizing training loop" | **NEW but REJECT** | No ratio instrumentation exists (Finding B); metric has a lived perverse incentive. The "evolution as training loop with a held-out eval to reject regressions" framing, however, **is already built** — `evaluate_candidate` §7 holdout gate (ADR-0022/0025), `attribute_failure`, `select_mutation_targets`, `loops/evolve.md` (PRs #413/#414/#418/#421/#423/#438/#445). Canon already has the generate→score→reject loop; it just doesn't call the objective "compilation." |
| #4 "resourcing inversion — invest at compile-time, cheapen the frequent path" | **PARTLY NEW / ACTIONABLE** | The compile-time investment is the entire trace-driven-evolution program (real, shipped). But the *frequent path is still expensive*: the reviewer's 6-stage pass runs every build on Opus/Sonnet and re-derives even compilable checks. The inversion is **incompletely applied** — this is the actionable residue (see D). |

**Two existing directions people will confuse this with — and why they're different:**
- **Workflow-compilation (runbook→Workflow, project_harness_workflow_compilation_direction):** compiles *control flow* (loop bounds, gates, fan-out) into an executable IR. That is a **different compilation target** (orchestration, not judgment). Orthogonal — do not merge the two.
- **Trace-driven evolution (project_trace_driven_evolution_decisions):** compiles *observed failures* into artifact mutations, gated by a held-out eval. This **is** the "run expensive analysis once, produce a reusable artifact" half of PAW — already Canon's most mature program. The compilation-gradient lens adds nothing to it except vocabulary.

**Finding C:** ~80% of the thesis is a rename of shipped work (`prefer-deterministic-gate` convention + the evolution program). ~20% is genuinely net-new: the **middle execution tier** and the reframe of the reviewer as an under-inverted frequent path.

---

## The net-new core: a three-tier execution gradient (this is what the PAW lens actually contributes)

The framing's own metaphor, taken literally against PAW, exposes a tier Canon has not named:

| Tier | Executor | Cost / frequency | Fuzzy-tolerant? | Canon population today |
|---|---|---|---|---|
| **T1** | Big-model prose reviewer (Opus/Sonnet, 6-stage) | Expensive, **every build** | Yes (full judgment) | ~all 67 principles re-interpreted here every build |
| **T2** | **Cheap-model compiled checker (Haiku + frozen rubric)** | Cheap, per-build | **Yes** (this is the PAW analog) | **Exactly ONE: the evaluator gate.** Middle tier is empty. |
| **T3** | Deterministic shell gate (zero model) | ~free, unconditional | **No** (mechanical only) | ~6 gates wired into verify (dead-wire, summary-diff, scribe-scope, shell-test, context-manifest, lint) + 23 hook scripts total |

**The insight:** Canon jumps from T1 (expensive prose) straight to T3 (shell gate) — and T3 only accepts mechanical predicates. The vast middle — **fuzzy judgments that can't become shell gates but could become a distilled cheap-model checker** — is empty except for the single evaluator gate. PAW's whole point is that the compiled artifact lands in **T2** (a cheaper *fuzzy* executor), not T3. Canon has been reading "compile" as "T3-ify," which is why the gradient felt like a category error: T3 genuinely can't hold fuzzy judgment. **T2 can.** Recognizing T2 as a first-class compilation target is the real product idea buried in this thesis, and Canon already owns the machinery (the Haiku evaluator gate + the `evaluate_candidate` holdout harness to prove a T2 checker doesn't regress against the reviewer).

---

## D. The smallest, most informative bet (if the thesis survives — it does, narrowly)

**Probe-build: compile ONE high-frequency fuzzy principle from T1 (reviewer prose) into a T2 (Haiku) single-principle checker, and measure recall against the reviewer.**

Not the cheapest win — the most *falsifying* one. It directly tests the PAW claim ("fuzzy judgment compiles to a cheaper-but-still-fuzzy executor"), which is the only part of the thesis not already proven by the shipped `prefer-deterministic-gate` work (which only ever proved the *mechanical* → T3 direction).

**Shape (single build, reuses existing machinery):**
1. Run `get_drift_report` → pick the **most-violated principle that is fuzzy** (fails the `prefer-deterministic-gate` Exceptions test — e.g. `errors-are-values` or `leave-touched-files-better`), so a shell gate is off the table by construction.
2. Fork the evaluator-gate pattern (assumption 2) into a **single-principle Haiku checker** with a frozen few-shot rubric distilled from that principle's examples + recent real violations (mined via `get_cross_run_analysis`).
3. Wire it as a **pre-review advisory gate** (fail-open, like the evaluator gate — never blocks).
4. For N builds, record: (a) violations the Haiku checker flags for that principle, (b) violations the full reviewer flags for that principle. Compute recall (checker∩reviewer / reviewer) and false-positive rate.

**What it tells us:**
- **If checker recall ≈ reviewer recall with low FP** → T2 compilation is real. You've moved one high-frequency judgment from Opus to Haiku, and the three-tier gradient becomes product direction. The evaluator-gate machinery generalizes into a *bank* of per-principle cheap checkers.
- **Falsifier:** checker recall materially below reviewer, OR FP rate high enough that the eval-fix loops it triggers cost more than the Opus tokens saved. Then T2 doesn't hold for fuzzy principles, PAW's inversion applies to Canon **only at the mechanical boundary** (which `prefer-deterministic-gate` already covers), and the whole "compilation gradient" collapses to "the convention you already shipped." Either outcome is decisive.

**Why this and not the ratio metric:** the probe measures *quality* (recall vs the reviewer) at fixed scope, not *quantity* (how much got compiled). It cannot reward brittleness — a checker that over-fires is caught by its own FP measurement in the same build. It's the safe, bounded version of the thesis.

**Explicitly NOT in the smallest bet:** no `compilation_level` scalar attribute (category error), no compiled-vs-derived ratio instrumentation (dangerous north-star), no new artifact class. One forked checker, one drift-report query, N measured builds.

---

## Requirements Coverage / Honesty — what I could NOT verify

| Item | Status | Why |
|---|---|---|
| PAW loss function & stated limitations | **NOT VERIFIED** | WebFetch returned abstract only; arXiv HTML/PDF not fetched. The neural-adapter disanalogy (the crux of the verdict) rests on the abstract's phrasing — assumption 1. This is the single most important thing to confirm before acting. |
| Evaluator gate is forkable into a single-principle checker | **NOT VERIFIED** | Read its contract in CLAUDE.md, not its handler. Section D's cost assumption depends on it. |
| `times_honored` = evaluated-and-passed | **NOT VERIFIED** | Saw the counter in `analyzer.ts`; did not trace its emit site. Affects how close B's denominator actually is. |
| Live cost split (Opus reviewer vs Haiku evaluator tokens) | **NOT MEASURED** | Read-only pass; no build run. The resourcing-inversion claim (#4) is structural/directional, not quantified. |
| Which specific principle is best for the D probe | **NOT SELECTED** | Requires running `get_drift_report` most_violated against live drift.db, out of scope for a read-only brief. |

**Load-bearing uncertainty:** if PAW's compiled artifact is *not* fuzzy-tolerant (i.e. it's a rule table, not a soft adapter), then Canon's T3 shell gate **is** a faithful PAW analog, the three-tier insight loses its PAW grounding, and the thesis reduces almost entirely to "you already shipped `prefer-deterministic-gate-over-prose-check`." Confirm the paper before committing engineering.

---

## Ranked disposition

**Net-new and worth doing (1 item):**
1. **The three-tier gradient + the D probe-build** — recognize T2 (cheap-model compiled checker) as a compilation target; test it on one fuzzy high-frequency principle. Small, bounded, falsifiable, reuses the evaluator + `evaluate_candidate` machinery.

**Already covered — do not rebuild (rename only):**
2. "Canon is a compiler for judgment" = `prefer-deterministic-gate-over-prose-check` + `architectural-fitness-functions`.
3. "Evolution as a train-and-reject loop" = the shipped trace-driven-evolution program (#413–#445).
4. "Compile-time investment" = same program; the workflow-compilation direction is a *different* (control-flow) compilation — keep separate.

**Reject:**
5. **`compilation_level` as a first-class scalar principle attribute** — category error (Finding A). A binary `compilable_predicate: y/n` is the coherent version, and it already exists implicitly in the gate convention's Exceptions.
6. **Compiled-vs-derived ratio as a north-star metric** — not measurable without new instrumentation, and rewards over-compiling fuzzy judgment into brittle gates, a failure mode Canon has lived at least 3 times (Finding B). If a metric is wanted, scope it to *mechanically-verifiable* checks only.
