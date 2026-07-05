---
adr: "0040"
title: "Durable orchestrator-decisions corpus via reap-time persistence into a dedicated drift.db table"
status: accepted
date: "2026-07-05"
build: "explore-cross-workspace-decisions-ledger-readeraggregator-make-the"
---

# ADR-0040: Durable orchestrator-decisions corpus via reap-time persistence

## Context

Canon's `log_decision` ledger writes each `orchestrator_decision` event to a per-workspace `orchestration.db`. Probing the live repo found this is a real, richly-filled human-preference dataset (40 decisions across 10 live workspaces; rationale 100%, outcome 92%, gate 70% populated) — but it is being silently destroyed. `orchestration.db` is in the archive `SKIP_PATTERNS` (never archived), and the janitor's `archiveAndRemoveSlug` deletes the workspace (`rmSync`) ~24h post-ship. 426 archived builds have already lost their decisions, and erosion continues on every reap. There is no cross-workspace read path.

We are adding both an offline reader (`get_decisions_corpus`) and a durability mechanism so the corpus stops eroding. This ADR records where decisions are persisted durably and into what store. Constraint: stay offline + deterministic (`docs/supervised-build-quality.md:216`), and do not touch the authoritative fail-closed `log_decision` write.

## Options Considered

### Option A: Dual-write at `log_decision` into the existing dead `decisions` table

**Pros:**
- Immediate durability; complete.

**Cons:**
- Touches the AUTHORITATIVE fail-closed hot write path.
- A workspace's decisions sit in the durable store WHILE still live on disk → the reader must dedup live-vs-durable.
- The dead `decisions` table's schema (`title`/`content`, built for the removed architect docs) has no `gate`/`outcome`/`rationale`/`refs` columns → loses the by-gate/by-outcome queryability the corpus exists for.

**Canon-principle alignment:** tensions "leave fail-closed authoritative writes untouched" and deep-modules.

### Option B: Mirror at `finalize_workspace`

**Pros:**
- Off the hot path; batch.

**Cons:**
- Misses decisions logged after finalize (merge_resolution during ship, post-ship auto-triage) — permanently lost once reaped.

**Canon-principle alignment:** tensions no-silent-failures (silent incompleteness).

### Option C: Persist at janitor reap-time, immediately before `rmSync`, into a NEW dedicated `orchestrator_decisions` table

**Pros:**
- The janitor `rmSync` is the sole destruction boundary → captures everything ever logged, including post-ship decisions.
- Does not touch the fail-closed hot path.
- A workspace is EITHER live-on-disk OR reaped-and-persisted, never both → the reader unions the two partitions with no dedup.
- A purpose-built table mirrors the ledger payload (incl. a `gate` column) → aggregation is a direct query; `UNIQUE(source_slug, source_event_id)` makes persist idempotent.

**Cons:**
- Requires persist-then-delete ordering and a fail-open persist (janitor is best-effort).
- One migration + one DAO; leaves the dead `decisions` table in place (noted as a learner signal).

**Canon-principle alignment:** honors deep-modules, no-silent-failures (fail-open + visible), define-errors-out-of-existence.

## Decision

Chosen: **Option C — reap-time persistence into a new `orchestrator_decisions` drift.db table.**

Persisting exactly at the live→reaped transition is complete (captures post-ship decisions), keeps the authoritative `log_decision` write untouched, and gives the reader a dedup-free `live ∪ durable` union. A dedicated table preserves by-gate/by-outcome queryability; `INSERT OR IGNORE` on `UNIQUE(source_slug, source_event_id)` handles the persist-then-rmSync crash window idempotently. Reads use a raw readonly sqlite open (`readDecisionEvents`) so no migration mutates a soon-to-die or foreign store and schema skew degrades to an empty result.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| no-silent-failures | honors | persist + reader are fail-open with visible `skipped[]`/warns; never block a reap |
| deep-modules | honors | `readDecisionEvents(dbPath)` + `tryPersistDecisionsBeforeReap(...)` are thin interfaces |
| define-errors-out-of-existence | honors | missing table / absent row → `[]`, not an error |
| command-query-separation | honors | reader is a pure query; persistence is a separate command path |
| fail-closed-by-default | tensions (acceptable) | the persist mirror is deliberately fail-open — it is best-effort housekeeping, not a safety gate; the authoritative fail-closed `log_decision` is untouched |

## Consequences

**Positive:**
- The decisions corpus stops eroding; post-ship decisions are captured.
- Clean two-partition read model with no dedup logic.
- Rich fields stay queryable for later offline consumers.

**Negative / trade-offs:**
- The dead `decisions` table + `get_history`'s read of it remain a dead-wire (relocated for line-count remediation, not deleted) — filed as a learner signal, not resolved here.
- Persistence is bounded to the reap path: a workspace that is never reaped is durable only via the live reader (acceptable — durability matters only at destruction).

## Revisit-If

- `finalize_workspace` gains destructive teardown (the destruction boundary moves — the persist call must move with `rmSync`).
- A future build wires `get_history` onto the new `orchestrator_decisions` corpus (then the dead `decisions` table can be deleted).
- The corpus grows large enough that an unbounded `getAll()` needs pagination/time-windowing.
