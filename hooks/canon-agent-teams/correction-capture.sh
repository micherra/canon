#!/usr/bin/env bash
# correction-capture.sh — PostToolUse (Bash) hook that detects user corrections
# to agent commits (git checkout -- / git restore) and writes correction records.
#
# Detection heuristic: if the Bash command contains `git checkout --` or
# `git restore`, and the most recent commit was made within the last 60 seconds,
# this is likely a user correcting an agent's work.
#
# Input: JSON on stdin (Claude Code PostToolUse hook format).
# Exit 0: always (non-blocking — advisory hook).

set -euo pipefail

# Source shared hook helpers.
_HOOK_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/canon-hook-lib.sh"
# shellcheck source=hooks/lib/canon-hook-lib.sh
source "$_HOOK_LIB"

INPUT=$(cat)

# Only care about Bash calls
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
if [[ "$TOOL_NAME" != "Bash" ]]; then
  exit 0
fi

# Extract command
COMMAND=$(canon_extract_command "$INPUT")

# Check for git restore or git checkout -- patterns
if ! echo "$COMMAND" | grep -qE 'git[[:space:]]+(checkout[[:space:]]+--|restore)'; then
  exit 0
fi

# Resolve the worktree directory so git log runs in the right repo context.
GIT_DIR_ARG=$(canon_git_dir_arg "$COMMAND")

# Check if the last commit was recent (within 60 seconds)
# shellcheck disable=SC2086
LAST_COMMIT_EPOCH=$(git $GIT_DIR_ARG log -1 --format='%ct' 2>/dev/null || echo "0")
NOW_EPOCH=$(date +%s)
ELAPSED=$(( NOW_EPOCH - LAST_COMMIT_EPOCH ))

if [[ "$ELAPSED" -gt 60 ]]; then
  exit 0
fi

# Extract affected file paths from the command
# For `git checkout -- file1 file2` or `git restore file1 file2`
AFFECTED_FILES=$(echo "$COMMAND" \
  | sed 's/.*git checkout -- //;s/.*git restore //' \
  | tr ' ' '\n' \
  | grep -v '^$' \
  | grep -v '^--' \
  | head -10)

if [[ -z "$AFFECTED_FILES" ]]; then
  exit 0
fi

# Get the last commit SHA and message for context
# shellcheck disable=SC2086
LAST_SHA=$(git $GIT_DIR_ARG log -1 --format='%H' 2>/dev/null || echo "unknown")
# shellcheck disable=SC2086
LAST_MSG=$(git $GIT_DIR_ARG log -1 --format='%s' 2>/dev/null || echo "unknown")

# Extract agent type from the last commit's Canon-Agent trailer (if present)
# shellcheck disable=SC2086
AGENT_TYPE=$(git $GIT_DIR_ARG log -1 --format='%B' 2>/dev/null | grep '^Canon-Agent:' | sed 's/Canon-Agent:[[:space:]]*//' || echo "unknown")
# Default to unknown if empty
AGENT_TYPE="${AGENT_TYPE:-unknown}"

# Create corrections directory — if this fails, exit 0 (advisory hook, never blocks)
CORRECTIONS_DIR=".canon/corrections"
if ! mkdir -p "$CORRECTIONS_DIR" 2>/dev/null; then
  exit 0
fi

# Write one correction file per affected file
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SAFE_TIMESTAMP=$(echo "$TIMESTAMP" | tr ':' '-')

# Escape a string for safe embedding in a JSON value (double-quoted context).
# Escapes backslashes, double quotes, tabs, and newlines.
escape_json() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/	/\\t/g' | tr '\n' ' ' | sed 's/ $//'
}

# Pre-escape variables that may contain special characters.
SAFE_MSG=$(escape_json "$LAST_MSG")
SAFE_CMD=$(escape_json "$COMMAND")
SAFE_AT=$(escape_json "$AGENT_TYPE")

while IFS= read -r FILE_PATH; do
  [[ -z "$FILE_PATH" ]] && continue

  # Escape file path for JSON embedding.
  SAFE_FP=$(escape_json "$FILE_PATH")

  # Sanitize the file path for use in the filename
  SAFE_PATH=$(echo "$FILE_PATH" | tr '/' '_' | tr '.' '_')
  CORRECTION_FILE="${CORRECTIONS_DIR}/${SAFE_TIMESTAMP}--${SAFE_PATH}.json"

  # Write JSON correction record — best-effort, errors are silently swallowed
  cat > "$CORRECTION_FILE" 2>/dev/null <<ENDJSON || true
{
  "file_path": "${SAFE_FP}",
  "commit_sha": "${LAST_SHA}",
  "commit_subject": "${SAFE_MSG}",
  "agent_type": "${SAFE_AT}",
  "correction_command": "${SAFE_CMD}",
  "timestamp": "${TIMESTAMP}"
}
ENDJSON
done <<< "$AFFECTED_FILES"

exit 0
