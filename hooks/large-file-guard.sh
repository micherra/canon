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
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .file_path // empty' 2>/dev/null || true) # DOCUMENTED FAIL-OPEN -- empty FILE_PATH triggers pass-through at line 23

# If we couldn't extract a path, pass through
if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

# Skip non-source files where large size is expected
case "$FILE_PATH" in
  *.lock|*.svg|*.json|*.csv|*.sql|*.min.*|*bundle*|*vendor*|*node_modules*|*.generated.*) exit 0 ;;
esac

# Resolve main repo root for worktree support
MAIN_ROOT=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's|/\.git$||') || { >&2 echo "CANON WARNING: [large-file-guard] git root resolution failed"; MAIN_ROOT=""; }
CANON_DIR="${MAIN_ROOT:-.}/.canon"

# Read threshold from .canon/config.json if present, default 500
MAX_LINES=500
CONFIG_FILE="${CANON_DIR}/config.json"
if [[ -f "$CONFIG_FILE" ]]; then
  CONFIGURED=$(jq -r '.max_file_lines // empty' "$CONFIG_FILE" 2>/dev/null || true) # DOCUMENTED FAIL-OPEN -- config read failure uses default MAX_LINES=500
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
if echo "$INPUT" | jq -e '.tool_input.content // .content // empty | select(. != "")' >/dev/null 2>&1; then
  NEW_CONTENT="yes"
else
  NEW_CONTENT=""
fi
if [[ -n "$NEW_CONTENT" ]]; then
  NEWLINE_COUNT=$(echo "$INPUT" | jq -r '.tool_input.content // .content // empty' 2>/dev/null | wc -l | tr -d ' ' || echo "0") # DOCUMENTED FAIL-OPEN -- count failure defaults to 0; falls through to existing-file check
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
