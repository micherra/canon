---
id: _probe-self-paced
title: Loop Framework Self-Paced Probe
status: active
trigger:
  fired_by: orchestrator
  lifecycle_hook: session-start
  firing_posture:
    autonomous: disabled
    light-touch: disabled
    supervised: opt-in
mode: self-paced
schedule:
  cadence_hint:
    active: 1m
    idle: 5m
  max_wall: "0"
state:
  scope: session
  path: ${WORKSPACE}/_probe-self-paced-state.json
  snapshot:
    - tick_count
observe:
  tools: []
  mcp: []
  shell_commands: []
surface:
  on_transition:
    - field: tick_count
      to: "3"
      message: "Self-paced probe tick 3 reached — Phase C self-paced path proven (schema→registry→self-paced runtime)."
      terminate: true
terminate:
  when:
    - max_wall_reached
guardrails:
  mutates_build: false
  forbidden_tools:
    - Edit
    - Write
    - get_next_escalation_strategy
---

## _probe-self-paced — Loop Framework Self-Paced Runnable Proof (DC6 / AC #7)

`_probe-self-paced` is the framework's Phase C demonstration loop. It proves the
schema→registry→self-paced runtime path end-to-end without side effects. It is invoked
via opt-in at session-start in supervised mode and is never auto-fired in production.

This definition proves the self-paced adapter (C-05) independently of session-watch
(C-06) — any self-paced loop can run and terminate through this same path.

**First-tick baseline (ADR-0002):** tick 1 captures a baseline and surfaces nothing.
The `to: "3"` rule fires on the tick-2→tick-3 transition (when `tick_count` changes
from 2 to 3), which HAS a present prior. This is the executable proof.

### Observe (per tick)

1. Read the current state from `state.path` (`${WORKSPACE}/_probe-self-paced-state.json`).
2. If the state file is absent (first tick), treat `tick_count` as 0.
3. Increment `tick_count` by 1. Record the new value in the observed snapshot.

### Diff against snapshot

Compare the observed `tick_count` to the last-seen snapshot value from the state file.

**First-tick guard (ADR-0002):** On tick 1, the prior `tick_count` is absent — no transition
fires. The baseline tick is written and `[loop: _probe-self-paced] Tick 1 baseline captured. Watching from next tick.` is reported.

### Surface on transition

- When `tick_count` transitions to `3` (from a present prior of 2): emit the transition
  message. Mark for termination.

### Write snapshot

Write the updated snapshot `{ tick_count: <new_value> }` back to `state.path`.

### Evaluate terminate

**If terminal** (`tick_count >= 3` OR `max_wall` exceeded):
- Report termination and stop. OMIT the `ScheduleWakeup` call — omitting it terminates
  the self-paced loop (no auto-re-fire).

**If NOT terminal** (tick_count < 3 and max_wall not exceeded):
- Re-arm the next wakeup:
  ```
  ScheduleWakeup({
    delaySeconds: 60,  # active cadence (1m), clamped to runtime minimum [60, 3600]
    reason: "[loop: _probe-self-paced] Tick <N> complete. Re-arming at active cadence.",
    prompt: "Run one tick of Canon loop \"_probe-self-paced\": call get_loop_definition({ id: \"_probe-self-paced\" }) to load its definition + body, then execute that body's observe → diff → surface → write → evaluate pipeline (the steps in skills/canon/commands/loop-tick.md), using the loop's state.path (substitute ${WORKSPACE}) for the prior snapshot. Read-only observation only (dc-06)."
  })
  ```

### Non-declarative constraint (dc-06)

The orchestrator calls `ScheduleWakeup` to start this loop at a named lifecycle moment
(`session-start`). The runner re-arms the NEXT wakeup per tick (by calling `ScheduleWakeup`
again); it does NOT start the loop from scratch. Authoring this file registers the definition
only — it does NOT start the loop.
