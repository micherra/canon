---
adr: "0024"
title: "Failure→artifact attribution joins on principle_id == in-context artifact_id"
status: accepted
date: "2026-06-24"
build: "build-the-attribution-consumer-attribute-step-for-trace-driven"
---

# ADR-0024: Failure→artifact attribution joins on principle_id == in-context artifact_id

## Context

Trace-driven evolution Phase 1 ships two halves on `main`: the provenance PRODUCER
(#413) records, per agent spawn, which artifacts (rule/ref/primer/template, each with
`id`, `kind`, `content_hash`, `char_span`) were assembled into that agent's context,
keyed by `step_id`/`agent_id`; and the fitness GATE (#414, `evaluate_candidate`)
scores a candidate mutation against a frozen holdout. The missing middle is the
ATTRIBUTE consumer: read recorded provenance, join it with review violations + the
transcript, and localize a failure to the specific artifact section that was in the
failing agent's context. This join's output is the contract the future mutator
(deliverable 5) consumes — it must be designed for stability.

The crux constraint, discovered by probing the shipped code (not the brief): a
`ReviewViolation` (parsed from `REVIEW.md`) carries `principle_id` + an optional
`file_path`, but **no `step_id` and no `agent_id`**. There is therefore no recorded
edge from a violation to the agent step whose in-context artifact should be
attributed. The edge must be inferred, and the chosen inference defines the
mutator-facing output contract — making it hard to reverse later.

## Options Considered

### Option A: Join on `file_path`

**Pros:**
- `file_path` is a concrete code location.

**Cons:**
- Provenance is keyed by *artifact-in-context*, not by code file. No provenance edge
  links a code file to an artifact, so `file_path` cannot be a join key — only
  corroborating evidence. It is also frequently `null`.
- Would assert an edge the recorded data never captured.

**Canon-principle alignment:** tensions `validate-at-trust-boundaries` — manufactures
a join the data does not support.

### Option B: Join on `violation.principle_id == assembled_artifacts[].id`

**Pros:**
- Grounded in the real producer: for `kind:"rule"` artifacts the recorded
  `artifact.id` IS the rule/principle id (`resolve-agent-skills-provenance.ts`
  `buildSkillInputs`). So `principle_id == id` is a true equality join on a recorded
  edge, naturally attributing to the rule artifact that was in the failing agent's
  context.
- Extends to non-rule classes via the same id-equality mechanism; the output carries
  `kind` to support it.

**Cons:**
- Lossy: if multiple steps held the same rule, the violation maps to multiple
  candidate steps (ambiguous); a violation whose `principle_id` matches no in-context
  artifact id is unattributable.

**Canon-principle alignment:** honors `validate-at-trust-boundaries` (joins only on a
recorded edge), `errors-are-values` (lossy cases become typed buckets, not
exceptions), `observable-best-effort` (unmatched/ambiguous are surfaced).

## Decision

Chosen: **Option B — join on `violation.principle_id == assembled_artifacts[].id`**,
with the lossiness modeled as first-class output (an array of `owning_steps`, an
`ambiguous` flag, an `unattributed[]` bucket with reasons, and `join_basis:
"principle_id==artifact_id"`). `file_path` is retained as corroborating evidence
only.

This is the only join an edge in the recorded data actually supports for review
violations, and surfacing its lossiness directly serves the attribution ≠ causation
invariant: the consumer produces presence-in-context hypotheses, never proven causes.

## Scope extension (plan-approval) — failure is a discriminated set, the join is MULTI-KEY

The user broadened scope at plan-approval to cover three failure kinds. Probing the
real shipped data (PROBE-FINDINGS §9) showed the three kinds have genuinely DIFFERENT
recorded join quality, so the join is per-kind, not uniform:

| failure_kind | recorded join key | join quality | base confidence |
|---|---|---|---|
| `cliff_event` | `cliff.step_id == provenance.step_id` (EXACT; `CliffEventRow.step_id` never null) | clean | HIGH (then hash) |
| `review_violation` | `principle_id == artifact_id` (inferred; violations carry no step_id) | lossy (L1/L2) | MEDIUM (hash/ambiguity) |
| `test_failure` | **DESCOPED (deferred to follow-up)** — no durable joinable key in current trace | n/a | n/a |

- **cliff_event** is the cleanest path: a cliff names `step_id` directly, so it joins
  exactly to the cliffed step's in-context artifact SET with no inference. `join_basis:
  "cliff_step_id"`.
- **test_failure** is **descoped (deferred to a follow-up build)**. The current trace
  records no joinable key for test failures (journal has no "failed" status;
  TEST-REPORT.md carries no step_id/principle_id; no `test_failure` event type —
  PROBE §9b). The `FailureKind` union in this build ships as
  `"review_violation" | "cliff_event"` only. A follow-up build can add `test_failure`
  once a durable `test_failure` event keyed by step_id exists in the trace schema
  (Revisit-If condition below).

The output gains a `failure_kind` discriminant so the mutator can weight hypotheses by
join quality. content_hash byte-identity verification is uniform across all three kinds.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| validate-at-trust-boundaries | honors | Joins only on the recorded principle_id==id edge; never invents a file→artifact edge. |
| attribution-≠-causation (BRIEF §9) | honors | Output is a hypothesis with `presence_in_context: true` as the only asserted truth; lossiness surfaced, not hidden. |
| errors-are-values | honors | Ambiguous / unmatched / hash-mismatch cases are typed result buckets, never thrown. |
| observable-best-effort | honors | Unmatched violations land in `unattributed[]` with a reason; nothing is silently dropped. |
| no-llm-calls-in-mcp-tools | honors | The join is a deterministic equality match; no model call participates in attribution. |

## Consequences

**Positive:**
- The mutator-facing output (`FailureAttribution`) names `{path, id, kind,
  content_hash, char_span}` of the attributed artifact — exactly what a future
  mutator needs to load and hand to `evaluate_candidate.target_path`.
- Lossiness is auditable: ambiguous attributions and unattributed violations are
  visible, so the mutator can rank or discount them.

**Negative / trade-offs:**
- The join is genuinely lossy when multiple steps share a rule in context; consumers
  must handle an `owning_steps` array, not a single step.
- `file_path` precision is not exploited for the join (only for corroboration).
- **test_failure is descoped (deferred)**: at plan-approval the user confirmed
  test_failure should be cut from this build. The `FailureKind` union ships as
  `"review_violation" | "cliff_event"` only. Attribution for test failures is a
  follow-up pending a durable `test_failure` event keyed by step_id in the trace.

## Revisit-If

- A future build stamps the implement `step_id` into `REVIEW.md` (or onto each
  violation), making the violation→step edge exact — then L1 ambiguity collapses and
  the join can prefer the recorded step_id, falling back to principle_id==id. The
  output shape (array-of-steps) already tolerates this with zero contract change.
- Violations begin naming non-principle targets (e.g. a template id) directly, at
  which point the same id-equality join attributes to non-rule artifact classes.
