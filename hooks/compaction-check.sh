#!/bin/bash
# Canon Compaction Check Hook
# Runs as a PostToolUse hook after Bash calls containing "git commit".
# Checks if .jsonl data files or CONVENTIONS.md have grown past thresholds
# and nudges to compact them.
#
# Thresholds:
#   - .jsonl files: 500 entries (rotation should handle this, but warn if it didn't)
#   - CONVENTIONS.md: 20+ conventions
#
# Noise reduction:
#   - Only triggers on git commit
#   - Only nudges once per session (dedup file)
#
# Input: JSON on stdin with the tool call details
# Output: Nudge message on stdout (if applicable)
# Exit 0: always (advisory only, never blocks)

set -euo pipefail

# Read tool input
INPUT=$(cat)

# Only trigger on git commit commands
if ! echo "$INPUT" | grep -q "git commit"; then
  exit 0
fi

# Session dedup — only nudge once per session.
# Use session_id from the hook JSON input (not PID or pwd-based hash).
SESSION_ID=$(echo "$INPUT" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"session_id"[[:space:]]*:[[:space:]]*"//;s/"$//' || true)
NUDGE_FILE="${TMPDIR:-/tmp}/canon-compaction-nudged-${SESSION_ID:-unknown}"
if [[ -f "$NUDGE_FILE" ]]; then
  exit 0
fi

# Resolve main repo root for worktree support
MAIN_ROOT=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's|/\.git$||' || true)
CANON_DIR="${MAIN_ROOT:-.}/.canon"

WARNINGS=()

# Check .jsonl file sizes
for JSONL_FILE in "${CANON_DIR}/reviews.jsonl" "${CANON_DIR}/decisions.jsonl" "${CANON_DIR}/patterns.jsonl"; do
  if [[ -f "$JSONL_FILE" ]]; then
    LINE_COUNT=$(wc -l < "$JSONL_FILE" | tr -d ' ')
    if [[ $LINE_COUNT -gt 500 ]]; then
      WARNINGS+=("  - ${JSONL_FILE}: ${LINE_COUNT} entries (expected max 500 — rotation may not be running)")
    fi
  fi
done

# Check CONVENTIONS.md size
CONVENTIONS_FILE="${CANON_DIR}/CONVENTIONS.md"
if [[ -f "$CONVENTIONS_FILE" ]]; then
  CONVENTION_COUNT=$(grep -c '^- \*\*' "$CONVENTIONS_FILE" 2>/dev/null || echo "0")
  if [[ $CONVENTION_COUNT -gt 20 ]]; then
    WARNINGS+=("  - CONVENTIONS.md: ${CONVENTION_COUNT} conventions — consider consolidating similar entries")
  fi
fi

if [[ ${#WARNINGS[@]} -eq 0 ]]; then
  exit 0
fi

# Mark as nudged for this session
touch "$NUDGE_FILE"

echo "CANON: Context management warning — some files are getting large:"
printf '%s\n' "${WARNINGS[@]}"
echo "Run /canon:doctor for a full health check."

exit 0
