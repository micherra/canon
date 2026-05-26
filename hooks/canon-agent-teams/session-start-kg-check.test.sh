#!/usr/bin/env bash
# Tests for session-start-kg-check.sh
# Run with: bash hooks/canon-agent-teams/session-start-kg-check.test.sh
# Exit 0 = all tests pass, Exit 1 = one or more failures

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/session-start-kg-check.sh"

# shellcheck source=hooks/test-helpers.sh
source "$SCRIPT_DIR/../test-helpers.sh"

PASS=0
FAIL=0

echo ""
echo "=== session-start-kg-check.sh tests ==="
echo ""

# ---------------------------------------------------------------------------
# No .canon directory: exits 0 silently
# ---------------------------------------------------------------------------
echo "-- No .canon directory (should pass silently) --"

DIR1=$(mktemp -d)
trap 'rm -rf "$DIR1"' EXIT

EXIT_CODE=0
OUTPUT=$(CANON_PROJECT_DIR="$DIR1" bash "$HOOK" 2>&1) || EXIT_CODE=$?
if [[ "$EXIT_CODE" -eq 0 ]] && [[ -z "$OUTPUT" ]]; then
  echo "  PASS: no .canon dir exits 0 silently"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected silent exit 0, got exit=$EXIT_CODE output=$OUTPUT"
  FAIL=$((FAIL + 1))
fi
rm -rf "$DIR1"

# ---------------------------------------------------------------------------
# .canon dir exists but no knowledge-graph.db: advisory message
# ---------------------------------------------------------------------------
echo ""
echo "-- KG missing (should nudge) --"

DIR2=$(mktemp -d)
mkdir -p "$DIR2/.canon"

EXIT_CODE=0
OUTPUT=$(CANON_PROJECT_DIR="$DIR2" bash "$HOOK" 2>&1) || EXIT_CODE=$?
if [[ "$EXIT_CODE" -eq 0 ]]; then
  echo "  PASS: missing KG exits 0 (advisory)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: missing KG should exit 0, got $EXIT_CODE"
  FAIL=$((FAIL + 1))
fi

if echo "$OUTPUT" | grep -q "Knowledge graph not found"; then
  echo "  PASS: missing KG outputs advisory"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected 'Knowledge graph not found' in output, got: $OUTPUT"
  FAIL=$((FAIL + 1))
fi
rm -rf "$DIR2"

# ---------------------------------------------------------------------------
# KG exists and is fresh (modified now): no output
# ---------------------------------------------------------------------------
echo ""
echo "-- KG present and fresh (should pass silently) --"

DIR3=$(mktemp -d)
mkdir -p "$DIR3/.canon"
touch "$DIR3/.canon/knowledge-graph.db"

EXIT_CODE=0
OUTPUT=$(CANON_PROJECT_DIR="$DIR3" bash "$HOOK" 2>&1) || EXIT_CODE=$?
if [[ "$EXIT_CODE" -eq 0 ]] && [[ -z "$OUTPUT" ]]; then
  echo "  PASS: fresh KG passes silently"
  PASS=$((PASS + 1))
else
  echo "  FAIL: fresh KG should be silent, got exit=$EXIT_CODE output=$OUTPUT"
  FAIL=$((FAIL + 1))
fi
rm -rf "$DIR3"

# ---------------------------------------------------------------------------
# KG exists but is stale (>24h old): advisory message
# ---------------------------------------------------------------------------
echo ""
echo "-- KG stale (>24h old, should nudge) --"

DIR4=$(mktemp -d)
mkdir -p "$DIR4/.canon"
touch "$DIR4/.canon/knowledge-graph.db"

# Set mtime to 48 hours ago (cross-platform: try GNU touch, then BSD touch)
if touch -d "48 hours ago" "$DIR4/.canon/knowledge-graph.db" >/dev/null 2>&1; then
  :
elif touch -t "$(date -v-48H +"%Y%m%d%H%M" 2>/dev/null || true)" "$DIR4/.canon/knowledge-graph.db" >/dev/null 2>&1; then
  :
else
  # Fallback: force stale by using a very old timestamp
  touch -t 202301010000 "$DIR4/.canon/knowledge-graph.db" 2>/dev/null || true
fi

EXIT_CODE=0
OUTPUT=$(CANON_PROJECT_DIR="$DIR4" bash "$HOOK" 2>&1) || EXIT_CODE=$?
if [[ "$EXIT_CODE" -eq 0 ]]; then
  echo "  PASS: stale KG exits 0 (advisory only)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: stale KG should exit 0, got $EXIT_CODE"
  FAIL=$((FAIL + 1))
fi

if echo "$OUTPUT" | grep -q "old\|stale\|refresh"; then
  echo "  PASS: stale KG outputs staleness advisory"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected staleness advisory in output, got: $OUTPUT"
  FAIL=$((FAIL + 1))
fi
rm -rf "$DIR4"

# ---------------------------------------------------------------------------
# Custom stale threshold (very short — 1 second)
# ---------------------------------------------------------------------------
echo ""
echo "-- Custom threshold (CANON_KG_STALE_SECONDS=1) --"

DIR5=$(mktemp -d)
mkdir -p "$DIR5/.canon"
touch "$DIR5/.canon/knowledge-graph.db"
# Sleep 2 seconds to exceed the 1-second threshold
sleep 2

OUTPUT=$(CANON_PROJECT_DIR="$DIR5" CANON_KG_STALE_SECONDS=1 bash "$HOOK" 2>&1) || true
if echo "$OUTPUT" | grep -q "old\|stale\|refresh"; then
  echo "  PASS: custom 1s threshold triggered after 2s"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected staleness advisory with 1s threshold, got: $OUTPUT"
  FAIL=$((FAIL + 1))
fi
rm -rf "$DIR5"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi

exit 0
