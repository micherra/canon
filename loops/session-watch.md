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
    - docs_stale_crossed          # boolean: commits-since-scribe crossed threshold this tick
    - kg_age_crossed              # boolean: KG DB mtime age crossed threshold this tick
    - staleness_refresh_signatures # de-dupe ledger key set (mirrors .staleness-refreshed.json)
observe:
  tools:
    - Bash
  mcp:
    - reconcile_workspace
  shell_commands:
    - "git log"
    - "git rev-list"
    - "git rev-parse"
    - "stat"
    - "date"
surface:
  on_transition:
    - field: surfaced_cliff_signatures
      append: true
      message: "Mid-flight cliff detected on a long/backgrounded step — surfacing once via the cliff→HITL pattern."
    - field: kg_stale
      to: "true"
      fire_on_baseline: true
      message: "Knowledge graph looks stale — dependency reasoning may be degraded. Consider re-running codebase_graph."
    - field: open_drift_crossed
      to: "true"
      message: "Open drift / partially-finished work accumulating — surfacing the staleness digest."
    # NO fire_on_baseline here (ADR-0056): the auto-staleness-refresh directive is already
    # tick-1 capable via the .staleness-refreshed.json ledger emitted from this loop's body
    # (ADR-0045). These rules are the tick-2+ observability echo. Adding the flag double-fires.
    - field: docs_stale_crossed
      to: "true"
      orchestrator_action: auto-staleness-refresh
      message: "Docs stale (N commits since last scribe) — auto-refresh directive emitted."
    - field: kg_age_crossed
      to: "true"
      orchestrator_action: auto-staleness-refresh
      message: "Knowledge graph over age threshold — auto-refresh directive emitted."
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
accumulating drift, and — the auto-refresh sub-concern below — doc/KG staleness against a
declared threshold). Both concerns are observe+surface only — no build mutations.

**dc-06 note:** The orchestrator's session-start tap starts this loop by calling
`ScheduleWakeup`. Authoring this file only registers the definition. Do not call
`ScheduleWakeup` from within this body to start the loop — only to re-arm the next tick.

**First-tick baseline (ADR-0002, amended by ADR-0056):** On tick 1 there is no prior
snapshot, so no `on_transition` rule fires — **with one exception**: `kg_stale` declares
`fire_on_baseline: true` and fires on tick 1 if the observed value already equals `"true"`
(i.e. the KG already looks stale at session-open). No other rule in this loop carries the
flag — `surfaced_cliff_signatures` is `append`-mode (ineligible), `open_drift_crossed` is
tick-relative by body construction, and `docs_stale_crossed`/`kg_age_crossed` are
deliberately excluded (see the comment above those two rules — their directive is already
tick-1 capable via the ADR-0045 ledger; adding the flag would double-fire).

Write the baseline snapshot and report the baseline capture, noting whether `kg_stale`
fired:
- If it fired: `[loop: session-watch] Tick 1 baseline captured (1 rule fired on baseline). Watching from next tick.`
- Otherwise: `[loop: session-watch] Tick 1 baseline captured. Watching from next tick.`

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
  to the current `git rev-parse HEAD` output (now backed by the `observe.shell_commands`
  allowlist below — no behavior change to this check). Set `kg_stale: true` if the KG is >3
  commits behind HEAD. Use `reconcile_workspace` output (already called above) to infer
  activity — if recent steps are active, KG staleness is more likely relevant.
- Check open-drift count: from the `reconcile_workspace` result, if `needs_recovery: true`
  and the same cliff has been in the ledger for >2 ticks without resolution, set
  `open_drift_crossed: true`.

Both staleness reads are best-effort (fail-open). If the KG DB is unavailable, skip and
leave `kg_stale` unchanged.

### Staleness Thresholds

Declared here in the loop definition — not hard-coded in runner logic (AC6). Tune by
editing this block, not by editing the observe steps below.

- **KG age**: `24h` (honors the `CANON_KG_STALE_SECONDS` env var, default `86400` seconds —
  the same threshold and env var `hooks/canon-agent-teams/session-start-kg-check.sh` uses).
- **Commits-since-scribe**: `15` (a net-new *action* threshold — the sibling hook,
  `hooks/canon-agent-teams/session-start-doc-check.sh`, nudges on any divergence with no
  numeric threshold of its own; auto-dispatching a scribe→PR flow needs a higher bar than a
  passive nudge).

**Staleness auto-refresh sub-concern (idle cadence only, mirrors the cliff ledger above):**

- **Observe commits-since-scribe**: run
  `git log -E --grep='^docs\(context-sync\)' --grep='^Canon-Agent: scribe[[:space:]]*$' --format='%H' -n1`
  to find the last-scribe SHA — the identical computation `session-start-doc-check.sh` uses
  (single source of truth, no second detection path) — then run
  `git rev-list --count <LAST_SHA>..HEAD` for the commit count. Set `docs_stale_crossed: true`
  when the count is `>= 15` (the commits-since-scribe threshold above); otherwise `false`.
- **Observe KG age**: run `stat -f %m .canon/knowledge-graph.db` (BSD/macOS) or
  `stat -c %Y .canon/knowledge-graph.db` (GNU) for the DB's mtime, and `date +%s` for "now".
  Compute `age = now - mtime`. Set `kg_age_crossed: true` when
  `age > CANON_KG_STALE_SECONDS` (default `86400`, the KG-age threshold above); otherwise
  `false`. Best-effort fail-open: if the DB is absent or `stat` fails, leave
  `kg_age_crossed` unchanged (mirrors the existing `kg_stale` fail-open behavior).
- **De-dupe ledger** (mirrors `.cliff-surfaced.json`): read
  `${WORKSPACE}/.staleness-refreshed.json` — a JSON array of episode signatures. Compute the
  episode signature for each crossed signal this tick: `docs:<last_scribe_sha_short>` for
  `docs_stale_crossed`, `kg:<kg_db_mtime_epoch>` for `kg_age_crossed`. Keep only signatures
  NOT already in the ledger — these are new staleness episodes unrefreshed this session.
  Update the `staleness_refresh_signatures` snapshot field with the new signatures (append
  semantics, same as `surfaced_cliff_signatures`).
- **Silent no-op (AC5)**: when neither signal crosses its threshold, there are no new
  signatures this tick — nothing is appended to the ledger or to
  `staleness_refresh_signatures`, and nothing is emitted in Surface-once below. Only the
  snapshot write happens.

### Diff against snapshot

Apply `on_transition` rules per the runner Step 5 algorithm (ADR-0002 first-tick guard applies,
with `kg_stale`'s `fire_on_baseline` exception — see Step 5 and the first-tick section above).
Since `surfaced_cliff_signatures` uses `append: true`, the rule fires when new signatures are
appended to the set (i.e., the set grew this tick).

### Surface-once

After the diff determines which rules fire:
1. For each new cliff signature in `toSurface`, surface the cliff message (from the
   transition rule).
2. Append the new signatures to the de-dupe ledger (`${WORKSPACE}/.cliff-surfaced.json`)
   using the cliff-ledger `appendLedger` pattern: read → surface → append.
3. For each new staleness signature computed in Observe (docs_stale and/or kg_age), emit the
   directive line — `ORCHESTRATOR_ACTION: auto-staleness-refresh field=docs_stale
   loop=session-watch` and/or `ORCHESTRATOR_ACTION: auto-staleness-refresh field=kg_age
   loop=session-watch` — then append the new signature(s) to the de-dupe ledger
   (`${WORKSPACE}/.staleness-refreshed.json`) using the same read → surface → append pattern.
   This is what makes the directive tick-1 capable (fires on an already-stale-at-session-start
   condition, which a pure `on_transition` rule would miss — ADR-0002 first-tick guard); the
   `on_transition` rules on `docs_stale_crossed`/`kg_age_crossed` above cover the
   observability/tick-2+ human-facing message for a later mid-session transition.
4. `kg_stale` is NOT enumerated above because it needs no body-side handling — its
   `fire_on_baseline: true` flag (ADR-0056) makes it tick-1 capable through the generic
   runner Step 5/6 path alone, unlike the ledger-driven staleness directives in step 3.
   It surfaces via the ordinary fall-through, both on tick 1 (if already stale) and on any
   later transition.

This prevents double-HITL collisions with the resume/post_subagent cliff passes: once a
signature is in the ledger, session-watch suppresses it on subsequent ticks. The same
suppression applies to the staleness ledger: once an episode signature is recorded, it is
not re-surfaced until the underlying value changes (a refresh advances the last-scribe SHA
or the KG mtime, producing a new signature).

### Write snapshot

Write the updated snapshot atomically to `${WORKSPACE}/session-watch-state.json`:

```json
{
  "surfaced_cliff_signatures": ["<sig1>", "<sig2>"],
  "kg_stale": false,
  "open_drift_crossed": false,
  "docs_stale_crossed": false,
  "kg_age_crossed": false,
  "staleness_refresh_signatures": ["<sig1>", "<sig2>"],
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
  prompt: "Run one tick of Canon loop \"session-watch\": call get_loop_definition({ id: \"session-watch\" }) to load its definition + body, then execute that body's observe → diff → surface → write → evaluate pipeline (the steps in skills/canon/commands/loop-tick.md), using the loop's state.path (substitute ${WORKSPACE}) for the prior snapshot. Read-only observation only (dc-06)."
})
```

Choose `active` (4m / 240s) when a long/backgrounded step is currently in flight (cliff
concern active); choose `idle` (30m / 1800s) when the session is quiet (staleness-only cadence).
Both values are within the harness clamp [60, 3600].
