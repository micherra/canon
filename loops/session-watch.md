---
id: session-watch
title: Session Watch — self-paced cliff + staleness observer
status: active
trigger:
  fired_by: orchestrator
  lifecycle_hook: session-start
  firing_posture:
    autonomous: auto
    light-touch: auto
    supervised: opt-in
mode: self-paced
schedule:
  cadence_hint:
    active: 4m    # tighten when a long/backgrounded step is in flight (240s ≤ 270s keeps prompt cache warm)
    idle: 30m     # back off when the session is quiet (≥1200s commits to real backoff)
  max_wall: "0"   # bounded by terminate conditions, not wall-clock
state:
  scope: session
  path: ${WORKSPACE}/session-watch-state.json
  snapshot:
    - surfaced_cliff_signatures   # de-dupe ledger key set (mirrors .cliff-surfaced.json)
    - kg_stale                    # boolean: KG mtime older than threshold
    - open_drift_crossed          # boolean: open-drift count crossed threshold this tick
observe:
  tools: []
  mcp:
    - reconcile_workspace
  shell_commands: []
surface:
  on_transition:
    - field: surfaced_cliff_signatures
      append: true
      message: "Mid-flight cliff detected on a long/backgrounded step — surfacing once via the cliff→HITL pattern."
    - field: kg_stale
      to: "true"
      message: "Knowledge graph looks stale — dependency reasoning may be degraded. Consider re-running codebase_graph."
    - field: open_drift_crossed
      to: "true"
      message: "Open drift / partially-finished work accumulating — surfacing the staleness digest."
terminate:
  when:
    - at_finalize
    - on_cliff_surfaced
    - max_wall_reached
guardrails:
  mutates_build: false
  forbidden_tools:
    - Edit
    - Write
    - get_next_escalation_strategy
---

## session-watch — Per-Tick Action Body

`session-watch` is a self-paced loop that consolidates two concerns: cliff detection
(long/backgrounded dispatched steps that may have died) and staleness detection (stale KG,
accumulating drift). Both concerns are observe+surface only — no build mutations.

**dc-06 note:** The orchestrator's session-start tap starts this loop by calling
`ScheduleWakeup`. Authoring this file only registers the definition. Do not call
`ScheduleWakeup` from within this body to start the loop — only to re-arm the next tick.

**First-tick baseline (ADR-0002):** On tick 1 there is no prior snapshot, so no
`on_transition` rules fire. Write the baseline snapshot and report:
`[loop: session-watch] Tick 1 baseline captured. Watching from next tick.`

### Observe

**Cliff concern (primary):**

Call `reconcile_workspace({ workspace, source: "loop", emit_telemetry: true })`.

Scope to long/backgrounded dispatched steps only — if no such step is in flight, the cliff
concern is a no-op this tick.

Read the de-dupe ledger `${WORKSPACE}/.cliff-surfaced.json`. Compute `cliffSignature` per
incomplete step (from the `cliff-ledger` module: `${step_id}|${sorted_missing}|${sorted_partial}`).
Keep only signatures NOT already in the ledger — these are new cliffs unsurfaced this session.

Update the `surfaced_cliff_signatures` snapshot field with the new signatures (append semantics:
the field accumulates signatures across ticks as a record of what was surfaced).

**Staleness concern (secondary, idle cadence):**

On the `idle` cadence only (skip on active tick to reduce overhead):

- Check KG mtime: read the knowledge graph DB's `graph_head_commit` meta field and compare
  to the current `git rev-parse HEAD` output. Set `kg_stale: true` if the KG is >3 commits
  behind HEAD. Use `reconcile_workspace` output (already called above) to infer activity — if
  recent steps are active, KG staleness is more likely relevant.
- Check open-drift count: from the `reconcile_workspace` result, if `needs_recovery: true`
  and the same cliff has been in the ledger for >2 ticks without resolution, set
  `open_drift_crossed: true`.

Both staleness reads are best-effort (fail-open). If the KG DB is unavailable, skip and
leave `kg_stale` unchanged.

### Diff against snapshot

Apply `on_transition` rules per the runner Step 5 algorithm (ADR-0002 first-tick guard is
always active). Since `surfaced_cliff_signatures` uses `append: true`, the rule fires when
new signatures are appended to the set (i.e., the set grew this tick).

### Surface-once

After the diff determines which rules fire:
1. For each new cliff signature in `toSurface`, surface the cliff message (from the
   transition rule).
2. Append the new signatures to the de-dupe ledger (`${WORKSPACE}/.cliff-surfaced.json`)
   using the cliff-ledger `appendLedger` pattern: read → surface → append.

This prevents double-HITL collisions with the resume/post_subagent cliff passes: once a
signature is in the ledger, session-watch suppresses it on subsequent ticks.

### Write snapshot

Write the updated snapshot atomically to `${WORKSPACE}/session-watch-state.json`:

```json
{
  "surfaced_cliff_signatures": ["<sig1>", "<sig2>"],
  "kg_stale": false,
  "open_drift_crossed": false,
  "last_tick": "<ISO-8601 timestamp>"
}
```

### Evaluate terminate

Check `terminate.when` conditions:

| Condition | When satisfied |
|-----------|---------------|
| `at_finalize` | The workspace is being finalized (session ending) |
| `on_cliff_surfaced` | The cliff concern surfaced ≥1 new cliff this tick (self-terminates; resume/post_subagent own remaining recovery) |
| `max_wall_reached` | `max_wall` elapsed time exceeded (body-enforced; `max_wall: "0"` disables wall-clock cap) |

Also terminate if any fired transition rule has `terminate: true`.

**If terminal:**
Report `[loop: session-watch] Loop terminated after tick <N>. Reason: <condition>.`
OMIT the `ScheduleWakeup` call — omitting it terminates the self-paced loop.

**If NOT terminal:**
Re-arm the next wakeup:
```
ScheduleWakeup({
  delaySeconds: <cadence>,   # active (240s) if cliff in flight; idle (1800s) otherwise
  reason: "[loop: session-watch] Tick <N> complete. Re-arming at <active|idle> cadence.",
  prompt: "/canon:loop-tick session-watch"
})
```

Choose `active` (4m / 240s) when a long/backgrounded step is currently in flight (cliff
concern active); choose `idle` (30m / 1800s) when the session is quiet (staleness-only cadence).
Both values are within the harness clamp [60, 3600].
