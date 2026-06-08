# Workflow-Integration Design Competition (2026-06-07)

This directory contains the complete artifacts from a design competition to decide how the Claude Code `Workflow` tool should be integrated into Canon. Three independent teams produced proposals; three independent judges scored them; a synthesis architect produced the ratified design.

## What happened

Canon ran a full judge-panel competition (the same pattern now available as `canon-compete`): three teams each designed a distinct integration approach; three judges each scored the proposals from a different primary lens (feature richness, shippability/risk, Canon-identity coherence); a synthesis architect read all nine artifacts and produced a unified design that was then ratified at a user HITL gate on 2026-06-07.

**Verdict: B > C > A.**

- **B wins the trunk** — Proposal B (Leverage-per-Primitive Pragmatist) provides the most user-felt new capabilities: 100% adversarial review verification, loop-until-dry multi-modal sweeps, judge-panel competitions as one call, security harnesses. Every increment is independently shippable; rollback is a one-field deletion.
- **C shapes the endgame** — B and C are a sequencing disagreement, not an architecture disagreement. C's generic runner + compiled SegmentPlan IR is the documented later path, evidence-gated behind 5 conditions including measured adoption and harness-stability proof.
- **A is disqualified** — unanimous third, capped by Judge 3 for a constraint-ledger #2 violation: A's `reviewFixLoop` auto-fixes BLOCKING findings before any human sees the initial verdict.

## Reading order

1. **[SYNTHESIS.md](SYNTHESIS.md)** — Start here. The ratified design supersedes the proposals for all decision-making purposes. Includes the §8 decision record (the four questions answered at the HITL gate).
2. **[CAPABILITY-REVIEW.md](CAPABILITY-REVIEW.md)** — The shared fact base: what the Workflow tool can actually do (19 Canon mechanisms mapped against Workflow primitives, 6 hard conflicts, 15 degrees of freedom). Neutral; no design advocacy.
3. **[PROPOSAL-B.md](PROPOSAL-B.md)** — The winning trunk: saved-workflow library, args envelope, schema contracts, null-policy table, evidence-gated 8-increment migration.
4. **[PROPOSAL-C.md](PROPOSAL-C.md)** — The endgame shape: generic runner, compiled SegmentPlan IR, evidence-gated at M5 after M1–M4 prove the substrate.
5. **[PROPOSAL-A.md](PROPOSAL-A.md)** — Third place; useful for understanding the mandatory-gate compiler invariant (adopted verbatim into SYNTHESIS §3.3) and the env-snapshot path-indirection pattern (grafted from A-F9).
6. **[JUDGE-richness.md](JUDGE-richness.md)** — Feature richness & user value lens (D1 double-weighted). Ranks B > C > A (scores 61.5 / 56.5 / 49).
7. **[JUDGE-shippability.md](JUDGE-shippability.md)** — Shippability & risk lens (D3+D4 double-weighted). Ranks B > C > A (weighted totals 8.75 / 8.50 / 7.38). Includes codebase spot-checks.
8. **[JUDGE-coherence.md](JUDGE-coherence.md)** — Canon-identity coherence lens (D5+D6 double-weighted). Ranks C > B > A (69 / 62 / 55, A capped at 5 for the gate violation).
9. **[workflow-tool-spec.md](workflow-tool-spec.md)** — The authoritative Workflow tool spec: verbatim-faithful transcription of the harness tool definition. Reference this for what the primitives (`agent()`, `pipeline()`, `parallel()`, `workflow()`, `budget`, `phase()`, `log()`) actually do. Useful independently of the competition.

## Decision status

**Near-term commitment: Increments 0–3** (canon-probe, schema library, args envelope, canon-tail, ingest_workflow_run, canon-review-verify with reconciled minority probes, engine default-on with audited opt-out).

**Increments 4–6** proceed on their promotion gates; **Increment 7** (endgame compiler/runner) is a fresh future decision gated on five evidence conditions (see SYNTHESIS §3.4).

Key HITL decisions (see SYNTHESIS §8):
- Q1: Default-on adoption ratified (eligible steps default to their workflow engine; `engine: direct` is the audited opt-out).
- Q2: Supervised carve-out is a standing posture, not a permanent invariant; reconsiderable at the Inc-7 decision.
- Q3: Endgame is a fresh future decision, not a committed roadmap item.
- Q4: `canon-compete`, `canon-learn-mine`, and `canon-maintenance` all rescued into the portfolio (only `canon-flaky-hunt` stays cut).

## Relation to the Deterministic Spine epic

The Workflow-adoption items in `docs/supervised-build-quality.md` § "New Epic — Deterministic Spine" (G1–G9 enrichment, W4 tail PoC, transpiler, W8) are superseded by the 8-increment plan in SYNTHESIS §6. The X4 Stop-hook item and the #151 analysis in that section remain standing — they are substrate-independent and complementary to any Workflow adoption path.
