#!/usr/bin/env bash
# Tests for session-duration-watchdog.sh
# Run with: bash hooks/canon-agent-teams/session-duration-watchdog.test.sh
# Exit 0 = all tests pass, Exit 1 = one or more failures

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/session-duration-watchdog.sh"

# shellcheck source=hooks/test-helpers.sh
source "$SCRIPT_DIR/../test-helpers.sh"

PASS=0
FAIL=0

PAYLOAD='{"tool_name":"Bash","tool_input":{"command":"npm test"}}'

echo ""
echo "=== session-duration-watchdog.sh tests ==="
echo ""

# ---------------------------------------------------------------------------
# No session start timestamp: exit 0 silently
# ---------------------------------------------------------------------------
echo "-- No session start timestamp (should pass silently, exit 0) --"

DIR1=$(mktemp -d)
trap 'rm -rf "$DIR1"' EXIT
mkdir -p "$DIR1/.canon"

EXIT_CODE=0
CANON_PROJECT_DIR="$DIR1" bash "$HOOK" <<<"$PAYLOAD" >/dev/null 2>&1 || EXIT_CODE=$?
if [[ "$EXIT_CODE" -eq 0 ]]; then
  echo "  PASS: no timestamp file exits 0"
  PASS=$((PASS + 1))
else
  echo "  FAIL: no timestamp file should exit 0, got $EXIT_CODE"
  FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
# Session under threshold: exit 0 silently
# ---------------------------------------------------------------------------
echo ""
echo "-- Session under threshold (should pass silently, exit 0) --"

DIR2=$(mktemp -d)
mkdir -p "$DIR2/.canon"
# 60 minutes ago with 120-minute threshold
echo "$(( $(date +%s) - 3600 ))" > "$DIR2/.canon/.session-start-ts"

EXIT_CODE=0
OUTPUT=$(CANON_PROJECT_DIR="$DIR2" bash "$HOOK" <<<"$PAYLOAD" 2>&1) || EXIT_CODE=$?
if [[ "$EXIT_CODE" -eq 0 ]] && [[ -z "$OUTPUT" ]]; then
  echo "  PASS: session under threshold is silent"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected silent exit 0, got exit=$EXIT_CODE output=$OUTPUT"
  FAIL=$((FAIL + 1))
fi
rm -rf "$DIR2"

# ---------------------------------------------------------------------------
# Session over threshold: advisory message on stdout, exit 0
# ---------------------------------------------------------------------------
echo ""
echo "-- Session over threshold (should warn, exit 0 always) --"

DIR3=$(mktemp -d)
mkdir -p "$DIR3/.canon"
# 130 minutes ago with default 120-minute threshold
echo "$(( $(date +%s) - 7800 ))" > "$DIR3/.canon/.session-start-ts"

EXIT_CODE=0
OUTPUT=$(CANON_PROJECT_DIR="$DIR3" bash "$HOOK" <<<"$PAYLOAD" 2>&1) || EXIT_CODE=$?
if [[ "$EXIT_CODE" -eq 0 ]]; then
  echo "  PASS: over-threshold exits 0 (advisory only)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: over-threshold should exit 0, got $EXIT_CODE"
  FAIL=$((FAIL + 1))
fi

if echo "$OUTPUT" | grep -q "CANON SESSION NOTE"; then
  echo "  PASS: over-threshold outputs advisory message"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected CANON SESSION NOTE in output, got: $OUTPUT"
  FAIL=$((FAIL + 1))
fi
rm -rf "$DIR3"

# ---------------------------------------------------------------------------
# Custom threshold via env var
# ---------------------------------------------------------------------------
echo ""
echo "-- Custom threshold (CANON_SESSION_WATCHDOG_MINUTES=5) --"

DIR4=$(mktemp -d)
mkdir -p "$DIR4/.canon"
# 6 minutes ago; custom threshold 5 minutes
echo "$(( $(date +%s) - 360 ))" > "$DIR4/.canon/.session-start-ts"

EXIT_CODE=0
OUTPUT=$(CANON_PROJECT_DIR="$DIR4" CANON_SESSION_WATCHDOG_MINUTES=5 bash "$HOOK" <<<"$PAYLOAD" 2>&1) || EXIT_CODE=$?
if echo "$OUTPUT" | grep -q "CANON SESSION NOTE"; then
  echo "  PASS: custom threshold 5min triggers at 6min"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected advisory with custom threshold, got: $OUTPUT"
  FAIL=$((FAIL + 1))
fi
rm -rf "$DIR4"

# Under custom threshold (4 minutes ago, threshold 5)
DIR5=$(mktemp -d)
mkdir -p "$DIR5/.canon"
echo "$(( $(date +%s) - 240 ))" > "$DIR5/.canon/.session-start-ts"

OUTPUT=$(CANON_PROJECT_DIR="$DIR5" CANON_SESSION_WATCHDOG_MINUTES=5 bash "$HOOK" <<<"$PAYLOAD" 2>&1) || true
if [[ -z "$OUTPUT" ]]; then
  echo "  PASS: custom threshold 5min silent at 4min"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected silent under custom threshold, got: $OUTPUT"
  FAIL=$((FAIL + 1))
fi
rm -rf "$DIR5"

# ---------------------------------------------------------------------------
# Interval dedup: after firing, same interval fires nothing
# ---------------------------------------------------------------------------
echo ""
echo "-- Interval dedup: does not re-fire within same interval --"

DIR6=$(mktemp -d)
mkdir -p "$DIR6/.canon"
echo "$(( $(date +%s) - 7800 ))" > "$DIR6/.canon/.session-start-ts"
# Write a dedup file as if we already showed the advisory just now
echo "$(date +%s)" > "$DIR6/.canon/.session-watchdog-last-shown"

OUTPUT=$(CANON_PROJECT_DIR="$DIR6" bash "$HOOK" <<<"$PAYLOAD" 2>&1) || true
if [[ -z "$OUTPUT" ]]; then
  echo "  PASS: dedup suppresses repeat within interval"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected silent (dedup), got: $OUTPUT"
  FAIL=$((FAIL + 1))
fi
rm -rf "$DIR6"

# ---------------------------------------------------------------------------
# Dedup expiry: fires again after full threshold interval
# ---------------------------------------------------------------------------
echo ""
echo "-- Dedup expiry: re-fires after another full interval --"

DIR7=$(mktemp -d)
mkdir -p "$DIR7/.canon"
# Session started 250 minutes ago; threshold 120 minutes
echo "$(( $(date +%s) - 15000 ))" > "$DIR7/.canon/.session-start-ts"
# Dedup file written 130 minutes ago (> threshold of 120 minutes)
echo "$(( $(date +%s) - 7800 ))" > "$DIR7/.canon/.session-watchdog-last-shown"

OUTPUT=$(CANON_PROJECT_DIR="$DIR7" bash "$HOOK" <<<"$PAYLOAD" 2>&1) || true
if echo "$OUTPUT" | grep -q "CANON SESSION NOTE"; then
  echo "  PASS: dedup expires and re-fires after full interval"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected advisory after dedup expiry, got: $OUTPUT"
  FAIL=$((FAIL + 1))
fi
rm -rf "$DIR7"

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
