#!/usr/bin/env bash
# Tests for compaction-check.sh
# Run with: bash hooks/compaction-check.test.sh
# Exit 0 = all tests pass, Exit 1 = one or more failures

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/compaction-check.sh"

# shellcheck source=hooks/test-helpers.sh
source "$SCRIPT_DIR/test-helpers.sh"

PASS=0
FAIL=0

TMPDIR_BASE=$(mktemp -d)
trap 'rm -rf "$TMPDIR_BASE"' EXIT

# Unique session id so dedup file does not collide with other test runs
TEST_SESSION="compaction-test-$$"
COMMIT_INPUT="{\"session_id\":\"${TEST_SESSION}\",\"tool_output\":\"ok\",\"command\":\"git commit -m 'x'\"}"
NON_COMMIT_INPUT="{\"session_id\":\"${TEST_SESSION}-nc\",\"command\":\"npm test\"}"

echo ""
echo "=== compaction-check.sh tests ==="
echo ""

# ---------------------------------------------------------------------------
# Non-commit input: pass silently (exit 0, no output)
# ---------------------------------------------------------------------------
echo "-- Non-commit commands (should pass silently) --"

T_BASE="$TMPDIR_BASE/t_base"
setup_repo "$T_BASE"

OUTPUT=$(cd "$T_BASE" && echo "$NON_COMMIT_INPUT" | TMPDIR="$TMPDIR_BASE" bash "$HOOK" 2>&1) || true
if [[ -z "$OUTPUT" ]]; then
  echo "  PASS: non-commit input is silent"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected silent for non-commit, got: $OUTPUT"
  FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
# Commit with no .canon files: passes silently (no warnings)
# ---------------------------------------------------------------------------
echo ""
echo "-- No .canon files (should pass silently) --"

T_EMPTY="$TMPDIR_BASE/t_empty"
setup_repo "$T_EMPTY"

OUTPUT=$(cd "$T_EMPTY" && echo "$COMMIT_INPUT" | TMPDIR="$TMPDIR_BASE" bash "$HOOK" 2>&1) || true
if [[ -z "$OUTPUT" ]]; then
  echo "  PASS: no .canon files produces no warning"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected silent for no .canon files, got: $OUTPUT"
  FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
# reviews.jsonl with <500 entries: passes silently
# ---------------------------------------------------------------------------
echo ""
echo "-- reviews.jsonl under threshold (should pass silently) --"

SESSION_SMALL="compaction-small-$$"
SMALL_INPUT="{\"session_id\":\"${SESSION_SMALL}\",\"command\":\"git commit -m 'x'\"}"

T_SMALL="$TMPDIR_BASE/t_small"
setup_repo "$T_SMALL"
mkdir -p "$T_SMALL/.canon"
# Write 10 entries (well under 500)
for i in $(seq 1 10); do echo "{\"id\":$i}"; done > "$T_SMALL/.canon/reviews.jsonl"

OUTPUT=$(cd "$T_SMALL" && echo "$SMALL_INPUT" | TMPDIR="$TMPDIR_BASE" bash "$HOOK" 2>&1) || true
if [[ -z "$OUTPUT" ]]; then
  echo "  PASS: reviews.jsonl under 500 lines is silent"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected silent for small jsonl, got: $OUTPUT"
  FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
# reviews.jsonl >500 entries: warns
# ---------------------------------------------------------------------------
echo ""
echo "-- reviews.jsonl over threshold (should warn) --"

SESSION_BIG="compaction-big-$$"
BIG_INPUT="{\"session_id\":\"${SESSION_BIG}\",\"command\":\"git commit -m 'x'\"}"

T_BIG="$TMPDIR_BASE/t_big"
setup_repo "$T_BIG"
mkdir -p "$T_BIG/.canon"
# Write 510 entries (over 500 threshold)
python3 -c "
for i in range(510):
    print('{\"id\":' + str(i) + '}')
" > "$T_BIG/.canon/reviews.jsonl" 2>/dev/null || seq 1 510 | awk '{print "{\"id\":" $1 "}"}' > "$T_BIG/.canon/reviews.jsonl"

EXIT_CODE=0
OUTPUT=$(cd "$T_BIG" && echo "$BIG_INPUT" | TMPDIR="$TMPDIR_BASE" bash "$HOOK" 2>&1) || EXIT_CODE=$?
if [[ "$EXIT_CODE" -eq 0 ]]; then
  echo "  PASS: over-threshold exits 0 (advisory only)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: over-threshold should exit 0, got $EXIT_CODE"
  FAIL=$((FAIL + 1))
fi

if echo "$OUTPUT" | grep -q "CANON"; then
  echo "  PASS: over-threshold outputs CANON warning"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected CANON warning in output, got: $OUTPUT"
  FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
# CONVENTIONS.md with >20 conventions: warns
# ---------------------------------------------------------------------------
echo ""
echo "-- CONVENTIONS.md over threshold (should warn) --"

SESSION_CONV="compaction-conv-$$"
CONV_INPUT="{\"session_id\":\"${SESSION_CONV}\",\"command\":\"git commit -m 'x'\"}"

T_CONV="$TMPDIR_BASE/t_conv"
setup_repo "$T_CONV"
mkdir -p "$T_CONV/.canon"
# Write 22 convention entries (over 20 threshold)
printf '' > "$T_CONV/.canon/CONVENTIONS.md"
for i in $(seq 1 22); do
  echo "- **Convention $i**: description $i" >> "$T_CONV/.canon/CONVENTIONS.md"
done

OUTPUT=$(cd "$T_CONV" && echo "$CONV_INPUT" | TMPDIR="$TMPDIR_BASE" bash "$HOOK" 2>&1) || true
if echo "$OUTPUT" | grep -q "CANON"; then
  echo "  PASS: CONVENTIONS.md over 20 outputs CANON warning"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected CANON warning for CONVENTIONS.md, got: $OUTPUT"
  FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
# Session dedup: only warns once per session
# ---------------------------------------------------------------------------
echo ""
echo "-- Session dedup (should warn once, silent on repeat) --"

SESSION_DEDUP="compaction-dedup-$$"
DEDUP_INPUT="{\"session_id\":\"${SESSION_DEDUP}\",\"command\":\"git commit -m 'x'\"}"

T_DEDUP="$TMPDIR_BASE/t_dedup"
setup_repo "$T_DEDUP"
mkdir -p "$T_DEDUP/.canon"
seq 1 510 | awk '{print "{\"id\":" $1 "}"}' > "$T_DEDUP/.canon/reviews.jsonl"

# First call: should warn
OUTPUT1=$(cd "$T_DEDUP" && echo "$DEDUP_INPUT" | TMPDIR="$TMPDIR_BASE" bash "$HOOK" 2>&1) || true
# Second call with same session: should be silent (dedup)
OUTPUT2=$(cd "$T_DEDUP" && echo "$DEDUP_INPUT" | TMPDIR="$TMPDIR_BASE" bash "$HOOK" 2>&1) || true

if [[ -n "$OUTPUT1" ]] && [[ -z "$OUTPUT2" ]]; then
  echo "  PASS: warns once, silent on second call (dedup)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: dedup failed — first=$OUTPUT1 second=$OUTPUT2"
  FAIL=$((FAIL + 1))
fi

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
