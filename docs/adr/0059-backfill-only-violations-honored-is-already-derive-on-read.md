---
adr: "0059"
title: "Backfill rewrites only violations; honored citations need no backfill because they are derived on read"
status: accepted
date: "2026-07-15"
build: "fix-the-violations-extraction-parsertemplate-mismatch-f1-and-the"
---

# ADR-0059: Backfill rewrites only violations; honored citations need no backfill because they are derived on read

## Context

Two parsers failed symmetrically — violations and honored citations both encoded a `**{principle-id}**:` format
the corpus never contained — so the natural assumption was that both needed a historical backfill to make 584
builds of evidence usable.

A read-only probe over the real archives falsified the symmetry (`PROBE-FINDINGS.md`, Finding 3). The two sides
sit on **opposite sides of the archive boundary**:

| field | archived state | when the parse happens |
|-------|---------------|------------------------|
| `review_results[].violations` | **0 rows** across 455 review records | at ARCHIVE time (`extractViolationsSection` → `buildRunSummary`) — the empty array is frozen into `run-summary.json` |
| `review_results[].honored` | **1,793 raw strings, all present** | at READ time (`positive-attribution.ts:172`, invoked by `attribute_outcomes` per ADR-0051 derive-on-read) |

`extractHonoredSection` stores the raw bullet text verbatim and never interprets it. `extractViolationsSection`
interprets, and stores only the (empty) interpretation.

This asymmetry is invisible from the symptom — both report zero — and it determines the entire shape of the fix.

## Options Considered

### Option A: Backfill both sides uniformly (rewrite `violations` and `honored` in every `run-summary.json`)

**Pros:**
- One code path; no need to reason about which side is which.
- Superficially matches the PRD's framing of the two bugs as one root cause.

**Cons:**
- **Rewrites 1,793 honored strings for literally zero benefit** — the raw text is already correct and already
  durable; only the read-time regex was wrong.
- Doubles the blast radius of the riskiest operation in the build (mutating the archive corpus).
- Freezes today's parse of the honored strings into the archive, *destroying* the derive-on-read property
  ADR-0051 deliberately established. A future parser improvement could no longer be applied retroactively —
  it would require yet another backfill. This actively recreates the class of bug we are fixing.

**Canon-principle alignment:** tensions `simplicity-first` (work with no effect) and directly contradicts ADR-0051.

### Option B: Normalize the archived REVIEW.md files into one canonical format, then parse strictly

**Pros:**
- A single format going forward; the parser stays simple.

**Cons:**
- Rewrites the primary evidence. REVIEW.md is what a reviewer actually wrote; editing it destroys the audit trail.
- The 131 archives with no REVIEW.md still cannot be recovered, so it does not even achieve uniformity.
- A normalizer must itself parse all six observed table shapes — the tolerant parser is a strict prerequisite,
  so this is *additional* work, not alternative work.

**Canon-principle alignment:** tensions `refactoring-integrity` (mutates evidence to suit the reader).

### Option C: Backfill violations only; fix the honored parser and let derive-on-read do the rest

**Pros:**
- Honored: fixing `HONORED_ID_PATTERN` is **automatically retroactive across all 584 builds** at the next read.
  Zero archive writes. Measured yield 20.4% → 95.0% (1,703 / 1,793) — the charset guard (ADR-0058)
  rejects ~90 prose/non-id tokens a naive bold-span parse (99.9%) would have miscounted.
- Violations: the backfill re-runs the **real** `extractReviewResults` against the archive path — archive dirs
  mirror the workspace layout (`reviews/` beside `run-summary.json`), so the shipped extractor runs unmodified.
  No second parser is written, so no second parser can drift.
- Idempotent by construction: the operation is `violations := f(REVIEW.md)` — a derive-and-overwrite, not an
  append. Running it twice is byte-identical. AC#5 is satisfied structurally, not by bookkeeping.
- Preserves the derive-on-read property for the honored side.

**Cons:**
- Requires understanding and explaining the asymmetry — the design is less superficially uniform.
- The 131 archives lacking REVIEW.md remain permanently unbackfillable.

**Canon-principle alignment:** honors `simplicity-first`, `single-source-of-truth`, `refactoring-integrity`.

## Decision

Chosen: **Option C — backfill violations only.**

The honored side is not broken *in the archive*; it is broken *in the reader*. Fix the reader and 584 builds of
honored citations light up with no writes at all. Only the violations side has lost information at the archive
boundary, and only it gets rewritten.

The 131 archives with no `reviews/REVIEW.md` (of 479 on disk) are left untouched and reported as unbackfillable.
There is no source text to parse; inventing violations for them is precisely the fabrication the build forbids.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| `simplicity-first` | honors | The smallest intervention that reaches the outcome: one side needs a write, the other needs a regex. Doing both uniformly would be more code doing less. |
| `single-source-of-truth` | honors | Backfill invokes the shipped `extractReviewResults`, not a reimplementation. The parser fix and the backfill cannot diverge because they are the same function. |
| `refactoring-integrity` | honors | Archived REVIEW.md files — the primary evidence — are never modified. Only the derived `run-summary.json` interpretation is recomputed. |
| `observable-best-effort` | honors | Per-archive failure is isolated and counted; the backfill reports `backfilled`, `unbackfillable`, and `failed` rather than aborting or silently skipping. |
| `errors-are-values` | honors | Unbackfillable archives are a reported category in the result, not an exception and not a silent zero. |

## Consequences

**Positive:**
- Honored fix is retroactive across all 584 builds at zero write cost, and stays retroactive for future parser
  improvements.
- Backfill is idempotent by construction — re-running is a no-op, so AC#5 needs no version column, no ledger,
  and no dedup logic.
- Backfill blast radius is confined to the `review_results` field of `run-summary.json` in 348 archive dirs.

**Negative / trade-offs:**
- Two different mental models for two symptoms that look identical. A future contributor debugging "why is
  attribution zero?" must know which side of the archive boundary the parse happens on. This ADR exists
  primarily to answer that question.
- 131 archives (27% of those on disk) are permanently dark for violations. Accepted: honest zero over invented data.

## Revisit-If

- `extractHonoredSection` is ever changed to interpret rather than store raw text — that would move honored to
  the archive-time side of the boundary and re-create the need for a backfill. Do not do this.
- A future change makes `attribute_outcomes` read violations from `reviews/REVIEW.md` directly rather than from
  `run-summary.json`, which would make the violations backfill unnecessary too.
- Archive pruning starts removing `reviews/REVIEW.md` while retaining `run-summary.json`, which would grow the
  unbackfillable set and argue for extracting at archive time into a richer, rawer form.
