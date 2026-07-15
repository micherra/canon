---
adr: "0051"
title: "Trust-weighted attribution derives on-read (no scores table); honored[] parsed at read-time"
status: accepted
date: "2026-07-11"
build: "design-and-scope-gap-3-a-trust-weighted-attribution-consumer-over-the"
---

# ADR-0051: Trust-weighted attribution derives on-read (no scores table); honored[] parsed at read-time

## Context

Gap 3 (the trust-weighted attribution consumer, PR #492 unified-memory explore) must produce a
signed, trust-weighted per-principle score over the decisions/RunSummary corpus, offline and
deterministically. Two storage/shape questions are hard-to-reverse:

1. **Where do scores live?** A new `drift.db` table for attributed scores, or derive-on-read from
   the already-durable corpus (`RunSummary.review_results[]` + `context_provenance[]` +
   `buildDecisionsCorpus`)?
2. **How is the positive signal (`honored[]`) made joinable?** `run-summary-extractors.ts`
   `extractHonoredSection` records honored entries as RAW markdown (`**{id}**: desc`), unlike
   `extractViolationsSection` which parses the bare `principle_id`. Do we FIX the archive
   extractor, or parse the `**{id}**:` prefix at read-time in the new consumer?

Both interact with the ADR-0044 supervised-path deny-list: a new table adds the
`drift-store-schema` category on top of the `mcp-tool-contract` category the new `register-*.ts`
already triggers.

## Options Considered

### Option A: New drift.db scores table + fix `extractHonoredSection` in the archive path

**Pros:**
- Scores queryable/cacheable via SQL; honored ids stored clean going forward.

**Cons:**
- Adds the `drift-store-schema` sensitive-path category → deeper supervised floor + a schema
  migration to maintain.
- Fixing `extractHonoredSection` changes archived-schema semantics: already-archived `honored[]`
  strings remain raw, so old and new archives would parse differently — a determinism hazard for
  a tool whose entire contract is "same corpus → identical scores".
- Persisted scores can drift from the corpus they summarize (a second source of truth).

**Canon-principle alignment:** tensions `command-query-separation` (introduces a stored
derived-state cache) and the determinism constraint.

### Option B: Derive-on-read; parse honored[] at read-time in the consumer

**Pros:**
- Zero schema change → supervised floor stays single-category (`mcp-tool-contract`).
- Scores are a pure function of the corpus — no drift, trivially deterministic.
- The read-time `**{id}**:` parser (mirroring `extractViolationsSection`'s regex) handles BOTH
  old and new archives identically; unparseable lines become a typed `unattributed` bucket.

**Cons:**
- Recompute per call (no cache) — acceptable: the corpus is bounded and the join is linear.
- Honored parsing lives in the consumer, slightly duplicating the violations-parse idiom.

**Canon-principle alignment:** honors `command-query-separation` (pure query, no stored derived
state), `deep-modules`, and the offline+deterministic constraint.

## Decision

Chosen: **Option B — derive-on-read, parse honored[] at read-time.**

Scores are a pure on-read aggregate over the already-durable corpus; no new `drift.db` table. The
positive-signal join parses the `**{id}**:` prefix inside the new `positive-attribution.ts`
consumer, leaving `extractHonoredSection` (and all archived data) untouched so old and new
archives score identically.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| command-query-separation | honors | scores are a pure query; nothing is stored/mutated |
| no-llm-calls-in-mcp-tools | honors | pure regex + equality join + arithmetic |
| deep-modules | honors | one small consumer interface over the corpus join |
| fail-closed-by-default | tensions (acceptable) | the SCORING tool is fail-open (advisory analytics degrade to partial); safety is preserved at the fail-closed `evaluate_candidate` + HITL gates |

## Consequences

- The ADR-0044 supervised floor for this build stays at exactly one deny-list category
  (`mcp-tool-contract`), not two.
- No migration to maintain; no cache-invalidation surface.
- If profiling ever shows the on-read aggregate is too slow at corpus scale, a derived cache can
  be added later WITHOUT changing the tool contract (the scores remain a pure function of the
  corpus) — reversible in the cheap direction.
- The honored read-time parser is the single place honored-format assumptions live; a future
  change to the review template's Honored line format updates one regex.
