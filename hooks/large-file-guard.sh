#!/bin/bash
# Canon Large File Guard Hook
# Runs as a PreToolUse hook on Write and Edit tool calls.
# Warns when a file is being written that exceeds a line threshold,
# nudging the agent to consider splitting it.
#
# Configurable via .canon/config.json:
#   "max_file_lines": 500  (default)
#
# Input: JSON on stdin with the tool call details
# Output: Warning message on stdout (if applicable)
# Exit 0: allow the tool call (advisory only)

set -euo pipefail

# Read tool input
INPUT=$(cat)

# Extract file path from the tool input
FILE_PATH=$(echo "$INPUT" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"file_path"[[:space:]]*:[[:space:]]*"//;s/"$//' || true)

# If we couldn't extract a path, pass through
if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

# Skip non-source files where large size is expected
case "$FILE_PATH" in
  *.lock|*.svg|*.json|*.csv|*.sql|*.min.*|*bundle*|*vendor*|*node_modules*|*.generated.*) exit 0 ;;
esac

# Resolve main repo root for worktree support
MAIN_ROOT=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's|/\.git$||' || true)
CANON_DIR="${MAIN_ROOT:-.}/.canon"

# Read threshold from .canon/config.json if present, default 500
MAX_LINES=500
CONFIG_FILE="${CANON_DIR}/config.json"
if [[ -f "$CONFIG_FILE" ]]; then
  CONFIGURED=$(grep -o '"max_file_lines"[[:space:]]*:[[:space:]]*[0-9]*' "$CONFIG_FILE" | grep -o '[0-9]*' || true)
  if [[ -n "$CONFIGURED" ]]; then
    MAX_LINES=$CONFIGURED
  fi
fi

# For Write tool: count lines in the new content
# For Edit tool: count lines in the existing file (the edit may grow it)
if [[ -f "$FILE_PATH" ]]; then
  CURRENT_LINES=$(wc -l < "$FILE_PATH" | tr -d ' ')
else
  CURRENT_LINES=0
fi

# For Write calls, estimate new size from the content field
NEW_CONTENT=$(echo "$INPUT" | grep -o '"content"[[:space:]]*:[[:space:]]*"' || true)
if [[ -n "$NEW_CONTENT" ]]; then
  # Count newlines in content value; actual lines = newline_count + 1
  NEWLINE_COUNT=0
  if command -v jq &>/dev/null; then
    NEWLINE_COUNT=$(echo "$INPUT" | jq -r '.content // empty' 2>/dev/null | wc -l | tr -d ' ' || echo "0")
  else
    NEWLINE_COUNT=$(echo "$INPUT" | sed -n 's/.*"content"[[:space:]]*:[[:space:]]*"//p' | grep -o '\\n' | wc -l | tr -d ' ' || echo "0")
    NEWLINE_COUNT=$((NEWLINE_COUNT + 1))
  fi
  if [[ $NEWLINE_COUNT -gt $MAX_LINES ]]; then
    cat <<EOF
CANON WARNING: Writing ~${NEWLINE_COUNT} lines to ${FILE_PATH} (threshold: ${MAX_LINES}). Consider splitting this file into smaller, focused modules. Large files are harder to review, test, and maintain.
EOF
    exit 0
  fi
fi

# For Edit calls on existing files, check current size
if [[ $CURRENT_LINES -gt $MAX_LINES ]]; then
  cat <<EOF
CANON WARNING: ${FILE_PATH} is ${CURRENT_LINES} lines (threshold: ${MAX_LINES}). Consider whether this edit is an opportunity to extract logic into a separate module.
EOF
fi

exit 0
