---
id: evolve
title: Evolve — accumulated-attribution-signal observer that nudges an evolve-candidate pass
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
    active: 4m
    idle: 30m
  max_wall: "0"
state:
  scope: workspace
  path: ${WORKSPACE}/evolve-state.json
  snapshot:
    - last_evolve_archive_count    # marker baseline — total_count when evolve last surfaced
    - archives_since_last_evolve   # int: current total_count − last_evolve_archive_count
    - gate_eligible_target_count   # int: select_mutation_targets targets.length for most-recent archive
    - last_probed_archive_id       # string|null: archive_id probed this tick (null when skipped)
    - evolve_due                   # boolean: signal+freshness threshold crossed this tick
observe:
  tools: []
  mcp:
    - get_build_history
    - select_mutation_targets
  shell_commands: []
surface:
  on_transition:
    - field: evolve_due
      to: "true"
      message: "Gate-eligible attributed failure signal detected — surfacing an evolve-candidate pass."
      orchestrator_action: run-evolve
      terminate: true
terminate:
  when:
    - on_evolve_surfaced
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

## evolve — Per-Tick Action Body

`evolve` is a self-paced loop that watches accumulated attributed failure signal — the
presence of gate-eligible mutation targets in the most-recent archived build — and surfaces
a single `run-evolve` orchestrator action when the conjoined signal+freshness threshold
crosses. It is observe+surface only — no build mutations, no model calls, no proposal writes.

**dc-06 note:** The orchestrator's session-start tap starts this loop by calling
`ScheduleWakeup`. Authoring this file only registers the definition. Do not call
`ScheduleWakeup` from within this body to start the loop — only to re-arm the next tick.

### First-tick baseline (ADR-0002)

On tick 1 there is no prior snapshot, so no `on_transition` rules fire. Call
`get_build_history({ project_dir, limit: 1 })`, read `total_count`. Set:

- `last_evolve_archive_count = total_count`
- `archives_since_last_evolve = 0`
- `gate_eligible_target_count = 0`
- `last_probed_archive_id = null`
- `evolve_due = false`

Surface NOTHING. Write the baseline snapshot. Report:
`[loop: evolve] Tick 1 baseline captured. Watching from next tick.`

### Observe (tick 2+)

Call `get_build_history({ project_dir, limit: 1 })` → read `total_count` and the most-recent
archive entry. Compute:

```
archives_since_last_evolve = total_count − last_evolve_archive_count
```

**Archive selection:** use the most-recent archive with `has_run_summary === true` (freshest
attribution data — one archive probed per tick for bounded cost). If the most-recent archive
has `has_run_summary === false`, skip the probe this tick:

- Set `gate_eligible_target_count = 0`
- Set `last_probed_archive_id = null`

Otherwise call `select_mutation_targets({ archive_id: <most-recent archive_id>, project_dir })`:

- Set `gate_eligible_target_count = targets.length`
- Set `last_probed_archive_id = <archive_id>`

The `select_mutation_targets` probe is deterministic and makes ZERO model calls (verified:
it composes the `attribute_failure` pipeline plus a selection policy filter — no `claude -p`,
no `evaluate_candidate`). It is the correct "evolve-due" detector because it tells the
observer whether an evolve pass would have gate-eligible targets WITHOUT incurring the
expensive model-backed generation or the `evaluate_candidate` holdout gate.

### Threshold → `evolve_due`

Set `evolve_due = true` when BOTH:

- **(a) Signal floor:** `gate_eligible_target_count >= 1` (at least one gate-eligible target exists)
- **(b) Freshness floor:** `archives_since_last_evolve >= 1` (at least one new archive since the last surfaced evolve)

Otherwise `evolve_due = false`.

The conjunct is intentional: firing with zero gate-eligible targets would make the spawned
evolve-candidate pass immediately report "No eligible mutation targets found" — a wasted
dispatch. The freshness floor prevents re-surfacing if nothing new has been archived since
the last evolve.

### Diff + surface

Apply `on_transition` rules per the runner Step 5 algorithm. `evolve_due` false→true is the
only transition. On fire, emit the message AND the structured orchestrator-action line (runner
Step 6 does this generically from `orchestrator_action`):

```
ORCHESTRATOR_ACTION: run-evolve field=evolve_due loop=evolve
```

The runner only PRINTS this line — it never spawns the learner or executes the evolve pass
(dc-06). The orchestrator reads and acts on it per the `run-evolve` consumption contract in
CLAUDE.md.

### Advance the marker + write snapshot

When `evolve_due` fired this tick, set `last_evolve_archive_count = total_count` in the
snapshot before writing. This resets `archives_since_last_evolve` for the next armed instance.

Persist the snapshot atomically to `state.path` (`${WORKSPACE}/evolve-state.json`):

```json
{
  "last_evolve_archive_count": 42,
  "archives_since_last_evolve": 0,
  "gate_eligible_target_count": 2,
  "last_probed_archive_id": "archive-abc123",
  "evolve_due": false,
  "last_tick": "<ISO-8601 timestamp>"
}
```

NOTE: this is the runner's Step 7 snapshot write — loop-state persistence, NOT a build
mutation. `Write` stays out of `observe.tools`.

**Marker-advancement honesty caveat (documented, accepted):** The marker advances when the
loop *surfaces* the nudge, not when the evolve-candidate pass *actually runs*. If the
orchestrator declines or defers the surfaced `run-evolve`, the marker still advances and the
counter resets. This is the conservative failure mode (under-nudging, never spam) and is
acceptable for Phase 1. A future increment may tighten this by having the orchestrator write
an evolve-ran marker the loop reads.

### Evaluate terminate

Check `terminate.when` conditions:

| Condition | When satisfied |
|-----------|---------------|
| `on_evolve_surfaced` | The evolve_due transition fired this tick (self-terminates after surfacing) |
| `at_finalize` | The workspace is being finalized (session ending) |
| `max_wall_reached` | `max_wall` elapsed time exceeded (`max_wall: "0"` disables wall-clock cap) |

Also terminate when any fired transition rule carries `terminate: true` (the `evolve_due`
rule does).

**If terminal:**
Report `[loop: evolve] Loop terminated after tick <N>. Reason: <condition>.`
OMIT the `ScheduleWakeup` call — omitting it terminates the self-paced loop.

**If NOT terminal:**
Re-arm the next wakeup:
```
ScheduleWakeup({
  delaySeconds: <cadence>,   # active (240s) if the probe ran this tick; idle (1800s) otherwise
  reason: "[loop: evolve] Tick <N> complete. Re-arming at <active|idle> cadence.",
  prompt: "Run one tick of Canon loop \"evolve\": call get_loop_definition({ id: \"evolve\" }) to load its definition + body, then execute that body's observe → diff → surface → write → evaluate pipeline (the steps in skills/canon/commands/loop-tick.md), using the loop's state.path (substitute ${WORKSPACE}) for the prior snapshot. Read-only observation only (dc-06)."
})
```

Choose `active` (4m / 240s) when a probe ran this tick (archive had `has_run_summary === true`
and `select_mutation_targets` was called); choose `idle` (30m / 1800s) when the probe was
skipped (most-recent archive has `has_run_summary === false` — no attribution data yet).
