#!/bin/bash
# Canon Pre-Push Review Guard Hook
# Runs as a PreToolUse hook on Bash commands containing "git push".
# Checks if a Canon review has been logged for the commits being pushed.
# If not, warns (but does not block) so the user can run /canon:review first.
#
# Input: JSON on stdin with the tool call details
# Output: Warning message on stdout (if applicable)
# Exit 0: always (advisory only, never blocks)

set -euo pipefail

# Read tool input
INPUT=$(cat)

# Extract command
COMMAND=$(echo "$INPUT" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"command"[[:space:]]*:[[:space:]]*"//;s/"$//' || true)

# Only trigger on git push commands
if ! echo "$COMMAND" | grep -qE '\bgit\b.*\bpush\b'; then
  exit 0
fi

# Check if reviews.jsonl exists
REVIEWS_FILE=".canon/reviews.jsonl"
if [[ ! -f "$REVIEWS_FILE" ]]; then
  cat <<EOF
CANON WARNING: No Canon reviews logged for this project. Consider running /canon:review before pushing to check principle compliance.
EOF
  exit 0
fi

# Get the current branch
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
if [[ -z "$BRANCH" ]]; then
  exit 0
fi

# Get the remote tracking branch to find unpushed commits
UPSTREAM=$(git rev-parse --abbrev-ref "@{upstream}" 2>/dev/null || echo "")
if [[ -n "$UPSTREAM" ]]; then
  # Count commits being pushed
  UNPUSHED=$(git rev-list "$UPSTREAM"..HEAD --count 2>/dev/null || echo "0")
else
  # No upstream — count commits not reachable from any remote branch
  UNPUSHED=$(git rev-list HEAD --count --not --remotes 2>/dev/null || echo "0")
fi

if [[ "$UNPUSHED" == "0" ]]; then
  exit 0
fi

# Check if the most recent review covers recent work
# Compare the last review timestamp against the oldest unpushed commit
LAST_REVIEW_TS=$(tail -1 "$REVIEWS_FILE" 2>/dev/null | grep -o '"timestamp":"[^"]*"' | grep -o '[0-9T:Z.+-]*' | head -1 || echo "")

if [[ -z "$LAST_REVIEW_TS" ]]; then
  cat <<EOF
CANON WARNING: Pushing ${UNPUSHED} commit(s) without a Canon review. Consider running /canon:review first.
EOF
  exit 0
fi

# Get the oldest unpushed commit timestamp
if [[ -n "$UPSTREAM" ]]; then
  OLDEST_UNPUSHED_TS=$(git log "$UPSTREAM"..HEAD --format="%aI" --reverse 2>/dev/null | head -1 || echo "")
else
  OLDEST_UNPUSHED_TS=$(git log HEAD --not --remotes --format="%aI" --reverse 2>/dev/null | head -1 || echo "")
fi

if [[ -z "$OLDEST_UNPUSHED_TS" ]]; then
  exit 0
fi

# Convert timestamps to epoch for comparison — handle both GNU and BSD date
# Input: ISO-8601 like 2026-03-15T10:30:00Z, 2026-03-15T10:30:00.123Z,
#         2026-03-15T10:30:00+05:00, 2026-03-15T10:30:00.123+05:00
to_epoch() {
  local ts="$1"
  # GNU date handles ISO-8601 natively
  if date -d "$ts" +%s >/dev/null 2>&1; then
    date -d "$ts" +%s
  else
    # BSD date (macOS): strip fractional seconds and timezone suffix,
    # keeping YYYY-MM-DDTHH:MM:SS intact.
    # Remove trailing Z
    local clean="${ts%Z}"
    # Remove fractional seconds (.123, .123456, etc.)
    clean=$(echo "$clean" | sed 's/\.[0-9]*//')
    # Remove timezone offset (+HH:MM or -HH:MM) at the end — but only
    # a trailing offset (5 chars from end: ±HH:MM), not date hyphens.
    clean=$(echo "$clean" | sed 's/[+-][0-9][0-9]:[0-9][0-9]$//')
    if date -jf "%Y-%m-%dT%H:%M:%S" "$clean" +%s >/dev/null 2>&1; then
      date -jf "%Y-%m-%dT%H:%M:%S" "$clean" +%s
    else
      echo "0"
    fi
  fi
}

REVIEW_EPOCH=$(to_epoch "$LAST_REVIEW_TS")
COMMIT_EPOCH=$(to_epoch "$OLDEST_UNPUSHED_TS")

# If the last review is older than the oldest unpushed commit, warn
if [[ "$REVIEW_EPOCH" -lt "$COMMIT_EPOCH" ]]; then
  cat <<EOF
CANON WARNING: Pushing ${UNPUSHED} commit(s) — last Canon review was before these changes. Consider running /canon:review first.
EOF
fi

exit 0
