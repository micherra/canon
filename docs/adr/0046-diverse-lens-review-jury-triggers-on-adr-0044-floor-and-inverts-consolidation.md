---
adr: "0046"
title: "Diverse-lens review jury triggers on the ADR-0044 floor and inverts consolidation semantics on the vertical axis"
status: accepted
date: "2026-07-10"
build: "h2-posthog-program-add-a-diverse-lens-review-jury-for-high-stakes"
---

# ADR-0046: Diverse-lens review jury triggers on the ADR-0044 floor and inverts consolidation semantics on the vertical axis

## Context

Canon's review fan-out partitions **horizontally**: `references/team-dispatch-protocol.md` splits changed files into disjoint groups and clones the **same** six-stage `canon:reviewer` across them — same lens, different files. Item H2 of the PostHog review-cycle program adds a **vertical** axis: the **same** code viewed through **diverse concern lenses** (correctness / contract-compatibility / clarity-maintainability), where cross-lens agreement is itself a confidence signal. H1 (ADR-0044, PR #480) shipped the sensitive-path deny-list floor that forces supervised + `canon:security` + fresh adversarial re-review on high-stakes changes.

Two coupled decisions shape H2 and are non-obvious to a future contributor: (1) what makes a change jury-worthy, and (2) how findings consolidate when jurors share all files but differ by lens — which inverts the existing horizontal consolidation semantics.

## Options Considered

### Option A: Jury triggers on the ADR-0044 floor; vertical consolidation inverts single-lens semantics (single-lens findings first-class, overlap = agreement, any-juror-blocks); minority-probe stays horizontal-only

**Pros:**
- Reuses H1's already-computed high-stakes signal — zero new threshold to calibrate; composes H1+H2 into one pathway.
- Single-lens findings are promoted first-class (no probe storm); overlap becomes an N-of-M confidence signal.
- any-juror-blocks preserves and strengthens the existing worst-case-verdict rule.
- Jurors reuse `canon:reviewer` with a lens-primacy directive — smallest new surface, no new agent.

**Cons:**
- Couples H2's firing condition to the ADR-0044 floor definition (ripple risk if the deny-list changes).
- The two review axes now treat a lone finding OPPOSITELY (horizontal: minority → probe; vertical: single-lens → promote) — a subtlety that must be documented side-by-side.

**Canon-principle alignment:** honors `simplicity-first` (one high-stakes signal), `deep-modules` (reuse the deep reviewer, don't fork), `fail-closed-by-default` (any rule violation blocks).

### Option B: New independent jury threshold + apply the horizontal minority-probe unchanged to the vertical axis + stage-scoped jurors

**Pros:**
- Decouples H2 from H1; literally reuses the existing minority-probe branch; cheaper per juror.

**Cons:**
- A second high-stakes signal to calibrate and keep consistent (drift risk).
- The minority-probe fires on nearly every vertical finding (cost explosion) and mislabels intended single-lens findings as suspect.
- Stage-scoped jurors forfeit the free correctness scan + cross-coverage and eliminate overlap — killing the agreement signal that motivates the jury.

**Canon-principle alignment:** tensions `simplicity-first` (parallel threshold + probe storm), tensions `deep-modules` (stage-scoping fragments the reviewer).

## Decision

Chosen: **Option A**

The jury fires exactly when `compute_autonomy_tier` returns the ADR-0044 sensitive-path floor (`require_security` + `require_adversarial`); blast-radius > 50 remains the horizontal trigger, unchanged. Consolidation reuses the dedupe MECHANISM (group by `(file_path, principle_id, line_number)`) but inverts the SEMANTIC on the vertical axis: single-lens findings are first-class, overlap is an agreement/confidence signal, and the horizontal minority-verification probe is scoped to the horizontal (disjoint-partition) axis only. Verdict is any-juror-blocks for rule-severity. Jurors run the full six-stage `canon:reviewer` with one lens weighted primary. Security is delegated to the existing mandatory `canon:security` pass (no security juror) because ADR-0044 already forces it on the same trigger.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| simplicity-first | honors | Reuses H1's floor as the trigger — no parallel high-stakes threshold to calibrate. |
| deep-modules | honors | Jurors reuse the deep six-stage reviewer via a spawn-prompt directive; no new agent, no stage-fragmentation. |
| fail-closed-by-default | honors | any-juror-blocks: any rule-severity finding from any lens blocks; agreement never downgrades a rule violation. |
| information-hiding | honors | Lens→stage mapping reuses the reviewer's existing `M0…MV` module table as documentation, not a new structural surface. |

## Consequences

**Positive:**
- H1 and H2 compose into one high-stakes pathway; the same floor convenes supervised review, `canon:security`, adversarial re-review, AND the lens jury.
- No new reviewer agent; no MCP code — protocol/prose change only.
- The agreement signal (N-of-M jurors on the same finding) is a durable confidence primitive future work can persist machine-readably.

**Negative / trade-offs:**
- Vertical review is N× cost over the same code with no amortization (every juror reads every file) — justified only on the deny-list-triggered high-stakes set.
- any-juror-blocks raises the false-positive-block risk at the gate (accepted: a lens is authoritative in its domain).
- The trigger-composition binds H2 to ADR-0044's floor semantics — a future floor change ripples into jury convening.

## Revisit-If

- The ADR-0044 deny-list floor is retired or its trigger semantics change materially.
- Empirically, the jury-eligible set and the blast-radius>50 set converge (then one trigger suffices).
- A machine-readable persisted agreement signal replaces the orchestrator-prose confidence boost.
- The reviewer is escalated to topology-A/B (per-module spawn), at which point lenses could become structural spawn boundaries.
