---
adr: "0001"
title: "ADR template lives at docs/adr/TEMPLATE.md and coexists with templates/design-decision.md"
status: accepted
date: "2026-06-09"
build: "close-the-adr-gap-the-architect-currently-writes-rich-design-decision"
---

# ADR-0001: ADR template lives at docs/adr/TEMPLATE.md and coexists with templates/design-decision.md

## Context

Canon has an existing ephemeral decision template at `templates/design-decision.md`. It is used by the architect to record non-trivial in-build decisions to `${WORKSPACE}/decisions/{id}.md` — records consumed by engineers mid-build and not tracked in git history.

This build introduces durable Architecture Decision Records (ADRs) at `docs/adr/`. A rich ADR template is required. The question is whether the two templates should be unified into one, or whether they should coexist as separate artifacts serving different purposes.

The decision is self-applicable: the resolution to this question is itself the first durable ADR (`0001`), proving the pipeline end-to-end.

Relevant constraints:
- `templates/design-decision.md` is referenced by `mcp-server/src/features/knowledge-graph/__tests__/md-relations.test.ts:13`. Moving or deleting it would break that test.
- The two templates have different output paths, different audiences (engineers in-build vs. future contributors in git history), and different gate strengths (weak "at least 2 options" vs. the conjunctive 3-condition gate).

## Options Considered

### Option A: One shared template — delete `design-decision.md`, point architect at `docs/adr/TEMPLATE.md`

**Pros:**
- Single source of truth for decision recording.
- No duplication between two similarly-shaped files.

**Cons:**
- Breaks `md-relations.test.ts` classifier assertion at line 13.
- Couples two distinct concerns: the ephemeral in-build path (engineer consumption, throwaway) and the durable history path (git-tracked, long-lived). Collapsing them forces every ephemeral decision fork into tracked history as noise.
- Defeats the purpose of the conjunctive gate — the ephemeral template intentionally has a weaker gate because ephemeral records are throwaway; applying the strong gate to all decisions would over-restrict the ephemeral path.

**Canon-principle alignment:** Tensions `simplicity-first` by introducing a breaking change to a working path and coupling two distinct concerns.

### Option B: Two templates coexist with a stated relationship

**Pros:**
- Each template matches its output path, audience, and gate strength.
- `design-decision.md` is unchanged except a one-line cross-reference; no test risk.
- `docs/adr/TEMPLATE.md` carries the strong conjunctive gate and rich six-section structure appropriate for durable records.
- The one-line cross-reference in `design-decision.md`'s Rules section prevents the relationship from being orphaned.

**Cons:**
- Two files of similar shape — some duplication.

**Canon-principle alignment:** Honors `simplicity-first` (no breaking change, no test risk, smallest change satisfying the requirement).

## Decision

Chosen: **Option B — Two templates coexist with a stated relationship**

The two templates serve different consumers (in-build engineers vs. future contributors), have different lifetimes (ephemeral vs. git-permanent), and have different gate strengths (weak vs. strong conjunctive). Collapsing them would couple distinct concerns. A one-line cross-reference in `design-decision.md`'s Rules section keeps the relationship discoverable without breaking any existing path.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| simplicity-first | honors | No breaking change, no test risk, no new machinery — smallest change satisfying the requirement |
| agent-design-before-code | honors | This ADR is itself the design-before-code record for the ADR mechanism being shipped |

## Consequences

**Positive:**
- `templates/design-decision.md` keeps its location; `md-relations.test.ts` stays green.
- The ephemeral path (architect → `.canon/decisions/`) is unchanged for engineers.
- The durable path (architect → `docs/adr/NNNN-slug.md`) is new and additive.
- A one-line cross-reference in `design-decision.md` keeps the relationship visible.

**Negative / trade-offs:**
- Two files of similar shape exist. If they drift apart over time, the duplication may cause inconsistency — addressed by the Revisit-If condition below.

## Revisit-If

- The two templates drift apart in shape and the duplication causes visible inconsistency between ephemeral and durable decision records.
- A future build moves all decision recording to a single durable path (retiring the ephemeral tier), at which point the two templates could be unified.
