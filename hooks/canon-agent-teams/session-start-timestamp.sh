#!/usr/bin/env bash
# session-start-timestamp.sh — SessionStart hook that writes the current epoch
# timestamp to .canon/.session-start-ts so that the session duration watchdog
# (session-duration-watchdog.sh) can compute elapsed time on subsequent tool calls.
#
# Always active. Never blocks: this is purely informational bookkeeping, exit 0 always.

set -euo pipefail

# Consume stdin (required by Claude Code hook contract)
INPUT=$(cat)

# shellcheck disable=SC2034  # SESSION_ID unused: extracted for potential future use
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)

CANON_DIR="${CANON_PROJECT_DIR:-.}/.canon"

if [[ ! -d "$CANON_DIR" ]]; then
  exit 0
fi

TS_FILE="${CANON_DIR}/.session-start-ts"

date +%s > "$TS_FILE"

exit 0
