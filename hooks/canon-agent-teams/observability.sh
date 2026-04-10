#!/bin/bash
# Canon agent-teams: observability hook.
#
# Logs SubagentStart, SubagentStop, and TeammateIdle events to
# .canon/workspaces/<id>/events.jsonl for post-hoc analysis and drift
# tracking. Advisory only — never blocks.
#
# The hook is registered against multiple events in hooks.json; this script
# works out which event fired from the payload shape and emits a single
# JSONL line per call.
#
# Input: JSON on stdin. Output: nothing on stdout (advisory). Exit 0 always.
#
# Gated on CANON_AGENT_TEAMS_MODE=on. No-op when the flag is unset or off.

set -euo pipefail

if [[ "${CANON_AGENT_TEAMS_MODE:-off}" != "on" ]]; then
  exit 0
fi

INPUT="$(cat || true)"
if [[ -z "$INPUT" ]]; then
  exit 0
fi

WORKSPACE_DIR="${CANON_WORKSPACE_DIR:-}"
if [[ -z "$WORKSPACE_DIR" ]]; then
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  CANDIDATE="$(find "$REPO_ROOT/.canon/workspaces" -maxdepth 2 -type d -name 'agent-teams' 2>/dev/null | head -1 || true)"
  if [[ -n "$CANDIDATE" ]]; then
    WORKSPACE_DIR="$(dirname "$CANDIDATE")"
  fi
fi

if [[ -z "$WORKSPACE_DIR" || ! -d "$WORKSPACE_DIR" ]]; then
  exit 0
fi

EVENTS_FILE="$WORKSPACE_DIR/events.jsonl"
mkdir -p "$WORKSPACE_DIR"

# Best-effort event type detection from input shape / hook_event_name field.
EVENT_TYPE=""
if printf '%s' "$INPUT" | grep -q '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"'; then
  EVENT_TYPE="$(printf '%s' "$INPUT" | grep -o '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"//;s/"$//')"
elif printf '%s' "$INPUT" | grep -q 'agent_transcript_path'; then
  EVENT_TYPE="SubagentStop"
elif printf '%s' "$INPUT" | grep -q 'teammate_name'; then
  EVENT_TYPE="TeammateIdle"
elif printf '%s' "$INPUT" | grep -q 'agent_id'; then
  EVENT_TYPE="SubagentStart"
else
  EVENT_TYPE="unknown"
fi

TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Escape the payload for safe embedding in a JSON string.
# Uses tr / sed to avoid a jq dependency. Newlines -> \n, quotes -> \".
PAYLOAD_ESCAPED="$(printf '%s' "$INPUT" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ' | tr -s ' ')"

printf '{"ts":"%s","event":"%s","payload":"%s"}\n' \
  "$TIMESTAMP" "$EVENT_TYPE" "$PAYLOAD_ESCAPED" >> "$EVENTS_FILE" || true

exit 0
