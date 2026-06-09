---
id: _probe
title: Loop Framework Probe
status: active
trigger:
  fired_by: orchestrator
  lifecycle_hook: post-ship
  firing_posture:
    autonomous: disabled
    light-touch: disabled
    supervised: opt-in
mode: interval
schedule:
  interval: 1m
  max_ticks: 3
state:
  scope: workspace
  path: ${WORKSPACE}/_probe-state.json
  snapshot:
    - tick_count
observe:
  tools: []
  mcp: []
surface:
  on_transition:
    - field: tick_count
      to: "3"
      message: "Probe tick 3 reached — Loop Framework Phase A path proven (schema→registry→runtime)."
      terminate: true
terminate:
  when:
    - max_ticks_reached
guardrails:
  mutates_build: false
  forbidden_tools: []
---

## _probe — Loop Framework Runnable Proof

`_probe` is the framework's demonstration loop. It proves the schema→registry→runtime path
end-to-end without side effects. It is invoked manually in the Phase A verify step and is
never fired in production.

### Observe (per tick)

1. Read the current state from `state.path` (`${WORKSPACE}/_probe-state.json`).
2. If the state file is absent (first tick), treat `tick_count` as 0.
3. Increment `tick_count` by 1. Record the new value in the observed snapshot.

### Diff against snapshot

Compare the observed `tick_count` to the last-seen snapshot value from the state file.

### Surface on transition

- When `tick_count` equals `3`: emit the transition message. Mark for termination.

### Write snapshot

Write the updated snapshot `{ tick_count: <new_value> }` back to `state.path`.

### Evaluate terminate

If `tick_count >= max_ticks` (i.e., `tick_count >= 3`), the loop has reached `max_ticks_reached`.
Do NOT reschedule — the loop ends here.

Otherwise the loop continues under its CronCreate cadence (interval: 1m). The orchestrator made
the initial CronCreate call; this runner only evaluates whether to continue.

### Non-declarative constraint (dc-06)

The orchestrator calls `CronCreate` to start this loop at a named lifecycle moment.
The runner does NOT auto-start or reschedule from scratch — it is the per-tick body only.
