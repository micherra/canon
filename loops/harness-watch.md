---
id: harness-watch
title: Harness Watch — accumulated-build-signal observer that nudges a learner pass
status: active
trigger:
  fired_by: orchestrator
  lifecycle_hook: post-ship
  firing_posture:
    autonomous: auto
    light-touch: auto
    supervised: opt-in
mode: self-paced
schedule:
  cadence_hint:
    active: 4m
    idle: 30m
  max_wall: "0"
state:
  scope: workspace
  path: ${WORKSPACE}/harness-watch-state.json
  snapshot:
    - last_learner_archive_count    # marker baseline (decision harness-watch-01)
    - builds_since_last_learner     # int: current total_count − last_learner_archive_count
    - recurring_violation_count     # int: distinct recurring violations from get_cross_run_analysis
    - top_recurring_principle       # string|null: highest-occurrence recurring principle_id
    - learner_due                   # boolean: a threshold crossed this tick
observe:
  tools: []
  mcp:
    - get_build_history
    - get_cross_run_analysis
  shell_commands: []
surface:
  on_transition:
    - field: learner_due
      to: "true"
      message: "Accumulated build signal crossed the learner threshold — surfacing a learner pass."
      orchestrator_action: run-learner
      terminate: true
terminate:
  when:
    - on_learner_surfaced
    - at_finalize
    - max_wall_reached
guardrails:
  mutates_build: false
  forbidden_tools:
    - Edit
    - Write
    - Bash
    - get_next_escalation_strategy
---

## harness-watch — Per-Tick Action Body

`harness-watch` is a self-paced loop that watches accumulated build signal — the volume of
builds since the last learner pass and the trajectory of recurring violations — and surfaces
a single `run-learner` orchestrator action when a cheap threshold crosses. It is observe+surface
only — no build mutations.

**dc-06 note:** The orchestrator's post-ship tap starts this loop by calling `ScheduleWakeup`.
Authoring this file only registers the definition. Do not call `ScheduleWakeup` from within
this body to start the loop — only to re-arm the next tick.

### First-tick baseline (ADR-0002)

On tick 1 there is no prior snapshot, so no `on_transition` rules fire. Call
`get_build_history({ project_dir, limit: 1 })`, read `total_count`. Set:

- `last_learner_archive_count = total_count`
- `builds_since_last_learner = 0`
- `recurring_violation_count = 0`
- `top_recurring_principle = null`
- `learner_due = false`

Surface NOTHING. Write the baseline snapshot. Report:
`[loop: harness-watch] Tick 1 baseline captured. Watching from next tick.`

### Observe (tick 2+)

Call `get_build_history({ project_dir, limit: 1 })` → read `total_count`. Compute:

```
builds_since_last_learner = total_count − last_learner_archive_count
```

Call `get_cross_run_analysis({ project_dir })`. From the result:

- Set `recurring_violation_count = recurring_violations.length` (0 when empty or sparse)
- Set `top_recurring_principle` = the `principle_id` with the highest `occurrence_count`
  among `recurring_violations`, or `null` if none exist

Respect the data-volume floor: if `total_archived_runs < 5` or the
`recurring_violations` array is empty, do NOT let the recurring-violation path
escalate. Only the volume threshold (`builds_since_last_learner`) may fire in
that case. (Five archived runs mirrors the same floor the volume path uses and
matches the `get_cross_run_analysis` result field `total_archived_runs`.)

### Threshold → `learner_due`

Set `learner_due = true` when EITHER:

- **(a) Volume threshold:** `builds_since_last_learner >= 5`, OR
- **(b) Signal threshold:** `total_archived_runs >= 5` (sufficient history)
  AND `recurring_violation_count` rose since the prior snapshot
  AND `top_recurring_principle` is non-null

Otherwise `learner_due = false`.

### Diff + surface

Apply `on_transition` rules per the runner Step 5 algorithm. `learner_due` false→true is the
only transition. On fire, emit the message AND the structured orchestrator-action line (runner
Step 6 does this generically from `orchestrator_action`):

```
ORCHESTRATOR_ACTION: run-learner field=learner_due loop=harness-watch
```

The runner only PRINTS this line — it never spawns the learner (dc-06). The orchestrator
reads and acts on it per the `run-learner` consumption contract in CLAUDE.md.

### Advance the marker + write snapshot (decision harness-watch-01)

When `learner_due` fired this tick, set `last_learner_archive_count = total_count` in the
snapshot before writing. This resets `builds_since_last_learner` for the next armed instance.

Persist the snapshot atomically to `state.path` (`${WORKSPACE}/harness-watch-state.json`):

```json
{
  "last_learner_archive_count": 42,
  "builds_since_last_learner": 0,
  "recurring_violation_count": 3,
  "top_recurring_principle": "errors-as-values",
  "learner_due": false,
  "last_tick": "<ISO-8601 timestamp>"
}
```

NOTE: this is the runner's Step 7 snapshot write — loop-state persistence, NOT a build
mutation. `Write` stays out of `observe.tools`.

**Marker-advancement honesty caveat (documented, accepted):** The marker advances when the
loop *surfaces* the nudge, not when the learner *actually runs*. If the orchestrator
declines or defers the surfaced `run-learner`, the marker still advances and the counter
resets. This is the conservative failure mode (under-nudging, never spam) and is acceptable
for v1. A future increment may tighten this by having the orchestrator write a learner-ran
marker the loop reads.

### Evaluate terminate

Check `terminate.when` conditions:

| Condition | When satisfied |
|-----------|---------------|
| `on_learner_surfaced` | The learner_due transition fired this tick (self-terminates after surfacing) |
| `at_finalize` | The workspace is being finalized (session ending) |
| `max_wall_reached` | `max_wall` elapsed time exceeded (`max_wall: "0"` disables wall-clock cap) |

Also terminate when any fired transition rule carries `terminate: true` (the `learner_due`
rule does).

**If terminal:**
Report `[loop: harness-watch] Loop terminated after tick <N>. Reason: <condition>.`
OMIT the `ScheduleWakeup` call — omitting it terminates the self-paced loop.

**If NOT terminal:**
Re-arm the next wakeup:
```
ScheduleWakeup({
  delaySeconds: <cadence>,   # active (240s) if a build just shipped this tick; idle (1800s) otherwise
  reason: "[loop: harness-watch] Tick <N> complete. Re-arming at <active|idle> cadence.",
  prompt: "Run one tick of Canon loop \"harness-watch\": call get_loop_definition({ id: \"harness-watch\" }) to load its definition + body, then execute that body's observe → diff → surface → write → evaluate pipeline (the steps in skills/canon/commands/loop-tick.md), using the loop's state.path (substitute ${WORKSPACE}) for the prior snapshot. Read-only observation only (dc-06)."
})
```

Choose `active` (4m / 240s) when a build just shipped this tick (harness-watch fires at
post-ship, so tick 1 is typically active-cadence); choose `idle` (30m / 1800s) for
subsequent ticks when no build is in flight.
