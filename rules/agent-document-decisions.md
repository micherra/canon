---
id: agent-document-decisions
title: Two-Tier Decision Record System
severity: rule
scope:
  layers: []
tags:
  - agent-behavior
  - architect
---

When the architect records a design decision, it uses a two-tier model:

1. **Ephemeral record** (`${WORKSPACE}/decisions/{id}.md`) — always written for every non-trivial decision. Used by engineers in-build via the plan's `decisions:` frontmatter link. Discarded after the build completes.

2. **Durable ADR** (`docs/adr/NNNN-slug.md`) — written ONLY when ALL THREE conditions hold (conjunctive gate):
   - **(a) Hard-to-reverse** — undoing the decision requires significant rework or breaking changes.
   - **(b) Surprising-without-context** — a future contributor would not naturally understand why this approach was chosen.
   - **(c) Genuine trade-off** — at least two options were considered and the chosen option has real costs.

   **All three, or no ADR.** Failing any one condition → ephemeral record only, no ADR.

## Rationale

Workspace decisions are ephemeral by design — they are scoped to a single build and consumed by engineers mid-build. But decisions that are hard-to-reverse, non-obvious, and genuinely costly need a permanent home that future contributors can find.

The three-condition gate is conjunctive to keep the ADR record signal-rich. An ADR for every decision would dilute the record with noise; an ADR only for "important" decisions (without specific criteria) leads to inconsistent promotion. The three conditions together identify decisions where future contributors need the "why" the most.

The architect — not the scribe — is the right author for durable ADRs. The architect holds the full design context (research findings, alternatives considered, tradeoff reasoning) at decision time. The scribe runs post-build with only the diff and summaries; it cannot reliably reconstruct the "why" that makes an ADR valuable.

## Examples

**Bad — architect skips the durable record for a hard-to-reverse decision:**

The architect decides to use a single shared SQLite database for all workspace state instead of per-workspace files. This is hard-to-reverse (all downstream tools depend on the schema), surprising (most projects use per-entity files), and genuinely costly (concurrency complexity). The architect writes only an ephemeral `${WORKSPACE}/decisions/db-choice.md`.

Result: a future engineer refactoring the storage layer doesn't understand why SQLite was chosen, makes a wrong assumption about per-entity files, and creates a breaking change.

**Good — architect evaluates the three conditions and writes both records:**

Same decision. The architect evaluates: hard-to-reverse? Yes. Surprising-without-context? Yes. Genuine trade-off? Yes (file-per-entity was the alternative, with lower concurrency risk but higher query complexity). All three → architect writes BOTH the ephemeral `${WORKSPACE}/decisions/db-choice.md` AND `docs/adr/0007-shared-sqlite-workspace-state.md`.

**Bad — architect writes an ADR for a routine choice:**

The architect chooses to name a helper function `computeScore` instead of `calculateScore`. It writes this as an ADR.

Result: the ADR record is polluted with trivial decisions; contributors stop trusting the ADR record as a signal of consequential choices.

**Good — architect skips the ADR for a routine choice:**

Same naming decision. Hard-to-reverse? No (trivial rename). The architect records it in the ephemeral `${WORKSPACE}/decisions/` record only (if at all), and moves on.

## Negative Scope

This rule applies only to the architect. The scribe does NOT promote workspace decisions to durable ADRs — the scribe lacks the design context to evaluate the three conditions reliably, and the architect already writes qualifying ADRs during the design phase.

Non-qualifying decisions (those failing any of the three conditions) stay ephemeral-only in `${WORKSPACE}/decisions/`. They are consumed by engineers during the build and are not promoted anywhere.

## Exceptions

If `worktree_path` is absent from the architect's spawn context, skip the durable ADR write and note it in the design document's `ASSUMPTIONS:` block. Do NOT fall back to a relative path.

If no decision in the current build passes the three-condition gate, no ADR is written. `docs/adr/` is populated lazily — only when qualifying decisions exist.
