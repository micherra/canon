---
adr: "0056"
title: "Citation parsing validates a closed charset but never resolves against on-disk principles"
status: accepted
date: "2026-07-15"
build: "fix-the-violations-extraction-parsertemplate-mismatch-f1-and-the"
---

# ADR-0056: Citation parsing validates a closed charset but never resolves against on-disk principles

## Context

Canon's evolution loop joins principle citations mined out of REVIEW.md files (violations and honored
principles) against context-provenance records. Both parsers required a `**{principle-id}**:` literal that
real reviews never produced, so the loop scored zero across 584 builds.

Fixing them means relaxing the match. Relaxing the match immediately raises the question this ADR settles:
**how do we know an extracted token is a principle id and not prose?**

A read-only probe over the real archived corpus (`PROBE-FINDINGS.md`, Findings 6) measured the hazard. Naively
dropping the required colon extracts *any* bold span, yielding 343 distinct tokens of which **79 are prose**:

- `"DOCUMENTED FAIL-OPEN on the new git-log call"`
- `"Robust git-failure degradation"`
- `"errors-are-values / define-errors-out-of-existence"`

Recording those as `principle_id` is fabrication — the exact failure the build's constraints forbid ("a
backfill that invents attribution data is worse than the current honest zero").

The obvious-looking fix is to validate each extracted id against the principles that exist on disk. The probe
falsified that instinct.

## Options Considered

### Option A: Charset guard only — reject tokens that don't look like ids (`^[a-z0-9][a-z0-9-]{2,}$`)

**Pros:**
- Rejects 100% of the measured prose tokens (79/79).
- Retains 1,703 / 1,793 honored citations (95.0%) — the charset guard rejects ~90 prose/non-id bold
  spans on top of the 2 truly-unparseable lines. The naive pre-guard bold-span count was 1,791 /
  1,793 (99.9%), but that figure counts the very prose tokens the guard correctly rejects (see the
  "rejects 79/79 prose tokens" bullet above), so 99.9% cannot be the post-guard honored yield — 95.0%
  is the real, post-guard figure.
- Preserves real historical citations to principles that have since been retired or renamed.
- Parsing stays a pure, offline, corpus-independent function — no I/O, no dependency on the current principle set.

**Cons:**
- A charset-valid token that was never a real principle id (a typo'd citation) is recorded as an id.
- The parser cannot, alone, tell a live id from a dead one.

**Canon-principle alignment:** honors `validate-at-trust-boundaries` (closed-domain validation at the point of
ingest), `simplicity-first`, `functions-do-one-thing` (parse ≠ resolve).

### Option B: Charset guard + resolve against principles on disk; drop unresolvable ids

**Pros:**
- Every recorded id provably names a principle that exists today.
- Feels stricter, and "stricter" reads as safer.

**Cons:**
- **Measured: drops 340 citations across 176 distinct ids — retaining only 1,363 / 1,793 (76.0%) vs the charset-guard's 95.0%.**
- The dropped ids are *real* historical citations to retired/renamed principles: `explicit-contracts` (×18),
  `single-source-of-truth` (×13), `thin-handlers` (×8), `no-dead-abstractions` (×8). Deleting them is its own
  species of dishonesty — it rewrites what reviewers actually said.
- Makes parsing depend on mutable global state (the current principle set on disk). The same archived REVIEW.md
  would parse differently before and after an unrelated principle rename — a non-deterministic parser.
- Duplicates resolution that `select_mutation_targets` already performs downstream, honestly, via
  `loadAllPrinciples` → `skipped[reason: "artifact_unresolved"]`.

**Canon-principle alignment:** tensions `functions-do-one-thing` (conflates parsing with resolution) and
`single-source-of-truth` (a second resolver alongside `mutation-selection.ts`).

## Decision

Chosen: **Option A — charset guard only.**

Validate the closed domain at the citation boundary; do not resolve. Parsing answers "did the reviewer write a
principle id here?" Resolution answers "does that principle still exist?" They are different questions, asked at
different layers, and the second one already has an owner.

The 2 residual unparseable honored lines (0.1%) and 7 residual violation cells (7.4%) are recorded as
unparsed — never coerced, never guessed.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| `validate-at-trust-boundaries` | honors | REVIEW.md is agent-authored free text — an untrusted input. The charset guard is a closed-domain validator applied exactly at ingest, mirroring `overlay-closed-domain.ts`'s `filterTagArray`. |
| `functions-do-one-thing` | honors | The parser parses. `select_mutation_targets` resolves. Neither does the other's job. |
| `single-source-of-truth` | honors | Principle-id → artifact resolution keeps exactly one implementation (`mutation-selection.ts`), rather than a second, subtly-different copy inside the parser. |
| `tests-are-deterministic` | honors | Parsing an archived REVIEW.md yields the same result regardless of which principles happen to exist on disk that day. |
| `fail-closed-by-default` | tensions (accepted) | The guard is a charset allowlist, not a membership allowlist — a strictly weaker gate. Accepted because the *stricter* gate destroys 24% of real signal, and the downstream resolver is the true fail-closed boundary for anything actually acted upon. |

## Consequences

**Positive:**
- Honored-citation yield 20.4% → 95.0% (1,703 / 1,793), measured over the real corpus — the charset
  guard rejects ~90 prose/non-id tokens that a naive bold-span parse (99.9%) would have miscounted as
  citations.
- Historical citations to retired principles survive as evidence, and can be studied (e.g. "which retired
  principles were most cited before removal?").
- Parsing is pure and deterministic — no filesystem reads, trivially unit-testable.

**Negative / trade-offs:**
- `attribute_outcomes` will surface scored ids that no longer resolve to an artifact. This is intended and
  honest, but a reader who assumes every scored id is live will be surprised.
- A typo'd citation (`simplicty-first`) is recorded as a distinct id and scores separately. The charset guard
  cannot catch this; only downstream resolution can, and it does — as `artifact_unresolved`.

## Revisit-If

- `select_mutation_targets`' downstream resolution is removed or weakened such that unresolvable ids can reach
  an apply path — the resolution boundary would then need to move up into the parser.
- Measured typo'd-id noise exceeds ~5% of scored citations, making charset-only validation a real precision problem.
- A principle-id registry with historical aliases (retired ids → successors) ships, making membership validation
  non-destructive; at that point Option B becomes viable without erasing history.
