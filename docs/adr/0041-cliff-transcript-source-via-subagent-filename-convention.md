---
adr: "0041"
title: "Cliffed-agent transcript source is resolved from the session-scoped Claude Code subagent filename convention"
status: accepted
date: "2026-07-06"
build: "forward-cliff-transcript-instrumentation-capture-a-transcript-snapshot"
---

# ADR-0041: Cliff-transcript source via the session-scoped subagent filename convention

## Context

`reconcile_workspace` detects write-cliffs (a code-writing agent that dies before
finishing its declared artifact). The dead agent's transcript is exactly the
evidence needed to diagnose the cliff, but transcript capture is wired to step
*completion* with an `agent_id` (`log_step`/`batch_log_steps` → `tryTranscriptCapture`),
and a cliffed (`started`/`planned`) step never completes.

Empirically (PROBE-FINDINGS.md for this build):
- A cliffed step has **no `agent_id` anywhere in durable state** — `JournalStep` has
  no such field, a `started` re-log never persists it, and the `context_provenance`
  event back-fills `agent_id` only at completion. So `captureTranscript`'s existing
  `agent_id` glob fallback cannot be used.
- Claude Code stores each subagent's raw JSONL at
  `~/.claude/projects/{projectId}/{parentSessionId}/subagents/agent-{agentId}.jsonl`,
  and for a **named** agent the filename embeds the spawn `name`. Canon's spawn
  contract makes that name `{agent_type}-{step_id}-{job_suffix}` — the filename
  therefore encodes the two keys reconcile already holds per incomplete step.
- `journal.session_id` (added 2026-07-03) durably records the orchestrator's session,
  which is the parent-session directory the subagent lives under.

This ADR records the chosen source-resolution mechanism and why it is scoped and
forward-only.

## Options Considered

### Option A: Session-scoped subagent-filename convention (CHOSEN)
Glob `~/.claude/projects/{projectId}/{journal.session_id}/subagents/agent-*.jsonl`
for a file whose name contains `{agent_type-minus-canon:}-{step_id}-`, disambiguating
same-step re-spawns by `started_at` proximity; then reuse
`captureTranscript({ source_path })`.

**Pros:**
- Uses keys reconcile already has; validated end-to-end against real historical
  transcripts (scribe/reviewer/tester all captured).
- Server-side and durable — survives in-session compaction and resume, the exact
  conditions under which a cliff occurs.
- Session scoping makes the token effectively unique, eliminating cross-session
  wrong-attribution.

**Cons:**
- Couples Canon to Claude Code's subagent filename format **and** to Canon's own
  spawn-name contract.
- Requires `session_id`; legacy (pre-2026-07-03) journals lack it.

### Option B: Orchestrator passes a step→agent_id map into reconcile
**Pros:** exact identity, no filename coupling.
**Cons:** the map lives only in the orchestrator's in-context memory and is gone
after compaction/resume — precisely the cliffs most worth capturing; needs a
reconcile protocol change; is a behavioral obligation skippable under context
pressure (the failure mode watch_GGGGGG1 documents).

### Option C: Unscoped filename scan (newest global mtime)
**Pros:** would also capture legacy cliffs.
**Cons:** the probe matched 10–38 candidates across past sessions for common tokens;
"newest global" attaches another build's transcript to this cliff. False evidence is
worse than no evidence.

## Decision

Option A. Resolution is **session-scoped and forward-only**: when `journal.session_id`
is absent, the resolver returns a typed `no_session_id` absent-marker rather than
guess across sessions. All absent/failed captures are recorded as typed reasons
(`no_project_dir | no_session_id | projects_dir_unreadable | no_source_match |
capture_failed`) and joined to the cliff telemetry alongside a captured path, so the
watch_GGGGGG1 remeasurement can always join cliff → evidence (present or explained).

The `agent_type` recorded on the cliff (`canon:scribe`) is stripped of its `canon:`
prefix to match the short type in the filename token — this is load-bearing and
probe-verified.

The join is persisted durably in the drift.db `cliff_events` table via two additive
nullable columns (`transcript_path`, `transcript_uncaptured_reason`; schema v15) and
also in the per-workspace `cliff_detected` orchestration event.

## Consequences

- New `cliff-transcript-source.ts` (resolver) + `cliff-transcript-capture.ts` (effect)
  services; `reconcile_workspace` runs capture before its existing telemetry writes.
- Capture is **strictly fail-open** — no failure alters `needs_recovery`,
  `incomplete_steps`, or the tool's ok/error status; the clean (no-cliff) path is
  untouched. This is the deliberate opposite of `fail-closed-by-default`, which
  governs safety gates; this is advisory diagnostics.
- **Hard-to-reverse**: the coupling is to an external tool's on-disk format, and the
  drift schema columns are append-only. A future CC filename-format change silently
  degrades coverage to `no_source_match` (fail-open) rather than crashing.
- Legacy and unnamed-agent cliffs are not captured (typed marker instead) — accepted,
  since retroactive capture is out of scope and forward cliffs all carry session_id.

## Revisit If

- Claude Code changes the subagent filename format or parent-session storage layout.
- A durable agent-identity signal for `started` steps becomes available (e.g. an
  optional `agent_id` persisted on a `spawned` sub-state) — then prefer exact identity
  over the filename convention.
- Coverage of legacy/unnamed-agent cliffs becomes a requirement.

## Gate Justification (conjunctive 3-condition)

- **Hard-to-reverse**: couples to an external on-disk format + append-only drift
  columns; unwinding touches the storage schema and a cross-tool contract.
- **Surprising-without-context**: "why does cliff capture parse subagent filenames and
  require session_id" is deeply non-obvious to a future contributor.
- **Genuine trade-off**: coverage (all cliffs, Option C) vs false-attribution safety
  (session-scoped, forward-only) — a real cost on both sides, resolved toward safety.
