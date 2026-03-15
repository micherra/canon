#!/bin/bash
# Canon Post-Commit Review Reminder Hook
# Runs as a PostToolUse hook after Bash calls that contain "git commit".
# Checks if a Canon review has been logged for the current changes.
# If not, nudges the user to run /canon:review.
#
# Noise reduction:
#   - Only triggers on git commit
#   - Only nudges once per session (dedup file)
#   - Skips if a review was logged within the last 2 minutes
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

# Session dedup — only nudge once per session, scoped to this project
PROJECT_HASH=$(echo -n "$(pwd)" | md5 | head -c 8)
NUDGE_FILE="/tmp/canon-review-nudged-${PROJECT_HASH}"
if [[ -f "$NUDGE_FILE" ]]; then
  exit 0
fi

# Check if reviews.jsonl exists
REVIEWS_FILE=".canon/reviews.jsonl"
if [[ ! -f "$REVIEWS_FILE" ]]; then
  # No reviews at all — definitely nudge
  touch "$NUDGE_FILE"
  cat <<EOF
CANON: Commit created without a Canon review. Run /canon:review to check compliance before pushing.
EOF
  exit 0
fi

# Check if a review was logged recently (within last 2 minutes)
LAST_REVIEW_TS=$(tail -1 "$REVIEWS_FILE" 2>/dev/null | grep -o '"timestamp":"[^"]*"' | grep -o '[0-9T:Z.+-]*' | head -1 || echo "")
if [[ -n "$LAST_REVIEW_TS" ]]; then
  # Convert to epoch — handle both GNU and BSD date
  if date -d "$LAST_REVIEW_TS" +%s >/dev/null 2>&1; then
    LAST_EPOCH=$(date -d "$LAST_REVIEW_TS" +%s 2>/dev/null)
  elif date -jf "%Y-%m-%dT%H:%M:%S" "$LAST_REVIEW_TS" +%s >/dev/null 2>&1; then
    LAST_EPOCH=$(date -jf "%Y-%m-%dT%H:%M:%S" "${LAST_REVIEW_TS%%.*}" +%s 2>/dev/null)
  else
    LAST_EPOCH=0
  fi

  NOW_EPOCH=$(date +%s)
  DIFF=$((NOW_EPOCH - LAST_EPOCH))

  # If a review was logged within the last 120 seconds, skip nudge
  if [[ $DIFF -lt 120 ]]; then
    exit 0
  fi
fi

# Mark as nudged for this session
touch "$NUDGE_FILE"

cat <<EOF
CANON: Commit created without a recent Canon review. Run /canon:review to check compliance before pushing.
EOF

exit 0
