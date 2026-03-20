#!/bin/bash
# Canon Destructive Git Command Guard
# Runs as a PreToolUse hook on Bash commands.
# Blocks destructive git operations (reset --hard, clean -f, checkout -- .,
# branch -D) so the user is prompted for permission before they execute.
#
# Input: JSON on stdin with the tool call details
# Output: Warning message on stdout (when blocking)
# Exit 0: allow the tool call
# Exit 2: block the tool call (user will be prompted)

set -euo pipefail

# Read the tool input from stdin
INPUT=$(cat)

# Extract the command being run from the tool input
COMMAND=$(echo "$INPUT" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"command"[[:space:]]*:[[:space:]]*"//;s/"$//' || true)

# If we couldn't extract a command, pass through
if [[ -z "$COMMAND" ]]; then
  exit 0
fi

# Check for destructive git operations
if echo "$COMMAND" | grep -qE '\bgit\b.*\breset\b.*--hard'; then
  cat <<EOF
CANON: Destructive git operation detected — git reset --hard. This discards all uncommitted changes and cannot be undone. Ensure you have committed or stashed any work you want to keep.
EOF
  exit 2
fi

if echo "$COMMAND" | grep -qE '\bgit\b.*\bclean\b.*-[a-zA-Z]*f'; then
  cat <<EOF
CANON: Destructive git operation detected — git clean -f. This permanently deletes untracked files. Ensure no important untracked files will be lost.
EOF
  exit 2
fi

if echo "$COMMAND" | grep -qE '\bgit\b.*\bcheckout\b.*--\s*\.'; then
  cat <<EOF
CANON: Destructive git operation detected — git checkout -- . This discards all unstaged changes in the working tree and cannot be undone.
EOF
  exit 2
fi

if echo "$COMMAND" | grep -qE '\bgit\b.*\bbranch\b.*-D\b'; then
  cat <<EOF
CANON: Destructive git operation detected — git branch -D. This force-deletes a branch even if it has unmerged changes.
EOF
  exit 2
fi

# Not a destructive command — allow
exit 0
