#!/usr/bin/env bash
# Tests for learn-nudge.sh
# Run with: bash hooks/learn-nudge.test.sh
# Exit 0 = all tests pass, Exit 1 = one or more failures

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/learn-nudge.sh"

# shellcheck source=hooks/test-helpers.sh
source "$SCRIPT_DIR/test-helpers.sh"

PASS=0
FAIL=0

TMPDIR_BASE=$(mktemp -d)
trap 'rm -rf "$TMPDIR_BASE"' EXIT

echo ""
echo "=== learn-nudge.sh tests ==="
echo ""

# ---------------------------------------------------------------------------
# Non-commit input: pass silently (exit 0, no output)
# ---------------------------------------------------------------------------
echo "-- Non-commit commands (should pass silently) --"

T_BASE="$TMPDIR_BASE/t_base"
setup_repo "$T_BASE"

OUTPUT=$(cd "$T_BASE" && echo '{"command":"npm test"}' | bash "$HOOK" 2>&1) || true
if [[ -z "$OUTPUT" ]]; then
  echo "  PASS: non-commit input is silent"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected silent for non-commit, got: $OUTPUT"
  FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
# Commit with no reviews.jsonl: passes silently
# ---------------------------------------------------------------------------
echo ""
echo "-- No reviews.jsonl (should pass silently) --"

T_NOREV="$TMPDIR_BASE/t_norev"
setup_repo "$T_NOREV"
# No .canon directory at all

OUTPUT=$(cd "$T_NOREV" && echo '{"command":"git commit -m x"}' | bash "$HOOK" 2>&1) || true
if [[ -z "$OUTPUT" ]]; then
  echo "  PASS: no reviews.jsonl passes silently"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected silent for no reviews.jsonl, got: $OUTPUT"
  FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
# reviews.jsonl with <10 reviews since last learn: silent
# ---------------------------------------------------------------------------
echo ""
echo "-- Under 10 reviews since last learn (should pass silently) --"

T_FEW="$TMPDIR_BASE/t_few"
setup_repo "$T_FEW"
mkdir -p "$T_FEW/.canon"
# 15 reviews total, last learn saw 10 (5 new reviews — under threshold)
for i in $(seq 1 15); do echo "{\"id\":$i}"; done > "$T_FEW/.canon/reviews.jsonl"
echo '{"reviews_analyzed":10}' > "$T_FEW/.canon/learning.jsonl"

OUTPUT=$(cd "$T_FEW" && echo '{"command":"git commit -m x"}' | bash "$HOOK" 2>&1) || true
if [[ -z "$OUTPUT" ]]; then
  echo "  PASS: 5 reviews since last learn is silent"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected silent for <10 new reviews, got: $OUTPUT"
  FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
# 10+ reviews since last learn: nudges
# ---------------------------------------------------------------------------
echo ""
echo "-- 10+ reviews since last learn (should nudge) --"

T_MANY="$TMPDIR_BASE/t_many"
setup_repo "$T_MANY"
mkdir -p "$T_MANY/.canon"
# 25 reviews total, last learn saw 10 (15 new reviews — over threshold)
for i in $(seq 1 25); do echo "{\"id\":$i}"; done > "$T_MANY/.canon/reviews.jsonl"
echo '{"reviews_analyzed":10}' > "$T_MANY/.canon/learning.jsonl"

EXIT_CODE=0
OUTPUT=$(cd "$T_MANY" && echo '{"command":"git commit -m x"}' | bash "$HOOK" 2>&1) || EXIT_CODE=$?
if [[ "$EXIT_CODE" -eq 0 ]]; then
  echo "  PASS: nudge exits 0 (advisory only)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: nudge should exit 0, got $EXIT_CODE"
  FAIL=$((FAIL + 1))
fi

if echo "$OUTPUT" | grep -q "CANON"; then
  echo "  PASS: nudge outputs CANON message"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected CANON message in nudge output, got: $OUTPUT"
  FAIL=$((FAIL + 1))
fi

if echo "$OUTPUT" | grep -q "canon:learn\|/canon:learn"; then
  echo "  PASS: nudge mentions /canon:learn"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected /canon:learn mention in nudge, got: $OUTPUT"
  FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
# No learning.jsonl: counts all reviews (10+ triggers nudge)
# ---------------------------------------------------------------------------
echo ""
echo "-- No learning.jsonl (counts all reviews) --"

T_NOLEARN="$TMPDIR_BASE/t_nolearn"
setup_repo "$T_NOLEARN"
mkdir -p "$T_NOLEARN/.canon"
# 12 reviews, no learning.jsonl
for i in $(seq 1 12); do echo "{\"id\":$i}"; done > "$T_NOLEARN/.canon/reviews.jsonl"

OUTPUT=$(cd "$T_NOLEARN" && echo '{"command":"git commit -m x"}' | bash "$HOOK" 2>&1) || true
if echo "$OUTPUT" | grep -q "CANON"; then
  echo "  PASS: no learning.jsonl counts all reviews, nudges at 12"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected nudge for 12 reviews with no learning.jsonl, got: $OUTPUT"
  FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
# Session dedup: only nudges once per session (project-scoped)
# ---------------------------------------------------------------------------
echo ""
echo "-- Session dedup (should nudge once, silent on repeat) --"

T_DEDUP="$TMPDIR_BASE/t_dedup"
setup_repo "$T_DEDUP"
mkdir -p "$T_DEDUP/.canon"
for i in $(seq 1 12); do echo "{\"id\":$i}"; done > "$T_DEDUP/.canon/reviews.jsonl"

# First call: should nudge
OUTPUT1=$(cd "$T_DEDUP" && echo '{"command":"git commit -m x"}' | bash "$HOOK" 2>&1) || true
# Second call: should be silent (dedup file exists)
OUTPUT2=$(cd "$T_DEDUP" && echo '{"command":"git commit -m x"}' | bash "$HOOK" 2>&1) || true

if [[ -n "$OUTPUT1" ]] && [[ -z "$OUTPUT2" ]]; then
  echo "  PASS: nudges once, silent on second call (dedup)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: dedup failed — first=$OUTPUT1 second=$OUTPUT2"
  FAIL=$((FAIL + 1))
fi

# Cleanup dedup file so test isolation is clean
rm -f "$T_DEDUP/.canon/.learn-nudged-"* 2>/dev/null || true

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
