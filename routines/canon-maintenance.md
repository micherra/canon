---
name: canon-maintenance
title: Canon Maintenance Run
status: enabled

trigger:
  kind: schedule
  cron: "0 3 * * *"

needs:
  state: local-canon
  daemon: true
binding_target: ~

repos: [canon]
scope: repo

guardrails:
  mutates_running_build: false
  repo_writes: draft-pr
  consent: opt-in

recurrence: standing
---

## Routine: Canon Maintenance Run

### Intent
Each night at 03:00, perform a full Canon maintenance pass on the local working tree: sync context documentation (scribe), prune orphaned workspace artifacts (janitor), and optionally run a drift sweep. All changes are collected into a draft pull request and a desktop notification is posted. No changes are merged automatically.

### Body
This routine runs on the desktop (local machine) against the live local Canon repository. It requires a running Canon MCP daemon (`daemon: true`) and access to local `.canon/` state.

The routine executes the following steps in sequence:

1. **Context sync (scribe)**: invoke the Canon scribe to sync `CLAUDE.md`, `context.md`, and `CONVENTIONS.md` with the current state of the codebase. The scribe commits its changes to a maintenance branch named `canon/maintenance-<date>`.

2. **Prune orphaned workspaces (janitor)**: run the Canon janitor to remove orphaned workspace directories (workspaces whose build branches no longer exist or whose tasks completed more than 7 days ago). The janitor commits its removals to the same maintenance branch.

3. **Optional drift sweep**: if the drift database has not been refreshed in the last 24 hours, run `get_drift_report` to update the drift signals. This step is skipped if a drift refresh already occurred today.

4. **Open a draft pull request**: push the maintenance branch and open a draft PR titled `chore(maintenance): nightly Canon maintenance <date>`. The PR description lists all changes made (synced docs, pruned workspaces, drift refresh status).

5. **Desktop notification**: post a local notification summarizing the maintenance run (files changed, workspaces pruned, draft PR URL).

All steps must complete before the draft PR is opened. If any step fails, log the error and open the draft PR with a partial-completion note rather than failing silently.

### Guardrail notes
This routine is bound to `desktop-task` — it requires `local-canon` state (reads from `.canon/` directories) and a running Canon MCP daemon (`daemon: true`). Cloud execution is not possible until the headless-MCP precondition (A3-headless) is green.

`repo_writes: draft-pr` is intentional: maintenance changes (doc sync, workspace prune) accumulate on a branch and are submitted as a draft PR for human review before merging. The routine never merges, pushes to main, or approves its own PR.

`mutates_running_build: false` is honored: the routine checks for an active workspace lock before starting and exits early if a build is in progress (adaptive-queen invariant).
