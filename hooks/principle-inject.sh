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

canon_hash_string() {
  local input="$1"
  local h=""
  if command -v shasum >/dev/null 2>&1; then
    h=$(printf '%s' "$input" | shasum 2>/dev/null | awk '{print $1}') || true
  elif command -v sha1sum >/dev/null 2>&1; then
    h=$(printf '%s' "$input" | sha1sum 2>/dev/null | awk '{print $1}') || true
  elif command -v md5sum >/dev/null 2>&1; then
    h=$(printf '%s' "$input" | md5sum 2>/dev/null | awk '{print $1}') || true
  fi
  if [[ -z "$h" ]]; then
    h=$(printf '%s' "$input" | tr '/[:space:]' '_')
  fi
  printf '%s' "$h"
}

# Session dedup: skip if we already injected for this file in this session.
# Prefer hook session_id (stable across invocations); else scope by repo root so dedup is per-project.
SESSION_ID=$(echo "$INPUT" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"session_id"[[:space:]]*:[[:space:]]*"//;s/"$//' || true)
if [[ -n "$SESSION_ID" ]]; then
  DEDUP_SLUG="$SESSION_ID"
else
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  REPO_BRANCH="$(git branch --show-current 2>/dev/null || true)"
  REPO_KEY="${REPO_ROOT}:${REPO_BRANCH}"
  DEDUP_SLUG=$(canon_hash_string "$REPO_KEY")
fi
DEDUP_DIR="${TMPDIR:-/tmp}/canon-inject-${DEDUP_SLUG}"
mkdir -p "$DEDUP_DIR" 2>/dev/null || true
HASH=$(canon_hash_string "$FILE_PATH")
if [[ -z "$HASH" ]]; then
  HASH="nohash_$(printf '%s' "$FILE_PATH" | tr '/[:space:]' '_')"
fi
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

# Run the worker — pass plugin dir so it can find compiled matcher
export CANON_PLUGIN_DIR="${CANON_PLUGIN_DIR:-$(dirname "$HOOK_DIR")}"
node "$WORKER" "$FILE_PATH" 2>/dev/null || true

exit 0
