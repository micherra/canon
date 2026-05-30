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

# Source shared hook helpers.
_HOOK_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/canon-hook-lib.sh"
# shellcheck source=hooks/lib/canon-hook-lib.sh
source "$_HOOK_LIB"

# Read the tool input from stdin
INPUT=$(cat)

# Extract the command being run
COMMAND=$(canon_extract_command "$INPUT")

# Only trigger on git commit or git merge commands
if ! canon_is_git_cmd "$COMMAND" "commit" && ! canon_is_git_cmd "$COMMAND" "merge"; then
  exit 0
fi

# Extract cd target so we resolve the branch in the right worktree.
GIT_DIR_ARG=$(canon_git_dir_arg "$COMMAND")

# Get the current branch (in the target directory if cd was used)
# DOCUMENTED FAIL-OPEN -- empty branch triggers pass-through at line 35
# shellcheck disable=SC2086
BRANCH=$(git $GIT_DIR_ARG branch --show-current 2>/dev/null || echo "")
if [[ -z "$BRANCH" ]]; then
  exit 0
fi

# Sanitize the branch name (same logic as the orchestrator)
SANITIZED=$(echo "$BRANCH" | sed 's|/|--|g' | tr ' ' '-' | tr -cd 'a-zA-Z0-9-' | tr '[:upper:]' '[:lower:]' | cut -c1-80)
if [[ -z "$SANITIZED" ]]; then
  exit 0
fi

# Resolve main repo root for worktree support
# shellcheck disable=SC2086
MAIN_ROOT=$(git $GIT_DIR_ARG rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's|/\.git$||') || { >&2 echo "CANON WARNING: [workspace-lock-guard] git root resolution failed"; MAIN_ROOT=""; }
CANON_DIR="${MAIN_ROOT:-.}/.canon"

LOCK_FILE="${CANON_DIR}/workspaces/${SANITIZED}/.lock"
if [[ ! -f "$LOCK_FILE" ]]; then
  exit 0
fi

# Read lock contents
LOCK_CONTENT=$(cat "$LOCK_FILE" 2>/dev/null) || { >&2 echo "CANON WARNING: [workspace-lock-guard] could not read lock file"; LOCK_CONTENT="{}"; }

# Extract started timestamp from lock
# DOCUMENTED FAIL-OPEN -- malformed lock content handled by empty LOCK_STARTED check at line 62
LOCK_STARTED=$(echo "$LOCK_CONTENT" | jq -r '.started // empty' 2>/dev/null || true)

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
# DOCUMENTED FAIL-OPEN -- empty SESSION_ID triggers allow-path at line 84
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
# DOCUMENTED FAIL-OPEN -- empty LOCK_SESSION triggers pass-through at line 88
LOCK_SESSION=$(echo "$LOCK_CONTENT" | jq -r '.session_id // empty' 2>/dev/null || true)

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
