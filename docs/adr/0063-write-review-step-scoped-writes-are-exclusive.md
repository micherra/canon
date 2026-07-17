---
adr: "0063"
title: "write_review step-scoped writes are exclusive; consolidation owns the canonical REVIEW.md"
status: accepted
date: "2026-07-16"
build: "fix-writereviews-two-artifact-contract-defects-1-unconditional-reviewmd"
---

# ADR-0063: write_review step-scoped writes are exclusive; consolidation owns the canonical REVIEW.md

## Context

`write_review` is the sanctioned MCP write path for the review artifact. Since 2026-06-24 it
accepted an optional `step_id` that wrote a step-scoped pair (`REVIEW-{step_id}.md` +
`.meta.json`) **and** unconditionally refreshed the canonical pair (`REVIEW.md` +
`REVIEW.meta.json`) — the code comment justified the refresh as giving "the consolidator a
stable well-known read target".

In vertical diverse-lens jury builds (ADR-0044/ADR-0046, `references/team-dispatch-protocol.md`),
N jurors call the tool serially, so the canonical pair is last-writer-wins
(watch_reviewclobber1, verified live on the PR #509 build and re-reproduced by empirical probe
in this build's PROBE-FINDINGS.md: a BLOCKING juror followed by a CLEAN juror leaves canonical
`REVIEW.md` reading CLEAN). Fixed-path consumers — the review renderer
(`templates/renderer-review.md`) and Post-Review Tester Enrichment (Stage 5 extraction) —
silently consume one arbitrary lens as if it were the consolidated verdict, corrupting the
highest-value HITL gate in the pipeline. The agent-doc workaround (`agents/reviewer.md`
instructing per-lens reviewers to use the raw `Write` tool instead) traded the clobber for
losing the sidecar, the confidence adapter, drift-signal persistence, and the ADR-0043 write
receipt.

## Options Considered

### Option A: Keep the unconditional canonical refresh (status quo)

**Pros:**
- Zero contract change; a lone juror's output is at least *something* at the canonical path.

**Cons:**
- IS the defect: last-writer-wins presents an arbitrary lens as the consolidated verdict —
  silent corruption of the review HITL, the renderer, and the tester's AC seeds.

**Canon-principle alignment:** violates `validate-at-trust-boundaries` in spirit — the
artifact contract promises a consolidated verdict the write path cannot deliver.

### Option B: Jury-aware merge inside the tool

**Pros:**
- Consumers need no orchestrator step; the tool could accumulate per-step payloads and emit a
  merged canonical file on every call.

**Cons:**
- Consolidation is axis-dependent *judgment*, not a data merge: horizontal fan-out requires
  minority-finding verification probes (spawning agents!); vertical juries require
  single-lens-first-class + any-juror-blocks semantics (team-dispatch-protocol Phase 3 vs 3V).
  An MCP tool cannot spawn probes or know the axis; encoding half the semantics would be
  wrong on one axis or both.
- Statefulness across calls (who has reported? is the jury done?) has no clean home in a
  stateless tool contract.

**Canon-principle alignment:** tensions `simplicity-first` and `no-dead-abstractions` — a
merge engine duplicating what the dispatch protocol already assigns to the orchestrator.

### Option C: Step-scoped writes are exclusive; consolidation owns the canonical pair (chosen)

**Pros:**
- Race eliminated by construction: with `step_id`, the tool writes ONLY the step-scoped pair;
  the canonical pair has exactly one writer — the no-`step_id` call (a solo reviewer, or the
  orchestrator's post-consolidation call that Phase 3 step 7 / Phase 3V step 4 already name).
- Per-lens reviews return to the sanctioned tool (sidecars, confidence, signals, ADR-0043
  receipts restored; the raw-`Write` doc workaround retired).
- Consumers unchanged — `reviews/REVIEW.md` remains the single fixed-path surface, now
  guaranteed to be sole-or-consolidated.

**Cons:**
- Behavioral change to a shipped tool contract: a caller relying on the canonical refresh
  under `step_id` must adapt (in-repo callers are updated in the same build; solo reviewers
  never passed `step_id`).
- New footgun: a solo reviewer erroneously passing `step_id` produces no canonical file.
  Mitigated: failure is loud, not silent (the renderer reports-and-stops; the orchestrator's
  Post-Subagent Artifact Check flags the missing `reviews/REVIEW.md` and re-spawns), and the
  tool description + `agents/reviewer.md` state the posture explicitly.

**Canon-principle alignment:** honors `fail-closed-by-default` (receipts restored on every
per-lens write; ADR-0043 strong path is kind-keyed and unaffected; WR-02 gains a
`reviews/REVIEW-*.md` fallback glob) and `validate-at-trust-boundaries` (the artifact
contract and the write path now agree).

## Decision

Chosen: **Option C — step-scoped writes are exclusive; consolidation owns the canonical pair.**

`write_review` with `step_id` writes only `REVIEW-{step_id}.md` + `REVIEW-{step_id}.meta.json`;
the canonical `REVIEW.md` + `REVIEW.meta.json` are written only by a call without `step_id`.
Consolidation stays orchestrator-owned per the team-dispatch protocol. (Companion, non-ADR
change shipped alongside: an optional `body` prose param and Description/Fix table rendering
close the thin-artifact gap so the consolidated call can carry the full six-stage review.)

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| validate-at-trust-boundaries | honors | The consumer contract (canonical = consolidated-or-sole) is now enforced by construction at the write path, not promised by convention. |
| fail-closed-by-default | honors | Per-lens writes emit ADR-0043 receipts again; WR-02 fallback extended, strong path unchanged. |
| simplicity-first | honors | One conditional branch replaces a latent merge-engine requirement (Option B). |
| errors-are-values | honors | No new throw paths; contract stays `ToolResult`. |

## Consequences

**Positive:**
- Jury builds cannot present an arbitrary lens as the consolidated verdict — the corruption
  class is structurally impossible, not behaviorally discouraged.
- Per-lens reviews regain sidecar durability, server-computed confidence, drift signals, and
  receipt-backed step completion.
- `reviews/REVIEW.md` becomes a trustworthy single surface for the renderer, tester
  enrichment, and the ADR-0043 WR-02 fallback.

**Negative / trade-offs:**
- The orchestrator MUST make the consolidation `write_review` call (no `step_id`) after
  team-dispatched reviews — a forgotten consolidation leaves no canonical file (loud
  failure: renderer stops, artifact check flags).
- `step_id` misuse by a solo reviewer produces no canonical file (loud failure, documented
  posture in `agents/reviewer.md` and the tool description).
- The `WriteReviewResult.path` a `step_id` caller receives is now the step-scoped path.

## Revisit-If

- A consumer emerges that legitimately needs an always-fresh canonical file during an
  in-progress jury (e.g. live-streaming review UI) — would need an explicit
  `refresh_canonical` opt-in rather than reverting the default.
- Consolidation moves server-side (e.g. a `consolidate_reviews` tool with axis-aware
  semantics) — Option B's cons would need re-evaluation with real requirements.
- The team-dispatch protocol stops assigning consolidation to the orchestrator.
