#!/usr/bin/env bash
# session-duration-watchdog.sh — PreToolUse hook ("*" matcher) that surfaces an
# advisory message when the current session has been active longer than a
# configurable threshold.
#
# Configuration:
#   CANON_SESSION_WATCHDOG_MINUTES  — threshold in minutes (default: 120).
#                                     Also used as the re-fire interval after
#                                     the user dismisses and keeps going.
#
# State files (written to .canon/, which is gitignored):
#   .canon/.session-start-ts             — epoch seconds written at SessionStart
#   .canon/.session-watchdog-last-shown  — epoch seconds when advisory last shown
#
# Only active when CANON_AGENT_TEAMS_MODE=on.
# Never blocks: advisory only, exit 0 always.

set -euo pipefail

if [[ "${CANON_AGENT_TEAMS_MODE:-off}" != "on" ]]; then
  exit 0
fi

# Consume stdin (required by Claude Code hook contract)
INPUT=$(cat)

THRESHOLD_MINUTES=${CANON_SESSION_WATCHDOG_MINUTES:-120}
THRESHOLD_SECONDS=$(( THRESHOLD_MINUTES * 60 ))

CANON_DIR="${CANON_PROJECT_DIR:-.}/.canon"
TS_FILE="${CANON_DIR}/.session-start-ts"

# No start timestamp — hook hasn't fired yet this session
if [[ ! -f "$TS_FILE" ]]; then
  exit 0
fi

START_TS=$(cat "$TS_FILE")
NOW=$(date +%s)
ELAPSED=$(( NOW - START_TS ))

# Session not yet at threshold
if (( ELAPSED < THRESHOLD_SECONDS )); then
  exit 0
fi

# Interval-aware dedup: only re-fire after another full threshold interval
DEDUP_FILE="${CANON_DIR}/.session-watchdog-last-shown"
if [[ -f "$DEDUP_FILE" ]]; then
  LAST_SHOWN=$(cat "$DEDUP_FILE")
  if (( (NOW - LAST_SHOWN) < THRESHOLD_SECONDS )); then
    exit 0
  fi
fi

# Record when we last showed the advisory
echo "$NOW" > "$DEDUP_FILE"

# Format elapsed time as Xh Ym for human display
ELAPSED_HOURS=$(( ELAPSED / 3600 ))
ELAPSED_MINS=$(( (ELAPSED % 3600) / 60 ))

cat <<EOF
CANON SESSION NOTE: This session has been active for ${ELAPSED_HOURS}h ${ELAPSED_MINS}m.

Long-running sessions can degrade (slower responses, lost context).
You can start a fresh session and say "resume" to continue where you left off.
Or dismiss this and keep going — you'll be reminded again in ${THRESHOLD_MINUTES} minutes.
EOF

exit 0
