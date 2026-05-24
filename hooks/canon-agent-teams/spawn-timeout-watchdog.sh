#!/usr/bin/env bash
# spawn-timeout-watchdog.sh — PreToolUse ("*" matcher) hook that surfaces an
# advisory message when a spawned agent subagent has been running longer than a
# configurable threshold.
#
# Configuration (in priority order):
#   1. CANON_SPAWN_TIMEOUT_MINUTES env var
#   2. .canon/config.json "spawn_timeout_minutes" field
#   3. Default: 20 minutes
#
# State files (written to .canon/, which is gitignored):
#   .canon/.spawn-start-ts           — epoch seconds written at agent spawn start
#                                      (by session-start-timestamp.sh — this hook reads it)
#   .canon/.spawn-watchdog-shown     — epoch seconds when advisory last shown
#
# Agent identity read from env vars:
#   CANON_AGENT_TYPE  — e.g. "engineer", "reviewer"
#   CANON_STEP_ID     — e.g. "implement", "review"
#
# Never blocks: advisory only, exit 0 always (exit 2 on timeout to surface HITL).
#
# Actually: exits 2 on timeout (like session-duration-watchdog) to surface a
# HITL checkpoint so the orchestrator can decide whether to continue or abort.

set -euo pipefail

# Consume stdin (required by Claude Code hook contract)
INPUT=$(cat)


CANON_DIR="${CANON_PROJECT_DIR:-.}/.canon"
SPAWN_TS_FILE="${CANON_DIR}/.spawn-start-ts"

# No spawn timestamp — agent hasn't started yet or hook hasn't run
if [[ ! -f "$SPAWN_TS_FILE" ]]; then
  exit 0
fi

# Resolve threshold: env var → config.json → default 20
THRESHOLD_MINUTES=${CANON_SPAWN_TIMEOUT_MINUTES:-}

if [[ -z "$THRESHOLD_MINUTES" ]]; then
  CONFIG_FILE="${CANON_DIR}/config.json"
  if [[ -f "$CONFIG_FILE" ]]; then
    THRESHOLD_MINUTES=$(grep -o '"spawn_timeout_minutes"[[:space:]]*:[[:space:]]*[0-9]*' "$CONFIG_FILE" | grep -o '[0-9]*$' || true)
  fi
fi

if [[ -z "$THRESHOLD_MINUTES" ]]; then
  THRESHOLD_MINUTES=20
fi

THRESHOLD_SECONDS=$(( THRESHOLD_MINUTES * 60 ))

START_TS=$(cat "$SPAWN_TS_FILE")
NOW=$(date +%s)
ELAPSED=$(( NOW - START_TS ))

# Agent not yet at threshold
if (( ELAPSED < THRESHOLD_SECONDS )); then
  exit 0
fi

# Interval-aware dedup: only re-fire after another full threshold interval
DEDUP_FILE="${CANON_DIR}/.spawn-watchdog-shown"
if [[ -f "$DEDUP_FILE" ]]; then
  LAST_SHOWN=$(cat "$DEDUP_FILE")
  if (( (NOW - LAST_SHOWN) < THRESHOLD_SECONDS )); then
    exit 0
  fi
fi

# Record when we last showed the advisory
echo "$NOW" > "$DEDUP_FILE"

# Format elapsed time as Xh Ym
ELAPSED_HOURS=$(( ELAPSED / 3600 ))
ELAPSED_MINS=$(( (ELAPSED % 3600) / 60 ))

# Extract agent identity from env vars
AGENT_TYPE="${CANON_AGENT_TYPE:-unknown}"
STEP_ID="${CANON_STEP_ID:-unknown}"

# Extract last tool_name from stdin for "last activity"
LAST_TOOL=$(echo "$INPUT" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"tool_name"[[:space:]]*:[[:space:]]*"//;s/"$//' || true)
if [[ -z "$LAST_TOOL" ]]; then
  LAST_TOOL="unknown"
fi

cat <<EOF
CANON SPAWN TIMEOUT: The agent has been running for ${ELAPSED_HOURS}h ${ELAPSED_MINS}m (threshold: ${THRESHOLD_MINUTES} minutes).

Agent:      ${AGENT_TYPE}
Step:       ${STEP_ID}
Elapsed:    ${ELAPSED_HOURS}h ${ELAPSED_MINS}m
Last tool:  ${LAST_TOOL}

Long-running agents may be stuck in a loop, waiting on a resource, or producing
low-quality output due to context saturation.

You can:
  1. Let the agent continue — it will warn again in ${THRESHOLD_MINUTES} minutes.
  2. Abort the agent and resume from the last checkpoint.
  3. Start a fresh session and say "resume" to continue from where you left off.
EOF

exit 2
