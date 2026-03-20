#!/bin/bash
# Canon Agent Cost Tracker
# Runs as a PostToolUse hook after Agent tool calls.
# Logs every agent spawn to .canon/agent-costs.jsonl for cost observability.
#
# Input: JSON on stdin with the tool call details
# Output: none (silent)
# Exit 0: always (never blocks)

set -euo pipefail

# Read tool input
INPUT=$(cat)

# Extract fields from the hook JSON
SESSION_ID=$(echo "$INPUT" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"session_id"[[:space:]]*:[[:space:]]*"//;s/"$//' || true)

# Extract agent description (the "description" field in Agent tool_input)
AGENT_DESC=$(echo "$INPUT" | grep -o '"description"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"description"[[:space:]]*:[[:space:]]*"//;s/"$//' || true)

# Extract subagent_type if present
AGENT_TYPE=$(echo "$INPUT" | grep -o '"subagent_type"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"subagent_type"[[:space:]]*:[[:space:]]*"//;s/"$//' || true)

# Resolve main repo root for worktree support
MAIN_ROOT=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's|/\.git$||' || true)
CANON_DIR="${MAIN_ROOT:-.}/.canon"

# Ensure .canon directory exists
if [[ ! -d "$CANON_DIR" ]]; then
  exit 0
fi

COST_FILE="${CANON_DIR}/agent-costs.jsonl"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Append cost entry
printf '{"timestamp":"%s","session_id":"%s","agent_type":"%s","description":"%s"}\n' \
  "$TIMESTAMP" \
  "${SESSION_ID:-unknown}" \
  "${AGENT_TYPE:-general}" \
  "${AGENT_DESC:-unknown}" \
  >> "$COST_FILE" 2>/dev/null || true

exit 0
