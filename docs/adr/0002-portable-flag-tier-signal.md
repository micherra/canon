---
adr: "0002"
title: "portable: frontmatter flag is the tier signal; physical location is authoritative for shipping"
status: accepted
date: "2026-06-11"
build: "separate-canon-internal-conventions-from-the-universalshipped-principle"
---

# ADR-0002: portable: frontmatter flag is the tier signal; physical location is authoritative for shipping

## Context

Canon's shipped `principles/` library had accumulated ~24 Canon-internal conventions (scoped exclusively to `mcp-server/**`, `hooks/**`, `templates/**`, `agents/*.md`, `principles/**`) that can never match a file in an adopter's project. The project-local overlay `.canon/principles/` and its merge loader (`loadAllPrinciples`, project-local-wins) already existed and worked, but the universal-vs-project-specific routing was an unenforced judgment call with no mechanical guard. We needed a tier signal that (a) marks each principle's portability and (b) lets a mechanical lint catch mis-routing — without changing the loader or the release packaging.

A subtlety forces the decision: physical location in `.canon/principles/` ALREADY determines what adopters receive. The principle loader (`loadAllPrinciples` in `mcp-server/src/shared/matcher.ts:378-379`) reads the SHIPPED `principles/` from the plugin-install directory plus the ADOPTER'S OWN `projectDir/.canon/principles/` — it never reads the plugin-install directory's own `.canon/principles/`. So adopters do not receive relocated Canon-internal files because of the loader's `projectDir`-vs-`pluginDir` path resolution (not because of gitignore — the files are git-tracked in this repo). The question is whether to introduce a `portable` flag at all, and if so, what authority it carries relative to location.

## Options Considered

### Option A: portable flag only (advisory), files stay in shipped tree

**Pros:**
- Zero file moves; lowest churn.
- Single source of truth (the flag).

**Cons:**
- The ~24 files physically remain in the shipped `principles/` tree, so they still ship to adopters unless the release packaging learns to filter on the flag — which would require a new release-workflow mechanism.
- Does not visibly de-bloat the Canon repo's own shipped set.

**Canon-principle alignment:** tensions faithful-install (files still ship); adds release-pipeline complexity (against simplicity-first).

### Option B: physical location only, no flag

**Pros:**
- Relocation into gitignored `.canon/` excludes files from installs automatically; no packaging change.

**Cons:**
- No machine-readable signal a lint can check before a human notices the wrong directory. The mis-routing guard would have to re-derive portability purely from scope paths every run, with no authorial intent recorded.

**Canon-principle alignment:** honors simplicity-first but leaves the recurrence guard weaker.

### Option C (chosen): both — flag is the signal, location is authoritative for shipping

**Pros:**
- Location (gitignored `.canon/`) decides shipping with no packaging change.
- The `portable: false` flag is the explicit authorial signal the `wiki_lint misrouted_principles` check keys on: a `portable:false` file living under shipped `principles/` is a lint failure, forcing the move. The flag makes mis-routing detectable independent of scope-path heuristics.
- Flag + location are coupled, not redundant: the flag carries intent; location carries effect.

**Cons:**
- Every principle file must carry the flag (backfill cost).
- Two facts (flag + location) must stay consistent — but the lint enforces exactly that consistency.

**Canon-principle alignment:** honors fail-closed-by-default (lint blocks on inconsistency), faithful-install (location excludes from installs), simplicity-first (no loader/release change).

## Decision

Chosen: **Option C — both.**

Physical location is authoritative for what ships (via the existing `.canon/**` gitignore). `portable: true|false` is the machine-readable tier signal that DRIVES the `wiki_lint misrouted_principles` check: a file under shipped `principles/` marked `portable: false` (or scoped exclusively to Canon-internal paths) is a lint failure that forces relocation to `.canon/principles/`. The flag records intent; the lint enforces that intent matches location.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| fail-closed-by-default | honors | misrouted_principles reports a blocking finding on flag/location mismatch |
| faithful-install | honors | gitignored `.canon/` location excludes Canon-internal principles from installs |
| simplicity-first | honors | no loader change, no release-workflow change; rides existing overlay+gitignore |
| mechanism-ships-first-instance | tensions | this convention nudged first instances into the shipped tree (a root cause); it is itself relocated to `.canon/` so it applies only to Canon's meta-process going forward |

## Consequences

**Positive:**
- Future mis-routing is caught mechanically every build, not by judgment.
- The shipped set is now auditable by a single grep on `portable: true`.

**Negative / trade-offs:**
- Every new principle must carry the flag (writer + routing-doc updated to enforce).
- Two consistent facts to maintain — mitigated by the lint.

## Revisit-If

- The plugin gains a release-time packaging filter (then location could become advisory and the flag authoritative for shipping).
- The loader is changed to filter on `portable` directly (would let Canon-internal files stay in `principles/` without shipping — re-evaluate location authority then).
