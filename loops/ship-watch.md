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
    - merge_state
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
      orchestrator_action: auto-triage-fix
      message: "CI failed — surfacing failing job + log. ship-watch terminating."
      terminate: true
    - field: ci_conclusion
      from: pending
      to: success
      orchestrator_action: auto-enable-merge
      message: "CI is green on the open PR — surfacing auto-enable-merge (orchestrator arms squash auto-merge)."
    - field: release_tag
      orchestrator_action: auto-plugin-update
      message: "Release tag cut — reminder: run plugin-update so the new version goes live."
    - field: external_review_comment_ids
      append: true
      orchestrator_action: auto-triage-fix
      message: "New external review comment(s) on the PR — surfacing for triage."
    - field: merge_state
      to: BEHIND
      orchestrator_action: auto-update-branch
      message: "PR branch is behind main — surfacing auto-update-branch (orchestrator merges origin/main into the PR branch and pushes)."
    - field: merge_state
      to: DIRTY
      orchestrator_action: auto-update-branch
      message: "PR branch conflicts with main — surfacing auto-update-branch (orchestrator merges origin/main into the PR branch and pushes)."
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
   # Derive pr_state, ci_conclusion, and merge_state:
   gh pr view <pr-number> --json state,statusCheckRollup,mergeStateStatus
   ```
   - `pr_state` = the `state` field (`OPEN`, `MERGED`, `CLOSED`).
   - `ci_conclusion` = aggregate `statusCheckRollup`:
     - Any `FAILURE` or `ERROR` → `failure`
     - All `SUCCESS` → `success`
     - Otherwise (any `PENDING` / `IN_PROGRESS` / absent) → `pending`
   - `merge_state` = the `mergeStateStatus` field verbatim — GitHub's own enum
     (`BEHIND`, `DIRTY`, `CLEAN`, `BLOCKED`, `UNSTABLE`, `UNKNOWN`, `DRAFT`, `HAS_HOOKS`),
     passed through unmodified with no reinterpretation.

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

Compare each of the five fields against the last-seen value from `state.path`:

- `pr_state` — string equality.
- `ci_conclusion` — string equality.
- `release_tag` — string equality (null → non-null is a transition).
- `external_review_comment_ids` — array equality; new IDs present = transition (append mode).
- `merge_state` — string equality.

### Surface on transition

Apply `surface.on_transition` rules (transition-only — silent on no-op ticks):

1. **`ci_conclusion`: `pending` → `failure`** — emit the failure message and mark for
   termination. Optionally surface the failing job: `gh pr checks <pr-number>` to show
   which check failed. Carries `orchestrator_action: auto-triage-fix` — the ORCHESTRATOR
   reads the failing CI job logs and dispatches a fix flow (or asks first if ambiguous).
   The runner only surfaces the signal; it does NOT act on it.

2. **`ci_conclusion`: `pending` → `success`** — emit the auto-enable-merge message. Carries
   `orchestrator_action: auto-enable-merge` — the ORCHESTRATOR read-only-prechecks the PR
   (`gh pr view --json state,autoMergeRequest`) and, if OPEN and not already armed, runs
   `gh pr merge <pr> --auto --squash` (unattended on autonomous/light-touch, ask-first on
   supervised). No `terminate` on this rule — the loop keeps watching until `resolved` fires
   naturally when GitHub completes the merge. This rule and the `pending → failure` rule above
   are mutually exclusive (AND from/to matching) and never cross-fire. The runner only surfaces
   the signal; it does NOT run `gh pr merge`.

3. **`release_tag` transitions** (null→tag, or tag changes) — emit the plugin-update
   reminder message. Carries `orchestrator_action: auto-plugin-update` — the ORCHESTRATOR
   asks the user to confirm, then runs plugin-update and confirms the new version is active.
   The runner only surfaces the signal; it does NOT run plugin-update.

4. **`external_review_comment_ids` gains new IDs** — emit the new-comment message (append
   mode: prior surfaces remain visible; only new IDs trigger). Carries
   `orchestrator_action: auto-triage-fix` — the ORCHESTRATOR reads the new PR comment(s)
   and dispatches a fix flow (or asks first if ambiguous). The runner only surfaces the
   signal; it does NOT act on it.

5. **`merge_state`: → `BEHIND`** — emit the auto-update-branch message. Carries
   `orchestrator_action: auto-update-branch` — the ORCHESTRATOR merges `origin/main` into
   the PR branch and pushes. No `terminate` on this rule — the loop keeps watching (the
   branch update may itself flip `merge_state` again, or CI/review transitions may still
   need to surface). The runner only surfaces the signal; it does NOT run any `git merge`
   or `git push`.

6. **`merge_state`: → `DIRTY`** — emit the auto-update-branch message (same action as
   `BEHIND`; `DIRTY` means the merge would produce real conflicts, which the ORCHESTRATOR's
   consumption contract handles by attempting a merge and routing genuine source conflicts
   to HITL — see `references/loop-framework.md`). No `terminate` on this rule. The runner
   only surfaces the signal; it does NOT run any `git merge` or `git push`.

Ticks where no field changes: emit nothing. Silent on no-op is by construction.

### auto-update-branch

`merge_state` transitioning to `BEHIND` or `DIRTY` means the watched PR's branch has
fallen behind `origin/main` (or now conflicts with it) since the PR was opened or since
the loop's last tick — this is exactly the failure mode that let PR #462 sit with an
armed-but-stalled auto-merge until a human noticed. The loop's job stops at observation:
it reads `mergeStateStatus` via the existing read-only `gh pr view` call (already on the
`observe.shell_commands` allowlist — no allowlist change needed) and surfaces
`ORCHESTRATOR_ACTION: auto-update-branch field=merge_state loop=ship-watch` when the
transition fires. The runner never runs `git merge`, `git push`, or any other mutating
command (dc-06; `guardrails.mutates_build` stays `false`, and no mutating `git`/`gh`
subcommand is on this loop's `observe.shell_commands` allowlist). The ORCHESTRATOR
performs the actual branch update — read-only precheck, merge `origin/main` into the PR
branch, resolve generated-artifact conflicts by regeneration, re-run the manifest gate,
then push. Full consumer contract: `references/loop-framework.md`.

### Write snapshot

Persist the five fields plus `last_tick` (ISO-8601 timestamp) to `state.path` atomically:

```json
{
  "pr_state": "<value>",
  "ci_conclusion": "<value>",
  "release_tag": "<value or null>",
  "external_review_comment_ids": [<sorted-ids>],
  "merge_state": "<value>",
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
