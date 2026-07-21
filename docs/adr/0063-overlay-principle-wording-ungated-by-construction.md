---
adr: "0063"
title: "Overlay principle-wording is ungated-by-construction; the built-in holdout gate is mechanically-run-but-semantically-inert on the current eval surface"
status: accepted
date: "2026-07-17"
build: "add-the-principle-wording-mutation-class-to-trace-driven-evolution"
---

# ADR-0063: Overlay principle-wording is ungated-by-construction; the built-in holdout gate runs mechanically but is semantically inert on the current eval surface

## Context

This build adds the principle-wording mutation class to trace-driven evolution: a single-build
review violation that localizes to a `principles/**` (built-in) or `.canon/principles/**`
(overlay) file can now produce a gated, HITL-reviewable wording-rewrite proposal.

Two empirically-probed facts (`PROBE-FINDINGS.md`) shape the trust-boundary design and are
surprising enough — and hard enough to reverse once code depends on them — to record here:

1. **Probe 2 — the ADR-0025 guardrail sandbox never loads principle bodies into eval context.**
   The sandbox COPIES `principles/**` (26 files) onto disk, but a real `claude -p` session run
   with the exact `run-evals.sh` guardrail flags (`--plugin-dir <tmpDir> --setting-sources
   project`, `--allowedTools "Read Grep Glob"`) reports `PRINCIPLES_IN_CONTEXT=NO`. Principle
   markdown is on disk in the sandbox but is not auto-injected into the eval session's context,
   and the eval sessions carry no MCP tools (only `Read Grep Glob`), so they cannot pull a
   principle via `get_principles` either. Rewording a built-in principle therefore changes a file
   the eval session never reads — it produces zero holdout delta, so `decideGate`'s strict `>`
   can never accept a principle-wording candidate on the current eval surface. This mirrors the
   already-shipped ADR-0052 retirement inertness (the aggregate retire/reinforce track has the
   same structural gap).

2. **Probe 2 (same probe, second half) — `.canon/` is never copied into the sandbox.**
   `PLUGIN_ARTIFACT_ROOTS` (the guardrail sandbox's copy list) excludes `.canon/` by design
   (ADR-0027). An overlay principle candidate cannot enter the eval sandbox even in principle —
   not just today's eval surface gap, but a load-bearing trust boundary that must never be
   relaxed (untrusted-project-local content must never become model-facing execution input).

Two decisions follow from these facts and are hard to reverse once other code (selection,
`evaluate_candidate`, the apply channel) is built against them:

- **D2 — overlay never enters the sandbox; ungated + HITL.** `evaluate_candidate` now
  fail-closed-rejects any `.canon/**` target_path (`guard_rejection.reason:
  "overlay_not_sandboxable"`) BEFORE any file read or subprocess call — defense-in-depth on top
  of the sandbox's own exclusion, so no future caller path can accidentally inject overlay text
  by skipping the copy-list check. Overlay principle targets are `holdout_exempt: true`,
  `trust_tier: "untrusted-project-local"`, and are emitted as `gated: false` proposals — the
  human Accept in `/canon:review-learnings` IS the trust gate.

- **D3 — the built-in gate runs mechanically despite being semantically inert.** The
  `evolution-hard-gate` invariant (regressive candidates rejected, never averaged) is honored
  literally for built-in `principles/**` targets: `evaluate_candidate` still runs, `decideGate`'s
  strict `>` still applies. Given Probe 2 fact 1, this gate will almost always REJECT a
  principle-wording candidate on today's eval surface — that is expected and the PRD's AC#5
  explicitly counts a REJECT verdict as proving the path works end-to-end. The alternative —
  papering over the inertness by skipping the gate for built-in targets too — was rejected
  because it would silently drop a real invariant (the day a principle-sensitive eval surface
  ships, the gate becomes meaningful with zero code change) and would make built-in and overlay
  targets indistinguishable in trust posture, which they are not.

## Options Considered

### Option A: Treat both tiers identically — skip the gate for all principle-wording candidates

**Pros:** Simplest code path. No asymmetry to explain.

**Cons:** Erases the real trust distinction between a tracked, git-reviewable built-in principle
and an untrusted, gitignored overlay principle. A built-in principle candidate CAN in principle
be gated once a principle-sensitive eval surface exists; papering over that with a permanent skip
would require un-skipping it later, which is a harder migration than running an inert-but-honest
gate now. Also conflates "we haven't built the eval surface yet" with "this can never be gated,"
which is false for the built-in tier.

**Canon-principle alignment:** tensions `evolution-hard-gate` (the gate stops running at all,
rather than running-but-usually-rejecting) and `probe-before-build-invoke-not-infer` (would be
building on an assumption — "the gate can never work here" — that the probe did not establish for
the built-in tier).

### Option B: Build a principle-sensitive eval surface now, so the gate is meaningful immediately

**Pros:** Closes the inertness gap for real, not just mechanically.

**Cons:** A separate, larger increment (DESIGN Open Question 1, explicitly deferred and confirmed
out of scope by the user at plan approval). Building a new eval surface is design work in its own
right — what does a principle-compliance eval look like, how is it judged, what's the golden set —
and blocking the plumbing build on it would mean shipping nothing for AC#1–#4/#6 in the meantime.

**Canon-principle alignment:** honors `evolution-hard-gate` fully (the gate becomes genuinely
discriminating) but tensions `simplicity-first` / incremental delivery — this build's job is the
plumbing, not a new eval methodology.

### Option C (chosen): Mechanically-run-but-inert for built-in; ungated-by-construction for overlay

**Pros:** Honest about what is currently true for each tier — built-in principles run through the
REAL gate (mechanically correct, expected-REJECT is documented and accepted by AC#5); overlay
principles are structurally excluded from ever reaching the gate (ADR-0027 boundary, not an
implementation gap). Neither tier's trust posture is misrepresented. The built-in gate needs zero
code change to become meaningful once Option B's eval surface ships later — only the design
document needs updating, not the enforcement code.

**Cons:** The asymmetry (one tier mechanically gated-but-inert, the other ungated-by-construction)
is not self-explanatory from the code alone — a future contributor could look at the reject-before-
sandbox guard and the near-always-REJECT built-in gate and conclude something is broken, and "fix"
it by feeding overlay content into the sandbox (defeating ADR-0027) or by removing the built-in
gate call (defeating `evolution-hard-gate`). This is exactly the surprise this ADR exists to head
off.

**Canon-principle alignment:** honors `evolution-hard-gate` (gate runs, regressions rejected,
never averaged — literally, for the tier where it CAN run), `agent-never-trust-overlay-tier` and
`validate-at-trust-boundaries` (the `.canon/**` reject is the architectural trust gate, checked
before any subprocess), and `probe-before-build-invoke-not-infer` (both facts underpinning this
decision were invoked, not inferred — see PROBE-FINDINGS.md Probes 2 and 3).

## Decision

Chosen: **Option C.**

Built-in `principles/**` candidates run through the real `evaluate_candidate` holdout gate
unconditionally — `decideGate`'s strict `>`, regressions rejected, never averaged — even though
Probe 2 proves this gate cannot currently discriminate principle-wording on the intent-
classification eval surface (eval sessions never load principle bodies). A REJECT verdict here is
expected and, per the PRD's AC#5, itself proves the mechanical path is wired correctly end-to-end.

Overlay `.canon/principles/**` candidates NEVER reach `evaluate_candidate` — `evaluate_candidate`
fail-closed-rejects any `.canon/**` target_path before any file read or subprocess call
(`guard_rejection.reason: "overlay_not_sandboxable"`), and the selection layer stamps overlay
targets `holdout_exempt: true` / `gated: false` so the learner skill skips the call entirely (the
reject is defense-in-depth, not the primary control flow). The HITL Accept in
`/canon:review-learnings` is the sole trust gate for this tier.

A principle-sensitive eval surface (Option B) that would make the built-in gate genuinely
discriminating is explicitly deferred — see Revisit-If.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| evolution-hard-gate | honors | The gate runs before every built-in proposal, strict `>`, never averaged — literally, for the tier capable of running it. |
| validate-at-trust-boundaries | honors | The `evaluate_candidate` `.canon/**` fail-closed reject is the architectural trust gate for overlay content; checked first, before any subprocess. |
| agent-never-trust-overlay-tier | honors | Overlay principle bodies are model-generated untrusted text; they are only ever WRITTEN under HITL, never READ as instructions into an eval session. |
| fail-closed-by-default | honors | An unknown or `.canon`-rooted injection target rejects; it never falls open to a sandbox run. |
| probe-before-build-invoke-not-infer | honors | Both load-bearing facts (sandbox never loads principle bodies; `.canon/` never copied) were established by invoking the real capability (a live `claude -p` session; the shipped injection function), not inferred from the PRD's pre-probe assumptions. |
| errors-are-values | honors | `guard_rejection` is a typed result field, never a thrown error; `holdout_exempt`/`trust_tier` are typed optional fields, not sentinel strings. |

## Consequences

**Positive:**
- Overlay principle-wording candidates can never leak into the eval sandbox — structurally, not
  by convention — closing a class of trust-boundary bug before it can exist.
- The built-in gate needs zero code change to become meaningful the day a principle-sensitive
  eval surface ships (Revisit-If below); only this document's framing needs an update.
- Both tiers' actual trust posture is now explicit and tracked, rather than left to be discovered
  by reading `evaluate_candidate`'s dispatch order.
- AC#5's dry-run (one live evolve pass on the real corpus) is expected to record a REJECT for a
  built-in candidate — that REJECT is itself the proof the mechanical path works, not a failure.

**Negative / trade-offs:**
- Until a principle-sensitive eval surface exists, the built-in principle-wording gate cannot
  accept ANY candidate, no matter how good the rewrite — every built-in proposal in this class
  will show `accepted: false` in the live corpus. A future maintainer skimming the corpus without
  this ADR could reasonably conclude the pipeline is broken.
- The two-tier asymmetry (mechanically-gated-but-inert vs. ungated-by-construction) adds a
  concept a contributor must learn before touching either `evaluate_candidate`'s guard order or
  the selection layer's `trust_tier` stamping.

## Revisit-If

- **A principle-sensitive eval surface ships** (Option B, DESIGN Open Question 1) — re-run Probe
  2's methodology against the new surface; if principle bodies ARE now loaded into eval context,
  the built-in gate transitions from mechanically-inert to genuinely discriminating with no code
  change required, and this ADR's Consequences section should be updated to record the date that
  happened.
- **A future contributor proposes feeding overlay content into the guardrail sandbox** "to make
  the gate consistent across tiers" — this is the exact mistake this ADR exists to prevent. Point
  them here first; the answer is D2 stands regardless of what happens to D3.
- **The `.canon/**` fail-closed reject in `evaluate_candidate` is ever weakened or made
  conditional** — re-verify via a probe (not inference) that no path exists for overlay content to
  reach `withInjectedGuardrailCandidate`/`withInjectedCandidate` before relaxing it.
