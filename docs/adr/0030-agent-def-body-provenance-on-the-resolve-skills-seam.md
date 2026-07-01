---
adr: "0030"
title: "Agent-definition-body provenance rides the resolve_agent_skills seam"
status: accepted
date: "2026-07-01"
build: "phase-2-agent-definition-body-provenance-seam-trace-driven-evolution"
---

# ADR-0030: Agent-definition-body provenance rides the resolve_agent_skills seam

## Context

Trace-driven-evolution Phase 2 requires provenance for the agent-definition body
(`agents/<name>.md`) — the persona/behavior instructions that are the largest single influence on
how an agent acts — so a diagnosed behavioral failure can attribute to the exact def-body that was
in context, and the (already-shipped) Mutator pipeline can select it as a `evaluate_candidate`
target.

The exploration BRIEF (`docs/explore/trace-driven-evolution/BRIEF.md` §5) and the PRD both framed
this as needing **a new provenance seam**: "captured at the orchestrator's spawn-prompt
construction, the one assembly point `resolveAgentSkills` does not own." The orchestrator is the
model (the lead session), which assembles the spawn prompt in-context — so the a-priori worry was
that no TypeScript chokepoint sees the def body at spawn, forcing a new MCP tool, a hook, or a
harness change.

An empirical probe (PROBE-FINDINGS.md, base_commit dfbd4c85) **falsified that premise**:
`resolve-agent-skills.ts:298-308` already `readFileSync`s the entire `agents/<name>.md` file to
parse its frontmatter, then discards the body (`const { data } = splitFrontmatter(agentFile)`).
The body is already in memory at the exact function that already emits the Phase-1
`context_provenance` event (#413 / ADR-0018). The decision is therefore *where to capture the
agent-def body*, given that the "new seam" the BRIEF assumed is unnecessary.

A second, coupled decision: what does `content_hash` cover for an agent-def artifact, given that
AC#6 forbids frontmatter (`name`/`tools`/`model`) from being a mutable target while
`attribute_failure` verifies byte-identity by hashing the whole current file via a shared
`readCurrentBody` seam.

## Options Considered

### Option A: New spawn-time MCP tool (sibling to `resolve_agent_skills`) or a hook

**Pros:**
- Matches the BRIEF's mental model ("a new seam").
- Conceptually isolates agent-def capture from skill resolution.

**Cons:**
- Adds a new tool the orchestrator MUST remember to call at every spawn — a new omission surface
  and a new protocol obligation in CLAUDE.md.
- Duplicates the file read `resolve_agent_skills` already performs.
- A hook cannot easily emit into the execution store keyed by the journal `step_id` the way the
  existing emit does.
- More code, more wiring, more failure modes — for zero capability the resolver seam lacks.

**Canon-principle alignment:** tensions `simplicity-first` (new primitive where none is needed) and
`probe-before-build-invoke-not-infer` (would enshrine the un-probed premise).

### Option B: Extend the existing `resolve_agent_skills` provenance emit with an `"agent-def"` artifact

**Pros:**
- Zero new tools/hooks; the body is already read at this seam.
- Rides the existing `(workspace, step_id)` join and `agent_id` back-fill unchanged.
- Downstream (`classifyArtifact→"agent"`, guardrail eligibility, `evaluate_candidate` sandbox,
  `attributeCliffs` loop) is already generic over artifact class (ADR-0025) — agent-def falls out
  with a one-line type widening.
- Public tool contracts of `attribute_failure` / `select_mutation_targets` / `evaluate_candidate`
  stay unchanged.

**Cons:**
- Couples agent-def provenance to `resolve_agent_skills`: any spawn path that bypasses the resolver
  records no agent-def (same coverage limitation Phase-1 preload provenance already accepts →
  fail-open, never an error).
- Overloads one function with a second responsibility (skill resolution + agent-def capture),
  though both already read the same file.

**Canon-principle alignment:** honors `simplicity-first`, `deep-modules` (extend the deep seam),
`errors-are-values` (fail-open), `validate-at-trust-boundaries` (reuses the hash re-check).

### Sub-decision (hash coverage): whole-file hash vs body-only hash

- **Whole-file hash** (chosen): keeps `attribute_failure`'s whole-file `readCurrentBody`
  byte-identity seam untouched and detects frontmatter drift as drift; frontmatter is excluded from
  *mutation scope* at the section-span layer instead.
- **Body-only hash** (rejected): would force a frontmatter-aware variant of the shared
  `readCurrentBody` seam (or a per-kind branch), leaking agent-def specifics into the generic
  attribution join and risking universal hash mismatch for every other artifact kind.

## Decision

Chosen: **Option B — extend the existing `resolve_agent_skills` provenance emit.** The agent-def
body is already read there; adding it as one `AssembledArtifact` of kind `"agent-def"` (with
`char_span: null`, body-relative section spans, and a **whole-file** `content_hash`) is the minimal,
lowest-blast-radius capture. Frontmatter exclusion (AC#6) is enforced at the section-span layer:
mutable `sections` cover the body only; the whole-file hash serves drift detection, not mutation
scope.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| `probe-before-build-invoke-not-infer` | honors | Seam chosen from a source probe that falsified the BRIEF's a-priori premise. |
| `simplicity-first` | honors | No new tool/hook/primitive; one artifact kind on an existing seam. |
| `deep-modules` | honors | Extends the existing deep provenance seam and cliff join rather than adding a parallel path. |
| `errors-are-values` | honors | Agent-def emit is fail-open; deferred review_violation path is a typed bucket, not an error. |
| `validate-at-trust-boundaries` | honors | Reuses the fail-closed content_hash byte-identity re-check unchanged (enabled by whole-file hashing). |
| matcher-load-bearing immutability (AC#6) | honors | Frontmatter `name`/`tools`/`model` lie outside every emitted section span. |

## Consequences

**Positive:**
- Phase-2's headline capability is unlocked with ~4 additive source-file changes and unchanged
  public contracts.
- Cliff-event → agent-def attribution works immediately (the cliff loop already iterates all step
  artifacts; only the `RawArtifact.kind` union widens).
- `evaluate_candidate` guardrail mode (ADR-0025) already sandboxes `agents/`, so a proposed def-body
  rewrite is genuinely exercised.

**Negative / trade-offs:**
- Agent-def provenance coverage is bounded by resolver invocation: a spawn that bypasses
  `resolve_agent_skills` yields no agent-def record (fail-open).
- `content_hash` covering the whole file means a frontmatter-only edit registers as drift
  (`flagged[]`) even though frontmatter is immutable for mutation — intentional (drift ≠ mutation
  scope), but a reader must understand the split.
- Agent-def attribution ships on `cliff_event` AND `review_violation` (see Amendment-1); the
  `review_violation` join is via the code-author agent-def (ADR-0031), not a per-violation step key.

## Amendment-1 (2026-07-01) — Expansion-2: runtime frontmatter-reject guard

At plan approval the user expanded AC#6 from "frontmatter excluded from mutable spans" (a
provenance-layer property) to ALSO include a **mutation-runtime reject**. This ADR's original
decision (frontmatter is immutable; the whole-file hash detects frontmatter drift; sections cover
body only) is now enforced at a second layer:

`evaluate_candidate` gains a pure pre-eval guard `checkFrontmatterImmutable(baselineText, candidateText)`
(sibling to the existing `checkScriptReachable` short-circuit at `evaluate-candidate.ts:243`). When
the target is an agent-def, a candidate whose raw frontmatter block differs from baseline is REJECTED
before any eval subprocess runs — protecting `name`/`tools`/`model` and every matcher-load-bearing
key in one byte comparison. Fail-CLOSED: unparseable frontmatter also rejects
(`frontmatter_unverifiable`); the guard never throws. The result gains one ADDITIVE optional field
`guard_rejection?: { reason; fields? }` with `accepted:false` (backward compatible; the input schema
is unchanged). This makes the immutability decision here enforceable at generation time, not merely a
provenance-layer property. Consequence: the mutator can never land a frontmatter edit even if a
generated candidate attempts one.

## Revisit-If

- A `step_id`-keyed review-violation (or test_failure) event type is added → refine the
  review_violation→agent-def join (currently the code-author join, ADR-0031) with per-step precision,
  and extend agent-def attribution to test_failure.
- A spawn path is introduced that does NOT call `resolve_agent_skills` and must still yield
  agent-def provenance → reconsider a dedicated capture point.
- Section-scoped (rather than whole-file) mutation of agent defs is introduced → the whole-file
  `content_hash` decision must be re-examined against the finer mutation granularity.
