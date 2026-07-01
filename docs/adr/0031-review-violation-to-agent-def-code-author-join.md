---
adr: "0031"
title: "review_violation to agent-def attribution joins on the code-author agent-def, not a per-violation step key"
status: accepted
date: "2026-07-01"
build: "phase-2-agent-definition-body-provenance-seam-trace-driven-evolution"
---

# ADR-0031: review_violation to agent-def attribution joins on the code-author agent-def

## Context

Phase-2 (this build) adds agent-def provenance (ADR-0030). At plan approval the user expanded scope:
`attribute_failure` must attribute a **review_violation** to the agent-def, not only a `cliff_event`.

A `ReviewViolation` (`archive-types.ts`) is `{ principle_id, severity, file_path, message }` — it carries
**no `step_id` and no agent identity**. The existing review_violation join is
`violation.principle_id == artifact.id` (rules/principles). An agent-def artifact's `id` is the agent
name, which a `principle_id` never equals, so the recorded data supports no agent-def edge on the current
join. To attribute a code violation to *which agent-def was the persona that produced the code*, we need a
link from the violation to the code-authoring step.

Empirical probe (PROBE-FINDINGS.md Finding 6): threading a durable per-violation `step_id`/`agent_id`
would touch ~7 files across three bounded contexts (`WriteReviewInput`, `generateMarkdown`, `parseReviewFile`,
`ReviewViolation`, REVIEW.meta, run-summary builder, the reviewer agent) plus a **file→step oracle**. The
obvious oracle — git `Canon-State` commit trailers — is fragile: squash-merge to `main` empties them, so
they are unreliable at archived-attribution time.

Key insight: **every `engineer` step (implement/fix, and every wave-task engineer) loads the same
`agents/engineer.md`.** So even without knowing which step produced a given violated file, the agent-def
*artifact to mutate* is a single, hash-verifiable file. The per-violation step key only refines *which
step's transcript* to cite — it does not change the mutation target.

## Options Considered

### Option A: Thread a durable per-violation `owning_step_id` through the review pipeline

**Pros:**
- File-level precision on which step (hence which transcript) produced each violation.

**Cons:**
- ~7 files across `orchestration` + `platform/archive` + `evolution` + the reviewer agent def.
- Needs a file→step oracle; the natural one (git `Canon-State` trailers) is squash-fragile and absent at
  archived-attribution time — a medium-confidence dependency requiring its own probe.
- All that machinery buys precision that does not change the mutation target (all engineer steps share
  one `agents/engineer.md`).

**Canon-principle alignment:** tensions `simplicity-first` and `probe-before-build-invoke-not-infer`
(would build on a fragile, unproven oracle).

### Option B: Join on the code-author agent-def already present in the provenance array

**Pros:**
- Zero review-pipeline change, zero git, zero journal read — pure logic in `attribution-join.ts`.
- The mutation target is singular and hash-verifiable (one `agents/engineer.md`) regardless of step count.
- Reuses the existing whole-file `readCurrentBody` byte-identity check unchanged.
- Confidence stays honest: `high` for a single distinct code-author agent-def + hash_verified; `medium` +
  `ambiguous` when more than one distinct code-author def is present.

**Cons:**
- Attributes broadly — every code review_violation implicates the code-author agent-def.
- Loses per-step transcript precision (immaterial to the target; deferred).

**Canon-principle alignment:** honors `simplicity-first`, `deep-modules` (extend the existing join),
`errors-are-values`, `observable-best-effort`, and the honesty posture (presence vocabulary only).

## Decision

Chosen: **Option B.** Add a review_violation → agent-def edge computed purely from the provenance array:
for each violation, attribute to each DISTINCT agent-def artifact of provenance steps whose `agent_name`
is in `CODE_AUTHORING_AGENTS = {"engineer"}`, with `join_basis: "code_author_agent_def"`. This edge is
ADDITIVE to the existing `principle_id==artifact_id` rule edge (a violation may now yield both a rule
target and an agent-def target — distinct mutation hypotheses the §7 eval gate disposes between).

The broad-attribution risk is bounded downstream: the `weighted_instance_count ≥ 3` recurrence filter, the
`select_mutation_targets` `confidence:high` gate, and the §7 strict-holdout eval gate all sit between this
attribution and any human-visible proposal. A proposed `agents/engineer.md` rewrite must strictly improve
the holdout to survive.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| `simplicity-first` | honors | Pure-logic join; avoids a 7-file cross-layer change + fragile oracle. |
| `probe-before-build-invoke-not-infer` | honors | Chosen after empirically tracing the review pipeline and testing the git-trailer oracle (found squash-fragile). |
| `errors-are-values` | honors | Lossy/ambiguous paths stay typed buckets; hash-mismatch → `flagged[]`. |
| `validate-at-trust-boundaries` | honors | Reuses the fail-closed content_hash byte-identity re-check. |
| attribution honesty (ADR-0024) | honors | `presence_in_context: true` only; hypotheses use presence vocabulary, never "caused". |

## Consequences

**Positive:**
- review_violation → agent-def attribution ships with a change confined to `features/evolution`
  (`attribution-join.ts` + `attribution-types.ts`), keeping the build a single-engineer sequential task.
- The mutation target is unambiguous and hash-verifiable even for multi-wave builds.

**Negative / trade-offs:**
- Every code review_violation implicates the code-author agent-def (broad); noise is bounded only by the
  downstream recurrence + eval gates, not by the attribution itself.
- No per-step transcript precision for review-violation attributions (cliff_event retains exact step_id).
- `CODE_AUTHORING_AGENTS` is a policy constant (currently just `"engineer"`); a code violation in output
  from another code-writing agent would not attribute to that agent's def until the set is extended.

## Revisit-If

- A durable `step_id`-keyed review-violation event type is added (or REVIEW violations start carrying an
  `owning_step_id`) → add the precise per-violation join and raise transcript precision.
- Another agent's def becomes a legitimate review-violation author (its output is principle-reviewed) →
  extend `CODE_AUTHORING_AGENTS`.
- Broad attribution proves noisy in practice despite the downstream gates → add a file→step narrowing pass.
