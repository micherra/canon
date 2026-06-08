# Canon Self-Improvement — Engineering Investment Review

## Status: Complete

A hard-nosed value review of the candidates from `MAP.md` §5. The scoring axis is
**not** "is it recursive." It is: **does it remove real pain or prevent real
defects, and is the payoff worth the build cost?** Conceptually-elegant
candidates with thin payoff are killed.

Every number below is pulled from the live repo at HEAD (`8aad9241`):
`.canon/drift.db` (40 violations, 315 build archives, 413 flow runs), 156 build
digests over the last ~30 days, and `.canon/learning.jsonl` (122 entries).

---

## Ground-truth pain data (measured, not asserted)

Before scoring candidates, here is what the data actually says hurts:

| Pain signal | Measured value | Source |
|---|---|---|
| **Corrective builds reacting to external (Codex) PR review** | **29 of 156 builds (~19%)** in the last 30 days are "address-codex-pN on PR #NNN" / "fix-pr-NNN" builds | digest filenames, `.canon/agent-memory` |
| **Doc-conflict / stale-scribe / merge churn builds** | **32 of 156 digests** mention scribe/stale/conflict | digest grep |
| **A full build cycle burned on stale drift violations** | **9h 5m, 0 live violations, 0 diff** (watch_RRRRRR1) | `build-digest-2026-06-08-verify-all-21-...`, drift.db |
| **Drift store has no closure concept** | `violations` table has **no status column**; 40 rows accumulate, never close | `.schema violations` |
| **Recurring violation classes** | `leave-touched-files-better` (13 files), `observable-best-effort` (8), `consistent-abstraction-levels` (4), `incomplete-dead-code-removal` (3), `hooks-fail-closed` (3) | `file_violation_history` |
| **High fix-iteration builds** | 7, 6, 6, 3 fix cycles on recent renderer/promotion/codex builds | digests 06-06..06-07 |
| **Dead storage tables (producer exists, 0 rows)** | `violation_outcomes`=0, `predictions`=0, `craft_profiles`=0, `error_fixes`=0 | drift.db counts |

Two facts reframe everything below:

1. **The biggest measured pain is not in any MAP.md candidate.** It is the ~19%
   of builds spent reacting to external Codex review comments and the ~20% spent
   on doc/stale churn. The RSI lens looked entirely inward at Canon's analysis
   plumbing and missed that **one in five builds is rework triggered after a PR
   is already open.**

2. **The "dead-wire" candidates unlock nothing today because the upstream tables
   are also empty.** `violation_outcomes` has exactly one writer
   (`outcome-store.ts:61`) that is **never called in the pipeline** — 0 rows.
   `predictions` has a producer in `drift-db-signals.ts` — 0 rows.
   `craft_profiles` has writers (`store-pr-review.ts`, `report.ts`) — 0 rows.
   Wiring a *consumer* onto an empty *producer* delivers zero value until the
   producer actually emits. This kills the original §5 ranking, which put the L9
   consumer first.

---

## Candidate-by-candidate review (MAP.md §5)

### Candidate 1 — Wire agent-metrics into cross-run analysis (close L9)

1. **Pain removed.** In theory: no analysis ever sees per-agent turn/retry
   counts, so we can't tell which agent type is expensive. In practice today: a
   maintainer has *not once* been blocked by missing this. There is no digest, no
   watch, and no recurring violation that traces to "we couldn't see agent
   metrics." The pain is hypothetical.
2. **Payoff.** Unbounded and unmeasured. It only pays off *if* a downstream
   consumer (re-weight the gate, reorder the cascade, calibrate thresholds) is
   also built — and each of those is its own candidate with its own thin payoff.
   On its own it produces a dashboard nobody asked for.
3. **Build cost.** Medium. `buildRunSummary` (`run-summary-builder.ts:36`) must
   read `execution_states.metrics`, a new `RunSummary` field, a new learner
   dimension. The producer (`record_agent_metrics`) ships, but the data has to be
   threaded through archival into the history store — that's real plumbing, not a
   one-line read.
4. **Verdict: MEASURE-FIRST, and DEMOTE from keystone.** This was MAP.md's #1.
   It is not. It is infrastructure for value that lives in candidates 2/3/4, and
   its own standalone payoff is a report. Before building it, answer one
   question with a cheap query: *across the 315 build archives, is there an agent
   type whose retry/turn cost is an actual outlier worth acting on?* If yes,
   build the minimum consumer for that one decision. If no, skip.

### Candidate 2 — Escalation-cascade outcome learning (close L6)

1. **Pain removed.** The cascade (add_primer → increase_budget → escalate_model →
   narrow_scope → hitl) runs in fixed order. If `escalate_model` resolves 90% of
   stalls and `add_primer` resolves 5%, we still always try `add_primer` first,
   wasting a recovery attempt.
2. **Payoff — bounded, and it's small.** Escalation only fires on agent
   *failure/stall*. The dominant recovery in the last 30 days is **SendMessage
   resume** (watch_NNNNN2, now 6 consecutive lossless recoveries) — which is a
   *resume-first* path that **bypasses the cascade entirely**. The `auto_decision`
   events the cascade would learn from are sparse precisely because the common
   failure mode is handled upstream. Reordering a rarely-hit cascade saves a
   handful of attempts per month at most.
3. **Build cost.** Medium: a reader for `auto_decision` events + a reorder hook.
   No new collection.
4. **Verdict: SKIP (for now).** Conceptually clean, empirically low-traffic. The
   resume-first protocol already ate this loop's lunch. Revisit only if cascade
   invocations rise.

### Candidate 3 — Confidence-weight calibration from outcomes (deepen L5)

1. **Pain removed.** The autonomy-tier gate uses fixed penalty constants
   (`cleanPenalty=(1-rate)*30`, `retryPenalty=min(retry*5,20)`,
   `failurePenalty=rate*10`). If those weights mis-rank, builds get over- or
   under-gated.
2. **Payoff.** Unmeasurable today and probably tiny. `predictions` table is
   **empty (0 rows)** — Canon is not even recording which tier it assigned vs how
   the build turned out, so there is *no data to calibrate against*. You'd have
   to first run dozens of builds capturing tier-vs-outcome pairs, then fit
   weights, to maybe move a threshold by a few points. The whole apparatus
   optimizes a gate that is already conservative and human-overridable.
3. **Build cost.** High: capture predictions, accumulate a sample, build a
   fitter, gate the fitted weights behind human ratification.
4. **Verdict: KILL.** This is the candidate that is mostly elegant framing and
   thin real payoff. It is self-tuning-gate machinery in search of a problem
   nobody has reported. The honest move flagged in the task prompt — "if
   candidate 3 is mostly buzzword, say so" — applies here. Killed.

### Candidate 4 — Promotion-efficacy feedback (close top of L1)

1. **Pain removed.** Real pain, and it's named in the data. The promotion ladder
   promotes conventions on a ≥3-instance threshold but **never checks whether a
   promoted convention actually reduced the violation it targeted.**
   `file_violation_history` shows `leave-touched-files-better` recurring across
   **13 files** and `observable-best-effort` across **8** — these recur *despite*
   being established principles. We promote, then never verify the promotion
   paid off, and bad/ineffective promotions entrench (watch_QQQQQQ1: a promoted
   remediation shipped containing the very defect it was meant to prevent, 3
   consecutive instances).
2. **Payoff — bounded.** If even one ineffective promotion per quarter is caught
   and demoted before it entrenches, that prevents a class of recurring review
   findings. The signal already exists: before/after `file_violation_history`
   counts per principle. Measurable: "did principle X's violation rate fall in
   the N builds after promotion?"
3. **Build cost.** Medium: a before/after attribution query over
   `file_violation_history` (data already populated) surfaced as a learner
   dimension + a demotion-proposal path (human-gated).
4. **Verdict: SHIP.** This is the highest real-value candidate from the original
   list because the upstream data is *already populated* (unlike candidates 1/3),
   the pain is *measured* (recurring violation classes), and it directly attacks
   promotion entrenchment.

### Candidate 5 — Consume analyzer's agent-performance trends

Same diagnosis as Candidate 1: consumer onto data that is either empty or
unused, no reported pain. **Verdict: SKIP.** Fold into Candidate 1's
measure-first query if ever revisited.

### Candidate 6 — Cliff-pattern → machinery feedback (deepen L3)

1. **Pain removed.** Repeated agent write-cliffs on the same step waste a build.
2. **Payoff.** `cliff_events` table has **1 row.** watch_BBBBB1's own closure
   digest notes "real_events_at_merge_time: 0." There is no measured cliff
   frequency to act on. Resume-first (watch_NNNNN2) already recovers the common
   case losslessly.
3. **Build cost.** Medium, depends on Candidate 1's plumbing.
4. **Verdict: SKIP.** No traffic. The cliff dimension was just built; let it
   accumulate data before adding machinery on top.

---

## Value adds the RSI lens MISSED

These are not in MAP.md §5. They came from looking at what actually costs
maintainers time, not at what is recursive.

### A. Drift-store auto-closure / auto-surface  *(this is the real keystone)*

**Pain (measured):** The `violations` table has **no status column** — there is
literally no concept of a closed violation. 40 rows accumulate. The result was a
**9-hour build (watch_RRRRRR1) that verified 21 recorded violations and found 0
live, producing a zero-line diff.** That is a full wasted build cycle caused
purely by the store's inability to tell stale from live. watch_RRRRRR2 adds that
5 of those 21 were *phantom or wrong-scope at record time* — recorded against
files/scopes where the principle never applied.

**Payoff (bounded, large):** Add a closure mechanism — when a build at commit C
shows a previously-recorded violation's file no longer matching, mark it closed;
validate scope/existence at *record* time so phantoms never enter. This directly
prevents the 9h zero-diff sweep from ever recurring, and keeps `get_drift_report`
/ the learner from reasoning over stale data. Even one prevented sweep per
quarter pays for the build.

**Build cost:** Medium. Add `status` + `closed_at` to `violations` (schema
migration), a closure check at review/verify time, and a record-time scope guard
(watch_RRRRRR2 — partially the reviewer's job already). Producer and consumer
both exist; this is a schema + two hooks.

**Verdict: SHIP — promote to #1.** It is the single change with measured,
already-incurred, repeatable cost (a 9h build) and a contained fix. There is even
an open workspace `canon--drift-store-closure-mechanism` indicating this was
already scoped.

### B. Pre-emptive internal review against the Codex finding-classes  *(biggest-volume pain)*

**Pain (measured):** **29 of 156 builds (~19%)** in 30 days are corrective builds
reacting to external Codex PR comments — "address-codex-p1/p2 on PR #NNN." These
are defects that **passed Canon's own reviewer**, reached an open PR, were caught
by an external bot, and required a whole new build to fix. Recurring Codex
finding-classes are visible in the digests: unanchored grep/awk boundary matches
(watch_QQQQQQ1), string-executing-wrapper eval safety (PR #337), scope-parity
gaps.

**Payoff (bounded, large):** Every one of these is a *second* build cycle.
Cutting even a third of them — by adding the recurring Codex finding-classes as
explicit reviewer checklist items so Canon catches them *before* the PR — saves
~3-4 builds/month. This is the highest-volume rework in the whole dataset.

**Build cost:** Low-Medium. Mine the ~29 corrective digests for the top 5
recurring external-finding classes, add them as reviewer Stage checks. No new
storage. This is largely an `agents/reviewer.md` content change plus a couple of
grep-guard checks (the codebase already does this style of check, e.g.
verification-grep-minimum-scope).

**Verdict: SHIP.** Attacks the single largest measured rework category. Cheapest
value-per-build in the slate.

### C. Doc-conflict / stale-scribe pre-empt

**Pain (measured):** **32 of 156 digests** involve scribe/stale/conflict; CLAUDE.md
is a known high-churn merge hotspot (the orchestrator already has a "Doc-file
conflict pre-check"). A standalone 130-155-commit scribe sync (PR #346) found
only 3 stale lines after combing 155 commits — the *commit-count staleness
heuristic measures churn, not drift* (watch_PPPPPP1), so it fires expensively and
finds little.

**Payoff (bounded, small-medium):** Replace the commit-count trigger with a
precise signal — grep CLAUDE.md files for dead symbol references
(watch_PPPPPP2/PPPPPP3 already propose exactly this). Stops over-firing standalone
scribe builds and catches the real stale-contract class (PR #167-era dead
symbols) that the current trigger misses for months.

**Build cost:** Low. A symbol-existence grep over `**/CLAUDE.md` replacing/​
augmenting the commit-count gate. Two watches already specify it.

**Verdict: SHIP (cheap).** Small toil reduction, near-zero cost, watches already
scoped the fix.

### D. Delete the dead storage tables (or wire their one writer)

**Pain:** `violation_outcomes`, `predictions`, `craft_profiles`, `error_fixes`
are all **0 rows**. `violation_outcomes` has one writer never called in the
pipeline. This is dead schema that every future maintainer must reason about and
that pollutes the "Canon has feedback loops" story.

**Payoff:** Legibility. Either delete the table+DAO (if the loop isn't wanted) or
add the one missing pipeline call (if it is). Small but it removes a standing
source of "is this wired?" confusion — exactly the confusion that consumed this
whole exploration.

**Build cost:** Low. Per table: one delete-or-one-call decision.

**Verdict: MEASURE-FIRST per table** — decide intent, then delete or wire. Don't
build consumers (Candidates 1/3/5) on top of these until they emit.

---

## Ranked investment slate (value ÷ cost)

| # | Investment | Saves | Costs | Verdict |
|---|-----------|-------|-------|---------|
| 1 | **Drift-store closure + record-time scope validation** (Value-Add A) | Prevents the 9h/0-diff stale-sweep build; stops learner reasoning over 40 stale rows | Schema `status` column + closure hook + scope guard (medium) | **SHIP** |
| 2 | **Pre-empt recurring Codex finding-classes in Canon's own reviewer** (Value-Add B) | ~19% of builds are external-review rework; cut a third → 3-4 builds/month | reviewer.md checklist + 2-3 grep guards (low-med) | **SHIP** |
| 3 | **Promotion-efficacy feedback + demotion** (Candidate 4) | Catches ineffective/entrenching promotions (watch_QQQQQQ1) before they recur across 8-13 files | before/after `file_violation_history` query + demotion proposal (medium) | **SHIP** |
| 4 | **Precise doc-staleness trigger** (Value-Add C) | Stops over-firing standalone scribe builds; catches real dead-symbol drift | symbol grep over CLAUDE.md replacing commit-count gate (low) | **SHIP (cheap)** |
| 5 | **Resolve dead storage tables** (Value-Add D) | Legibility; unblocks any future consumer work | delete-or-wire per table (low) | **MEASURE-FIRST** |

**Killed / deprioritized:** Candidate 1 (agent-metrics consumer) → demoted to
measure-first, its payoff lives in others. Candidate 2 (escalation learning) →
SKIP, resume-first already handles the common case. **Candidate 3 (self-tuning
gate weights) → KILLED** — elegant, no data to calibrate against
(`predictions`=0), optimizes an already-conservative gate; thin real payoff.
Candidates 5/6 → SKIP, no traffic in the data yet.

The headline correction to MAP.md: the original RSI ranking put the L9
agent-metrics consumer first. The value lens demotes it and surfaces three pains
the recursion framing never looked at — a 9h stale-sweep build, ~19% of builds
spent on external-review rework, and dead storage tables — all of which outrank
every "is it recursive" candidate on value-per-build-cost.

---

## Is finishing the unwired loops worth it?

The earlier "delete-or-wire" framing judged these tables as *legibility debt*.
This section judges the **end behavior** on its own merits: if we actually
finished the loop, would the resulting behavior be worth having?

**First, the critical split** — verified against git creation dates and actual
caller wiring. The empty tables are empty for two opposite reasons:

- **Disconnected (the loop was built and left unplugged — a real bug):**
  `violation_outcomes`. The writer (`OutcomeStore.recordOutcome`,
  `outcome-store.ts:98`) has **zero callers** anywhere in the pipeline (grep for
  `.recordOutcome(` / `new OutcomeStore` outside the file and its tests returns
  nothing). Created 2026-05-26 and never plugged in since.
- **Wired but starved (working as intended, just early / on-demand):**
  `predictions`, `error_fixes`, `craft_profiles`. Their writers **are** called
  in the live pipeline; the tables are empty in this local db because the
  trigger path hasn't run here yet or the producer only fires on a specific,
  recent code path.

Per-item:

### `violation_outcomes` (0 rows; writer never called)
1. **Designed to enable.** Record, per (file, principle, slug), whether a flagged
   violation was ultimately `fixed`, `accepted`, or `descoped` — so the learner
   and confidence-scorer can distinguish "violations that get fixed" from
   "violations everyone ignores," and stop nagging about the latter.
2. **Valuable?** Yes, and it overlaps directly with Value-Add A (drift closure).
   "Was this violation acted on?" is exactly the signal the 40-row no-status
   `violations` table lacks. The pain is measured (the 9h stale sweep).
3. **Gap.** Small in code, but it's the *disconnected* one: a single call site at
   review/verify resolution time to invoke `recordOutcome`. No accumulation
   runway needed — it would start filling on the next build.
4. **Verdict: FINISH — but as part of Value-Add A, not separately.** Don't wire
   `recordOutcome` in isolation; the drift-closure work (slate #1) is the right
   home for "mark this violation fixed/accepted." Finishing the closure loop
   *is* finishing this table. If closure ships, this table gets its caller for
   free; if closure is deferred, delete this table rather than leave a second
   half-built closure mechanism beside it.

### `predictions` (0 rows here; writer IS wired)
1. **Designed to enable.** `recordPrediction` (`get-context-handler.ts:131`)
   snapshots, at context-injection time, which (file, principle) pairs Canon
   *predicted* would be at risk. `reconcilePredictions` + `prediction-accuracy.ts`
   later score predicted-vs-actual (TP/FP/FN). The intended decision: feed
   per-principle accuracy back into `signal-compiler` weighting (MP-2/MP-3) so
   noisy predictors are down-weighted.
2. **Valuable?** The end behavior — Canon learning which of its own risk signals
   are trustworthy — is genuinely valuable *if* the predictions are acted on. But
   today nothing reads `prediction_accuracy` back into the weighting
   (`confidence.ts` only lists it as a possible signal name). So the valuable half
   is the consumer that doesn't exist yet.
3. **Gap.** Large and two-part: (a) an **accumulation runway** — predictions must
   be recorded and then *resolved* across dozens of builds before accuracy is
   statistically meaningful; (b) a **net-new consumer** that folds accuracy into
   signal weights. This is months of data plus a calibration consumer, not one
   call.
4. **Verdict: LEAVE-DORMANT.** Keep `recordPrediction` emitting so the runway
   fills, but do **not** build the accuracy-weighting consumer now — it has no
   data and (per the killed Candidate 3) confidence weighting is a
   low-reported-pain area. Revisit when the table has a few hundred *resolved*
   predictions. This is the same diagnosis as killed Candidate 3, one layer up.

### `craft_profiles` (0 rows; writers exist, created 2026-06-04)
1. **Designed to enable.** One row per reviewed subsystem area capturing the v2
   6-dimension craft ratings (`store-pr-review.ts` `persistCraftRows`), so
   `cross-run-craft-drift.ts` can show craft *trend over time* per subsystem —
   "is the renderer getting better or worse?"
2. **Valuable?** Moderately. A craft-trend-per-area view is a real maintainer
   want, but craft score is reviewer-LLM-judged and must stay diagnostic-only
   (Goodhart risk from VALUE.md §6). Useful as a dashboard, dangerous as an
   objective.
3. **Gap.** **None in code — pure accumulation runway.** Created 4 days ago
   (PR #301). It fills only when a reviewer passes the structured `craft_profile`
   field on a reviewed build; it just hasn't happened in this local db yet. The
   wire is complete.
4. **Verdict: LEAVE-DORMANT (working as intended).** Do nothing. Let it
   accumulate. If after ~20 reviewed builds it's still empty, *then* investigate
   whether reviewers are actually emitting the structured field — that would
   reclassify it as disconnected.

### `error_fixes` (0 rows here; writer AND consumer both wired)
1. **Designed to enable.** The "feed-forward error/fix index" (originating build:
   `epic-6-feed-forward-enrichment-with-cross-session-errorfix-index`,
   2026-05-22). `backfillErrorFixes` mines `file_violation_history` into
   error→fix pairs; `pitfall-enrichment.ts` (`getErrorFixes`, line 106) reads
   them and **injects prior-pitfall context into agent spawn prompts** via
   `resolve-agent-skills`. The decision it drives: a fresh agent touching a file
   gets warned about the error/fix that bit a prior build on that same file.
2. **Valuable?** Yes — directly attacks the recurring-violation pain measured in
   the slate (`leave-touched-files-better` recurring across 13 files,
   `observable-best-effort` across 8). Warning the agent up-front is exactly how
   you stop the same violation recurring on the same file.
3. **Gap.** **The smallest of all — the entire loop already exists end to end.**
   Writer wired, consumer wired, injection wired. It's empty here only because
   `backfillErrorFixes` is an on-demand backfill that hasn't been run against
   this db. It is effectively *one backfill call away from live*.
4. **Verdict: FINISH (cheapest finish in the set).** Trigger the backfill (or run
   it on a schedule / at flow start) so `error_fixes` populates from the 99 rows
   already sitting in `file_violation_history`. The consumer that turns it into
   agent-prompt warnings is already built. This is the rare case where "finish
   the loop" means "call the function that's already written."

### L9 agent-metrics consumer (producer ships, no reader)
1. **Designed to enable.** Per-agent turn/retry/duration counters in
   `execution_states.metrics`, intended to feed efficiency indices (MP-5) and
   threshold calibration (MP-3).
2. **Valuable?** The end behavior (spot an expensive agent type and act) is
   plausible but **unmeasured and unrequested** — no digest or watch traces pain
   to missing agent metrics (VALUE.md Candidate 1).
3. **Gap.** Medium: thread metrics through archival into the history store, then
   build a consumer. MP-3/MP-5 don't exist (`turns_per_file`/
   `threshold_calibration` → 0 matches in src).
4. **Verdict: LEAVE-DORMANT / MEASURE-FIRST.** Unchanged from Candidate 1. The
   producer already emits; don't build the consumer until the cheap one-query
   check (is any agent type a real cost outlier across 315 archives?) says yes.

### Analyzer's agent-performance trends (computed, read by nothing)
1. **Designed to enable.** `cross-run-analyzer.ts` computes per-agent performance
   trends intended for orchestrator model/budget choices or architect wave
   assignment.
2. **Valuable?** Same family as L9 — speculative, no measured pain.
3. **Gap.** Small (data is computed; just unread) but pointless without a
   decision that wants it.
4. **Verdict: LEAVE-DORMANT.** It's computed cheaply as a side effect; surface it
   only if/when L9's measure-first check justifies acting on agent cost.

### Summary table

| Item | Intended behavior | Worth finishing? | Why |
|------|-------------------|------------------|-----|
| `violation_outcomes` | Record fixed/accepted/descoped per violation → stop nagging ignored ones | **FINISH (inside Value-Add A)** | Disconnected wire; the exact signal drift-closure needs; small gap |
| `predictions` | Score Canon's own risk-signal accuracy → re-weight noisy signals | **LEAVE-DORMANT** | Valuable end, but needs months of resolved data + a net-new consumer; same as killed Cand. 3 |
| `craft_profiles` | Craft-trend-per-subsystem over time | **LEAVE-DORMANT** | Wire complete, 4 days old; pure accumulation runway, do nothing |
| `error_fixes` | Inject prior file pitfalls into agent prompts → prevent same-file recurrence | **FINISH (cheapest)** | Whole loop already built end-to-end; one backfill call from live; attacks measured recurrence |
| L9 agent-metrics | Spot expensive agent types (MP-3/MP-5) | **LEAVE-DORMANT / MEASURE-FIRST** | Unmeasured, unrequested; producer emits, defer consumer |
| Agent-perf trends | Budget/model/wave choices from agent trends | **LEAVE-DORMANT** | Speculative; computed but no decision wants it |

**Single strongest FINISH:** `error_fixes`. It is the only unwired thing whose
*entire* loop — backfill producer, pitfall consumer, and agent-prompt injection —
is already built and merged; it's empty purely because the backfill hasn't been
triggered against the live db. Finishing it means running an already-written
function (and scheduling it at flow start). It directly attacks the measured
recurring-violation pain (`leave-touched-files-better` × 13 files) by warning
agents about prior file pitfalls before they re-offend. Highest value-per-effort
in this entire document: near-zero cost, real measured payoff.

**Single clearest DELETE:** `violation_outcomes` *as a standalone table*. Its end
behavior is valuable but redundant — it duplicates the closure/outcome signal
that Value-Add A (drift-store closure) must build anyway. Either fold its
`recordOutcome` call into the closure work (FINISH-by-merging) or delete the
table outright; what it must not remain is a second, disconnected half-built
closure mechanism sitting beside the real one. If drift-closure (slate #1) ships,
delete this table unless closure explicitly adopts it as its store.

### Re-evaluation: predictions vs. PR churn

The user pushed back on the DORMANT verdict: *"predictions is worthwhile — look
at our PR churn."* The dormant verdict rested on two assumptions. I re-tested both
against the actual producer code and churn data. **Both fail — but not for the
reason I originally gave.** The honest finding is sharper: `predictions` as built
does not model churn at all, and the data needed to make it model churn is not
persisted.

**ASSUMPTION 1 — "needs months of forward data; can't backfill." Re-tested: the
backfill is impossible for a different, harder reason — the inputs aren't saved.**

What `predictions` actually predicts (read from `prediction-tracker.ts` +
`signal-compiler.ts`): per-**(file, principle)** *violation occurrence*, where
the features are entirely internal-history-derived — `violation_history` (this
principle was violated in this file N times before), `path_effect`, `correction`.
The target label is **the next reviewer's violations** (`reconcilePredictions`
compares predicted pairs against `reviews`/`violations` rows). It is a
"will-the-reviewer-flag-this-file-for-this-principle" model. **It is not a
"will-this-PR-need-a-corrective-build" model.** The user's churn signal is a
different target than the one this table was built for.

Could we *repurpose* it to predict churn by backfilling from history? **No — the
crux fails on persistence.** The at-build-time signal snapshot is stored in
exactly one place: the `signals_json` column of the `predictions` table itself
(`drift-schema.ts:235`), which is empty (0 rows). The `build_archives` table (315
rows) persists only branch/slug/flow/tier/artifact metadata — **there is no
`signals_json`, no compiled-signal snapshot, no risk-feature vector per archived
build.** So for the 315 historical builds we cannot reconstruct "what risk signals
did Canon have at build time," because those signals were computed transiently at
`get_context` time and never written for builds that predate live prediction
recording. **The training set's feature column does not exist in history.**
Backfill is therefore impossible; the runway must be forward, not historical.
Assumption 1's conclusion (dormant) survives, by a stronger argument than I gave.

**ASSUMPTION 2 — "no churn-prevention consumer; optimizes a conservative gate."
Re-tested: a churn-risk-flag consumer would be valuable, BUT the churn is
dominated by signals the model cannot see.**

The implied consumer is sound in principle: predict at build time which builds
will churn, then act (harder review, block autonomous tier, force a reviewer
check). That is a legitimate, valuable behavior — not the autonomy-gate-weight
loop I killed. So Assumption 2's framing was too dismissive; the *consumer* is
worth wanting.

But does the churn correlate with antecedent signals Canon *has*? Measured
breakdown of the corrective builds (30-day window, 156 builds):

- **25 of the corrective builds are externally driven** — "address-codex-pN on
  PR #NNN" / "address-review-comment." Only ~16 trace to internally-detected
  causes (broken render, stale doc, merge conflict, flaky test).
- The external corrective slugs are concrete, low-level findings: `eval` +
  `git reset --hard` safety on string-executing wrappers (PR #337), unanchored
  `awk`/`grep` boundary matches (PR #334, #330), scope-parity gaps (PR #332,
  #321). These are **shell/regex-correctness defects in single edited files** —
  not "this file historically violates principle X" patterns.

This is the fatal mismatch. The churn is dominated by **external Codex findings on
the specific diff**, and the model's features are **internal per-file violation
history**. A file's prior violation count tells you nothing about whether *this
diff's* awk terminator is unanchored. The model is structurally blind to the
dominant churn cause. It could perhaps catch the ~16 internal cases, but even
those (broken render, merge conflict) aren't principle-violation-history signals
either — they're diff-shape/hot-file signals the current feature set doesn't
encode.

**Honest payoff bound.** If `predictions` were finished *as built* and ran
forward for months, optimistic ceiling: it might pre-flag the subset of churn
that is both internal AND principle-violation-history-correlated. From the data
that is **at most a single-digit fraction of the ~29 corrective builds/month —
plausibly 2-4, and likely fewer**, because 25/29 are external-diff-specific and
outside its feature space. That does not justify building the forward runway +
the net-new churn-risk consumer.

**Where the user's instinct is actually right.** PR churn *is* a real, large,
measured pain (~19% of builds) and *is* worth a prediction-style risk flag — but
**not this table's model.** The churn-predictive features are diff-specific:
shell/regex-safety lint classes, unanchored-pattern detection, scope-parity
checks, hot-file + large-blast-radius diffs. That is precisely **Value-Add B**
(pre-empt the recurring Codex finding-classes in Canon's own reviewer) — a
checklist/lint approach that catches the *defect classes* directly, rather than a
statistical model that needs months of runway to maybe catch a few. The right
response to the churn pain is to **deterministically check for the finding
classes Codex keeps raising**, not to train a violation-history predictor that
can't see them.

**Revised verdict: DORMANT-stands for `predictions` as built; the churn pain it
points at is real and is better served by Value-Add B (SHIP).**

- **Persistence-of-signals answer (the crux):** the at-build-time risk-feature
  snapshot is **not persisted** in `build_archives` — it lives only in the empty
  `predictions.signals_json`. Historical backfill is impossible; only a forward
  runway exists.
- **Churn correlation:** the churn is **25/29 externally-driven, diff-specific**
  (shell/regex/scope-parity), which the model's internal per-file
  violation-history features structurally cannot predict.
- **Bounded payoff if finished as-is:** ≤ 2-4 of ~29 corrective builds/month
  pre-flagged, optimistically — not worth the forward runway + net-new consumer.
- **Redirect:** route the churn-prevention value to **Value-Add B** (reviewer
  checklist for recurring Codex finding-classes), which attacks the dominant
  external 25/29 directly and deterministically, no runway required.

### Mining the PR corpus directly

The user's follow-up — *"Can it just study the PRs for data?"* — sidesteps the
persistence objection entirely. My prior conclusion (backfill impossible) was
about the missing *internal* signal snapshot. But the PRs themselves are an
external, fully-retained corpus: diffs, Codex review comments, and corrective
follow-up builds all live in GitHub and are reconstructable via `gh`. I tested
both cruxes with real commands against this repo. **Both pass decisively.**

**Crux 1 — Labels (corrective → original linkage): mechanically reconstructable,
100% in sample.** Of the 27 corrective build slugs in the 30-day window, **27/27
name the original PR number** in the slug itself (`fix-codex-p1-on-pr-337-...`,
`address-codex-p2-comment-on-pr-332-...`). The (original PR → did-it-churn)
pairing is a string match, not a guess. Independently, `gh pr list --state
merged` titles already encode the linkage (`fix(hooks): ...` #337 follows the
hook PR it corrects).

**Crux 2 — Features (Codex comments retrievable): yes, and they are structured.**
`gh api repos/:owner/:repo/pulls/{N}/comments` returns the Codex findings as
inline review comments authored by `chatgpt-codex-connector[bot]`. Sampled 25
recent merged PRs: **17 carried ≥1 Codex review comment.** The bodies are not
free-form prose — they follow a fixed shape:

> `**![P1 Badge]...** Block quoted git passed to shell evaluators** ...`
> `**![P2 Badge]...** Bound the frontmatter grep to the tools field** ...`
> `**![P2 Badge]...** Include scope-parity warnings in the verdict rules** ...`

Each comment carries a **severity badge (P1/P2)**, a **bold one-line defect-class
title**, and a body with specifics — and is attached to a file + line. This is
near-ideal mining input: severity and defect-class are parseable from the first
line; file path gives the static-feature join (touches `hooks/`, touches `awk`,
etc.). The comments are present and parseable — the mining route does **not**
weaken to diff-only static features.

**Product (a) — one-time mining pass.** A `gh`-driven sweep over the last ~60
days of merged PRs: pull every `chatgpt-codex-connector[bot]` comment, parse
`{severity, title, file, body}`, cluster by title/keyword into recurring defect
classes, rank by frequency × severity. This produces an **evidence-backed,
frequency-ranked checklist** — strictly sharper than the hand-picked Value-Add B,
which was eyeballed from 29 digest *filenames*. The filenames only told me a PR
churned; the comments tell me *exactly what Codex flagged and how often*. From the
three samples alone the top classes already surface concretely: string-executing
wrapper / `eval` safety (P1), unanchored `awk`/`grep` boundary matches (P2),
scope-parity-vs-verdict gaps (P2) — each now with a real comment as the citation,
not a guess. Mining ~17 comment-bearing PRs would almost certainly surface 2-3
classes I did *not* eyeball. **Effort bound: a half-day `gh` + cluster pass — no
schema, no model, no table, no accumulation runway.**

**Product (b) — ongoing learner dimension.** Re-mine newly-merged PRs + their
Codex comments each learn cycle to keep the checklist current as Codex's
finding-mix shifts. Real but lower-value: Codex's defect classes are slow-moving
(the same shell/regex/scope-parity classes recur across weeks), so a **periodic
re-run of (a)** — quarterly, or triggered when corrective-build rate ticks up —
captures ~all the value of a standing dimension at a fraction of the maintenance.
Verdict: **(a) periodically, not (b).** Build the standing dimension only if the
finding-mix proves volatile across two re-runs.

**Verdict.** PR-mining is a real, cheap path the empty-table route could not
offer — and it is the *correct* way to source Value-Add B. It does not revive
`predictions` (still DORMANT — different target, missing internal features); it
**strengthens Value-Add B** by grounding the reviewer checklist in the actual
defect corpus instead of hand-picked guesses. Both cruxes — label linkage (27/27)
and comment retrievability (17/25 PRs, structured) — are confirmed against live
`gh` data. This is the empirical sourcing for the slate's #2, and it raises
confidence that #2 will actually catch the dominant 25/29 external churn.

- **Corpus minable?** Yes. Labels: 27/27 corrective slugs name the source PR.
  Features: Codex comments retained, structured (P1/P2 + titled), 17/25 sampled
  PRs.
- **Product (a) vs hand-picked B:** sharper and more complete — frequency-ranked
  from real comment text, citations attached, surfaces classes eyeballing missed.
- **Effort:** ~half-day `gh` + cluster pass; no schema/model/runway. Re-run
  periodically rather than a standing learner dimension.

### Full-corpus mine: how many PRs, how far back

The user's push — *"345 PRs, why can't we mine them all?"* — is correct: the
17/25 earlier was a feasibility sample, not the build scope. I ran the full mine
against live `gh`. The numbers and the actual ranked defect-class list follow.

**1. Total corpus.** **303 merged PRs** (numbers 1–347; the gaps are
release/unmerged). Date range 2026-03-15 → 2026-06-08.

**2. The Codex-activation boundary (the one real limit).** Codex first commented
on **PR #47, 2026-03-29** (probed: #46 = 0 codex comments, #47 = 2; #1–#46 carry
none). So the corpus splits:

- **Mineable-for-comments window: PRs #47–347 = 275 merged PRs** (the
  Codex-active set).
- **Pre-Codex: 28 merged PRs (#1–#46)** — have diffs and churn labels but **no
  Codex findings to mine.**

**3. What the full mine yielded.** Pulled every `chatgpt-codex-connector[bot]`
review comment across the 275-PR window: **234 Codex comments on 161 distinct
PRs** (≈59% of windowed PRs got at least one finding). Severity split: **84 P1 +
150 P2.** Clustering the bold-title defect descriptions by keyword gives the
ranked defect-class list below — **this is the actual input the reviewer
checklist (Value-Add B) would be built from.** Counts overlap slightly (a comment
can touch two themes); P1 column is the severe subset within each class.

| # | Defect class | Comments | of which P1 |
|---|--------------|---------:|------------:|
| 1 | **board/state persistence & ordering** (wave-gate precedence, finalize/terminal-state, flow-event override, profile lookup, normalize) | 28 | 11 |
| 2 | **path/dir resolution** (CANON_PROJECT_DIR→project root, pluginDir seed, ESM-safe dir refs, primer dir) | 24 | 11 |
| 3 | **scope/boundary too broad-or-narrow** (worktree exception too wide, grep/guard scope, restrict-to-X) | 22 | 7 |
| 4 | **validation / guard bad-or-missing input** (raise on missing state, robust-to-concurrent-init, verify-before-act, assert) | 20 | 4 |
| 5 | **shell/git tokenize & eval safety** (quoted-git→evaluators, strip command prefixes, split on shell whitespace, subshell `cd`, destructive-git scoping) | 14 | 8 |
| 6 | **grep/awk/regex/fence boundary** (bound frontmatter awk, anchor patterns, longer fences for embedded prompts) | 13 | 4 |
| 7 | **concurrency / transaction / race** (serialize board read+write, same-transaction reads, atomic init, session-scoped jobs) | 12 | 6 |
| 8 | **tool-wiring (schema/args/call)** (wire seed_from through schema, file-path options into resolve_agent_skills, diff_base into show_pr_impact) | 7 | 4 |
| 9 | **return-shape / empty handling** (return state_artifacts only when non-empty) | 5 | 1 |

**What the full mine reveals that the 30-day sample missed.** My hand-picked
Value-Add B (from digest filenames) surfaced ~3 classes: shell/eval safety,
awk/grep boundaries, scope-parity. The full mine confirms those (classes 5, 6, 3)
but **surfaces six more, and re-ranks them** — the top two by volume are actually
**board/state-ordering (28)** and **path/dir resolution (24)**, neither of which I
eyeballed. The long tail also exposes **rare-but-severe P1 classes** a 30-day
window misses: concurrency/transaction races (12, P1=6) and tool-wiring schema
gaps (7, P1=4) — exactly the "predict the diff that touches a shared board write
without a transaction" check a reviewer should run. The full corpus produces a
**strictly sharper and more complete checklist**, frequency-ranked with a real
comment as the citation for each class.

**4. The churn-label analysis runs over ALL 303, not just the window.** The
slug→PR# linkage (27/27 in the 30-day check) works on every corrective build
regardless of Codex era, so "what fraction of PRs churn, and is it trending"
mines the full history; only the *comment* features are confined to the #47+
window. Note the split: **labels over 303, comment-features over 275.**

**5. Effort / limits.** Measured: ~1.4s per `gh api .../comments` call. Sequential
over 275 PRs ≈ 6-7 min; **parallelized at `-P 8` the full mine completed in well
under 2 minutes** (234 comments, 161 PRs) with **no rate-limit errors** (authed
`gh` has a 5000-req/hr limit; 275 calls is 5.5% of budget). No pagination issues
at this comment volume. The whole mine is a **single ~2-minute `gh` + cluster
pass — no schema, no model, no table, no runway.**

**Verdict (unchanged direction, now fully sourced).** Mining all PRs is not only
feasible, it is cheap and it materially improves Value-Add B: the checklist
should be built from these 9 frequency-ranked, severity-weighted classes — led by
board/state-ordering and path/dir-resolution, not the shell-safety class I
happened to eyeball first. Re-run the 2-minute mine quarterly (or when the
corrective-build rate ticks up) rather than standing up a learner dimension.
