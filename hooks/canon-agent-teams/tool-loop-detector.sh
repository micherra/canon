#!/usr/bin/env bash
# tool-loop-detector.sh — PostToolUse ("*" matcher) hook that detects when an
# agent is looping: three consecutive identical tool calls with the same inputs.
#
# Detection:
#   - Fingerprint = SHA-256 (first 16 hex chars) of the tool_name + stable tool
#     input (volatile fields like session_id and tool_use_id stripped).
#   - State file: $TMPDIR/canon-tool-fingerprints-{session_id} — one fingerprint
#     per line, appended after each call.
#   - If the last 3 fingerprints are all identical: exit 2 with a HITL message.
#   - State file is reset after a detected loop.
#
# Exit 0: no loop (or cannot determine).
# Exit 2: loop detected — Claude Code interrupts the agent.
#

set -euo pipefail

INPUT=$(cat)


# Extract session_id (used to scope state file per session)
SESSION_ID=$(echo "$INPUT" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"session_id"[[:space:]]*:[[:space:]]*"//;s/"$//' || true)

# If no session_id, skip detection (can't scope state)
if [[ -z "$SESSION_ID" ]]; then
  exit 0
fi

# Extract tool_name for fingerprint
TOOL_NAME=$(echo "$INPUT" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"tool_name"[[:space:]]*:[[:space:]]*"//;s/"$//' || true)

# Strip volatile fields before hashing so identical tool calls produce the same fingerprint
STABLE_INPUT=$(echo "$INPUT" \
  | sed 's/"session_id"[[:space:]]*:[[:space:]]*"[^"]*"[[:space:]]*,\?//g' \
  | sed 's/"tool_use_id"[[:space:]]*:[[:space:]]*"[^"]*"[[:space:]]*,\?//g')

# Fingerprint: tool_name + stable input hashed to 16-char hex
FINGERPRINT=$(printf '%s\n%s' "$TOOL_NAME" "$STABLE_INPUT" | shasum -a 256 | head -c 16)

# State file — scoped to session
STATE_FILE="${TMPDIR:-/tmp}/canon-tool-fingerprints-${SESSION_ID}"

# Append fingerprint to state file
echo "$FINGERPRINT" >> "$STATE_FILE"

# Check if last 3 entries are all the same fingerprint
LAST_3=$(tail -3 "$STATE_FILE" 2>/dev/null || true)
LINE_COUNT=$(echo "$LAST_3" | wc -l | tr -d ' ')

if [[ "$LINE_COUNT" -ge 3 ]]; then
  UNIQUE_COUNT=$(echo "$LAST_3" | sort -u | wc -l | tr -d ' ')
  if [[ "$UNIQUE_COUNT" -eq 1 ]]; then
    # Loop detected — reset state and exit 2
    rm -f "$STATE_FILE"

    cat >&2 <<EOF
CANON LOOP DETECTED: The agent has issued the same tool call ($TOOL_NAME) 3 consecutive times with identical inputs.

This usually means the agent is stuck in a retry loop without making progress.

Recommended actions:
  1. Review the agent's recent tool calls and identify what is failing.
  2. Consider simplifying the approach or breaking the task into smaller steps.
  3. Start a fresh session with "resume" to continue with a clean context.

The agent has been paused to prevent wasted compute.
EOF

    exit 2
  fi
fi

exit 0
