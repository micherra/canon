#!/usr/bin/env bash
# hooks/lint.sh — Run shellcheck on all hook shell scripts.
#
# Skips:
#   - *.test.sh   (test files may use patterns shellcheck flags)
#   - test-helpers.sh  (shared test helper)
#
# Suppressions applied to all files:
#   SC1091 — not following sourced files (hooks source from relative paths)
#   SC2001 — see if you can use ${var//...} (sed used for regex patterns)
#   SC2016 — expressions in single quotes (false positive for embedded JS)
#
# Per-file inline suppressions (# shellcheck disable=...) are also honored.
#
# Usage: bash hooks/lint.sh
# Exit 0: all files pass. Exit 1: any file fails or shellcheck not installed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v shellcheck >/dev/null 2>&1; then
  echo "ERROR: shellcheck is not installed." >&2
  echo "Install it with: brew install shellcheck  (macOS)" >&2
  echo "  or: apt-get install shellcheck  (Debian/Ubuntu)" >&2
  exit 1
fi

FAILED=0
FILE_COUNT=0

while IFS= read -r file; do
  FILE_COUNT=$(( FILE_COUNT + 1 ))
  if ! shellcheck -e SC1091,SC2001,SC2016 "$file"; then
    FAILED=$(( FAILED + 1 ))
  fi
done < <(find "$SCRIPT_DIR" -name "*.sh" ! -name "*.test.sh" ! -name "test-helpers.sh" | sort)

if [[ $FAILED -gt 0 ]]; then
  echo ""
  echo "shellcheck: $FAILED of $FILE_COUNT file(s) failed." >&2
  exit 1
fi

echo "shellcheck: $FILE_COUNT file(s) passed."
exit 0
