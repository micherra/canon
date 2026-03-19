#!/bin/bash
# Canon Learn Nudge Hook
# Runs as a PostToolUse hook after Bash calls that contain "git commit".
# Checks if enough reviews have accumulated since the last learning run
# and nudges the user to run /canon:learn.
#
# Noise reduction:
#   - Only triggers on git commit (piggybacks on commit flow)
#   - Only nudges once per session (dedup file)
#   - Requires 10+ reviews since last learn run
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
# Cross-platform hash: try md5sum (Linux), fall back to md5 (macOS)
if command -v md5sum &>/dev/null; then
  PROJECT_HASH=$(echo -n "$(pwd)" | md5sum | head -c 8)
else
  PROJECT_HASH=$(echo -n "$(pwd)" | md5 | head -c 8)
fi
NUDGE_FILE=".canon/.learn-nudged-${PROJECT_HASH}"
if [[ -f "$NUDGE_FILE" ]]; then
  exit 0
fi

# Check if reviews.jsonl exists
REVIEWS_FILE=".canon/reviews.jsonl"
if [[ ! -f "$REVIEWS_FILE" ]]; then
  exit 0
fi

REVIEW_COUNT=$(wc -l < "$REVIEWS_FILE" | tr -d ' ')

# Check when the last learn run happened
LEARNING_FILE=".canon/learning.jsonl"
if [[ -f "$LEARNING_FILE" ]]; then
  LAST_LEARN_REVIEWS=$(tail -1 "$LEARNING_FILE" 2>/dev/null | grep -o '"reviews_analyzed":[0-9]*' | grep -o '[0-9]*' || echo "0")
  REVIEWS_SINCE=$((REVIEW_COUNT - LAST_LEARN_REVIEWS))
else
  REVIEWS_SINCE=$REVIEW_COUNT
fi

# Only nudge if 10+ reviews since last learn run
if [[ $REVIEWS_SINCE -lt 10 ]]; then
  exit 0
fi

# Mark as nudged for this session
touch "$NUDGE_FILE"

cat <<EOF
CANON: ${REVIEWS_SINCE} reviews since last learning run. Run /canon:learn to discover patterns and refine principles.
EOF

exit 0
