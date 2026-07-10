---
description: Generic loop runner — execute one tick of a named loop definition. Supports both interval (CronCreate) and self-paced (ScheduleWakeup) modes.
argument-hint: [loop-id]
allowed-tools:
  - Read
  - Write
  - Bash
  - mcp__canon__get_loop_definition
  - mcp__canon__list_loops
model: sonnet
---

# /canon:loop-tick <loop-id>

Generic, definition-driven loop tick runner. Contains **zero loop-specific logic** — all
behavior is encoded in the loop's definition file (`loops/<id>.md`). The definition drives
everything: what to observe, when to surface, when to terminate.

**Registered-install convenience form:** `/canon:loop-tick <id>` is the registered-install
convenience form of the tick — it is available when this slash command is live in the running
session. The orchestrator's default dispatch is the equivalent self-contained inline prompt
(calls `get_loop_definition({ id })` and runs this body), which works even when this command
is not registered in the running plugin (stale-install class). This runner body IS the
canonical step source that the inline prompt refers to. See CLAUDE.md §Loop Framework
"Resilient dispatch" for the canonical inline prompt text and ADR-0017 for the decision.

**Non-declarative constraint (dc-06, decision loops-phase-a-04):** This runner is the
per-tick body. The orchestrator made the initial scheduling call (`CronCreate` for interval
loops, `ScheduleWakeup` for self-paced loops) at a named lifecycle moment (`post-ship`,
`on-long-dispatch`, or `session-start`). This runner re-arms the NEXT wakeup of an
already-started self-paced loop — it NEVER starts a loop (the orchestrator's session-start
tap does that).

## Step 1: Parse argument and load the definition

Extract the loop `id` from `${ARGUMENTS}`.

Call `mcp__canon__get_loop_definition({ id })`.

If not found (INVALID_INPUT error): report "Loop '<id>' not found in loops/ registry." and STOP.

## Step 2: Mode branch

Both modes execute the same core observe → diff → surface → write → evaluate pipeline
(Steps 3–8). The mode controls Step 8 rescheduling only.

- If `definition.mode === "interval"`: proceed with Steps 3–8. Rescheduling is handled
  by the orchestrator's `CronCreate` cadence (nothing to do in Step 8 "If NOT terminal").
- If `definition.mode === "self-paced"`: proceed with Steps 3–8. In Step 8 "If NOT terminal",
  re-arm the next wakeup via `ScheduleWakeup` per the probe result. Choose `delaySeconds`
  from `definition.schedule.cadence_hint`:
  - `active` cadence when this tick surfaced something or work is in flight (parse the string
    to seconds, clamp to the runtime window [60, 3600]).
  - `idle` cadence otherwise (prefer idle ≥ 1200s to commit to a real backoff once paying
    the cache miss; prefer active ≤ 270s to keep the Anthropic prompt cache warm).
  
  Honor `definition.schedule.max_wall` as a hard wall-clock cap if set:
  - Track elapsed time (first-tick timestamp stored in snapshot or state) + tick count.
  - When `max_wall` is exceeded: terminate with reason `max_wall_reached`. Do NOT re-arm.
  
  Self-paced `terminate.when` vocabulary honored at Step 8:
  - `at_hitl_gate`: terminate when a HITL gate is open
  - `at_finalize`: terminate when the workspace is being finalized
  - `on_cliff_surfaced`: terminate after surfacing a cliff (self-terminates; resume/post_subagent own rest)
  - `max_wall_reached`: terminate when `max_wall` elapsed time is exceeded (body-enforced)

## Step 3: Read the current state snapshot

Resolve `definition.state.path` — substitute `${WORKSPACE}` with the current workspace path.

Read the state file (JSON). If absent (first tick or reset): treat all `definition.state.snapshot`
fields as absent (initialize to null/0 as appropriate for the loop's semantics).

Extract the current values for each field in `definition.state.snapshot`.

## Step 4: Run the observe action

Execute the observe behavior described in the definition body. For each field in
`definition.state.snapshot`, produce an updated value:

- Use only `definition.observe.tools` and `definition.observe.mcp` — no tools outside
  these lists (the guardrail is mechanical; the definition already passed schema validation).
- If `Bash` is in `definition.observe.tools`, invoke only commands whose prefix appears in
  `definition.observe.shell_commands` — the schema has already validated these are read-only.
- For `_probe`: observe = read `tick_count` from state (or 0 if absent), increment by 1.
  No external calls required — _probe's observe is a trivial counter.

Record the updated snapshot values.

## Step 5: Diff against last snapshot

**First-tick guard (ADR-0002):** A field whose *prior* value is absent — because there is no
state file yet (first tick) or the field is missing from the prior snapshot — is NOT a
transition. Such a field never matches any `on_transition` rule (not even an any-change or
`to:`-matching rule). On the first tick, ALL fields have an absent prior, so zero rules fire;
the tick still writes the baseline snapshot (Step 7) and reports a non-surfacing baseline tick.

Compare each field in the updated snapshot against the last-seen values from Step 3.

For each changed field, check `definition.surface.on_transition` rules:
- Match when `rule.field` matches the field name AND every set condition holds:
  - If `rule.from` is set, the last value must equal `rule.from` — else the rule does not fire.
  - If `rule.to` is set, the new value must equal `rule.to` — else the rule does not fire.
  - If BOTH `rule.from` and `rule.to` are set, both must hold simultaneously (AND, not OR) —
    the rule fires only on that exact transition. Two rules on the same field with disjoint
    `from`/`to` pairs (e.g. `ci_conclusion` `pending→failure` and `pending→success`) are
    mutually exclusive and never cross-fire.
  - If neither `rule.from` nor `rule.to` is set, any change from a *present* prior fires the rule.

Collect all fired rules. If a rule has `terminate: true`, mark the loop for termination.

## Step 6: Surface transitions

For each fired transition rule (not already surfaced this run):
- Emit the `rule.message` as a status update (print to output).
- If `rule.append` is true, append to the surfacing log rather than replacing.
- If the rule carries an `orchestrator_action` field, in addition to emitting `rule.message`,
  emit a structured signal line for the orchestrator to consume:
  ```
  ORCHESTRATOR_ACTION: <orchestrator_action> field=<rule.field> loop=<id>
  ```
  `<orchestrator_action>` is substituted verbatim from `rule.orchestrator_action` — the SAME
  instruction serves every vocabulary value (`auto-triage-fix`, `auto-plugin-update`, and any
  future member) with **no per-action branching**. The runner only PRINTS this line — it never
  performs the action. The orchestrator consumes the signal (see CLAUDE.md § Loop Framework,
  "Consuming `orchestrator_action`").

Example output line: `[loop: _probe] Probe tick 3 reached — Loop Framework Phase A path proven.`

**On a baseline (first) tick, surface nothing** — report:
`[loop: <id>] Tick 1 baseline captured. Watching from next tick.`

## Step 7: Write the updated snapshot

Write the updated snapshot values back to `definition.state.path` (JSON format):

```json
{
  "tick_count": <new_value>,
  "last_tick": "<ISO-8601 timestamp>"
}
```

Create parent directories if needed. Use atomic write (write to temp, rename) if possible.

## Step 8: Evaluate termination

Check `definition.terminate.when` conditions:

| Condition | Satisfied when |
|-----------|----------------|
| `max_ticks_reached` | `definition.schedule.max_ticks` is set AND current tick equals or exceeds it |
| Custom condition | Evaluate against the updated snapshot as needed |

Also terminate if any fired transition rule has `terminate: true`.

**If terminal condition is met:**
- Report: `[loop: <id>] Loop terminated after tick <N>. Reason: <condition>.`
- Do NOT reschedule. For interval loops, the recurring CronCreate schedule does NOT self-exhaust
  (the `max` param is gone; a `recurring: true` cron fires until session exit / 7-day expiry /
  explicit delete) — so the orchestrator MUST stop it with an explicit `CronDelete({ id })` at
  the terminal moment (`id` = the job id returned by the initial `CronCreate`). This is
  orchestrator-initiated per dc-06; the read-only tick runner only surfaces the terminal signal.
  For self-paced loops, simply OMIT the ScheduleWakeup call to terminate — no auto-re-fire
  occurs. Done.

**If NOT terminal:**
- **interval mode**: Report `[loop: <id>] Tick <N> complete. Next tick at <interval>.`
  The CronCreate schedule set by the orchestrator will fire this runner again at the next
  interval. Nothing to do here — the schedule is already running.
- **self-paced mode**: Re-arm the next wakeup by calling `ScheduleWakeup` with:
  ```
  ScheduleWakeup({
    delaySeconds: <cadence_hint.active | cadence_hint.idle, parsed to seconds, clamped [60,3600]>,
    reason: "[loop: <id>] Tick <N> complete. Re-arming at <active|idle> cadence.",
    prompt: "<inline tick prompt for <id> — load def via get_loop_definition, run this body>"
  })
  ```
  Use the canonical inline tick prompt from CLAUDE.md §Loop Framework "Resilient dispatch"
  (substituting `<id>`). The re-arm fires unattended on the running install, so it has the
  same staleness exposure as the initial dispatch — use the inline form, not the slash call.
  Report: `[loop: <id>] Tick <N> complete. Re-armed at <cadence> cadence (<delaySeconds>s).`

---

## Notes

- **No per-loop branching.** If you find yourself special-casing `_probe` or `ship-watch`
  in this runner, STOP — that logic belongs in the definition's body section.
- **Phase boundary.** Phase A: interval-mode only (CronCreate). Phase C adds self-paced mode
  (ScheduleWakeup). Both modes execute the same observe→diff→surface→write→evaluate pipeline.
- **_probe is the runnable proof.** Invoking `/canon:loop-tick _probe` in the Phase A
  verify step demonstrates the full schema→registry→runtime path end-to-end (registered-install form).
- **First-tick baseline (ADR-0002).** The first tick captures a baseline snapshot and surfaces
  nothing — transition rules always compare against a known prior value (present from tick 2+).
  This eliminates false-fires from conditions already true at arm time.
