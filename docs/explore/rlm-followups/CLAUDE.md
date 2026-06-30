# RLM Follow-ups — Agent Guidelines

## Purpose

This directory holds the authoritative record of the RLM-derived self-improvement
program (6 items, 4 phases). The documents here are decided program record — not
proposals and not under active competition.

## Authoritative source

**PROGRAM.md is the authoritative record.** It supersedes any informal notes or
memory entries for decision-making purposes. The 6-item verdict table, phase sequence,
and locked HITL decisions in PROGRAM.md are the canonical reference.

## Authority level: DECIDED PROGRAM (IN PROGRESS)

All 6 items have verdicts. Phase 0 (this build) is in progress. Do not re-adjudicate
the panel decisions without explicit user direction.

## Key decisions (already made — do not reopen without user direction)

- `#6` is permanently dropped — the unified outer loop is over-engineered for current scale.
- `#1` is split into `#1a` (meter now) and `#1b` (gate deferred to after MP-2/3/5 data).
- `#3` starts with reviewer-replay, not engineer or learner (highest fidelity target).
- The budget meter uses `claude -p` eval debit (agreed, cost worth measurement fidelity).
- Advisory meter before hard gate is mandatory — not optional.

## Phase 0 deliverable

The `human-narrative-machine-query-seam` convention in
`.canon/principles/conventions/human-narrative-machine-query-seam.md` is the Phase 0
output. It is Canon-internal (`portable: false`) and guards the seam between
`reviews/REVIEW.md` (prose, human HITL) and `reviews/REVIEW.meta.json` (typed,
machine-queried).
