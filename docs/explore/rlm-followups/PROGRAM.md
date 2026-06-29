# RLM Follow-ups — Program Record

**Status: IN PROGRESS (Phase 0 underway)**

> Authoritative record of the 6-item self-improvement program derived from the
> RLM article (isaacflath.com/writing/rlm — recursive-language-model: do intermediate
> work outside the model's context window so the expensive model sees only distilled
> results). Decided via adversarial architect panel. Supersedes any earlier informal notes.

---

## Thesis: Subtraction, Not Unification

The RLM article argues that large models work best when intermediate results are
externalised and only the distilled signal is fed back in. The panel reframed this
specifically for Canon: **Canon's substrate already ships the primitives** — the
`.meta.json` sidecars, the typed stores, the reviewer consolidation pipeline. The
program is about removing friction at seams that already exist, not building a new
unified context-window abstraction.

No new "working-set primitive" is introduced. Each item is a subtraction or a
clarification at an existing seam.

---

## 6-Item Verdict Table

| # | Item | Verdict | Phase |
|---|------|---------|-------|
| **#1a** | Budget meter (turn/token accounting per build step) | **SPLIT** → build now | Phase 1 (∥ #2) |
| **#1b** | Advisory-meter-then-gate (gate on meter after MP-2/3/5 data) | **DEFERRED** — build after MP-2/3/5 accumulated | Phase 2 |
| **#2** | Reviewer-consolidation (query `.meta.json` sidecars instead of re-reading prose) | **SMALL-BUILD** → fold into `write_review` | Phase 1 (∥ #1a) |
| **#3** | Trace-replay spike (replay recorded reviewer context to reproduce findings) | **EXPLORE** → reviewer-replay-first spike | Phase 3 |
| **#4** | Offload discriminator convention (document when to offload work out-of-context) | **CONVENTION** → write convention + ADR | Phase 2 (after #1b) |
| **#5** | Seam convention (human-narrative vs machine-query boundary) | **CONVENTION** → write now | **Phase 0 ← this build** |
| **#6** | General RLM-as-architecture (unified "outer loop" agent) | **DROP** — over-engineered for current scale | — |

---

## Phase Sequence

### Phase 0 — This Build

**#5 Seam convention**: `human-narrative-machine-query-seam` convention authored and
committed. Establishes the guardrail that lets Phase-1 reviewer-consolidation type-ify
the `.meta.json` findings without cannibalising the human-read `REVIEW.md` prose.

Status: **IN PROGRESS** (canon--rlm-phase0-seam-convention build).

### Phase 1 — Two parallel small builds (after Phase 0 merges)

**#2 Reviewer-consolidation**: Make the parallel-review consolidation step in the
orchestrator a QUERY over existing `REVIEW-{step_id}.meta.json` sidecars instead of
re-reading N fat `REVIEW-N.md` prose files. Folds into the `write_review` tool — no
new artifact type; the sidecar already exists.

**#1a Budget meter**: Turn/token accounting per build step. Emit a `budget_debit`
event per agent spawn with turn count and token estimate; surface per-step spend in
`get_build_history`. Lays the data foundation for #1b's gate.

These two builds are independent and run in parallel after Phase 0 lands.

### Phase 2 — Sequential after Phase 1 + MP data accumulation

**#1b Advisory-meter-then-gate**: Promote the budget meter to a soft gate once MP-2/3/5
build-history data exists (approximately 20+ MP-4 builds). Gate fires advisory-only first;
escalates to hard after confirmation. Blocked on MP-2/3/5 accumulation.

**#4 Offload discriminator convention**: When to externalise intermediate work
(reviewer findings, learner pattern sets, architect research notes) vs keep in-context.
A convention + ADR capturing the discriminator the panel developed during this program.
Sequenced after #1b because the meter data informs the discriminator's thresholds.

### Phase 3 — After Phase 2, exploratory

**#3 Trace-replay spike**: Replay the recorded reviewer context (agent transcript +
`context_provenance` provenance chain) to reproduce a finding. The spike validates
whether replay fidelity is sufficient to close the locate-not-re-run gap. This ride on
the trace-driven-evolution epic's `context_provenance` (#413) + `evaluate_candidate` /
`EVAL_PLUGIN_DIR` (#414 / ADR-0025) without forking those APIs.

---

## Locked HITL Decisions

Three decisions made at the panel and ratified — do not reopen without user direction:

1. **`claude -p` eval debit**: The budget meter (`#1a`) uses `claude -p` subprocess
   invocations to sample actual token spend. Agreed that the eval cost is worth the
   measurement fidelity. Alternative (estimating from turn count alone) was rejected as
   too noisy for the gate in `#1b`.

2. **Advisory-meter-then-gate-after-MP-2/3/5**: The gate in `#1b` is hard-blocked on
   accumulating 20+ MP-4 build-data samples. The panel declined to ship a gate with
   insufficient baseline. The advisory phase between #1a and #1b is mandatory, not
   optional.

3. **Reviewer-replay-first for #3**: The trace-replay spike (`#3`) starts with the
   reviewer agent, not the engineer or learner. The reviewer has the richest provenance
   chain (all 6 stages, multi-file scope, HITL verdict context) and is the highest-value
   target for replay fidelity validation.

---

## Roadmap Edges

**#3 rides the trace-driven-evolution epic** (`context_provenance` #413 +
`evaluate_candidate` / `EVAL_PLUGIN_DIR` #414 / ADR-0025) without forking. The
recorded provenance chain and the holdout gate are consumed as-is; no contract change
to those tools is planned.

**#2 respects the transport-settled per-workspace consistency model** (Option B: keep
HTTP daemon, settled 2026-06-12). The consolidation query goes over the workspace's
`reviews/REVIEW-{step_id}.meta.json` files — one workspace, one daemon instance. No
cross-workspace fan-out.

---

## Source

isaacflath.com/writing/rlm — "Recursive Language Models" by Isaac Flath. The core
insight applied here: externalise intermediate results so the expensive model sees only
the distilled signal. Canon's reframing: the substrate already ships the externalisation
primitives (`.meta.json` sidecars, typed stores); the program removes friction at the
seams, it does not build a new primitive.
