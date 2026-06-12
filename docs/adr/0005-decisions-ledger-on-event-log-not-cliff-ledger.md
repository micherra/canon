---
adr: "0005"
title: "Orchestrator decisions ledger lives on the execution-store event log, not cliff-ledger or a new table"
status: accepted
date: "2026-06-12"
build: "batch-b-orchestrator-memory-hardening-1-orchestrator-self-handoff"
---

# ADR-0005: Orchestrator decisions ledger lives on the execution-store event log, not cliff-ledger or a new table

## Context

Batch B hardens the orchestrator's memory: a deterministic, durable **decisions ledger** records each consequential orchestrator decision (HITL gate outcomes, scope cuts, AC changes, tier overrides, merge resolutions) so a mid-build compaction event is recoverable. The build brief explicitly steered the architect toward **reusing `mcp-server/src/features/orchestration/services/cliff-ledger.ts`** (echoing Batch A's dead-wire finding that its exports were "currently NOT wired"), to avoid building a parallel store.

Two facts, established by throwaway probes (`PROBE-FINDINGS.md`, invoked 2026-06-12), reframed the decision:

1. **cliff-ledger is a `Set<string>` de-dupe ledger**, not a decision store. `cliffSignature(...)` returns an opaque `"${step_id}|${missing}|${partial}"` string; `readLedger` returns a `Set<string>`. It has no fields for decision type, rationale, outcome, gate, or timestamp. Its sole purpose is surface-once suppression of repeated cliff surfacing across loop ticks.
2. **cliff-ledger is already wired** (the spawn premise is stale): `filterUnsurfaced`/`appendLedger` are consumed by the loop runner (ship-watch, `loops-phase-c-03`), and `tryRemoveCliffLedger` cleans it up at finalize (`workspace-cleanup.ts`). There is no dead wire to close here.
3. The **execution-store event log** (`appendEvent(type, payload)` / `getEventsByType` / `getEvents`) durably round-trips arbitrary structured payloads with an auto-assigned `id` and store-side `timestamp`, queryable by type with `since`/`limit`. `post_event` and `reconcile_workspace` cliff-telemetry already use it.

## Options Considered

### Option A: Reuse cliff-ledger.ts as the decisions store

**Pros:**
- Matches the literal build-brief instruction ("reuse before rebuild").

**Cons:**
- Categorically wrong shape — a `Set<string>` cannot hold typed, rationale-bearing, timestamped decision records without being rewritten into a different data structure (which is not "reuse").
- It is already wired for a different purpose (loop de-dupe); overloading it would couple two unrelated concerns and risk the loop's surface-once invariant.
- No ordering/timestamp semantics for free.

**Canon-principle alignment:** tensions `deep-modules` (would force one module to serve two unrelated jobs) and `refactoring-integrity` (would mutate working, wired behavior).

### Option B: New dedicated SQLite table (`orchestrator_decisions`) with its own schema + migration

**Pros:**
- Typed columns; indexed queries; clean separation.

**Cons:**
- New schema migration + parallel store — exactly the "parallel store" the brief says to avoid.
- Higher blast radius (schema version bump, migration tests) for data the event log already stores adequately.

**Canon-principle alignment:** tensions reuse-before-rebuild and `simplicity-first`.

### Option C: New event `type` (`orchestrator_decision`) on the existing execution-store event log

**Pros:**
- Zero new schema/table/migration — reuses the durable, ordered, timestamped, queryable substrate already in production.
- Same substrate `post_event` and cliff-telemetry use — consistent, well-understood, fail-mode-known.
- Probe-confirmed to round-trip arbitrary decision payloads (PROBE B).
- Thin `log_decision`/`get_decisions` tools give a deep, narrow module over it.

**Cons:**
- Decisions share a table with other event types (filtered by `type`) — slightly less isolated than a dedicated table.
- No DB-level typed schema; payload shape enforced at the tool boundary (Zod) instead.

**Canon-principle alignment:** honors `deep-modules`, `command-query-separation`, reuse-before-rebuild, `simplicity-first`.

## Decision

Chosen: **Option C — new `orchestrator_decision` event type on the execution-store event log.**

cliff-ledger is the wrong shape AND already wired (not a dead wire), so reuse is neither possible nor beneficial. The event log already provides durable, ordered, timestamped, queryable storage that probes confirmed accepts decision payloads — making a new table redundant. Two thin tools (`log_decision` command, `get_decisions` query) expose a narrow surface over it.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| deep-modules | honors | `decisions-ledger.ts` is a narrow surface over the event-log substrate; callers never touch `appendEvent`. |
| command-query-separation | honors | `log_decision` (command) and `get_decisions` (query) are separate tools. |
| refactoring-integrity | honors | cliff-ledger left untouched; new code added alongside, no working behavior changed. |
| observable-best-effort | honors (exceeds) | the ledger write is authoritative — returns a `ToolResult` error on store failure, not a silent no-op. |
| simplicity-first | honors | no new table, schema, or migration. |

## Consequences

**Positive:**
- Decisions are durable, ordered, and survive compaction (out-of-context SQLite).
- No schema migration; minimal blast radius.
- Reuses a substrate whose fail modes are already understood.

**Negative / trade-offs:**
- Decision payload shape is enforced at the tool boundary (Zod enum + fields), not by DB columns — a malformed direct `appendEvent` call (bypassing `log_decision`) would not be schema-rejected. Mitigated by routing all writes through `log_decision`.
- Querying decisions requires filtering the event log by `type` (cheap; `getEventsByType` exists).

## Revisit-If

- Decision volume per build grows large enough that `getEventsByType` filtering becomes a measured hot path (then add an index or a dedicated table).
- A future need arises to join decisions against typed columns at the DB level (reporting/analytics across builds) — then promote to a dedicated table with a migration.
