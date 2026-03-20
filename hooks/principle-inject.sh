#!/bin/bash
# Canon Principle Injection Hook
# Runs as a PreToolUse hook on Write and Edit tool calls.
# Injects relevant Canon principles into the AI context so the agent
# follows project conventions without needing a manual get_principles call.
#
# Input: JSON on stdin with the tool call details
# Output: Principle summaries on stdout (advisory only)
# Exit 0: always allows the tool call

set -euo pipefail

# Read tool input
INPUT=$(cat)

# Extract file path from the tool input
FILE_PATH=$(echo "$INPUT" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"file_path"[[:space:]]*:[[:space:]]*"//;s/"$//' || true)

# If we couldn't extract a path, pass through
if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

# Skip non-source files
case "$FILE_PATH" in
  *.lock|*.svg|*.json|*.csv|*.sql|*.min.*|*bundle*|*vendor*|*node_modules*|*.generated.*|*.md) exit 0 ;;
esac

# Session dedup: skip if we already injected for this file in this session.
# Use session_id from the hook JSON input (not $$ which changes per invocation).
SESSION_ID=$(echo "$INPUT" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"session_id"[[:space:]]*:[[:space:]]*"//;s/"$//' || true)
DEDUP_DIR="${TMPDIR:-/tmp}/canon-inject-${SESSION_ID:-unknown}"
mkdir -p "$DEDUP_DIR" 2>/dev/null || true
HASH=$(echo -n "$FILE_PATH" | shasum | cut -d' ' -f1)
DEDUP_FILE="$DEDUP_DIR/$HASH"
if [[ -f "$DEDUP_FILE" ]]; then
  exit 0
fi
touch "$DEDUP_FILE"

# Find the worker script relative to this hook
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER="$HOOK_DIR/principle-inject-worker.mjs"

if [[ ! -f "$WORKER" ]]; then
  exit 0
fi

# Resolve main repo root for worktree support — ensures project-local
# principles in .canon/ are found even when running in a worktree.
MAIN_ROOT=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's|/\.git$||' || true)
export CANON_PROJECT_DIR="${MAIN_ROOT:-.}"

# Run the worker — pass plugin dir so it can find compiled matcher
export CANON_PLUGIN_DIR="${CANON_PLUGIN_DIR:-$(dirname "$HOOK_DIR")}"
node "$WORKER" "$FILE_PATH" 2>/dev/null || true

exit 0
