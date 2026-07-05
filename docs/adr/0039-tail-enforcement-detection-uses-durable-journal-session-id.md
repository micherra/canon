---
adr: "0039"
title: "Tail-enforcement detection uses a durable journal.session_id, not the ephemeral .lock"
status: accepted
date: "2026-07-05"
build: "add-a-deterministic-stop-hook-tail-enforcement-gate-delta-d3-from-the"
amends: "0038"
---

# ADR-0039: Tail-enforcement detection uses a durable journal.session_id, not the ephemeral .lock

## Context

ADR-0038 established the `Stop`-hook tail-enforcement gate and chose its active-build detection
signal: scan `.canon/workspaces/*/*/journal.json` for a sibling `.lock` whose `session_id`
matches the Stop event's `session_id`. Automated review (Codex, PR #451) found that this signal
is dead for the gate's primary purpose:

- `finalize_workspace` releases the `.lock` **unconditionally** — the code comment reads "Run
  regardless of `complete`" (`orchestration-journal.ts` ~L613-617).
- The root `CLAUDE.md` Completion Checklist runs `finalize_workspace` as step 1, **before**
  context-sync, ship, and learn.
- The gate's trigger is `ship == completed`.

Therefore, by the time `ship` completes and any `Stop` could fire the gate, the `.lock` has
already been unlinked → no session match → the gate no-ops on exactly the shipped-tail-omission
scenario it exists to catch. The gate never fires for its primary purpose.

A correct replacement signal must satisfy three constraints simultaneously: (1) survive
`finalize`'s lock release; (2) uniquely attribute a Stop to exactly one build among N concurrent
builds in a shared repo; (3) introduce zero cross-session or chat-stop false positives (the
conservative posture ADR-0038 depends on).

Established by reading source: `journal.json`'s top-level object is `{ steps, version, workspace }`
(no session id); `finalize_workspace` archives the workspace by **copy** and never deletes the live
`journal.json`. So the journal is a durable, per-workspace artifact that outlives the lock.

## Options Considered

### Option A: Persist session_id into journal.json; gate matches journal.session_id

**Pros:**
- journal.json survives `finalize` (copy-archive, no delete) — the signal is present at the
  `ship==completed` trigger.
- Exactly one session id per journal ⇒ unique attribution; a session id lives in no other journal,
  so concurrent sessions and chat stops match nothing ⇒ zero cross-session false positives.
- The journal is already read in the gate's step 4 (ship status) — the signal is free at
  detection time; the `.lock` read is dropped entirely.

**Cons:**
- Requires a small `mcp-server/` change (Journal schema + `init_workspace` seed/resume +
  `readJournal`/`writeJournal` preserve), raising verify blast radius to the full gate set and
  requiring context-sync.
- A build resumed by a *different* session misses enforcement unless `init` refreshes the field on
  resume — but a miss is fail-open (no false block), and the refresh closes it.

### Option B: Disambiguate via the Stop event's `cwd`

**Pros:** No schema change.

**Cons:** The Stop `cwd` is the orchestrator's main repo root — shared by ALL concurrent sessions
in the repo (it is NOT the worktree path). It cannot tell which of N builds a session owns. Fails
constraint (2) outright.

### Option C: Reorder so the `.lock` releases only after `learn`

**Pros:** Keeps the existing lock signal; no TS change.

**Cons:** Re-couples the gate's correctness to orchestrator ordering — the exact dependency a
harness-fired gate exists to eliminate; lengthens the multi-session exclusion window (lock held
across the whole tail); still requires a Completion-Checklist / protocol change. Fragile.

## Decision

Chosen: **Option A**. Add an optional `session_id` to the persisted journal, written by
`init_workspace` (and refreshed on resume), preserved across every `log_step`/`batch_log_steps`
read-modify-write. The `Stop` gate identifies the active build by matching each journal's
top-level `session_id` against the Stop event's `session_id`, dropping the `.lock` read. Absent or
`unknown` journal session_id → no match → fail-open no-op (the same pre-existing provenance gap
ADR-0038 already documents). Enforcement remains fail-closed given a detected shipped build;
detection remains intentionally fail-open.

This ADR **amends ADR-0038's detection-signal decision only**. The gate's trigger
(`ship==completed`), loop-guard (`stop_hook_active`), doc-only skip, accepted-skip-reason
allowlist, and fail-closed enforcement posture are all unchanged.

A separate, co-shipped fix (Codex P2) makes the jq-missing fail-closed branch emit its block JSON
without `jq` — that is a localized bug fix, not an architecture decision, and is recorded in the
build's ephemeral decisions only.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| fail-closed-by-default | honors | Enforcement still blocks a detected shipped build with an incomplete tail. |
| fail-closed-by-default | tensions (resolved) | Detection stays intentionally fail-open on no-match to preserve zero false positives on chat / concurrent sessions — unchanged from ADR-0038. |
| hooks-fail-closed | honors | Unparseable journal / missing jq / unreadable allowlist still block. |
| errors-are-values | honors | `session_id` is an optional field; no new throw path in `readJournal`. |

## Consequences

**Positive:**
- The gate fires for its primary purpose: a shipped build whose tail was dropped is now detected
  after `finalize`, because the identifying signal outlives the lock.
- Zero new false-positive surface — journal.session_id is unique per build.

**Negative / trade-offs:**
- A small `mcp-server/` change (previously the gate was pure shell) — full verify + context-sync.
- A build resumed by a different session before ship is un-attributed unless `init` refreshes the
  journal session_id on resume (implemented; fail-open otherwise).
- Builds whose orchestrator never supplied a `session_id` remain un-attributable (the gate no-ops
  on them — the same pre-existing provenance gap noted in ADR-0038).

## Revisit-If

- The Claude Code harness adds a semantic "build complete" event that carries its own session
  attribution — replace both the `ship==completed` proxy and this signal.
- `finalize_workspace` is changed to delete (not copy-archive) the live `journal.json` — the
  durability assumption this ADR rests on would no longer hold.
