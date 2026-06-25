---
adr: "0020"
title: "Principles cross-link related principles by [[id]] in a ## Related prose section"
status: accepted
date: "2026-06-23"
build: "markdown-corpus-integrity-swap-gray-matteryaml-option-a-then-add-two (R3)"
---

# ADR-0020: Principles cross-link related principles by `[[id]]` in a `## Related` prose section

## Context

ADR-0019 made the inbound `[[wiki-link]]` graph the source of truth for principle orphan
detection, replacing the over-broad `String.includes(id)` substring scan. That was a
correctness fix — but at the moment it shipped, **no principle in the corpus used a real
`[[id]]` cross-link**. Every `[[ ]]` occurrence was bash-test syntax inside code fences,
which the text-node-only extractor correctly ignores. As a result `wiki_lint
orphan_principles` reported **84 findings** and the diagnostics docs had to carry a "Known
Expected Noise" caveat explaining the number away.

An empirical probe (this build, `PROBE-FINDINGS-R3.md`) settled the mechanism: the orphan
source-of-truth is an inbound `[[id]]` link in **prose** (not code), the recognized token is
the frontmatter `id` (confirmed by mutation: injecting two real links dropped the count
84 → 82 and flipped both targets), and the 84 split into **56 tracked** (fixable) + **28
`.canon/principles`** (gitignored, portable:false — unshippable residual). Separately, 28
tracked principles already carried genuine `**Related:**` prose citing other principles by
`` `id` `` in backticks — real relationships rendered inert by the code-exclusion rule.

The question: how should the corpus express principle relationships so the orphan check is a
true signal rather than permanent expected noise?

## Options Considered

### Option A: Leave the 84 as documented expected noise

**Pros:**
- Zero work; the caveat already exists.

**Cons:**
- The orphan check stays useless on Canon's own corpus — it can never catch a *real* future
  orphan because the floor is permanently ~84.
- The 28 genuine `**Related:**` relationships stay machine-invisible.

**Canon-principle alignment:** Violates `observable-best-effort` (the signal is buried) and
`leave-touched-files-better` (inert relationships left inert).

### Option B: Author genuine `[[id]]` links corpus-wide and codify the idiom (CHOSEN)

**Pros:**
- Drives tracked orphans to 0 using **genuine relationships** (convert the 28 existing
  `**Related:**` lines; add `## Related` links for the rest from documented thematic
  clusters), so the metric drop is a *consequence* of real cross-linking, not gaming.
- Makes the orphan check a live signal again (floor becomes the ~28 `.canon` residual, which
  is a true accepted residual, not noise).
- A new convention (`principles-use-id-crosslinks`) keeps future principles non-orphan by
  construction.

**Cons:**
- Touches ~56 files; requires a genuineness bar enforced by review (dc-03) to avoid gaming.

**Canon-principle alignment:** Honors `observable-best-effort`, `leave-touched-files-better`,
`patterns-need-justification` (each link carries a rationale; the convention justifies the
pattern once).

### Option C: Weaken the orphan check to ignore tracked principles

**Pros:**
- One-line code change zeros the count.

**Cons:**
- Discards exactly the signal ADR-0019 was built to provide. A genuinely orphaned (dead,
  never-referenced) tracked principle would never be caught again.

**Canon-principle alignment:** Directly violates the intent of ADR-0019 and
`observable-best-effort`.

## Decision

**Option B.** Principles express their genuine relationships as `[[principle-id]]` wiki-links
in a `## Related` prose section (or an existing `**Related:**` prose line). The link target
is the frontmatter `id` (== file stem). Links MUST sit in real prose, never inside code
fences or inline backticks (the extractor visits text nodes only). A link is only authored
when its target id resolves to a real principle (tracked ∪ `.canon`) — non-resolving prose
ids (e.g. `component-single-responsibility`) stay as backtick prose to avoid introducing a
`BROKEN_WIKILINK`. The idiom is codified as the `principles-use-id-crosslinks` convention.

## Consequences

- Future principles add a `## Related` `[[id]]` section citing ≥1 genuinely related principle;
  the convention (and the orphan check) enforce it.
- `wiki_lint orphan_principles` on the Canon corpus drops from 84 to ~28; the residual is the
  `.canon/principles/` internal set (portable:false, gitignored) — an **accepted, documented
  residual**, not a regression. The diagnostics "Known Expected Noise" note is updated to say
  so.
- Direction matters: a `## Related` link in principle A de-orphans **A's target B**, not A.
  Authors (and the convention) must ensure each principle is itself a *target* of some inbound
  link, not merely a source.
- Genuineness is a review gate (dc-03): each link states a real relationship with a one-clause
  rationale; "link to the next principle" padding is rejected.
