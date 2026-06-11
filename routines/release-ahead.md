---
name: release-ahead
title: Release Ahead Check
status: enabled

trigger:
  kind: schedule
  cron: "0 9 * * *"

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

## Routine: Release Ahead Check

### Intent
Each morning, check whether the local main branch is ahead of the latest published release tag. If commits exist that have not been released, open or update a tracking issue on the repository to notify maintainers that a release is pending.

### Body
This routine runs from a fresh clone. It does not require any local state beyond the repository checkout.

```bash
# From the root of a fresh clone of the canon repository:

# Fetch all tags to ensure we have the latest release tag
git fetch --tags

# Find the most recent release tag
LATEST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")

if [ -z "$LATEST_TAG" ]; then
  echo "No release tags found. Skipping release-ahead check."
  exit 0
fi

# Count commits on main that are not in the latest release tag
COMMIT_COUNT=$(git rev-list --count "${LATEST_TAG}..HEAD")

echo "Latest tag: ${LATEST_TAG}"
echo "Commits ahead of ${LATEST_TAG}: ${COMMIT_COUNT}"

if [ "$COMMIT_COUNT" -gt 0 ]; then
  echo "RELEASE_PENDING: ${COMMIT_COUNT} unreleased commits on main."
  echo "Action: open or update a tracking issue titled 'Release pending: ${COMMIT_COUNT} commits ahead of ${LATEST_TAG}'."
  echo "The issue body should list the unreleased commits:"
  git log "${LATEST_TAG}..HEAD" --oneline
else
  echo "UP_TO_DATE: main is at the latest release tag ${LATEST_TAG}."
fi
```

When `COMMIT_COUNT > 0`, post or update a GitHub issue titled:
`Release pending: <count> commits ahead of <latest-tag>`

Issue body must include:
- The latest tag name and the current HEAD SHA
- The list of unreleased commits (`git log --oneline`)
- The date of the check

If an open issue with this title already exists, update it with the new count and commit list. If the count drops to 0 (a new release was cut), close the issue.

This routine posts a notification only (`repo_writes: notify-only` — it opens/updates issues but does not open PRs, push branches, or merge code).

### Guardrail notes
`repo_writes: notify-only` — this routine only opens or updates GitHub issues. It never pushes code, merges branches, or creates pull requests.
