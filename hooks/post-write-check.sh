#!/bin/bash
# Canon Post-Write/Edit Check Hook
# Runs as a PostToolUse hook after Write and Edit tool calls.
# Extracts the file_path from the tool input JSON, runs principle-matcher
# to find applicable rule-severity principles, and outputs an advisory
# message if any rules apply.
#
# Noise reduction:
#   - Skips non-source files (configs, docs, images)
#   - Skips test files (checked at commit time instead)
#   - Time-windowed dedup: suppresses repeated checks on the same file
#     within 60 seconds (rapid-fire edits during implementation are quiet,
#     but revisiting a file later triggers a fresh check)
#
# Input: JSON on stdin with the tool call details
# Output: Advisory message on stdout (if applicable)
# Exit 0: always (advisory only, never blocks)

set -euo pipefail

# Read the tool input from stdin
INPUT=$(cat)

# Extract the file_path from the tool input
FILE_PATH=$(echo "$INPUT" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"file_path"[[:space:]]*:[[:space:]]*"//;s/"$//' || true)

# If we couldn't extract a file path, pass through silently
if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

# Skip non-source files (configs, docs, data files)
case "$FILE_PATH" in
  *.md|*.json|*.yaml|*.yml|*.toml|*.lock|*.txt|*.csv|*.svg|*.png|*.jpg|*.ico)
    exit 0
    ;;
esac

# Skip test files (they'll be checked at commit time)
case "$FILE_PATH" in
  *.test.*|*.spec.*|*__tests__*|*__test__*)
    exit 0
    ;;
esac

# --- Time-windowed deduplication ---
DEDUP_FILE="/tmp/canon-post-write-checked"
NOW=$(date +%s)
WINDOW=60  # seconds

# Clean stale entries (>5 minutes old) and check for recent check of this file
if [[ -f "$DEDUP_FILE" ]]; then
  CUTOFF=$((NOW - 300))
  # Remove stale entries, keep fresh ones
  FRESH_ENTRIES=$(awk -F: -v cutoff="$CUTOFF" '$1 >= cutoff' "$DEDUP_FILE" 2>/dev/null || true)
  echo "$FRESH_ENTRIES" > "$DEDUP_FILE" 2>/dev/null || true

  # Check if this file was checked within the dedup window
  LAST_CHECK=$(grep -F ":${FILE_PATH}" "$DEDUP_FILE" 2>/dev/null | tail -1 | cut -d: -f1 || true)
  if [[ -n "$LAST_CHECK" ]]; then
    ELAPSED=$((NOW - LAST_CHECK))
    if [[ $ELAPSED -lt $WINDOW ]]; then
      exit 0  # Checked recently, skip
    fi
  fi
fi

# Find the principles directory
PRINCIPLES_DIR=""
if [[ -d ".canon/principles" ]]; then
  PRINCIPLES_DIR=".canon/principles"
elif [[ -n "${CLAUDE_PLUGIN_ROOT:-}" && -d "${CLAUDE_PLUGIN_ROOT}/principles" ]]; then
  PRINCIPLES_DIR="${CLAUDE_PLUGIN_ROOT}/principles"
fi

if [[ -z "$PRINCIPLES_DIR" ]]; then
  exit 0
fi

# Find the matcher script
MATCHER=""
if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" && -f "${CLAUDE_PLUGIN_ROOT}/lib/principle-matcher.sh" ]]; then
  MATCHER="${CLAUDE_PLUGIN_ROOT}/lib/principle-matcher.sh"
elif [[ -f "$(dirname "${BASH_SOURCE[0]}")/../lib/principle-matcher.sh" ]]; then
  MATCHER="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/principle-matcher.sh"
fi

if [[ -z "$MATCHER" ]]; then
  exit 0
fi

# Run principle-matcher with rule severity filter only (keep it fast and focused)
RULES=$(bash "$MATCHER" --file "$FILE_PATH" --severity-filter rule --format text "$PRINCIPLES_DIR" 2>/dev/null || true)

# Record this check in the dedup file (even if no rules matched)
echo "${NOW}:${FILE_PATH}" >> "$DEDUP_FILE" 2>/dev/null || true

if [[ -z "$RULES" ]]; then
  exit 0
fi

# Count matched rules
RULE_COUNT=$(echo "$RULES" | wc -l | tr -d ' ')

# Output advisory message
cat <<EOF
CANON POST-WRITE CHECK: ${RULE_COUNT} rule-severity principle(s) apply to ${FILE_PATH}.
Verify your changes comply with:

${RULES}

Self-review the written/edited code against these principles before proceeding.
EOF

# Always exit 0 — advisory only, never block
exit 0
