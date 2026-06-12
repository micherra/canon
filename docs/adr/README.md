# Architecture Decision Records (ADRs)

## Purpose

This directory contains tracked, durable Architecture Decision Records — the "why we shipped X this way" that survives in git history. Unlike the ephemeral `.canon/decisions/` records (consumed in-build by engineers and discarded after the build completes), ADRs are permanent documents that explain consequential architectural choices to future contributors who were not present when the decision was made.

ADRs are **additive only** — once accepted, they are not deleted or overwritten. A superseding decision creates a new ADR that references the old one.

## Numbering Scheme

Files are named `NNNN-slug.md`, where `NNNN` is a 4-digit zero-padded sequential number (`0001`, `0002`, …).

**To assign the next number**: scan `docs/adr/` for the highest existing `NNNN` and add 1. Zero-pad to 4 digits.

**Concurrency note**: Concurrent builds on separate branches may independently pick the same number. This surfaces as a benign additive-file conflict at PR merge (two new files with the same number prefix). Resolve it by renaming the later ADR to the next available number. No distributed counter is used — the collision window is small and the rename is trivial.

## The Conjunctive 3-Condition Gate

An ADR is written **only when ALL THREE conditions hold**:

1. **(a) Hard-to-reverse** — undoing the decision would require significant rework or breaking changes.
2. **(b) Surprising-without-context** — a future contributor reading the code or config would not naturally understand why this approach was chosen.
3. **(c) Genuine trade-off** — at least two options were considered and the chosen option has real costs, not just an obvious winner.

**All three, or no ADR.** Fail any one condition → no ADR. Do not write an ADR for routine choices, obvious decisions, or easily-reversed experiments.

### Scope

The gate applies **only to architect design-conversation decisions** — decisions recorded by the architect during the design phase of a Canon build. It does NOT apply to:

- Scribe updates (doc sync, CLAUDE.md edits)
- Engineer fix decisions (targeted bug fixes, lint corrections)
- Non-qualifying decisions that fail any of the three conditions above

Non-qualifying decisions may still get an ephemeral `.canon/decisions/` record if the architect judges that engineers need the context in-build, but they do not get a durable ADR.

## Lazy Creation

`docs/adr/` is populated only when a build produces a qualifying ADR. Builds with no qualifying decisions add nothing here. Do not create placeholder or stub ADR files.

## Template

Use `docs/adr/TEMPLATE.md` as the starting point for every new ADR. Copy it, fill in each section, and save as `docs/adr/NNNN-slug.md`.

## Index

| # | Title | Status | Date | Build |
|---|-------|--------|------|-------|
| [0001](0001-adr-template-placement.md) | ADR template lives at docs/adr/TEMPLATE.md and coexists with templates/design-decision.md | accepted | 2026-06-09 | close-the-adr-gap-the-architect-currently-writes-rich-design-decision |
| [0003](0003-worktree-node-modules-symlink-containment.md) | Worktree node_modules via gitignored symlink with containment gate (not npm-install, not NODE_PATH) | accepted | 2026-06-11 | worktree-dev-environment-fixes-symlink-mcp-servernodemodules-into |
