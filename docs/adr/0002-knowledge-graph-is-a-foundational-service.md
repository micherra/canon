---
adr: "0002"
title: "knowledge-graph is a foundational service features may depend on"
status: accepted
date: "2026-06-12"
build: "enforce-ai-navigability-canon-already-preaches-name-the-grey-box-model"
---

# ADR-0002: knowledge-graph is a foundational service features may depend on

## Context

Canon's `mcp-server/src/features/` directory is organized as bounded-context feature modules that "must not import directly from each other — use `@domains/*` types as shared contracts" (stated in `features/README.md` and `features/.claude/CLAUDE.md`). A new blanket dependency-cruiser rule (`no-cross-feature-internal-import`, AC#1 of this build) enforces that invariant.

Enumerating the existing violations surfaced a cluster (**KG-PUBLIC**, 7 of 16 edges) in which three peer features — `file-context`, `pr-review`, and `orchestration` — reach into `features/knowledge-graph/` internals:

- `file-context` → `ensure-graph-fresh.ts`, `git-intel/git-intel-pipeline.ts`, `git-intel/git-intel-types.ts`
- `pr-review` → `git-intel/git-intel-pipeline.ts`
- `orchestration` → `tools/graph-query.ts`

Investigation showed `features/knowledge-graph/` is a thin feature wrapper over the foundational `@graph/` engine (`src/graph/`): every KG target imports from `@graph/kg-pipeline.ts`, `@graph/kg-query.ts`, `@graph/kg-schema.ts`. The KG provides freshness-ensuring, querying, and git-intel — capabilities that file-context (structural metrics + blast radius), pr-review (change impact), and orchestration (confidence scoring) all legitimately consume. This is not accidental coupling between peers; it is multiple consumers depending on a shared *foundational service* — analogous to how all features may depend on `@shared/*` and `@domains/*`.

## Options Considered

### Option A: Recognize knowledge-graph as a sanctioned foundational dependency

Exempt `^src/features/knowledge-graph/` as an allowed import target in the depcruise blanket rule (one `to.pathNot` allowance for the whole feature, not per-edge grandfathers). Document the recognition here.

**Pros:**
- Reflects the true architecture: KG is a foundational read service, not a peer feature.
- One allowance covers all current and future KG consumers — self-extending.
- No churn to working code; no risk of regressions from relocating KG internals.
- Mirrors the existing sanctioned kernels (`@shared`, `@domains`).

**Cons:**
- KG retains a feature-shaped folder while being treated as foundational — a naming/placement mismatch that a future contributor must read this ADR to understand.
- The allowance is folder-wide, so it does not force KG to expose a curated public entry point (any KG internal remains importable).

**Canon-principle alignment:** honors `simplicity-first` (one allowance vs. relocating an engine), `bounded-context-boundaries` (names the real boundary: KG is below the feature layer), `architectural-fitness-functions` (the allowance is encoded in the enforced rule, not just prose).

### Option B: Relocate the KG public surface into a kernel module

Move `ensure-graph-fresh`, the git-intel public functions, and `graph-query` into `@shared/` or a new `src/kernel/knowledge-graph/` and update all importers.

**Pros:**
- Makes KG's foundational status physically explicit; forces a curated public surface.

**Cons:**
- Large, high-risk relocation of a live engine wrapper (the KG targets themselves depend on `@graph/*`, `@platform/*`); ripples into the KG feature's own tools and tests.
- Re-solves a placement question without changing behavior — churn for little gain over Option A.
- Defers the actual integrity fix (the other 4 clusters) behind a risky move.

**Canon-principle alignment:** tensions `simplicity-first` (large move for a naming outcome); honors `information-hiding` slightly more (curated surface) but at disproportionate cost.

## Decision

Chosen: **Option A — Recognize knowledge-graph as a sanctioned foundational dependency.**

`knowledge-graph` is a foundational read service over the `@graph/` engine that peer features legitimately consume (freshness, query, git-intel). The depcruise blanket rule exempts `^src/features/knowledge-graph/` as an allowed target via a single, ADR-backed `to.pathNot` allowance. This is the one deliberately-retained boundary allowance permitted by AC#2 — it is an architectural recognition, not a grandfather of accidental coupling. The other four clusters (ORCH-PRESENT, HISTORY-ARCHIVAL, DIAGNOSTICS-ENRICH, CRAFT-PERSIST) are genuinely decoupled by real code relocation (see ADR-0003).

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| simplicity-first | honors | One folder-wide allowance vs. relocating a live engine wrapper. |
| bounded-context-boundaries | honors | Names the true boundary — KG sits below the feature layer, like @shared/@domains. |
| architectural-fitness-functions | honors | The allowance lives in the enforced depcruise rule, ADR-referenced inline. |
| per-folder-public-interface (new) | tensions | The allowance is folder-wide, not a single curated entry; accepted — see Revisit-If. |
| information-hiding | tensions (mild) | Any KG internal stays importable; the curated-entry refinement is deferred. |

## Consequences

**Positive:**
- The KG-PUBLIC cluster is resolved without risky code movement; the build's risk concentrates on the 4 relocation clusters.
- Future KG consumers need no new allowances — the foundational status is permanent and documented.
- The depcruise gate is green with exactly one documented allowance (this ADR), satisfying AC#2's "every remaining entry maps to a committed ADR."

**Negative / trade-offs:**
- KG keeps a feature-shaped folder while being foundational — a placement mismatch a contributor must read this ADR to understand (the surprising-without-context condition that makes this ADR-worthy).
- The allowance does not force a curated KG public entry; KG internals remain broadly importable.

## Revisit-If

- KG grows a curated public entry module (e.g. `features/knowledge-graph/index.ts` or a kernel relocation) — then narrow the allowance from the folder to that single entry path.
- A future reorg moves the `@graph/` engine and the KG feature wrapper together into an explicit kernel layer — then this allowance becomes a layer rule and this ADR is superseded.
