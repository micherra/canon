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

# Session dedup — only nudge once per session, scoped to this project
# Cross-platform hash: try md5sum (Linux), fall back to md5 (macOS)
if command -v md5sum &>/dev/null; then
  PROJECT_HASH=$(echo -n "$(pwd)" | md5sum | head -c 8)
else
  PROJECT_HASH=$(echo -n "$(pwd)" | md5 | head -c 8)
fi
NUDGE_FILE="/tmp/canon-compaction-nudged-${PROJECT_HASH}"
if [[ -f "$NUDGE_FILE" ]]; then
  exit 0
fi

WARNINGS=""

# Check .jsonl file sizes
for JSONL_FILE in .canon/reviews.jsonl .canon/decisions.jsonl .canon/patterns.jsonl; do
  if [[ -f "$JSONL_FILE" ]]; then
    LINE_COUNT=$(wc -l < "$JSONL_FILE" | tr -d ' ')
    if [[ $LINE_COUNT -gt 500 ]]; then
      WARNINGS="${WARNINGS}  - ${JSONL_FILE}: ${LINE_COUNT} entries (expected max 500 — rotation may not be running)\n"
    fi
  fi
done

# Check CONVENTIONS.md size
CONVENTIONS_FILE=".canon/CONVENTIONS.md"
if [[ -f "$CONVENTIONS_FILE" ]]; then
  CONVENTION_COUNT=$(grep -c '^- \*\*' "$CONVENTIONS_FILE" 2>/dev/null || echo "0")
  if [[ $CONVENTION_COUNT -gt 20 ]]; then
    WARNINGS="${WARNINGS}  - CONVENTIONS.md: ${CONVENTION_COUNT} conventions — consider consolidating similar entries\n"
  fi
fi

if [[ -z "$WARNINGS" ]]; then
  exit 0
fi

# Mark as nudged for this session
touch "$NUDGE_FILE"

cat <<EOF
CANON: Context management warning — some files are getting large:
${WARNINGS}
Run /canon:doctor for a full health check.
EOF

exit 0
