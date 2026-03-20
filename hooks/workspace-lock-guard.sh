#!/bin/bash
# Canon Workspace Lock Guard
# Runs as a PreToolUse hook on Bash commands.
# Before git commit or git merge, checks if the workspace has an active .lock
# from another session. Advisory only — warns but does not block.
#
# Input: JSON on stdin with the tool call details
# Output: Warning message on stdout (if applicable)
# Exit 0: always (advisory only, never blocks)

set -euo pipefail

# Read the tool input from stdin
INPUT=$(cat)

# Extract the command being run
COMMAND=$(echo "$INPUT" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"command"[[:space:]]*:[[:space:]]*"//;s/"$//' || true)

# Only trigger on git commit or git merge commands
if ! echo "$COMMAND" | grep -qE '\bgit\b.*(commit|merge)\b'; then
  exit 0
fi

# Get the current branch
BRANCH=$(git branch --show-current 2>/dev/null || echo "")
if [[ -z "$BRANCH" ]]; then
  exit 0
fi

# Sanitize the branch name (same logic as the orchestrator)
SANITIZED=$(echo "$BRANCH" | tr '/' '--' | tr ' ' '-' | tr -cd 'a-zA-Z0-9-' | tr '[:upper:]' '[:lower:]' | cut -c1-80)
if [[ -z "$SANITIZED" ]]; then
  exit 0
fi

# Resolve main repo root for worktree support
MAIN_ROOT=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's|/\.git$||' || true)
CANON_DIR="${MAIN_ROOT:-.}/.canon"

LOCK_FILE="${CANON_DIR}/workspaces/${SANITIZED}/.lock"
if [[ ! -f "$LOCK_FILE" ]]; then
  exit 0
fi

# Read lock contents
LOCK_CONTENT=$(cat "$LOCK_FILE" 2>/dev/null || echo "{}")

# Extract started timestamp from lock
LOCK_STARTED=$(echo "$LOCK_CONTENT" | grep -o '"started"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"started"[[:space:]]*:[[:space:]]*"//;s/"$//' || true)

# Check if lock is stale (>2 hours old)
if [[ -n "$LOCK_STARTED" ]]; then
  LOCK_EPOCH=0
  if date -d "$LOCK_STARTED" +%s >/dev/null 2>&1; then
    LOCK_EPOCH=$(date -d "$LOCK_STARTED" +%s)
  elif date -jf "%Y-%m-%dT%H:%M:%S" "${LOCK_STARTED%Z}" +%s >/dev/null 2>&1; then
    LOCK_EPOCH=$(date -jf "%Y-%m-%dT%H:%M:%S" "${LOCK_STARTED%Z}" +%s)
  fi

  NOW_EPOCH=$(date +%s)
  STALE_THRESHOLD=$((2 * 60 * 60))  # 2 hours

  if [[ $LOCK_EPOCH -gt 0 ]] && [[ $((NOW_EPOCH - LOCK_EPOCH)) -gt $STALE_THRESHOLD ]]; then
    # Lock is stale — ignore it
    exit 0
  fi
fi

# Check if the lock belongs to a different session
SESSION_ID=$(echo "$INPUT" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"session_id"[[:space:]]*:[[:space:]]*"//;s/"$//' || true)
LOCK_SESSION=$(echo "$LOCK_CONTENT" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"session_id"[[:space:]]*:[[:space:]]*"//;s/"$//' || true)

# If same session or no session info, allow
if [[ -n "$SESSION_ID" ]] && [[ "$SESSION_ID" == "$LOCK_SESSION" ]]; then
  exit 0
fi
if [[ -z "$LOCK_SESSION" ]]; then
  exit 0
fi

cat <<EOF
CANON WARNING: Workspace lock detected on branch '${BRANCH}'. Another session (started ${LOCK_STARTED:-unknown}) may be running a build. Concurrent builds on the same branch can cause conflicts.
EOF

exit 0
