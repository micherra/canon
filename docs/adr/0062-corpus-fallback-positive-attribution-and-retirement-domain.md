---
adr: "0062"
title: "Corpus-fallback positive attribution and the retirement nomination domain"
status: accepted
date: "2026-07-16"
build: "fix-adr-0052-retirement-pipeline-bug-1-as-a-bundled-change-a-widen"
---

# ADR-0062: Corpus-fallback positive attribution and the retirement nomination domain

## Context

ADR-0052's retirement path (`select_mutation_targets` scores-mode) was 100% inert across 599
builds. A live-corpus probe (workspace PROBE-FINDINGS, 2026-07-16) established three facts:

1. **The honored↔provenance join predicate has zero defects.** Of 2,549 `no_in_context_artifact`
   failures, 0 had the cited id present in the archive's provenance. The loss is provenance
   COVERAGE: 479/593 archives predate provenance recording (2026-06-24), and — decisively — even
   new archives record only `resolve_agent_skills` PRELOADS (rules/refs/primers/templates/
   agent-defs), while 72% of honored citations name PRINCIPLES surfaced via `get_principles`/
   `get_context`, which are never provenance-recorded. Positive attribution was capped at 37
   against 187 negatives — the two-sided net_score (ADR-0051) was structurally one-sided.
2. **The artifact resolver's domain excluded every id class that actually accumulates scores**:
   23 of 50 scored ids are top-level `rules/*.md`, 14 are refs/primers/templates, ~9 have no
   artifact file at all; only 4 were in `loadAllPrinciples` scope.
3. **The never-pruneable guard is not made redundant by fixing the join**: under the fix's
   conservative fallback weighting, `agent-artifact-write-before-return` (a frequently-violated,
   load-bearing pipeline-integrity rule) still lands ≈ −3.2 — retire-nominable. Its safety
   previously rested entirely on the resolver scope gap.

Constraints: ADR-0056 (parse ≠ resolve — parsers untouched), ADR-0051/0057 (derive-on-read — no
backfill), ADR-0027 (untrusted overlay never a mutation target).

## Options Considered

### Option A: Read-time corpus-fallback join + nomination-domain widening to principles ∪ rules (CHOSEN)

When a parsed honored id matches no in-context provenance artifact, resolve it against the
CURRENT on-disk artifact corpus (principles ∪ rules ∪ refs ∪ primers ∪ templates via one shared
`buildCorpusArtifactLookup`) and attribute with an explicitly weaker evidence tier:
`join_basis: "corpus_fallback"`, `presence_in_context: false`, `hash_status: "unrecorded"`,
`owning_steps: []` (which yields the existing weight floor — role-tier 0.7, corroboration 1 — by
construction, no new constant). Retirement NOMINATION domain = principles ∪ top-level rules only;
refs/primers/templates skip with `non_retirable_artifact_class`; the 7-id never-pruneable
allowlist is enforced mechanically inside nomination (`never_pruneable`, checked before
resolution), parity-tested against the prose list in `review-learnings.md`.

**Pros:**
- Retroactive across all 593 archives by construction — zero backfill, zero archive writes.
- Recovers ~78% of failed positive attributions (probe SIM: 37 → 1,998); net_score becomes
  genuinely two-sided (post-fix distribution: min −5.44, median +1.09, max +113.8).
- Honest epistemics: the two join edges are typed (`join_basis`); presence-in-context is never
  fabricated; fallback weight sits at the existing floor.
- One resolver serves both consumers (nomination + fallback join), keeping the bundle coherent.

**Cons:**
- The positive path no longer proves presence for fallback attributions — a reviewer citation is
  the evidence, and the artifact body is verified only to exist NOW (no recorded hash).
- Scores attribute honored credit to the current body of an artifact that may have changed since
  the build (attenuated by decay, flagged direction unavailable without a recorded hash).

**Canon-principle alignment:** honors derive-on-read (ADR-0051/0057), errors-are-values (typed
buckets), ADR-0056 boundary (parsers untouched); tension with validate-at-trust-boundaries
accepted and typed (`hash_status: "unrecorded"` is an explicit, queryable evidence tier).

### Option B: Record principle disclosures in provenance (hot-path fix)

Extend provenance recording so `get_principles`/`get_context` disclosures are captured per spawn,
making the existing strict join eventually cover principle citations.

**Pros:** preserves presence-proof epistemics; hash-verifiable.

**Cons:** forward-only — recovers 0 of 593 existing archives and the 479 no-provenance archives
NEVER become joinable; touches the spawn hot path (provenance is currently emitted only by
`resolve_agent_skills`); get_context results reach agents via orchestrator prompt-pasting, so
capture would require orchestrator-behavior changes, not just a tool change. Does not unblock the
retirement pipeline this quarter. (Remains compatible as a FUTURE addition: provenance-joined
attributions automatically outweigh fallback ones.)

**Canon-principle alignment:** honors validate-at-trust-boundaries fully; fails the build's
purpose (pipeline stays inert on the existing corpus).

### Option C: Backfill archives with synthesized provenance

**Pros:** would make the strict join fire retroactively.

**Cons:** fabricates presence claims that were never recorded — indistinguishable from real
provenance afterward; violates ADR-0051/0057's derive-on-read posture and the invalidate-don't-
delete audit trail; rejected outright.

**Canon-principle alignment:** violates validate-at-trust-boundaries (fabricated evidence) and
the ADR-0051 no-backfill posture.

### Option D: Widen nomination domain to every resolvable artifact class (incl. refs/primers/templates)

**Pros:** every scored id with a file becomes nominable; simplest domain rule.

**Cons:** refs/primers/templates have a STRUCTURALLY one-sided signal — violations join to them
via provenance, but reviewers essentially never honored-cite them (probe: `status-protocol`
pos = 0.00 even post-fallback), so their net_score can only fall. Nominating retirement on a
signal that cannot go positive is the false-retirement trap generalized. Their retire-apply
semantics are also undefined (`archived: true` is honored by no loader for these classes).

**Canon-principle alignment:** tensions fail-closed-by-default (nominates on unfalsifiable
negative evidence).

## Decision

Option A. Additionally: the retirement threshold stays ABSOLUTE −3
(`RETIREMENT_REINFORCEMENT_NET_SCORE_THRESHOLD`) — the post-join distribution is extremely
right-skewed (max +113.8 vs min −5.44), making z-scores an artifact of positive-tail mass, and
percentile cuts (p10 = −2.11) both weaken the evidence bar and move as the corpus grows
(non-reproducible nominations). Absolute −3 mirrors the learner's `weighted_instance_count >= 3`
minimum-evidence convention and nominated a sane 3-rule set on the live corpus.

## Consequences

- Positive attribution rises ~54× on the existing corpus with no archive writes; retire/reinforce
  nomination emits real targets for the first time.
- `PositiveAttribution` carries `join_basis`; downstream consumers can weight or filter fallback
  attributions without re-deriving evidence class. A future Option-B provenance-recording build
  strictly improves fallback attributions into provenance-joined ones with no schema change.
- Ids with no on-disk artifact (`advisory-*` reviewer-coined ids, retired principle ids) remain a
  documented non-resolvable class (`artifact_unresolved`) — the honest residual (~588 citations),
  alongside 168 unparseable honored lines (#511 residue, out of scope).
- Follow-up (explicitly NOT this build): `resolve_agent_skills` does not honor `archived: true`
  on `rules/*.md`, so a ratified rule retirement is loader-inert until that gap is closed; Arm R
  HITL + the strict holdout gate stand between nomination and apply in the interim.
- The never-pruneable allowlist now exists in code (`NEVER_PRUNEABLE_PRINCIPLE_IDS`) with a
  prose↔code parity test — editing the review-learnings.md list without the const (or vice versa)
  fails CI.
