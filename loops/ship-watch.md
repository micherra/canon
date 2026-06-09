---
id: ship-watch
title: Ship Watch — post-ship CI / release / review observer
status: active
trigger:
  fired_by: orchestrator
  lifecycle_hook: post-ship
  firing_posture:
    autonomous: auto
    light-touch: auto
    supervised: opt-in
mode: interval
schedule:
  interval: 5m
  max_ticks: 24
state:
  scope: workspace
  path: ${WORKSPACE}/ship-watch-state.json
  snapshot:
    - pr_state
    - ci_conclusion
    - release_tag
    - external_review_comment_ids
observe:
  tools:
    - Bash
  mcp: []
  shell_commands:
    - gh pr view
    - gh pr checks
    - gh release list
    - gh api
    - gh repo view
surface:
  on_transition:
    - field: ci_conclusion
      from: pending
      to: failure
      message: "CI failed — surfacing failing job + log. ship-watch terminating."
      terminate: true
    - field: release_tag
      message: "Release tag cut — reminder: run plugin-update so the new version goes live."
    - field: external_review_comment_ids
      append: true
      message: "New external review comment(s) on the PR — surfacing for triage."
terminate:
  when:
    - resolved
    - ci_failure_surfaced
    - pr_closed
    - max_ticks_reached
guardrails:
  mutates_build: false
  forbidden_tools:
    - Write
    - Edit
    - NotebookEdit
---

## ship-watch — Post-Ship CI / Release / Review Observer

`ship-watch` is Canon's first real loop. It monitors a just-shipped PR for CI status,
release tags, and external review comments — surfacing only on meaningful transitions
and self-terminating on resolution.

### Observe (per tick, read-only)

All commands are GET-only. Do NOT use `gh api -X POST` or any other mutating flag.

1. Read the current state from `state.path` (`${WORKSPACE}/ship-watch-state.json`).
   If absent (first tick), treat all fields as null/undefined.

2. Resolve the PR number from the workspace context (e.g. `WORKSPACE` variable or the
   state file's `pr_number` if previously persisted). Use the most recently shipped PR.

3. Run these read-only commands (each is on the `observe.shell_commands` allowlist):

   ```
   # Derive pr_state and ci_conclusion:
   gh pr view <pr-number> --json state,statusCheckRollup
   ```
   - `pr_state` = the `state` field (`OPEN`, `MERGED`, `CLOSED`).
   - `ci_conclusion` = aggregate `statusCheckRollup`:
     - Any `FAILURE` or `ERROR` → `failure`
     - All `SUCCESS` → `success`
     - Otherwise (any `PENDING` / `IN_PROGRESS` / absent) → `pending`

   ```
   # Derive release_tag:
   gh release list -L 1
   ```
   - `release_tag` = the tag name of the most recent release, or null if none.

   ```
   # Derive external_review_comment_ids (GET only):
   gh api repos/{owner}/{repo}/pulls/{pr-number}/comments --jq '[.[].id]'
   ```
   - `external_review_comment_ids` = sorted JSON array of comment IDs.
   - Extract `{owner}` and `{repo}` from `gh repo view --json nameWithOwner`.

4. Record the updated values as the observed snapshot.

### Diff against snapshot

Compare each of the four fields against the last-seen value from `state.path`:

- `pr_state` — string equality.
- `ci_conclusion` — string equality.
- `release_tag` — string equality (null → non-null is a transition).
- `external_review_comment_ids` — array equality; new IDs present = transition (append mode).

### Surface on transition

Apply `surface.on_transition` rules (transition-only — silent on no-op ticks):

1. **`ci_conclusion`: `pending` → `failure`** — emit the failure message and mark for
   termination. Optionally surface the failing job: `gh pr checks <pr-number>` to show
   which check failed.

2. **`release_tag` transitions** (null→tag, or tag changes) — emit the plugin-update
   reminder message.

3. **`external_review_comment_ids` gains new IDs** — emit the new-comment message (append
   mode: prior surfaces remain visible; only new IDs trigger).

Ticks where no field changes: emit nothing. Silent on no-op is by construction.

### Write snapshot

Persist the four fields plus `last_tick` (ISO-8601 timestamp) to `state.path` atomically:

```json
{
  "pr_state": "<value>",
  "ci_conclusion": "<value>",
  "release_tag": "<value or null>",
  "external_review_comment_ids": [<sorted-ids>],
  "last_tick": "<ISO-8601>"
}
```

Write to a temp file alongside `state.path`, then rename to `state.path` (atomic write).
Create parent directories if needed.

### Evaluate termination

Evaluate `terminate.when` conditions against the updated snapshot:

| Condition | Satisfied when |
|-----------|----------------|
| `resolved` | `pr_state === "MERGED"` AND `ci_conclusion === "success"` AND `release_tag` is non-null |
| `ci_failure_surfaced` | A `ci_conclusion: pending → failure` transition rule fired this tick |
| `pr_closed` | `pr_state === "CLOSED"` (PR closed without merging) |
| `max_ticks_reached` | Current tick count equals or exceeds `schedule.max_ticks` (24) |

If any condition holds, report:
```
[loop: ship-watch] Loop terminated after tick <N>. Reason: <condition>.
```
Do NOT reschedule — the loop lifecycle ends here.

If no condition holds, report:
```
[loop: ship-watch] Tick <N> complete. Next tick at 5m.
```
The orchestrator's CronCreate schedule will fire this runner again.

### Non-declarative constraint (dc-06)

The orchestrator calls `CronCreate` to start this loop at the `post-ship` lifecycle moment.
The runner does NOT auto-start or reschedule from scratch — it is the per-tick body only.
Authoring this file registers the definition; it does NOT fire the loop.
