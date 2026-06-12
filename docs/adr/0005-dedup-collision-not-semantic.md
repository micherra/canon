---
adr: "0005"
title: "Duplicate-concept prevention uses title/ID/scope collision detection, not semantic_search"
status: accepted
date: "2026-06-11"
build: "separate-canon-internal-conventions-from-the-universalshipped-principle"
---

# ADR-0005: Duplicate-concept prevention uses title/ID/scope collision detection, not semantic_search

## Context

Two principles (`fail-open-audit-event-emission` and `audit-event-from-detection-tool`) were authored as separate IDs with identical titles — the same convention minted twice, once leaking into the portable set. We need a mechanism that surfaces near-duplicates before the writer creates a new principle, so the author edits/forks an existing one rather than minting a parallel ID. The PRD explicitly asks us to investigate whether to back this with `semantic_search` over principle bodies, or with title/ID/scope collision detection, and whether to gate behaviorally (writer), mechanically (lint/MCP), or both.

## Options Considered

### Option A: semantic_search over principle bodies

**Pros:**
- Catches conceptually-similar principles with different wording.

**Cons:**
- Canon's `semantic_search` is KG-backed and indexes CODE entities, not principle prose (PROBE-FINDINGS P5). It is not a reliable surface for principle-text similarity without building a new embedding index.
- Adds cold-start / index-freshness fragility to a write-time gate that must be deterministic and fast.
- Non-deterministic ranking makes the gate hard to test and to reason about ("why didn't it catch this one?").

**Canon-principle alignment:** tensions simplicity-first (new index surface) and determinism in testing.

### Option B (chosen): title/ID/scope collision detection, both behavioral + mechanical

**Pros:**
- Deterministic, fast, testable. Catches the exact known failure (`audit-event-*` — identical titles).
- Behavioral layer (writer pre-write `list_principles` collision check) surfaces the duplicate at authoring time so the author forks/edits.
- Mechanical backstop (`wiki_lint duplicate_titles`) catches anything the writer skips — defense in depth, fail-closed at review.
- Reuses the existing `list_principles` tool already in the writer's allowlist — no new MCP write tool (read-only-tool-reuse-over-reimplementation).

**Cons:**
- Misses conceptual duplicates that use entirely different titles. Accepted: the dominant failure mode is the same-concept-same-title mint, and a future semantic layer can be added if title collision proves insufficient.

**Canon-principle alignment:** honors simplicity-first, read-only-tool-reuse, fail-closed-by-default, one-behavior-per-test (deterministic checks).

## Decision

Chosen: **Option B — title/ID/scope collision detection, gated both behaviorally (writer) and mechanically (wiki_lint).** Normalized-title + ID + scope comparison against the existing merged principle set. Not `semantic_search`.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| read-only-tool-reuse-over-reimplementation | honors | writer reuses `list_principles`; no new MCP tool |
| simplicity-first | honors | deterministic string comparison, no embedding index |
| fail-closed-by-default | honors | `duplicate_titles` is a blocking lint finding |
| one-behavior-per-test | honors | deterministic checks are unit-testable against seeded pairs |

## Consequences

**Positive:**
- The `audit-event-*` class of duplicate is caught at authoring time and at review.
- The mechanism is testable with a seeded duplicate-title fixture.

**Negative / trade-offs:**
- Differently-titled conceptual duplicates are not caught. Mitigated by the writer's interview step (human reads the existing set) and revisit trigger below.

## Revisit-If

- Duplicate principles appear that share concept but NOT title — then add a semantic similarity layer (built on a dedicated principle-prose index, not the code KG).
