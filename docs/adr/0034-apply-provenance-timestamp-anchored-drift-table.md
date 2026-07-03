---
adr: "0034"
title: "Apply-provenance is a timestamp-anchored drift.db table, not a commit-anchored record"
status: accepted
date: "2026-07-02"
build: "design-post-apply-live-regression-detection-rollback-for-trace-driven (Inc 1+2)"
---

# ADR-0034: Apply-provenance is a timestamp-anchored drift.db table, not a commit-anchored record

## Context

Canon's trace-driven evolution pipeline has a strong PRE-apply fitness gate (`evaluate_candidate`,
§7 strict-holdout) but nothing that catches an evolution which passes the gate yet degrades LIVE
build quality after it merges. The load-bearing gap: no durable record ties "evolution X" ↔
applying commit/PR ↔ target artifact ↔ before/after content_hash ↔ gen-time holdout scores ↔
apply time. Without such a record created AT apply time, later regression attribution is
structurally impossible.

The natural expectation (and the scoping brief's phrasing) was to anchor the record — and the
later pre/post-apply cohort split — on the applying commit SHA. A live probe of `.canon/drift.db`
falsified that premise:

- `flow_runs.commits` is empty in **all 510 rows**; `total_violations` populated in 4/510,
  `gate_pass_rate` in 1/510. There is no per-run commit linkage to anchor on.
- `reviews.timestamp` (94 rows) and `cliff_events.detected_at` (15 rows) ARE fully populated and
  fine-grained — the authoritative target-scoped signal lives here, not in `flow_runs`.
- The review-learnings apply path writes the mutated artifact to the working tree but does **not
  commit** — so the exact applying commit does not exist at record time.

## Options Considered

### Option A: drift.db `applied_evolutions` table, anchored on `applied_at` timestamp

**Pros:**
- Reuses the established drift migration + lazy-accessor DAO pattern (`cliff_events` v10, `craft_profiles` v9).
- `applied_at` is available at the apply instant and is the same axis the signal tables (`reviews`, `cliff_events`) can be split on.
- Stores before/after content hashes and gen-time holdout scores in typed columns.

**Cons:**
- The exact applying commit is not captured at record time — `applying_commit` is nullable and back-filled later.

**Canon-principle alignment:** honors `simplicity-first`, reuse-existing-machinery, and `no-cross-feature-internal-import` (the table lives in the platform drift layer, importable by the evolution feature).

### Option B: Commit-anchored record (store applying commit SHA; split cohorts by commit order)

**Pros:**
- Matches the intuitive "this commit caused it" mental model.

**Cons:**
- Falsified by the data: `flow_runs.commits` is empty, and no commit exists at record time. Would require the apply path to commit synchronously (a large behavior change) and back-linkage that does not exist.

**Canon-principle alignment:** tensions `measure-before-optimizing`/evidence-first — the anchor would rest on an unpopulated column.

### Option C: Commit-trailer-only store (parse `Canon-Evolution:` trailers from git log)

**Pros:**
- No schema change; git history is durable.

**Cons:**
- Requires a commit at record time (absent); per-read git-log parsing is slow/fragile; before/after hashes and holdout scores have no home.

**Canon-principle alignment:** tensions `simplicity-first`.

## Decision

**Option A.** Apply-provenance is a drift.db `applied_evolutions` table (v12 migration) anchored on
`applied_at` (ISO-8601 timestamp). `apply_base_commit` (git HEAD at apply time) is stored as an
audit anchor; `applying_commit` is nullable and back-filled later from the `Canon-Evolution:`
commit trailer (a secondary durable breadcrumb). The pre/post-apply cohort split in
`get_evolution_outcomes` pivots on `applied_at`, and the target-scoped signal comes from
`reviews`⋈`violations` (per principle) and `cliff_events` (per agent) — never from `flow_runs`.

## Consequences

- New v12 migration `applied_evolutions` + `AppliedEvolutionsDao` + `DriftDb.getAppliedEvolutions()`, following the `cliff_events` pattern.
- `record_applied_evolution` writes the row authoritatively (fail-closed) from the review-learnings apply path; `get_evolution_outcomes` reads it and splits cohorts on `applied_at`.
- Confidence keys on the count of target-scoped events per cohort side (reusing `deriveTier`), not on run count — so `insufficient` is the honest, common near-term verdict given current signal density.
- A future Inc-3 step may back-fill `applying_commit` by joining `Canon-Evolution:` trailers to `proposal_id`.

## Revisit If

- `flow_runs.commits` (or an equivalent per-run commit linkage) becomes reliably populated, enabling a commit-anchored cohort split.
- The apply path changes to commit synchronously at apply time, making `applying_commit` available without back-fill.
