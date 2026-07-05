# ADR-0036: Event-log project-level scope migration (Inc 1d of the event-backbone epic)

- Status: Proposed (GATED — not yet accepted; entry requires the Inc 1d HITL go/no-go)
- Date: 2026-07-02
- Deciders: user + architect (event-backbone epic, Option B)
- Related: ADR-0010 (event log as decisions ledger — the pattern this generalizes), ADR-0016 (finalize is archive-copy-only, no destructive teardown), ADR-0021 (workspace `.lock` mutex), ADR-0018 (provenance on the event log)

## Context

Canon runs two per-workspace state models: `journal.json` (step lifecycle) and the execution-store event log (`orchestration.db`: decisions, budget, metrics, provenance). Both are physically siloed inside `{workspace}/` (`execution-store-cache.ts:50` resolves `orchestration.db` under the absolute workspace path; `assertWorkspacePath` even requires the path contain `.canon/workspaces/`). No session can observe another session's build state — the motivating incident (user could not message a completed build's session).

The event-backbone epic promotes the event log to the primary substrate in sequenced increments. Inc 0 (chatter), Inc 1a (dual-write `step_logged`), Inc 1b (`materializeJournal` fold), and Inc 1c (write-path flip: event authoritative, `journal.json` a written projection) are all **within-workspace** and **reversible** — they deliver a unified single-source-of-truth write path without moving scope.

**Inc 1d is the one step that moves scope from per-workspace to project-level** so that step-state becomes cross-session-visible. This ADR records that decision because it is the irreversible hinge of the epic.

## Decision

Move the authoritative event log to a project-level store at `{projectDir}/.canon/orchestration.db` (the pattern `drift.db` and `knowledge-graph.db` already use — `drift-db-cache.ts`), partitioned by `correlation_id` as the workspace partition key (the column already exists on every event). Per-workspace reads become partition-filtered reads. Enter this increment ONLY on the Inc 1d go/no-go signal (see Consequences → Gate).

Preserve:
- **`.lock` mutex** (`workspace-lock.ts`): stays per-workspace (guards the worktree, not the db). Verify no coupling to db physical location.
- **archive/finalize** (ADR-0016): `archiveWorkspaceOnly` snapshots the workspace's `correlation_id` partition instead of copying a per-workspace db file.
- **journal-completeness verification** and **`log_decision` authoritative durability** (PRD constraint 2): unchanged — they operate on the same event stream, now partition-scoped.
- **Retention/compaction (new policy)**: janitor drops a workspace's `correlation_id` partition when it reaps the workspace — preserving today's "discard with the workspace" semantics at project scope.

## Options considered

### Option A — Keep per-workspace scope; achieve cross-session via a separate project-level index only for chatter/discovery
- Pros: no migration of the primary log; Inc 0 already delivers cross-session chatter; zero risk to step-state correctness.
- Cons: step-state (journal) stays siloed — cross-run mining and cross-session resume still cannot see another session's steps. Does not deliver the "one backbone" end-state.
- Alignment: simplicity-first ✓; but does not satisfy the Option-B thesis the user chose.

### Option B (chosen, gated) — Project-level event log, `correlation_id` partition key
- Pros: step-state becomes cross-session; single durable ordered substrate; generalizes ADR-0010 to the whole lifecycle; cross-run mining runs on a live stream.
- Cons: irreversible once sessions write cross-partition; introduces multi-writer-to-one-file reality (defended by `ExecutionStore.withRetry`, but only in-process serialization was probed — Probe B caveat); requires a brand-new retention policy the discardable per-workspace log never needed; touches the scope cache, archive lifecycle, and must be proven not to couple the `.lock` mutex.
- Alignment: honors the Option-B backbone thesis; tension with fail-closed-by-default (retention/growth) surfaced and owned (partition-drop-at-reap).

## Consequences

- **Irreversible**: once two sessions have interleaved writes into shared partitions, reverting to per-workspace stores would require splitting a shared log by partition and is not a clean rollback. This is the epic's point-of-no-return.
- **Gate (entry condition)**: Do NOT implement until the Inc 1d HITL go/no-go is satisfied. Recommended go criteria (DQ4): Inc 0 shows sustained cross-session usage over a real window AND a concrete second consumer needs cross-session *step* state (not just chatter) that the per-workspace silo blocks. Absent that, Inc 1a-1c ship the projection refactor and Inc 1d stays deferred (PRD explicitly allows this).
- **Blast radius**: `execution-store-cache.ts` (scope), `workspace-cleanup.ts`/archive (ADR-0016 partition snapshot), `janitor.ts` (partition-drop retention), plus every event reader now partition-filtered.
- **Transport untouched**: this is a storage-scope change, not a transport change; Option B (keep HTTP daemon) is not reopened.

## Revisit if
- Inc 0 demand data shows cross-session need is rare (then Option A is the terminal answer, not a stepping stone).
- Multi-OS-process contention on the shared project-level db proves to exceed what `withRetry` absorbs (Probe B only proved in-process serialization).
