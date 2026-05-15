#!/usr/bin/env bash
# correction-capture.sh — PostToolUse (Bash) hook that detects user corrections
# to agent commits (git checkout -- / git restore) and writes correction records.
#
# Only active when CANON_AGENT_TEAMS_MODE=on.
#
# Detection heuristic: if the Bash command contains `git checkout --` or
# `git restore`, and the most recent commit was made within the last 60 seconds,
# this is likely a user correcting an agent's work.
#
# Input: JSON on stdin (Claude Code PostToolUse hook format).
# Exit 0: always (non-blocking — advisory hook).

set -euo pipefail

# Feature flag gate
if [[ "${CANON_AGENT_TEAMS_MODE:-off}" != "on" ]]; then
  exit 0
fi

INPUT=$(cat)

# Only care about Bash calls
TOOL_NAME=$(echo "$INPUT" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"tool_name"[[:space:]]*:[[:space:]]*"//;s/"$//')
if [[ "$TOOL_NAME" != "Bash" ]]; then
  exit 0
fi

# Extract command
COMMAND=$(echo "$INPUT" \
  | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -1 \
  | sed 's/"command"[[:space:]]*:[[:space:]]*"//;s/"$//')

# Check for git restore or git checkout -- patterns
if ! echo "$COMMAND" | grep -qE 'git[[:space:]]+(checkout[[:space:]]+--|restore)'; then
  exit 0
fi

# Check if the last commit was recent (within 60 seconds)
LAST_COMMIT_EPOCH=$(git log -1 --format='%ct' 2>/dev/null || echo "0")
NOW_EPOCH=$(date +%s)
ELAPSED=$(( NOW_EPOCH - LAST_COMMIT_EPOCH ))

if [[ "$ELAPSED" -gt 60 ]]; then
  exit 0
fi

# Extract affected file paths from the command
# For `git checkout -- file1 file2` or `git restore file1 file2`
AFFECTED_FILES=$(echo "$COMMAND" \
  | sed 's/.*git checkout -- //;s/.*git restore //' \
  | tr ' ' '\n' \
  | grep -v '^$' \
  | grep -v '^--' \
  | head -10)

if [[ -z "$AFFECTED_FILES" ]]; then
  exit 0
fi

# Get the last commit SHA and message for context
LAST_SHA=$(git log -1 --format='%H' 2>/dev/null || echo "unknown")
LAST_MSG=$(git log -1 --format='%s' 2>/dev/null || echo "unknown")

# Extract agent type from the last commit's Canon-Agent trailer (if present)
AGENT_TYPE=$(git log -1 --format='%B' 2>/dev/null | grep '^Canon-Agent:' | sed 's/Canon-Agent:[[:space:]]*//' || echo "unknown")
# Default to unknown if empty
AGENT_TYPE="${AGENT_TYPE:-unknown}"

# Create corrections directory — if this fails, exit 0 (advisory hook, never blocks)
CORRECTIONS_DIR=".canon/corrections"
if ! mkdir -p "$CORRECTIONS_DIR" 2>/dev/null; then
  exit 0
fi

# Write one correction file per affected file
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SAFE_TIMESTAMP=$(echo "$TIMESTAMP" | tr ':' '-')

while IFS= read -r FILE_PATH; do
  [[ -z "$FILE_PATH" ]] && continue

  # Sanitize the file path for use in the filename
  SAFE_PATH=$(echo "$FILE_PATH" | tr '/' '_' | tr '.' '_')
  CORRECTION_FILE="${CORRECTIONS_DIR}/${SAFE_TIMESTAMP}--${SAFE_PATH}.json"

  # Write JSON correction record — best-effort, errors are silently swallowed
  cat > "$CORRECTION_FILE" 2>/dev/null <<ENDJSON || true
{
  "file_path": "${FILE_PATH}",
  "commit_sha": "${LAST_SHA}",
  "commit_subject": "${LAST_MSG}",
  "agent_type": "${AGENT_TYPE}",
  "correction_command": "${COMMAND}",
  "timestamp": "${TIMESTAMP}"
}
ENDJSON
done <<< "$AFFECTED_FILES"

exit 0
