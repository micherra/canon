---
name: pr-review
title: Automated PR Review
status: enabled

trigger:
  kind: github-event
  event: "pull_request.opened|synchronize"

needs:
  state: git-native
  daemon: false
binding_target: ~

repos: [canon]
scope: repo

guardrails:
  mutates_running_build: false
  repo_writes: notify-only
  consent: opt-in

recurrence: standing
---

## Routine: Automated PR Review

### Intent
When a pull request is opened or updated, run the Canon reviewer prompt against the PR diff and post a single review comment. The comment surfaces principle violations, warnings, and suggestions based on the changed files. The routine never approves or requests changes — it posts an informational comment only.

### Body
This routine runs from a fresh clone checked out to the PR's head commit. It does not read local state.

The routine performs the following steps:

1. **Fetch the PR diff**: obtain the unified diff for the pull request (the changes introduced relative to the base branch). In a CI/cloud environment this is typically available via `git diff origin/<base>..<pr-head>` after fetching both refs.

2. **Load Canon principles**: load principles from `${CLAUDE_PLUGIN_ROOT}/principles/**` using the glob fallback. A fresh clone has no local overrides, so all principles come from the plugin directory. Do not attempt to read from local state directories.

3. **Run the reviewer prompt**: present the diff and the loaded principles to Claude using the Canon reviewer role. The reviewer identifies applicable principles for each changed file and checks for violations, warnings, and improvements.

4. **Post a single review comment**: use the GitHub API to post one comment on the PR (not an approving review, not a request-for-changes review — a plain `COMMENT`). The comment must include:
   - A summary of files reviewed and principles checked
   - Any `BLOCKING` violations (must be fixed before merge)
   - Any `WARNING` findings (recommended fixes)
   - Any `CLEAN` file list

Do not use `--incremental` mode for this routine. Incremental mode reads from a local review state file that does not exist in a fresh clone.

Do not post multiple comments on the same PR run — consolidate all findings into a single comment.

### Guardrail notes
`repo_writes: notify-only` — this routine posts a single review comment. It never approves PRs, requests changes, merges code, or pushes to any branch. The `COMMENT` event type is used exclusively (not `APPROVE` or `REQUEST_CHANGES`).
