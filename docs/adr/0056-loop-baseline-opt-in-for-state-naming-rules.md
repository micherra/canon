---
adr: "0056"
title: "Loop baseline blindness: a per-rule fire_on_baseline opt-in for state-naming rules, mechanically constrained to bar the flood and any-change noise sub-classes"
status: accepted
date: "2026-07-14"
build: "adjudicate-the-adr-0002-baseline-blindness-consequence-a-to-matching"
amends: "ADR-0002"
supersedes-rationale-of: "ADR-0045 Option B rejection"
---

# ADR-0056: A per-rule `fire_on_baseline` opt-in for state-naming rules

## Context

ADR-0002 made a loop's first tick baseline-capture-only: a field with no prior value is never a
transition, so zero rules fire on tick 1. It named its own downside — "a genuinely
already-true-at-arm condition waits for its next change to surface" — and judged it a non-issue
for the loops that existed then.

It is no longer a non-issue. **If a watched field is already sitting in its alerting state when
the baseline is captured, the `to:`-matching rule for that state can never fire.** The baseline
records the alerting value and every subsequent tick compares equal to it. The field must leave
the alerting state and come back. A loop that starts watching an already-broken thing reports
healthy forever — and a blind loop is indistinguishable from a healthy one, which is the worst
property a watchdog can have.

**Live evidence.** On 2026-07-14, `ship-watch` tick 1 on PR #498 captured
`merge_state: "BEHIND"` into its baseline and fired zero rules — correct per ADR-0002. But
`ship-watch`'s rule is `to: BEHIND` with no `from:`, so BEHIND→BEHIND is not a transition and
`auto-update-branch` could never fire for that PR. This caused no harm only by luck:
`repos/micherra/canon/branches/main/protection` returns `required_status_checks.strict = null`,
so main does not require up-to-date branches and the armed auto-merge was not blocked. Had
`strict` been `true`, this would have reproduced the PR #462 incident — a silently stalled
auto-merge — with the watchdog built to prevent it looking on and reporting nothing.

**The decisive finding: the workaround has already been independently reinvented three times, three
different ways.** A probe of every rule in all 7 loops (17 rules) against the real diff algorithm
and every loop body found:

| Technique | Loops | How it defeats the blindness |
|---|---|---|
| **Marker baseline** | `harness-watch` (`learner_due`), `evolve` (`evolve_due`) | Tick 1 sets the marker to the observed total and the derived `_due` field to `false` — definitionally non-alerting at baseline. |
| **Empty-seed baseline** | `evolution-regression-watch` (`regression_candidate_ids`) | Tick 1 baselines `[]` rather than the *observed* set, so anything already true surfaces as growth on tick 2. |
| **De-dupe ledger** (ADR-0045) | `session-watch` (cliff + staleness directives) | The directive is emitted from the loop **body** against a persisted ledger, bypassing `on_transition` entirely. |

Three solutions to one problem, each encoded in prose an LLM must execute correctly, each
invisible to the schema, each requiring a future loop author to notice the trap and re-derive a
defense. The two rules that got no workaround (`ship-watch.merge_state` ×2, plus
`session-watch.kg_stale`) are exactly the ones that are blind today.

An empirical probe of the schema also established that this **cannot** be fixed in loop YAML
alone: `TransitionRuleSchema` is a plain `z.object`, so Zod's default `strip` silently discards an
unknown rule key. A `fire_on_baseline: true` added without a schema change parses clean and
vanishes — a silent no-op.

## Options Considered

### Option A: Accept as-is; document the blindness

Leave ADR-0002 untouched and document that loops are blind to already-alerting baselines, relying
on the orchestrator to notice such states out-of-band.

**Pros:** Zero build cost. Preserves a tracked decision untouched. Not hypothetical — the
orchestrator genuinely *did* catch the PR #498 case out-of-band, without any loop change.

**Cons:** The blindness is silent and indistinguishable from health — precisely the property that
made the PR #462 incident expensive. Three rules stay permanently inert, including
`auto-update-branch`, the consumer built in response to that incident. Relies on a human noticing
what the watchdog exists to notice.

**Canon-principle alignment:** honors `simplicity-first`; tensions `fail-safe-defaults`.

### Option B: Blanket — all `to:`-matching rules fire on a matching baseline

Treat an absent prior as a transition into the current value for any `to:`-matching rule.

**Pros:** No per-rule configuration; fixes every blind `to:` rule at once.

**Cons:** **Reintroduces exactly the noise class ADR-0002 exists to prevent.** The hoped-for
dissolution of the trade-off — "if the tick-1 noise came only from any-change rules, letting
`to:`-matching rules fire is nearly free" — does not survive contact with ADR-0002's own text,
which names *both* shapes in one sentence under Option B's cons:

> "Reintroduces exactly the false-fire `note_XXXXXXX1` warns about (e.g. **a `to: failure` rule
> fires on an un-acted-on baseline**; an **`append`-mode rule floods the entire initial state as
> 'new'**)."

Concretely: `ship-watch.release_tag` would announce a *pre-existing* release tag as newly cut — a
lie — and `ship-watch.external_review_comment_ids` would flood every pre-existing PR comment as
new. Both must stay blind. ADR-0002 is right about these.

**Canon-principle alignment:** tensions `least-surprise`.

### Option C (chosen): A per-rule `fire_on_baseline` opt-in, mechanically constrained

Add `fire_on_baseline?: boolean` to `TransitionRuleSchema`, admissible **iff** `to` is set AND
`from` is unset AND `append` is not `true` — enforced by a `superRefine` at parse time. A rule
that opts in fires on a baseline tick if and only if the observed value equals its declared `to:`.

**Pros:**
- Upholds ADR-0002's default for every rule that does not opt in.
- **Two of ADR-0002's three named noise sub-classes become inexpressible, not merely
  discouraged.** `append: true` → rejected (the flood sub-class); no `to:` → rejected (the
  any-change sub-class). A loop author *cannot write* the append-flood or any-change shapes.
  **The third sub-class — a to:-matching false-fire (e.g. a hypothetical `to: "failure"` rule
  firing on an un-acted-on baseline, ADR-0002's own named example) — remains schema-admissible.**
  Nothing in the `superRefine` distinguishes a `to:` naming an author-intended "alerting" state
  from one naming a healthy or otherwise noisy one; the schema has no concept of "alerting",
  only equality. This sub-class is governed by per-rule author judgment plus review, not by a
  structural bar — accepted for the 3 rules this build opts in, all of which name a state
  (`BEHIND`, `DIRTY`, `true`) rather than an event, but a future author *could* opt a noisy
  edge-shaped rule in by mistake and the schema would not stop them.
- **A healthy baseline still surfaces nothing, structurally, for the opted-in set** — the rule
  fires only when the observed value equals its declared `to:`, which a healthy snapshot does
  not match. This mechanical equality-gate holds for any to:-only rule regardless of whether the
  value is "alerting" — dc-04 (an all-healthy snapshot fires zero rules) holds by construction
  for the snapshot this build ships, not as a general guarantee against future noisy opt-ins.
- **Silent-on-no-op falls out for free** — after a tick-1 fire, tick 2 sees `BEHIND` against a
  prior of `BEHIND`, not a change. No ledger, no suppression logic, no new state.
- It is what ADR-0002 itself specified as the remedy.

**Cons:**
- Touches `loop-schema.ts`, the shared contract all 7 loops parse through. Note this file is
  **not** on the ADR-0044 sensitive-path deny-list — a gap this build closes separately; see
  ADR-0057.
- Per-rule opt-in means a future author must remember to declare it. Mitigated: the alternative
  is remembering to invent one of three bespoke body workarounds.

**Canon-principle alignment:** honors `simplicity-first`, `fail-closed-by-default`,
`least-surprise`, `least-privilege`.

## Decision

Chosen: **Option C.**

**ADR-0002's default stands and is not overturned.** Its analysis was correct: it identified the
noise class accurately, chose the safe default, predicted its own downside, and named the remedy:

> **ADR-0002, Consequences:** "If a future loop needs surface-on-arm, it must be added as an
> explicit per-rule `fire_on_baseline: true` opt-in (deliberately not built in Phase C)."
>
> **ADR-0002, Revisit-If:** "A future loop has a legitimate need to surface an already-true
> condition at arm time — add an explicit opt-in field rather than changing this default."

That Revisit-If condition has now been met. This ADR executes the contingency ADR-0002 wrote for
exactly this moment. It is an **amendment**, not a supersession.

Applied to 3 rules — the only genuinely-blind ones in the registry:
`ship-watch.merge_state` (`to: BEHIND`), `ship-watch.merge_state` (`to: DIRTY`), and
`session-watch.kg_stale` (`to: "true"`).

## Relationship to ADR-0045 — its Option-B rejection rationale is superseded; its decision is not

ADR-0045 (2026-07-10) hit this identical wall. Its Context names ADR-0002's guard as one of "two
hard problems" and states that "**the already-stale-at-arm-time case is the primary case**." It
considered this same framework primitive as its **Option B** and rejected it:

> "**Cons:** Changes the generic loop runner + loop schema that every loop shares — **large blast
> radius for a single feature; a shared-runtime change to satisfy one loop.**"

That rejection was correct **on its premise: N=1.** Paying a shared-contract change to serve one
loop is bad economics, and its Option C (the body ledger) was the right local call.

**The premise is now false.** N ≥ 3, the workaround has been reinvented three times three
different ways, and ADR-0045's own Revisit-If names this build as the trigger:

> "The generic loop runner gains a first-class 'surface-already-true-at-arm-time' (seed-baseline)
> capability — then the body ledger for staleness can collapse into a declarative rule (Option B
> becomes cheap)."

**This ADR supersedes the *rationale* of ADR-0045's rejected Option B, and nothing else.
ADR-0045's decision, its `.staleness-refreshed.json` ledger, and its ephemeral-workspace
scribe→PR dispatch all remain fully in force and are not modified by this ADR.** A future reader
must not read this as licence to remove the ledger — see Revisit-If.

In particular, `session-watch`'s `docs_stale_crossed` and `kg_age_crossed` rules deliberately do
**NOT** opt in: their `auto-staleness-refresh` directive is already tick-1 capable via the
ADR-0045 ledger, so adding the flag would emit the directive twice on tick 1.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| simplicity-first | honors | One optional boolean + one refinement. The once-only and healthy-baseline properties fall out of the existing diff — no new state, ledger, or suppression logic. |
| fail-closed-by-default | honors | An inadmissible combination is a parse-time rejection into `invalid[]`, never a runtime warning or a silent downgrade. |
| least-surprise | honors | Default behavior is untouched; only an explicitly-declared rule differs. |
| errors-as-values | honors | Rejection flows through `parseLoopDefinition`'s `{ ok: false }` path; never throws. |
| least-privilege / dc-06 | honors | Zero allowlist entries, zero tool grants, zero `mutates_build` changes. The runner still only surfaces; the orchestrator still mutates. |

## Consequences

**Positive:**
- The three genuinely-blind rules now surface an already-alerting condition at arm time.
  `auto-update-branch` works for a PR that is already BEHIND when the watch arms — the PR #462
  class is observable again.
- **Two of ADR-0002's three named noise sub-classes (flood/append, any-change) are now
  structurally inexpressible rather than convention-protected.** The third — a to:-matching
  false-fire — remains schema-admissible and is governed by author judgment plus review, not
  by the `superRefine`; see § Options Considered, Option C Pros for the full statement. This
  correction was caught by the review's correctness juror invoking `parseLoopDefinition`
  directly (`{ to: "failure", fire_on_baseline: true }` parses clean) rather than trusting this
  ADR's original, broader claim — the same `probe-before-build-invoke-not-infer` failure mode
  ADR-0057 corrects for ADR-0045, one document downstream.
- Future loop authors get a declared, schema-checked affordance instead of a trap plus three
  undocumented workaround precedents to choose between.

**Negative / trade-offs:**
- **Once-only; no re-surfacing interval (accepted).** A field stuck BEHIND for 20 ticks surfaces
  once. Silent-on-no-op is load-bearing, and the named consumers act on the first surface —
  `auto-update-branch` merges `origin/main` and pushes. A re-surfacing interval would re-trigger a
  completed action against every consumer's idempotence precheck. If the action fails, that is the
  consumer's failure to report, not the observer's cue to nag.
- **Verification is against a model, not the runner (accepted).** The runner
  (`skills/canon/commands/loop-tick.md`) is agentic markdown, so the tests prove the *semantics*
  via a pure model of the diff algorithm — they cannot prove an LLM executes the prose correctly.
  This limitation is inherited from ADR-0002's existing proof suite
  (`loop-runner-first-tick.test.ts` says so in its own header), not introduced here. Recorded
  rather than silently inherited.
- The opt-in is per-rule, so a new loop with an already-alerting field is blind until its author
  declares the flag. The template and `loops/CLAUDE.md` now document it at the point of authoring.
- The `superRefine` that bars the flood and any-change noise sub-classes lives in
  `loop-schema.ts`, which at the time of this decision carried **no** deny-list floor — so a
  future build could have weakened this guard without triggering a security or adversarial
  review. ADR-0057 closes that gap in the same build; without it, this ADR's central safety
  property would rest on an unfloored file.

## Revisit-If

- **ADR-0045's staleness ledger could collapse into a declarative `fire_on_baseline` rule**, as
  its Revisit-If invites — but only once the once-per-*episode* semantics (signature keyed on the
  last-scribe SHA / KG mtime) have an answer. `fire_on_baseline` does not replicate them, so this
  is a real design question, not a mechanical follow-through. Do not collapse the ledger without
  solving that first.
- **The runner gains real executable code** (the diff algorithm promoted out of the test-local
  model into a shipped pure function) — then the model-vs-prose verification gap closes and both
  this ADR's and ADR-0002's proofs become proofs of the real thing.
- **A fourth body workaround appears** for a problem this field should have covered — signals the
  admissibility constraint is too narrow; revisit the `from:`/`append` exclusions with the concrete
  case in hand.
- **A misspelled `to:` is found to have silently degraded a rule to any-change in production.** A
  probe during this build found that `too: BEHIND` parses clean and produces a strictly broader
  rule than the author intended. Pre-existing and unrelated to this decision, but it is the same
  class of silent-schema-permissiveness this ADR fixes for one field; a `.strict()` pass over
  `TransitionRuleSchema` would close both.
