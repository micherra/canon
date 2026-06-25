---
adr: "0019"
title: "The link graph (inbound [[wiki-link]] edges) is the source of truth for principle orphan detection"
status: accepted
date: "2026-06-21"
build: "markdown-corpus-integrity-swap-gray-matteryaml-option-a-then-add-two"
---

# ADR-0019: Link graph is the source of truth for orphan detection

## Context

`wiki_lint`'s `orphan_principles` check decided whether a principle is referenced via a substring scan: `runOrphanCheck` (`features/diagnostics/tools/wiki-lint.ts`) concatenated all CLAUDE.md + agent text and did `if (allText.includes(p.id)) referencedIds.add(p.id)`. A principle was an orphan iff it appeared in neither the violated set nor this substring-referenced set.

This is wrong in two directions:
- **Over-broad (false negatives — masks real orphans):** any incidental substring match suppresses an orphan finding. A principle id that is a substring of another id, or that happens to appear in prose or a code comment, is never flagged even when nothing actually links to it.
- **Structure-blind:** it cannot distinguish a genuine `[[principle-id]]` cross-link from a coincidental text occurrence.

Meanwhile the corpus already uses `[[wiki-link]]` cross-links across `principles/`, `references/`, `primers/`, and memory — but nothing parsed them, so link integrity was entirely unchecked (broken `[[name]]`, broken relative md links, dangling `ADR-NNNN` references all undetectable).

An empirical probe (PROBE-FINDINGS.md P1/P2) confirmed `[[ ]]` survives `remark-parse` as plain `text` nodes with line positions, and that visiting `text` nodes only excludes `[[ ]]` inside code blocks / inline code by construction.

## Decision

Build a **real reference graph** over the corpus via the existing remark/mdast pipeline (`features/diagnostics/services/link-graph.ts`): extract `[[wiki-link]]`, relative markdown links, and `ADR-NNNN` references; resolve targets against known principle ids, file stems, ADR numbers, and on-disk paths.

- **Orphan detection becomes inbound-link-based:** a principle is referenced iff it is the **inbound target of at least one `[[ ]]` edge** in the graph. A principle is an orphan iff (zero inbound links) AND (zero violations). The `allText.includes(p.id)` substring scan is **removed**.
- The same graph powers three new `link_integrity` findings: `BROKEN_WIKILINK`, `BROKEN_MDLINK`, `DANGLING_ADR_REF`.
- `orphan_principles` keeps its check name and `OrphanPrincipleFinding` output shape (consumers/tests unaffected); only its source of truth changes.

## Rationale

- **Correctness:** "is this principle linked to" is a graph-reachability question. Substring containment is a structurally wrong proxy that produces silent false negatives — the worst failure mode for a hygiene check (it reports CLEAN against a real orphan).
- **Reuse, not new weight:** the remark ecosystem is already a direct dependency used by `kg-adapter-markdown.ts`. A text-node visitor + regex (probe-confirmed) needs no new plugin and no new package.
- **Code-example safety is free:** because extraction visits `text` nodes only, a `[[link]]` written inside a documentation code block is excluded automatically (PROBE P2) — no hand-rolled fence-skipping.

## Consequences

- Orphan findings are now correct: incidental substring occurrences no longer suppress them; only a real inbound `[[ ]]` link marks a principle as referenced.
- Authors who want to "keep" a principle must link it with `[[id]]`, not merely mention its id in prose. This is the intended, stricter contract.
- Link integrity is now enforced corpus-wide: broken `[[name]]`, broken relative md links, and dangling ADR references surface as findings.
- The graph is computed once per `wiki_lint` run and shared between `orphan_principles` and `link_integrity`.
