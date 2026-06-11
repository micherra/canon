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

**Non-declarative constraint (dc-06, decision loops-phase-a-04):** This runner is the
per-tick body. The orchestrator made the initial `CronCreate` call at a named lifecycle
moment (`post-ship`, `on-long-dispatch`, or `session-start`). This runner NEVER calls
`CronCreate` to start a loop — it only executes one tick of an already-scheduled loop.

## Step 1: Parse argument and load the definition

Extract the loop `id` from `${ARGUMENTS}`.

Call `mcp__canon__get_loop_definition({ id })`.

If not found (INVALID_INPUT error): report "Loop '<id>' not found in loops/ registry." and STOP.

## Step 2: Mode guard (decision loops-phase-a-03)

If `definition.mode === "self-paced"`:
> STOP with: "self-paced loops are deferred to Phase C; this runtime supports CronCreate
> (interval) only. To run a self-paced loop, use ScheduleWakeup (Phase C)."

Continue only for `mode: "interval"`.

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
- Match when: `rule.field` matches the field name, AND
  - `rule.from` is set → last value matched `rule.from`, OR
  - `rule.to` is set → new value equals `rule.to`, OR
  - neither from nor to set → any change from a *present* prior fires the rule.

Collect all fired rules. If a rule has `terminate: true`, mark the loop for termination.

## Step 6: Surface transitions

For each fired transition rule (not already surfaced this run):
- Emit the `rule.message` as a status update (print to output).
- If `rule.append` is true, append to the surfacing log rather than replacing.

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
- Do NOT reschedule. The loop lifecycle ends here — the orchestrator's CronCreate schedule
  is exhausted or the loop exits early by its own rules. Done.

**If NOT terminal:**
- Report: `[loop: <id>] Tick <N> complete. Next tick at <interval>.`
- The CronCreate schedule set by the orchestrator will fire this runner again at the
  next interval. Nothing to do here — the schedule is already running.

---

## Notes

- **No per-loop branching.** If you find yourself special-casing `_probe` or `ship-watch`
  in this runner, STOP — that logic belongs in the definition's body section.
- **Phase boundary.** Phase A: interval-mode only (CronCreate). Phase C adds self-paced mode
  (ScheduleWakeup). Both modes execute the same observe→diff→surface→write→evaluate pipeline.
- **_probe is the runnable proof.** Invoking `/canon:loop-tick _probe` in the Phase A
  verify step demonstrates the full schema→registry→runtime path end-to-end.
- **First-tick baseline (ADR-0002).** The first tick captures a baseline snapshot and surfaces
  nothing — transition rules always compare against a known prior value (present from tick 2+).
  This eliminates false-fires from conditions already true at arm time.
