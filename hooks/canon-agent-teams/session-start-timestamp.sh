#!/usr/bin/env bash
# session-start-timestamp.sh — SessionStart hook that writes the current epoch
# timestamp to .canon/.session-start-ts so that the session duration watchdog
# (session-duration-watchdog.sh) can compute elapsed time on subsequent tool calls.
#
# Always active. Never blocks: this is purely informational bookkeeping, exit 0 always.

set -euo pipefail

# Consume stdin (required by Claude Code hook contract)
INPUT=$(cat)

# Extract session_id from stdin JSON without jq (grep/sed fallback)
SESSION_ID=$(echo "$INPUT" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)

CANON_DIR="${CANON_PROJECT_DIR:-.}/.canon"

if [[ ! -d "$CANON_DIR" ]]; then
  exit 0
fi

TS_FILE="${CANON_DIR}/.session-start-ts"

date +%s > "$TS_FILE"

exit 0
