---
name: workspaces
description: Manage Canon build workspaces — list, inspect, clean, and diff
---

# /canon:workspaces

Manage Canon build workspaces.

## Subcommands

### list
Show all workspaces with status, branch, task, and age.

```bash
# Find all workspace directories
ls -d .canon/workspaces/*/
```

For each workspace:
1. Read `session.json` for branch, task, tier, flow, status
2. Read `board.json` for current_state, started, last_updated
3. Calculate age from `started`
4. Display in a table:

| Branch | Task | Flow | Tier | Status | Current State | Age |
|--------|------|------|------|--------|---------------|-----|

### inspect <workspace>
Show detailed board state for a specific workspace.

1. Read `board.json` — show all states with status, entries, result
2. Read `session.json` — show metadata
3. Show concerns if any
4. Show iterations (count/max) for looping states
5. Show blocked info if blocked
6. If `log.jsonl` exists, show last 10 entries

### clean
Remove completed/aborted workspaces older than N days (default 7).

1. Scan all workspaces
2. Filter: `session.json` status is `completed` or `aborted`
3. Filter: `started` is older than N days
4. Show what will be removed and ask for confirmation
5. On confirmation, `rm -rf` each workspace directory

### diff <workspace>
Show the git log for a workspace's build.

1. Read `board.json` for `base_commit`
2. Run `git log --oneline {base_commit}..HEAD`
3. Run `git diff --stat {base_commit}..HEAD`
