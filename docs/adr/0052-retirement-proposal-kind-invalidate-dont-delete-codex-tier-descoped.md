---
adr: "0052"
title: "Retirement candidates via a new proposal_kind (invalidate-don't-delete); codex trust-tier descoped to an open slot"
status: accepted
date: "2026-07-11"
build: "design-and-scope-gap-3-a-trust-weighted-attribution-consumer-over-the"
---

# ADR-0052: Retirement candidates via a new proposal_kind (invalidate-don't-delete); codex trust-tier descoped to an open slot

## Context

Gap 3 wires trust-weighted scores into the learner's promotion/retirement flow. Two decisions are
hard-to-reverse because they change a shared contract and set a scoring precedent:

1. **How is a RETIREMENT candidate represented?** Today `MutationProposal`
   (`mutation-types.ts`) models a single semantic — a full-file *rewrite* — with
   `apply_channel: "writer" | "engineer-build-flow"`. A negative-signal-driven *retirement* is a
   different action (weaken/invalidate a principle that is not earning its keep), and
   `/canon:review-learnings` needs to route it distinctly.
2. **Trust-tier inputs are only partially recorded.** PROBE-FINDINGS Q2 established that the
   external-Codex trust tier is not recorded in any corpus the offline tool can read (Codex
   catches arrive via the ship-watch PR-comment channel, never landing in
   `RunSummary.review_results` or `orchestrator_decisions`). Role, adversarial-step, and
   corroboration ARE derivable; codex-origin is not.

## Options Considered

### Option A: Overload the existing rewrite proposal; block Gap 3 until a codex capture seam exists

**Pros:**
- No contract change; a "complete" trust model including codex on day one.

**Cons:**
- Overloading rewrite for retirement loses the invalidate-don't-delete distinction and mis-routes
  review-learnings.
- Blocking on a codex capture seam couples Gap 3 to a separate channel-integration increment —
  the same over-coupling that (rightly) descoped `test_failure` from `attribute_failure`
  (ADR-0024).

**Canon-principle alignment:** tensions `invalidate-don't-delete` and ship-incrementally.

### Option B: Add `proposal_kind` (rewrite|retire|reinforce) + reserve an open codex tier slot

**Pros:**
- Retirement is a first-class, correctly-routed proposal kind carrying an auditable
  `score_provenance` trace; the writer marks the principle `archived:true` (the loader-honored
  flag, `matcher.ts` excludes `archived===true`), never deletes.
- The weighting function ships with a reserved `codex` `TrustTierSlot` defaulting to `internal`,
  so a future capture seam adds the tier WITHOUT re-scoring historical builds differently.
- `proposal_kind` defaults to `"rewrite"` → existing consumers are byte-compatible.

**Cons:**
- v1 trust model is incomplete (no codex tier) — surfaced as PRD AC#2 `partial`.
- Extends a shared contract (mutation types) — a genuine, reviewed contract change.

**Canon-principle alignment:** honors `invalidate-don't-delete`, `model-step-in-agent-layer`,
`errors-are-values`.

## Decision

Chosen: **Option B.** Add `proposal_kind: "rewrite" | "retire" | "reinforce"` (default
`"rewrite"`) plus a `score_provenance` trace to the proposal contract; route `retire` to the
writer in invalidate-don't-delete mode. Reserve a default-`internal` `codex` `TrustTierSlot` and
DESCOPE the codex trust tier for v1 (surface AC#2 as `partial`). v1 weighting = role ×
adversarial-step × corroboration × time-decay.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| invalidate-don't-delete (posture) | honors | retirement marks a principle retired with an audit trace; never `rm` |
| model-step-in-agent-layer | honors | the retire/promote decision is the learner agent + HITL gate; the tool only scores + gates candidates |
| errors-are-values | honors | threshold/gate failures degrade to "no candidate", never throw |
| command-query-separation | honors | scores are query-side; emission uses the existing proposed-learnings write path |

## Consequences

- `proposal_kind` becomes part of the mutation-proposal contract; all constructors default it to
  `"rewrite"` to preserve existing behavior (parity tests enforce this).
- Every RETIRE candidate remains gated by `evaluate_candidate` (strict holdout) before emission —
  a retirement (principle marked `archived:true`, which the eval sandbox actually drops from
  loading) that regresses the holdout is rejected, never emitted. A REINFORCE candidate is
  byte-identical to its baseline, so a holdout cannot distinguish it; it is emitted UNGATED
  (`gated:false`) as a HITL confidence signal, never holdout-gated and never auto-applied.
- Adding the codex trust tier later is additive: the reserved slot defaults to `internal`, so
  historical builds keep identical scores when the tier is populated. The follow-up increment is a
  capture seam from the ship-watch PR-comment channel into the decisions ledger.
- AC#2 ships `partial`; the orchestrator surfaces this at plan approval for explicit user
  acknowledgement.
