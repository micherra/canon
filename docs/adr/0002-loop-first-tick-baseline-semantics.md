---
adr: "0002"
title: "Loop first-tick is baseline-capture-only — transition rules never fire against an empty prior"
status: accepted
date: "2026-06-11"
build: "loop-framework-phase-c-self-paced-mode-schedulewakeup-adapter-session"
amended-by: "ADR-0056"
---

# ADR-0002: Loop first-tick is baseline-capture-only

## Context

Canon's Loop framework (the `loops/*.md` artifact class) drives every loop through a generic
`/canon:loop-tick` runner that, each tick, observes the current state, diffs it against the
last-seen snapshot persisted in `state.path`, and fires `surface.on_transition` rules on
changed fields. The schema invariant is `surface.on_transition[].field ⊆ state.snapshot`, and a
rule matches on `from`, `to`, or any-change.

On a loop's **first tick** there is no prior snapshot to diff against (no state file yet). The
behavior of a transition-only rule against an empty prior was undefined — flagged as
`note_XXXXXXX1` during Phase B. The two failure modes are symmetric and both bad: (1) **false-fire**
— treating "absent → X" as a transition and surfacing a change that never happened; (2) **silent
swallow** — never surfacing a condition that was already true when the loop armed. This affects
*every* loop, including the already-shipped `ship-watch` and `_probe`, so the chosen default is a
framework-wide invariant, not a per-loop choice.

## Options Considered

### Option A: Baseline-only first tick

Tick 1 captures the snapshot and surfaces nothing. A field with no prior value is treated as
"no transition." Transition detection begins at tick 2 (the first tick with a real prior).

**Pros:**
- Eliminates the false-fire class deterministically.
- Matches operator intuition for a watcher: establish a baseline, then report changes.
- Formalizes the de-facto behavior the existing loop bodies already gesture at ("if absent,
  treat as null").

**Cons:**
- A condition already true at arm time is not surfaced until it changes again. (Non-issue for
  the real loops: ship-watch arms pre-CI-conclusion; session-watch's de-dupe ledger is its own
  baseline.)

**Canon-principle alignment:** honors `least-surprise`, `simplicity-first`, `errors-as-values`
(no spurious surface).

### Option B: Surface-current-state first tick

Tick 1 treats an absent prior as a transition into the current value, firing any rule whose `to`
matches (or any-change rules).

**Pros:**
- Surfaces an already-true condition immediately.

**Cons:**
- Reintroduces exactly the false-fire `note_XXXXXXX1` warns about (e.g. a `to: failure` rule fires
  on an un-acted-on baseline; an `append`-mode rule floods the entire initial state as "new").
- Requires per-rule opt-out to be safe → more complexity for the unsafe default.

**Canon-principle alignment:** tensions `least-surprise` (surfaces noise on arm).

## Decision

Chosen: **Option A — baseline-only first tick.**

`note_XXXXXXX1` frames the risk as false-firing against an empty baseline; Option A removes that
class entirely with the least machinery ("no prior value ⇒ not a transition") and formalizes what
the existing loop bodies already intend. The narrow downside does not bite either real loop.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| least-surprise | honors | A watcher reporting only *changes* after a baseline matches operator expectation; no surface on arm. |
| simplicity-first | honors | One guard in the runner's diff step; no per-rule configuration. |
| errors-as-values | honors | Removes a spurious-signal failure mode rather than papering over it downstream. |

## Consequences

**Positive:**
- All loops (incl. shipped `ship-watch`, `_probe`) get a single, predictable first-tick contract.
- The fix is a runner-semantics guard + documentation, not a schema migration.

**Negative / trade-offs:**
- A genuinely already-true-at-arm condition waits for its next change to surface. If a future
  loop needs surface-on-arm, it must be added as an explicit per-rule `fire_on_baseline: true`
  opt-in (deliberately not built in Phase C).

## Revisit-If

- A future loop has a legitimate need to surface an already-true condition at arm time — add an
  explicit opt-in field rather than changing this default.

**Resolved by ADR-0056 (2026-07-14).** This condition was met: `ship-watch.merge_state` and
`session-watch.kg_stale` were genuinely blind with no workaround, and the workaround pattern had
already been independently reinvented three times elsewhere in the registry. ADR-0056 built the
per-rule `fire_on_baseline` opt-in this ADR specified as the remedy, mechanically constrained so
the noise class this ADR exists to prevent stays inexpressible. This ADR's Decision, Status, and
Options Considered are unchanged — ADR-0056 is an amendment executing this ADR's own contingency,
not a supersession.
